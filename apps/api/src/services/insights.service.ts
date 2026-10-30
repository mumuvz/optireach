import { isWorkspaceParticipant } from '@surfaced/core/access';
import { getWorkspacePlan } from '@surfaced/core/billing';
import {
  competitorComparison,
  competitorTrend,
  metadataComparison,
  saveGapActionAsRecommendation,
  saveSeoSuggestionAsRecommendation,
  topicGaps,
} from '@surfaced/core/competitors';
import type { Prisma, PrismaClient } from '@surfaced/core/db';
import { Errors } from '@surfaced/core/errors';
import { createJobRecord, enqueueJobRecord } from '@surfaced/core/jobs';
import {
  syncAuditRecommendations,
  syncLocalRecommendations,
  syncVisibilityRecommendations,
} from '@surfaced/core/recommendations';
import { assertMonthlyQuota, recordUsage, withWorkspaceLock } from '@surfaced/core/usage';
import {
  RECOMMENDATION_STATUSES,
  SEO_COMPARISON_MAX_COMPETITORS,
  type CompetitorComparisonQuery,
  type GapAnalysisDto,
  type GapAnalysisResult,
  type RecommendationListQuery,
  type RecommendationUpdateInput,
  type SeoComparisonDto,
  type SeoComparisonResult,
  type TrendBucket,
} from '@surfaced/shared';
import { iso, pageMeta, paginate } from '../lib/http';
import type { AppDeps, AuthUser } from '../types';
import { requireProjectAccess } from './access';

/** Gap analyses per project per rolling 24 hours (each one may call the AI provider and fetch public pages). */
const GAP_ANALYSES_PER_DAY = 10;

export class CompetitorAnalysisService {
  constructor(private readonly deps: AppDeps) {}

  private get prisma(): PrismaClient {
    return this.deps.prisma;
  }

  /** Competitor analysis is a Growth/Agency feature (see plan limits). */
  private async access(
    user: AuthUser,
    projectId: string,
    permission: 'project.read' | 'competitor.snapshot' | 'recommendation.update' = 'project.read',
  ) {
    const access = await requireProjectAccess(this.prisma, user, projectId, permission);
    const { limits, plan } = await getWorkspacePlan(this.prisma, access.project.workspaceId);
    if (!limits.competitorAnalysis) {
      throw Errors.planLimit(
        `Competitor analysis is not included in the ${plan.name} plan. Upgrade to Growth or Agency.`,
        { feature: 'competitorAnalysis', plan: plan.key },
      );
    }
    return access;
  }

  async comparison(user: AuthUser, projectId: string, query: CompetitorComparisonQuery) {
    await this.access(user, projectId);
    return competitorComparison(this.prisma, projectId, query);
  }

  async gaps(user: AuthUser, projectId: string, query: CompetitorComparisonQuery) {
    await this.access(user, projectId);
    return topicGaps(this.prisma, projectId, query);
  }

  async trend(user: AuthUser, projectId: string, query: CompetitorComparisonQuery, bucket: TrendBucket) {
    await this.access(user, projectId);
    const competitors = await this.prisma.projectCompetitor.findMany({
      where: { projectId },
      select: { id: true, name: true },
    });
    return { competitors, points: await competitorTrend(this.prisma, projectId, query, bucket) };
  }

  async metadata(user: AuthUser, projectId: string) {
    await this.access(user, projectId);
    return metadataComparison(this.prisma, projectId);
  }

