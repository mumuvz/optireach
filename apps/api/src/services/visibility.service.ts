import { llmStatus } from '@surfaced/core/ai';
import { billingGroupWorkspaceIds, getWorkspacePlan } from '@surfaced/core/billing';
import type { Prisma, PrismaClient } from '@surfaced/core/db';
import { Errors } from '@surfaced/core/errors';
import { createJobRecord, enqueueJobRecord, toJobDto } from '@surfaced/core/jobs';
import { assertCountLimit, assertMonthlyQuota, withWorkspaceLock } from '@surfaced/core/usage';
import {
  getVisibilitySummary,
  getVisibilityTrend,
  getVisibilityProvider,
  listVisibilityProviderStatuses,
  nextPromptRun,
  observationWhere,
  recordManualObservation,
} from '@surfaced/core/visibility';
import {
  isFrequencyAllowed,
  normalizePromptText,
  type ObservationListQuery,
  type PromptBulkData,
  type PromptData,
  type TrendBucket,
  type VisibilityFilter,
  type VisibilityProviderKey,
  type ManualObservationInput,
} from '@surfaced/shared';
import { iso, pageMeta, paginate, stringArray } from '../lib/http';
import type { AppDeps, AuthUser } from '../types';
import { requireProjectAccess } from './access';

type PromptRow = Prisma.AiPromptGetPayload<{ include: { competitors: { select: { competitorId: true } } } }>;

export function toPromptDto(p: PromptRow) {
  return {
    id: p.id,
    projectId: p.projectId,
    text: p.text,
    intent: p.intent,
    country: p.country,
    city: p.city,
    language: p.language,
    targetBrand: p.targetBrand,
    competitorIds: p.competitors.map((c) => c.competitorId),
    providers: stringArray(p.providers),
    frequency: p.frequency,
    status: p.status,
    lastRunAt: iso(p.lastRunAt),
    nextRunAt: iso(p.nextRunAt),
    createdAt: p.createdAt.toISOString(),
  };
}

export class VisibilityService {
  constructor(private readonly deps: AppDeps) {}

  private get prisma(): PrismaClient {
    return this.deps.prisma;
  }

  providers() {
    return { providers: listVisibilityProviderStatuses(), llm: llmStatus() };
  }

  private assertProvidersConfigured(providers: VisibilityProviderKey[]): void {
    for (const key of providers) {
      const status = getVisibilityProvider(key).status();
      if (!status.configured)
        throw Errors.providerNotConfigured(getVisibilityProvider(key).meta.label, {
          provider: key,
          detail: status.detail,
        });
    }
  }

  private async assertCompetitorsBelong(projectId: string, ids: string[]): Promise<void> {
    if (!ids.length) return;
    const count = await this.prisma.projectCompetitor.count({ where: { projectId, id: { in: ids } } });
    if (count !== new Set(ids).size)
      throw Errors.badRequest('One or more competitors do not belong to this project.');
  }

  async listPrompts(
    user: AuthUser,
    projectId: string,
    query: { page: number; pageSize: number; status?: 'ACTIVE' | 'PAUSED'; q?: string },
  ) {
    await requireProjectAccess(this.prisma, user, projectId, 'project.read');
    const where: Prisma.AiPromptWhereInput = {
      projectId,
      ...(query.status ? { status: query.status } : {}),
      ...(query.q ? { text: { contains: query.q } } : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.aiPrompt.count({ where }),
      this.prisma.aiPrompt.findMany({
        where,
        include: { competitors: { select: { competitorId: true } } },
        orderBy: { createdAt: 'desc' },
        ...paginate(query.page, query.pageSize),
      }),
    ]);
    return { items: rows.map(toPromptDto), meta: pageMeta(query.page, query.pageSize, total) };
  }

  async createPrompt(user: AuthUser, projectId: string, input: PromptData) {
    const { project } = await requireProjectAccess(this.prisma, user, projectId, 'prompt.manage');
    this.assertProvidersConfigured(input.providers);
    await this.assertCompetitorsBelong(projectId, input.competitorIds);
    const prompt = await withWorkspaceLock(this.prisma, project.workspaceId, async (tx) => {
      const group = await billingGroupWorkspaceIds(tx, project.workspaceId);
      const count = await tx.aiPrompt.count({ where: { project: { workspaceId: { in: group } } } });
      const limits = await assertCountLimit(tx, project.workspaceId, 'trackedPrompts', count);
      if (!isFrequencyAllowed(limits, input.frequency))
        throw Errors.planLimit(`${input.frequency.toLowerCase()} tracking is not included in your plan.`);
      return tx.aiPrompt.create({
        data: {
          projectId,
          text: input.text,
          intent: input.intent,
          country: input.country,
          city: input.city ?? null,
          language: input.language,
          targetBrand: input.targetBrand ?? project.name,
          providers: [...new Set(input.providers)],
          frequency: input.frequency,
          status: input.status,
          nextRunAt: input.status === 'ACTIVE' ? nextPromptRun(input.frequency) : null,
          competitors: {
            create: [...new Set(input.competitorIds)].map((competitorId) => ({ competitorId })),
          },
        },
        include: { competitors: { select: { competitorId: true } } },
      });
    });
    return toPromptDto(prompt);
  }