  async snapshot(user: AuthUser, projectId: string, competitorId: string) {
    const { project } = await this.access(user, projectId, 'competitor.snapshot');
    const competitor = await this.prisma.projectCompetitor.findFirst({
      where: { id: competitorId, projectId },
    });
    if (!competitor) throw Errors.notFound('Competitor');
    const running = await this.prisma.competitorSnapshot.findFirst({
      where: { competitorId, status: { in: ['QUEUED', 'RUNNING'] } },
    });
    if (running) throw Errors.conflict('A snapshot of this competitor is already in progress.');
    const { snapshot, job } = await withWorkspaceLock(this.prisma, project.workspaceId, async (tx) => {
      await assertMonthlyQuota(tx, project.workspaceId, 'COMPETITOR_SNAPSHOT');
      const snapshot = await tx.competitorSnapshot.create({ data: { projectId, competitorId } });
      await recordUsage(tx, {
        workspaceId: project.workspaceId,
        projectId,
        metric: 'COMPETITOR_SNAPSHOT',
        quantity: 1,
        idempotencyKey: `snapshot:${snapshot.id}`,
      });
      const job = await createJobRecord(tx, {
        type: 'COMPETITOR_SNAPSHOT',
        queue: 'competitor',
        workspaceId: project.workspaceId,
        projectId,
        userId: user.id,
        entityType: 'CompetitorSnapshot',
        entityId: snapshot.id,
        payload: { snapshotId: snapshot.id },
        maxAttempts: 2,
      });
      return { snapshot, job };
    });
    await enqueueJobRecord(this.prisma, this.deps.queues, job, 'competitor', {
      backgroundJobId: job.id,
      snapshotId: snapshot.id,
    });
    return { jobId: job.id, snapshotId: snapshot.id, status: 'QUEUED' as const };
  }

  /** Starts a competitor gap analysis of the project's real AI answers (one at a time, a few per day). */
  async startGapAnalysis(user: AuthUser, projectId: string) {
    const { project } = await this.access(user, projectId, 'competitor.snapshot');
    if (!project.websiteUrl)
      throw Errors.badRequest(
        'Competitor gap analysis needs a website, and this business has none yet. Add it in project settings.',
      );
    const running = await this.prisma.visibilityGapAnalysis.findFirst({
      where: { projectId, status: { in: ['QUEUED', 'RUNNING'] } },
    });
    if (running) throw Errors.conflict('An analysis of this project is already running.');
    const today = await this.prisma.visibilityGapAnalysis.count({
      where: { projectId, createdAt: { gte: new Date(Date.now() - 24 * 3600 * 1000) } },
    });
    if (today >= GAP_ANALYSES_PER_DAY)
      throw Errors.rateLimited(
        `A project can be analyzed ${GAP_ANALYSES_PER_DAY} times a day. Try again later or after new AI checks.`,
      );
    const answers = await this.prisma.aiVisibilityObservation.count({
      where: { projectId, status: 'SUCCEEDED', isDemo: false },
    });
    if (!answers)
      throw Errors.conflict(
        'There are no real AI answers to analyze yet. Run AI visibility checks with a real provider first (demo answers are not analyzed).',
      );
    const { analysis, job } = await this.prisma.$transaction(async (tx) => {
      const analysis = await tx.visibilityGapAnalysis.create({ data: { projectId, createdById: user.id } });
      const job = await createJobRecord(tx, {
        type: 'GAP_ANALYSIS',
        queue: 'competitor',
        workspaceId: project.workspaceId,
        projectId,
        userId: user.id,
        entityType: 'VisibilityGapAnalysis',
        entityId: analysis.id,
        payload: { gapAnalysisId: analysis.id },
        maxAttempts: 2,
      });
      return { analysis, job };
    });
    await enqueueJobRecord(this.prisma, this.deps.queues, job, 'competitor', {
      backgroundJobId: job.id,
      gapAnalysisId: analysis.id,
    });
    return { jobId: job.id, analysisId: analysis.id, status: 'QUEUED' as const };
  }

  async latestGapAnalysis(user: AuthUser, projectId: string): Promise<GapAnalysisDto | null> {
    await this.access(user, projectId);
    const analysis = await this.prisma.visibilityGapAnalysis.findFirst({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
    });
    if (!analysis) return null;
    const [job, newAnswersSince] = await Promise.all([
      this.prisma.backgroundJob.findFirst({
        where: { entityType: 'VisibilityGapAnalysis', entityId: analysis.id },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      }),
      analysis.startedAt
        ? this.prisma.aiVisibilityObservation.count({
            where: { projectId, status: 'SUCCEEDED', isDemo: false, observedAt: { gt: analysis.startedAt } },
          })
        : Promise.resolve(0),
    ]);
    return {
      id: analysis.id,
      projectId: analysis.projectId,
      status: analysis.status,
      createdAt: analysis.createdAt.toISOString(),
      startedAt: iso(analysis.startedAt),
      finishedAt: iso(analysis.finishedAt),
      errorMessage: analysis.errorMessage,
      jobId: job?.id ?? null,
      newAnswersSince,
      result: (analysis.result as unknown as GapAnalysisResult | null) ?? null,
    };
  }