  /**
   * Adds many prompts with the same settings. Lines that are too short, repeated in the list or already tracked for
   * the same country and language are skipped and reported. The plan's prompt limit applies to the whole batch.
   */
  async createPromptsBulk(user: AuthUser, projectId: string, input: PromptBulkData) {
    const { project } = await requireProjectAccess(this.prisma, user, projectId, 'prompt.manage');
    this.assertProvidersConfigured(input.providers);
    await this.assertCompetitorsBelong(projectId, input.competitorIds);
    const existing = await this.prisma.aiPrompt.findMany({
      where: { projectId, country: input.country, language: input.language },
      select: { text: true },
    });
    const tracked = new Set(existing.map((p) => normalizePromptText(p.text)));
    const seen = new Set<string>();
    const accepted: string[] = [];
    const skipped: { text: string; reason: 'too_short' | 'duplicate' | 'already_tracked' }[] = [];
    for (const raw of input.texts) {
      const text = raw.replace(/\s+/g, ' ').trim();
      if (!text) continue;
      const key = normalizePromptText(text);
      if (text.length < 10) skipped.push({ text, reason: 'too_short' });
      else if (seen.has(key)) skipped.push({ text, reason: 'duplicate' });
      else if (tracked.has(key)) skipped.push({ text, reason: 'already_tracked' });
      else {
        seen.add(key);
        accepted.push(text);
      }
    }
    if (!accepted.length) return { created: [], skipped };
    const competitorIds = [...new Set(input.competitorIds)];
    const prompts = await withWorkspaceLock(this.prisma, project.workspaceId, async (tx) => {
      const group = await billingGroupWorkspaceIds(tx, project.workspaceId);
      const count = await tx.aiPrompt.count({ where: { project: { workspaceId: { in: group } } } });
      const limits = await assertCountLimit(
        tx,
        project.workspaceId,
        'trackedPrompts',
        count,
        accepted.length,
      );
      if (!isFrequencyAllowed(limits, input.frequency))
        throw Errors.planLimit(`${input.frequency.toLowerCase()} tracking is not included in your plan.`);
      const created = [];
      for (const text of accepted)
        created.push(
          await tx.aiPrompt.create({
            data: {
              projectId,
              text,
              intent: input.intent,
              country: input.country,
              language: input.language,
              targetBrand: input.targetBrand ?? project.name,
              providers: [...new Set(input.providers)],
              frequency: input.frequency,
              status: input.status,
              nextRunAt: input.status === 'ACTIVE' ? nextPromptRun(input.frequency) : null,
              competitors: { create: competitorIds.map((competitorId) => ({ competitorId })) },
            },
            include: { competitors: { select: { competitorId: true } } },
          }),
        );
      return created;
    });
    return { created: prompts.map(toPromptDto), skipped };
  }

  private async loadPrompt(
    user: AuthUser,
    promptId: string,
    permission: 'project.read' | 'prompt.manage' | 'visibility.run',
  ) {
    const prompt = await this.prisma.aiPrompt.findUnique({
      where: { id: promptId },
      include: { competitors: { select: { competitorId: true } } },
    });
    if (!prompt) throw Errors.notFound('Prompt');
    const access = await requireProjectAccess(this.prisma, user, prompt.projectId, permission);
    return { prompt, project: access.project };
  }

  async getPrompt(user: AuthUser, promptId: string) {
    return toPromptDto((await this.loadPrompt(user, promptId, 'project.read')).prompt);
  }

  async updatePrompt(user: AuthUser, promptId: string, input: Partial<PromptData>) {
    const { prompt, project } = await this.loadPrompt(user, promptId, 'prompt.manage');
    if (input.providers) this.assertProvidersConfigured(input.providers);
    if (input.competitorIds) await this.assertCompetitorsBelong(prompt.projectId, input.competitorIds);
    if (input.frequency) {
      const { limits } = await getWorkspacePlan(this.prisma, project.workspaceId);
      if (!isFrequencyAllowed(limits, input.frequency))
        throw Errors.planLimit(`${input.frequency.toLowerCase()} tracking is not included in your plan.`);
    }
    const frequency = input.frequency ?? prompt.frequency;
    const status = input.status ?? prompt.status;
    const updated = await this.prisma.$transaction(async (tx) => {
      if (input.competitorIds) {
        await tx.aiPromptCompetitor.deleteMany({ where: { promptId } });
        await tx.aiPromptCompetitor.createMany({
          data: [...new Set(input.competitorIds)].map((competitorId) => ({ promptId, competitorId })),
        });
      }
      return tx.aiPrompt.update({
        where: { id: promptId },
        data: {
          text: input.text,
          intent: input.intent,
          country: input.country,
          city: input.city,
          language: input.language,
          targetBrand: input.targetBrand,
          providers: input.providers ? [...new Set(input.providers)] : undefined,
          frequency: input.frequency,
          status: input.status,
          nextRunAt:
            status === 'ACTIVE'
              ? input.frequency || input.status
                ? nextPromptRun(frequency)
                : undefined
              : null,
        },
        include: { competitors: { select: { competitorId: true } } },
      });
    });
    return toPromptDto(updated);
  }

  async deletePrompt(user: AuthUser, promptId: string) {
    await this.loadPrompt(user, promptId, 'prompt.manage');
    await this.prisma.aiPrompt.delete({ where: { id: promptId } });
  }

  /** Queues a run for the given prompts (or all active prompts). Reserves the projected number of checks. */
  async startRun(user: AuthUser, projectId: string, promptIds?: string[]) {
    const { project } = await requireProjectAccess(this.prisma, user, projectId, 'visibility.run');
    const prompts = await this.prisma.aiPrompt.findMany({
      where: { projectId, ...(promptIds?.length ? { id: { in: promptIds } } : { status: 'ACTIVE' }) },
      select: { id: true, providers: true },
    });
    if (prompts.length === 0)
      throw Errors.badRequest(
        promptIds?.length
          ? 'None of those prompts belong to this project.'
          : 'Add or activate at least one prompt first.',
      );
    const providers = new Set(prompts.flatMap((p) => stringArray(p.providers))) as Set<VisibilityProviderKey>;
    this.assertProvidersConfigured([...providers]);
    const checks = prompts.reduce((sum, p) => sum + stringArray(p.providers).length, 0);
    const active = await this.prisma.aiVisibilityRun.findFirst({
      where: { projectId, status: { in: ['QUEUED', 'RUNNING'] } },
    });
    if (active) throw Errors.conflict('A visibility run is already in progress for this project.');

    const { run, job } = await withWorkspaceLock(this.prisma, project.workspaceId, async (tx) => {
      await assertMonthlyQuota(tx, project.workspaceId, 'VISIBILITY_CHECK', checks);
      const run = await tx.aiVisibilityRun.create({
        data: {
          projectId,
          trigger: 'MANUAL',
          promptCount: prompts.length,
          isDemo: providers.size === 1 && providers.has('mock_demo'),
        },
      });
      const job = await createJobRecord(tx, {
        type: 'VISIBILITY_RUN',
        queue: 'visibility',
        workspaceId: project.workspaceId,
        projectId,
        userId: user.id,
        entityType: 'AiVisibilityRun',
        entityId: run.id,
        payload: { runId: run.id, promptIds: prompts.map((p) => p.id), plannedChecks: checks },
        maxAttempts: 2,
      });
      return { run, job };
    });
    await enqueueJobRecord(this.prisma, this.deps.queues, job, 'visibility', {
      backgroundJobId: job.id,
      runId: run.id,
    });
    return { jobId: job.id, runId: run.id, plannedChecks: checks, status: 'QUEUED' as const };
  }

  async listRuns(user: AuthUser, projectId: string, page: number, pageSize: number) {
    await requireProjectAccess(this.prisma, user, projectId, 'project.read');
    const [total, runs] = await Promise.all([
      this.prisma.aiVisibilityRun.count({ where: { projectId } }),
      this.prisma.aiVisibilityRun.findMany({
        where: { projectId },
        orderBy: { createdAt: 'desc' },
        ...paginate(page, pageSize),
      }),
    ]);
    return {
      items: runs.map((r) => ({
        id: r.id,
        status: r.status,
        trigger: r.trigger,
        promptCount: r.promptCount,
        observationCount: r.observationCount,
        successCount: r.successCount,
        failureCount: r.failureCount,
        isDemo: r.isDemo,
        errorMessage: r.errorMessage,
        createdAt: r.createdAt.toISOString(),
        finishedAt: iso(r.finishedAt),
      })),
      meta: pageMeta(page, pageSize, total),
    };
  }