  /** Saves one action of a finished analysis as a recommendation, so it can be assigned and tracked. */
  /**
   * Crawls your site and up to five competitors the same way and compares them. Each competitor counts as one
   * competitor snapshot against the monthly quota.
   */
  async startSeoComparison(user: AuthUser, projectId: string, competitorIds?: string[]) {
    const { project } = await this.access(user, projectId, 'competitor.snapshot');
    if (!project.websiteUrl)
      throw Errors.badRequest(
        'SEO comparison needs a website, and this business has none yet. Add it in project settings.',
      );
    const running = await this.prisma.seoComparison.findFirst({
      where: { projectId, status: { in: ['QUEUED', 'RUNNING'] } },
    });
    if (running) throw Errors.conflict('A comparison of this project is already running.');
    const tracked = await this.prisma.projectCompetitor.findMany({
      where: { projectId },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    const ids = [
      ...new Set(
        competitorIds?.length
          ? competitorIds
          : tracked.slice(0, SEO_COMPARISON_MAX_COMPETITORS).map((c) => c.id),
      ),
    ];
    if (!ids.length) throw Errors.conflict('Add at least one competitor to compare with.');
    if (ids.length > SEO_COMPARISON_MAX_COMPETITORS)
      throw Errors.badRequest(`Compare at most ${SEO_COMPARISON_MAX_COMPETITORS} competitors at a time.`);
    if (ids.some((id) => !tracked.some((c) => c.id === id))) throw Errors.notFound('Competitor');
    const { comparison, job } = await withWorkspaceLock(this.prisma, project.workspaceId, async (tx) => {
      await assertMonthlyQuota(tx, project.workspaceId, 'COMPETITOR_SNAPSHOT', ids.length);
      const comparison = await tx.seoComparison.create({
        data: { projectId, createdById: user.id, competitorIds: ids },
      });
      await recordUsage(tx, {
        workspaceId: project.workspaceId,
        projectId,
        metric: 'COMPETITOR_SNAPSHOT',
        quantity: ids.length,
        idempotencyKey: `seo-comparison:${comparison.id}`,
      });
      const job = await createJobRecord(tx, {
        type: 'SEO_COMPARISON',
        queue: 'competitor',
        workspaceId: project.workspaceId,
        projectId,
        userId: user.id,
        entityType: 'SeoComparison',
        entityId: comparison.id,
        payload: { seoComparisonId: comparison.id },
        maxAttempts: 2,
      });
      return { comparison, job };
    });
    await enqueueJobRecord(this.prisma, this.deps.queues, job, 'competitor', {
      backgroundJobId: job.id,
      seoComparisonId: comparison.id,
    });
    return { jobId: job.id, comparisonId: comparison.id, status: 'QUEUED' as const };
  }

  async latestSeoComparison(user: AuthUser, projectId: string): Promise<SeoComparisonDto | null> {
    await this.access(user, projectId);
    const comparison = await this.prisma.seoComparison.findFirst({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
    });
    if (!comparison) return null;
    const job = await this.prisma.backgroundJob.findFirst({
      where: { entityType: 'SeoComparison', entityId: comparison.id },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    return {
      id: comparison.id,
      projectId: comparison.projectId,
      status: comparison.status,
      createdAt: comparison.createdAt.toISOString(),
      startedAt: iso(comparison.startedAt),
      finishedAt: iso(comparison.finishedAt),
      errorMessage: comparison.errorMessage,
      jobId: job?.id ?? null,
      competitorIds: Array.isArray(comparison.competitorIds) ? (comparison.competitorIds as string[]) : [],
      result: (comparison.result as unknown as SeoComparisonResult | null) ?? null,
    };
  }

  /** Saves one suggestion of a finished comparison as a recommendation. */
  async saveSeoSuggestion(user: AuthUser, projectId: string, comparisonId: string, suggestionKey: string) {
    await this.access(user, projectId, 'recommendation.update');
    const comparison = await this.prisma.seoComparison.findFirst({ where: { id: comparisonId, projectId } });
    const result = comparison?.result as unknown as SeoComparisonResult | null | undefined;
    if (!comparison || !result) throw Errors.notFound('Comparison');
    const suggestion = result.suggestions.find((s) => s.key === suggestionKey);
    if (!suggestion) throw Errors.notFound('Suggestion');
    const saved = await saveSeoSuggestionAsRecommendation(this.prisma, projectId, comparisonId, suggestion);
    const rec = await this.prisma.recommendation.findUniqueOrThrow({
      where: { id: saved.id },
      include: recInclude,
    });
    return { created: saved.created, recommendation: toRecommendationDto(rec) };
  }

  async saveGapAction(user: AuthUser, projectId: string, analysisId: string, actionKey: string) {
    await this.access(user, projectId, 'recommendation.update');
    const analysis = await this.prisma.visibilityGapAnalysis.findFirst({
      where: { id: analysisId, projectId },
    });
    const result = analysis?.result as unknown as GapAnalysisResult | null | undefined;
    if (!analysis || !result) throw Errors.notFound('Analysis');
    const action = result.actions.find((a) => a.key === actionKey);
    if (!action) throw Errors.notFound('Action');
    const saved = await saveGapActionAsRecommendation(this.prisma, projectId, analysisId, action);
    const rec = await this.prisma.recommendation.findUniqueOrThrow({
      where: { id: saved.id },
      include: recInclude,
    });
    return { created: saved.created, recommendation: toRecommendationDto(rec) };
  }

  async latestSnapshot(user: AuthUser, projectId: string, competitorId: string) {
    await this.access(user, projectId);
    const snapshot = await this.prisma.competitorSnapshot.findFirst({
      where: { competitorId, projectId },
      orderBy: { createdAt: 'desc' },
    });
    if (!snapshot) throw Errors.notFound('Snapshot');
    return { ...snapshot, createdAt: snapshot.createdAt.toISOString(), fetchedAt: iso(snapshot.fetchedAt) };
  }
}

type RecommendationRow = Prisma.RecommendationGetPayload<{
  include: {
    assignee: { select: { id: true; name: true } };
    verifiedBy: { select: { id: true; name: true } };
  };
}>;

export function toRecommendationDto(r: RecommendationRow) {
  return {
    id: r.id,
    projectId: r.projectId,
    title: r.title,
    category: r.category,
    source: r.source,
    severity: r.severity,
    relatedUrl: r.relatedUrl,
    expectedBenefit: r.expectedBenefit,
    benefitLevel: r.benefitLevel,
    evidence: r.evidence,
    proposedFix: r.proposedFix,
    status: r.status,
    assignee: r.assignee,
    ownerRole: r.ownerRole,
    effort: r.effort,
    verification: r.verification,
    dueAt: iso(r.dueAt),
    dismissedReason: r.dismissedReason,
    blockedReason: r.blockedReason,
    verifiedBy: r.verifiedBy,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    startedAt: iso(r.startedAt),
    plannedAt: iso(r.plannedAt),
    completedAt: iso(r.completedAt),
    verifiedAt: iso(r.verifiedAt),
    blockedAt: iso(r.blockedAt),
    dismissedAt: iso(r.dismissedAt),
  };
}

const recInclude = {
  assignee: { select: { id: true, name: true } },
  verifiedBy: { select: { id: true, name: true } },
} as const;

export class RecommendationService {
  constructor(private readonly deps: AppDeps) {}

  private get prisma(): PrismaClient {
    return this.deps.prisma;
  }

  async list(user: AuthUser, projectId: string, query: RecommendationListQuery) {
    await requireProjectAccess(this.prisma, user, projectId, 'project.read');
    const where: Prisma.RecommendationWhereInput = { projectId };
    if (query.status) where.status = { in: query.status };
    if (query.category) where.category = { in: query.category };
    if (query.severity) where.severity = { in: query.severity };
    if (query.assigneeId) where.assigneeId = query.assigneeId;
    const [total, rows, counts] = await Promise.all([
      this.prisma.recommendation.count({ where }),
      this.prisma.recommendation.findMany({
        where,
        include: recInclude,
        // Severity enum order is CRITICAL..LOW, so ascending = most severe first.
        orderBy: [{ severity: 'asc' }, { updatedAt: 'desc' }],
        ...paginate(query.page, query.pageSize),
      }),
      this.prisma.recommendation.groupBy({ by: ['status'], where: { projectId }, _count: { _all: true } }),
    ]);
    const byStatus = Object.fromEntries(
      RECOMMENDATION_STATUSES.map((s) => [s, counts.find((c) => c.status === s)?._count._all ?? 0]),
    );
    return {
      items: rows.map(toRecommendationDto),
      meta: pageMeta(query.page, query.pageSize, total),
      byStatus,
    };
  }

  private async load(user: AuthUser, id: string, permission: 'project.read' | 'recommendation.update') {
    const rec = await this.prisma.recommendation.findUnique({ where: { id }, include: recInclude });
    if (!rec) throw Errors.notFound('Recommendation');
    const access = await requireProjectAccess(this.prisma, user, rec.projectId, permission);
    return { rec, project: access.project };
  }

  async get(user: AuthUser, id: string) {
    return toRecommendationDto((await this.load(user, id, 'project.read')).rec);
  }

  async update(user: AuthUser, id: string, input: RecommendationUpdateInput) {
    const { rec, project } = await this.load(user, id, 'recommendation.update');
    const data: Prisma.RecommendationUncheckedUpdateInput = {};
    if (input.assigneeId !== undefined) {
      if (input.assigneeId) {
        if (!(await isWorkspaceParticipant(this.prisma, project.workspaceId, input.assigneeId)))
          throw Errors.badRequest('The assignee must be a member of this workspace.');
      }
      data.assigneeId = input.assigneeId;
    }
    if (input.ownerRole !== undefined) data.ownerRole = input.ownerRole;
    if (input.effort !== undefined) data.effort = input.effort;
    if (input.verification !== undefined) data.verification = input.verification?.trim() || null;
    if (input.dueAt !== undefined) data.dueAt = input.dueAt;
    if (input.status && input.status !== rec.status) {
      const now = new Date();
      data.status = input.status;
      if (input.status === 'PLANNED' && !rec.plannedAt) data.plannedAt = now;
      if (input.status === 'IN_PROGRESS' && !rec.startedAt) data.startedAt = now;
      if (input.status === 'COMPLETED') data.completedAt = rec.completedAt ?? now;
      if (input.status === 'VERIFIED') {
        // Verifying confirms the fix worked; it implies the work is complete.
        data.verifiedAt = now;
        data.verifiedById = user.id;
        data.completedAt = rec.completedAt ?? now;
        data.blockedAt = null;
        data.blockedReason = null;
      }
      if (input.status === 'BLOCKED') {
        data.blockedAt = now;
        data.blockedReason = input.blockedReason ?? null;
      }
      if (input.status === 'DISMISSED') {
        data.dismissedAt = now;
        data.dismissedReason = input.dismissedReason ?? null;
      }
      // Moving back to an active state clears the terminal/blocked markers.
      if (input.status === 'OPEN' || input.status === 'PLANNED' || input.status === 'IN_PROGRESS') {
        if (input.status !== 'IN_PROGRESS') data.completedAt = null;
        data.verifiedAt = null;
        data.verifiedById = null;
        data.dismissedAt = null;
        data.dismissedReason = null;
        data.blockedAt = null;
        data.blockedReason = null;
      }
    } else if (input.blockedReason !== undefined && rec.status === 'BLOCKED') {
      data.blockedReason = input.blockedReason;
    }
    const updated = await this.prisma.recommendation.update({ where: { id }, data, include: recInclude });
    return toRecommendationDto(updated);
  }

  async regenerate(user: AuthUser, projectId: string) {
    await requireProjectAccess(this.prisma, user, projectId, 'recommendation.update');
    const latestRun = await this.prisma.auditRun.findFirst({
      where: { projectId, status: 'SUCCEEDED' },
      orderBy: { finishedAt: 'desc' },
      select: { id: true },
    });
    const audit = latestRun
      ? await syncAuditRecommendations(this.prisma, projectId, latestRun.id)
      : { created: 0, updated: 0, autoCompleted: 0 };
    const visibility = await syncVisibilityRecommendations(this.prisma, projectId);
    const local = await syncLocalRecommendations(this.prisma, projectId);
    return { audit, visibility, local };
  }
}