  async getRun(user: AuthUser, runId: string) {
    const run = await this.prisma.aiVisibilityRun.findUnique({ where: { id: runId } });
    if (!run) throw Errors.notFound('Run');
    await requireProjectAccess(this.prisma, user, run.projectId, 'project.read');
    const job = await this.prisma.backgroundJob.findFirst({
      where: { entityType: 'AiVisibilityRun', entityId: runId },
      orderBy: { createdAt: 'desc' },
    });
    return {
      id: run.id,
      projectId: run.projectId,
      status: run.status,
      trigger: run.trigger,
      promptCount: run.promptCount,
      observationCount: run.observationCount,
      successCount: run.successCount,
      failureCount: run.failureCount,
      isDemo: run.isDemo,
      errorMessage: run.errorMessage,
      createdAt: run.createdAt.toISOString(),
      finishedAt: iso(run.finishedAt),
      job: job ? toJobDto(job) : null,
    };
  }

  async summary(user: AuthUser, projectId: string, filter: VisibilityFilter) {
    await requireProjectAccess(this.prisma, user, projectId, 'project.read');
    return getVisibilitySummary(this.prisma, projectId, filter);
  }

  async trend(user: AuthUser, projectId: string, filter: VisibilityFilter, bucket: TrendBucket) {
    await requireProjectAccess(this.prisma, user, projectId, 'project.read');
    return getVisibilityTrend(this.prisma, projectId, filter, bucket);
  }

  async observations(user: AuthUser, projectId: string, query: ObservationListQuery) {
    await requireProjectAccess(this.prisma, user, projectId, 'project.read');
    const where: Prisma.AiVisibilityObservationWhereInput = {
      ...observationWhere(projectId, query),
      ...(query.mentioned ? { brandMentioned: query.mentioned === 'true' } : {}),
      ...(query.cited ? { brandCited: query.cited === 'true' } : {}),
      ...(query.status ? { status: query.status } : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.aiVisibilityObservation.count({ where }),
      this.prisma.aiVisibilityObservation.findMany({
        where,
        orderBy: { observedAt: 'desc' },
        select: {
          id: true,
          promptId: true,
          promptText: true,
          provider: true,
          model: true,
          country: true,
          city: true,
          language: true,
          captureMethod: true,
          status: true,
          isDemo: true,
          brandMentioned: true,
          brandCited: true,
          brandRank: true,
          sentiment: true,
          sentimentSource: true,
          errorCode: true,
          observedAt: true,
          _count: { select: { citations: true, mentions: true } },
        },
        ...paginate(query.page, query.pageSize),
      }),
    ]);
    return {
      items: rows.map(({ _count, observedAt, ...r }) => ({
        ...r,
        observedAt: observedAt.toISOString(),
        citationCount: _count.citations,
        mentionCount: _count.mentions,
      })),
      meta: pageMeta(query.page, query.pageSize, total),
    };
  }

  async observation(user: AuthUser, observationId: string) {
    const observation = await this.prisma.aiVisibilityObservation.findUnique({
      where: { id: observationId },
      include: {
        mentions: { orderBy: { rank: 'asc' } },
        citations: { orderBy: { position: 'asc' } },
        prompt: { select: { id: true, text: true } },
      },
    });
    if (!observation) throw Errors.notFound('Observation');
    await requireProjectAccess(this.prisma, user, observation.projectId, 'project.read');
    return { ...observation, observedAt: observation.observedAt.toISOString() };
  }

  /** A manual observation (labeled manual everywhere); free, so it uses no visibility-check quota. */
  async recordManualObservation(user: AuthUser, projectId: string, input: ManualObservationInput) {
    await requireProjectAccess(this.prisma, user, projectId, 'prompt.manage');
    const { observationId } = await recordManualObservation(this.prisma, {
      projectId,
      userId: user.id,
      input,
    });
    return this.observation(user, observationId);
  }

  async citations(user: AuthUser, projectId: string, filter: VisibilityFilter) {
    await requireProjectAccess(this.prisma, user, projectId, 'project.read');
    const where = { observation: { ...observationWhere(projectId, filter), status: 'SUCCEEDED' as const } };
    const grouped = await this.prisma.aiCitation.groupBy({
      by: ['domain'],
      where,
      _count: { _all: true },
      orderBy: { _count: { domain: 'desc' } },
      take: 50,
    });
    const total = grouped.reduce((sum, g) => sum + g._count._all, 0);
    const details = await this.prisma.aiCitation.findMany({
      where: { ...where, domain: { in: grouped.map((g) => g.domain) } },
      select: { domain: true, url: true, title: true, isOwnedDomain: true, competitorId: true },
      take: 2000,
    });
    return grouped.map((g) => {
      const rows = details.filter((d) => d.domain === g.domain);
      return {
        domain: g.domain,
        citations: g._count._all,
        share: total ? g._count._all / total : 0,
        isOwnedDomain: rows.some((r) => r.isOwnedDomain),
        competitorId: rows.find((r) => r.competitorId)?.competitorId ?? null,
        sampleUrls: [...new Map(rows.map((r) => [r.url, { url: r.url, title: r.title }])).values()].slice(
          0,
          5,
        ),
      };
    });
  }
}
