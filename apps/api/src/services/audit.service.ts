import { recordAuditLog } from '@surfaced/core/audit-log';
import { getWorkspacePlan } from '@surfaced/core/billing';
import type { Prisma, PrismaClient } from '@surfaced/core/db';
import { Errors } from '@surfaced/core/errors';
import { createJobRecord, enqueueJobRecord, requestJobCancellation, toJobDto } from '@surfaced/core/jobs';
import { assertMonthlyQuota, recordUsage, withWorkspaceLock } from '@surfaced/core/usage';
import {
  DEFAULT_SCORING_CONFIG,
  SEVERITY_RANK,
  getAuditRule,
  type IssueListQuery,
  type PageListQuery,
  type StartAuditInput,
} from '@surfaced/shared';
import { iso, pageMeta, paginate } from '../lib/http';
import type { AppDeps, AuthUser } from '../types';
import { requireProjectAccess } from './access';
import { assertWebsiteAllowed, effectiveCrawlSettings } from './project.service';

type IssueRow = Prisma.AuditIssueGetPayload<object>;

export function toIssueDto(issue: IssueRow) {
  const rule = getAuditRule(issue.ruleId);
  return {
    id: issue.id,
    ruleId: issue.ruleId,
    category: issue.category,
    severity: issue.severity,
    status: issue.status,
    url: issue.url,
    title: issue.title,
    description: issue.description,
    impact: rule?.impact ?? null,
    evidence: issue.evidence,
    suggestedFix: issue.suggestedFix,
    firstDetectedAt: issue.firstDetectedAt.toISOString(),
    lastDetectedAt: issue.lastDetectedAt.toISOString(),
    resolvedAt: iso(issue.resolvedAt),
    ignoredAt: iso(issue.ignoredAt),
  };
}

export class AuditService {
  constructor(private readonly deps: AppDeps) {}

  private get prisma(): PrismaClient {
    return this.deps.prisma;
  }

  /** Loads an audit run the user may access (404 otherwise). */
  async loadRun(
    user: AuthUser,
    auditRunId: string,
    permission: 'project.read' | 'audit.run' | 'audit.cancel' = 'project.read',
  ) {
    const run = await this.prisma.auditRun.findUnique({
      where: { id: auditRunId },
      select: { id: true, projectId: true },
    });
    if (!run?.projectId) throw Errors.notFound('Audit');
    await requireProjectAccess(this.prisma, user, run.projectId, permission);
    return this.prisma.auditRun.findUniqueOrThrow({
      where: { id: auditRunId },
      include: { crawlJob: true, project: true },
    });
  }

  async start(user: AuthUser, projectId: string, input: StartAuditInput, ip: string) {
    const { project } = await requireProjectAccess(this.prisma, user, projectId, 'audit.run');
    if (!project.websiteUrl)
      throw Errors.badRequest(
        'A website audit needs a website, and this business has none yet. Add it in project settings.',
      );
    const websiteUrl = project.websiteUrl;
    assertWebsiteAllowed(websiteUrl);
    const active = await this.prisma.crawlJob.findFirst({
      where: { projectId, status: { in: ['QUEUED', 'RUNNING'] } },
    });
    if (active)
      throw Errors.conflict(
        'An audit is already running for this project. Wait for it to finish or cancel it.',
      );

    const created = await withWorkspaceLock(this.prisma, project.workspaceId, async (tx) => {
      const { limits } = await assertMonthlyQuota(tx, project.workspaceId, 'AUDIT_RUN');
      const settings = effectiveCrawlSettings(project.crawlSettings as never, input.crawlSettings, limits);
      const crawl = await tx.crawlJob.create({
        data: {
          projectId,
          startUrl: websiteUrl,
          settings,
          trigger: 'MANUAL',
          createdById: user.id,
          isDemo: project.isDemo,
        },
      });
      const run = await tx.auditRun.create({
        data: {
          projectId,
          crawlJobId: crawl.id,
          scoringVersion: DEFAULT_SCORING_CONFIG.version,
          weights: DEFAULT_SCORING_CONFIG as never,
          isDemo: project.isDemo,
        },
      });
      await recordUsage(tx, {
        workspaceId: project.workspaceId,
        projectId,
        metric: 'AUDIT_RUN',
        quantity: 1,
        idempotencyKey: `audit:${crawl.id}`,
      });
      const job = await createJobRecord(tx, {
        type: 'CRAWL',
        queue: 'crawl',
        workspaceId: project.workspaceId,
        projectId,
        userId: user.id,
        entityType: 'CrawlJob',
        entityId: crawl.id,
        payload: { crawlJobId: crawl.id, auditRunId: run.id },
        maxAttempts: 2,
      });
      return { crawl, run, job };
    });

    await enqueueJobRecord(this.prisma, this.deps.queues, created.job, 'crawl', {
      backgroundJobId: created.job.id,
      crawlJobId: created.crawl.id,
    });
    await recordAuditLog(this.prisma, {
      action: 'audit.started',
      actorUserId: user.id,
      workspaceId: project.workspaceId,
      targetType: 'AuditRun',
      targetId: created.run.id,
      ipAddress: ip,
    });
    return {
      jobId: created.job.id,
      auditRunId: created.run.id,
      crawlJobId: created.crawl.id,
      status: 'QUEUED' as const,
    };
  }

  async list(user: AuthUser, projectId: string, page: number, pageSize: number) {
    await requireProjectAccess(this.prisma, user, projectId, 'project.read');
    const where = { projectId };
    const [total, runs] = await Promise.all([
      this.prisma.auditRun.count({ where }),
      this.prisma.auditRun.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        include: {
          crawlJob: { select: { status: true, pagesCrawled: true, progress: true, trigger: true } },
        },
        ...paginate(page, pageSize),
      }),
    ]);
    return {
      items: runs.map((r) => ({
        id: r.id,
        status: r.status,
        crawlStatus: r.crawlJob.status,
        trigger: r.crawlJob.trigger,
        progress: r.crawlJob.progress,
        score: r.score,
        issueCounts: r.issueCounts,
        pagesCrawled: r.crawlJob.pagesCrawled,
        pagesAnalyzed: r.pagesAnalyzed,
        isDemo: r.isDemo,
        createdAt: r.createdAt.toISOString(),
        finishedAt: iso(r.finishedAt),
      })),
      meta: pageMeta(page, pageSize, total),
    };
  }

  async detail(user: AuthUser, auditRunId: string) {
    const run = await this.loadRun(user, auditRunId);
    const [jobs, previous] = await Promise.all([
      this.prisma.backgroundJob.findMany({
        where: {
          OR: [
            { entityType: 'CrawlJob', entityId: run.crawlJobId },
            { entityType: 'AuditRun', entityId: run.id },
          ],
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.auditRun.findFirst({
        where: { projectId: run.projectId, status: 'SUCCEEDED', createdAt: { lt: run.createdAt } },
        orderBy: { createdAt: 'desc' },
        select: { id: true, score: true, issueCounts: true, finishedAt: true },
      }),
    ]);
    const crawlJob = jobs.find((j) => j.type === 'CRAWL');
    const auditJob = jobs.find((j) => j.type === 'AUDIT');
    const counts = (run.issueCounts ?? null) as { limitations?: string[] } | null;
    return {
      id: run.id,
      projectId: run.projectId,
      status: run.status,
      score: run.score,
      categoryScores: run.categoryScores,
      issueCounts: run.issueCounts,
      limitations: counts?.limitations ?? [],
      pagesAnalyzed: run.pagesAnalyzed,
      scoringVersion: run.scoringVersion,
      weights: run.weights,
      isDemo: run.isDemo,
      createdAt: run.createdAt.toISOString(),
      finishedAt: iso(run.finishedAt),
      crawl: {
        id: run.crawlJob.id,
        status: run.crawlJob.status,
        startUrl: run.crawlJob.startUrl,
        settings: run.crawlJob.settings,
        progress: run.crawlJob.progress,
        pagesCrawled: run.crawlJob.pagesCrawled,
        pagesFailed: run.crawlJob.pagesFailed,
        pagesDiscovered: run.crawlJob.pagesDiscovered,
        robots: run.crawlJob.robotsInfo,
        sitemap: run.crawlJob.sitemapInfo,
        summary: run.crawlJob.summary,
        errorMessage: run.crawlJob.errorMessage,
        startedAt: iso(run.crawlJob.startedAt),
        finishedAt: iso(run.crawlJob.finishedAt),
      },
      jobs: { crawl: crawlJob ? toJobDto(crawlJob) : null, audit: auditJob ? toJobDto(auditJob) : null },
      previous: previous
        ? {
            id: previous.id,
            score: previous.score,
            issueCounts: previous.issueCounts,
            finishedAt: iso(previous.finishedAt),
          }
        : null,
    };
  }

  async cancel(user: AuthUser, auditRunId: string) {
    const run = await this.loadRun(user, auditRunId, 'audit.cancel');
    if (run.crawlJob.status !== 'QUEUED' && run.crawlJob.status !== 'RUNNING')
      throw Errors.conflict('Only queued or running audits can be cancelled.');
    await this.prisma.crawlJob.update({
      where: { id: run.crawlJobId },
      data: { cancelRequestedAt: new Date() },
    });
    const job = await this.prisma.backgroundJob.findFirst({
      where: { entityType: 'CrawlJob', entityId: run.crawlJobId, status: { in: ['QUEUED', 'RUNNING'] } },
    });
    if (job) {
      const updated = await requestJobCancellation(this.prisma, this.deps.queues, job);
      if (updated.status === 'CANCELLED') {
        await this.prisma.crawlJob.update({
          where: { id: run.crawlJobId },
          data: { status: 'CANCELLED', finishedAt: new Date() },
        });
        await this.prisma.auditRun.update({
          where: { id: run.id },
          data: { status: 'CANCELLED', finishedAt: new Date() },
        });
      }
    }
    return this.detail(user, auditRunId);
  }

  /** Re-applies the current scoring rules to a stored crawl (no new requests to the website). */
  async rescore(user: AuthUser, auditRunId: string) {
    const run = await this.loadRun(user, auditRunId, 'audit.run');
    if (run.crawlJob.status !== 'SUCCEEDED') throw Errors.conflict('Only completed crawls can be re-scored.');
    const project = run.project!;
    const next = await this.prisma.auditRun.create({
      data: {
        projectId: project.id,
        crawlJobId: run.crawlJobId,
        scoringVersion: DEFAULT_SCORING_CONFIG.version,
        weights: DEFAULT_SCORING_CONFIG as never,
        isDemo: run.isDemo,
      },
    });
    const job = await createJobRecord(this.prisma, {
      type: 'AUDIT',
      queue: 'audit',
      workspaceId: project.workspaceId,
      projectId: project.id,
      userId: user.id,
      entityType: 'AuditRun',
      entityId: next.id,
      payload: { crawlJobId: run.crawlJobId, rescoreOf: run.id },
    });
    await enqueueJobRecord(this.prisma, this.deps.queues, job, 'audit', {
      backgroundJobId: job.id,
      crawlJobId: run.crawlJobId,
      auditRunId: next.id,
    });
    return { jobId: job.id, auditRunId: next.id, status: 'QUEUED' as const };
  }

  async pages(user: AuthUser, auditRunId: string, query: PageListQuery) {
    const run = await this.loadRun(user, auditRunId);
    const where: Prisma.CrawledPageWhereInput = { crawlJobId: run.crawlJobId };
    if (query.q) where.OR = [{ url: { contains: query.q } }, { title: { contains: query.q } }];
    if (query.indexable) where.isIndexable = query.indexable === 'true';
    if (query.statusClass === 'error') where.statusCode = null;
    else if (query.statusClass) {
      const base = Number(query.statusClass[0]) * 100;
      where.statusCode = { gte: base, lt: base + 100 };
    }
    const [total, rows] = await Promise.all([
      this.prisma.crawledPage.count({ where }),
      this.prisma.crawledPage.findMany({
        where,
        orderBy: { [query.sort]: query.order },
        select: {
          id: true,
          url: true,
          statusCode: true,
          title: true,
          depth: true,
          wordCount: true,
          responseTimeMs: true,
          isIndexable: true,
          indexabilityReason: true,
          inlinksCount: true,
          inSitemap: true,
          fetchError: true,
          _count: { select: { occurrences: true } },
        },
        ...paginate(query.page, query.pageSize),
      }),
    ]);
    return {
      items: rows.map(({ _count, ...r }) => ({ ...r, issueCount: _count.occurrences })),
      meta: pageMeta(query.page, query.pageSize, total),
    };
  }

  async pageDetail(user: AuthUser, auditRunId: string, pageId: string) {
    const run = await this.loadRun(user, auditRunId);
    const page = await this.prisma.crawledPage.findFirst({
      where: { id: pageId, crawlJobId: run.crawlJobId },
    });
    if (!page) throw Errors.notFound('Page');
    const [occurrences, inlinks, outlinks] = await Promise.all([
      this.prisma.auditIssueOccurrence.findMany({
        where: { auditRunId: run.id, crawledPageId: page.id },
        include: { issue: true },
      }),
      this.prisma.crawledLink.findMany({
        where: { crawlJobId: run.crawlJobId, toUrlHash: page.urlHash },
        take: 50,
        select: { anchorText: true, nofollow: true, fromPage: { select: { id: true, url: true } } },
      }),
      this.prisma.crawledLink.findMany({
        where: { fromPageId: page.id },
        take: 300,
        select: { toUrl: true, anchorText: true, nofollow: true },
      }),
    ]);
    return {
      page,
      issues: occurrences
        .map((o) => toIssueDto(o.issue))
        .sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]),
      inlinks: inlinks.map((l) => ({
        pageId: l.fromPage.id,
        url: l.fromPage.url,
        anchorText: l.anchorText,
        nofollow: l.nofollow,
      })),
      outlinks,
    };
  }

  private issueWhere(query: IssueListQuery): Prisma.AuditIssueWhereInput {
    const where: Prisma.AuditIssueWhereInput = {};
    if (query.severity) where.severity = { in: query.severity };
    if (query.category) where.category = { in: query.category };
    if (query.status) where.status = { in: query.status };
    if (query.ruleId) where.ruleId = query.ruleId;
    if (query.q)
      where.OR = [
        { url: { contains: query.q } },
        { title: { contains: query.q } },
        { description: { contains: query.q } },
      ];
    return where;
  }

  private issueOrder(query: IssueListQuery): Prisma.AuditIssueOrderByWithRelationInput[] {
    // Severity is a MySQL ENUM declared CRITICAL..LOW, so ascending enum order = most severe first.
    if (query.sort === 'severity')
      return [{ severity: query.order === 'desc' ? 'asc' : 'desc' }, { lastDetectedAt: 'desc' }];
    return [{ [query.sort]: query.order }];
  }

  async projectIssues(user: AuthUser, projectId: string, query: IssueListQuery) {
    await requireProjectAccess(this.prisma, user, projectId, 'project.read');
    const where = {
      ...this.issueWhere(query),
      projectId,
      ...(query.status ? {} : { status: 'OPEN' as const }),
    };
    const [total, rows] = await Promise.all([
      this.prisma.auditIssue.count({ where }),
      this.prisma.auditIssue.findMany({
        where,
        orderBy: this.issueOrder(query),
        ...paginate(query.page, query.pageSize),
      }),
    ]);
    return { items: rows.map(toIssueDto), meta: pageMeta(query.page, query.pageSize, total) };
  }

  async runIssues(user: AuthUser, auditRunId: string, query: IssueListQuery) {
    const run = await this.loadRun(user, auditRunId);
    const where: Prisma.AuditIssueWhereInput = {
      ...this.issueWhere(query),
      occurrences: { some: { auditRunId: run.id } },
    };
    const [total, rows] = await Promise.all([
      this.prisma.auditIssue.count({ where }),
      this.prisma.auditIssue.findMany({
        where,
        orderBy: this.issueOrder(query),
        ...paginate(query.page, query.pageSize),
      }),
    ]);
    return { items: rows.map(toIssueDto), meta: pageMeta(query.page, query.pageSize, total) };
  }

  async issueSummary(user: AuthUser, projectId: string) {
    await requireProjectAccess(this.prisma, user, projectId, 'project.read');
    const [bySeverity, byCategory, byRule, byStatus] = await Promise.all([
      this.prisma.auditIssue.groupBy({
        by: ['severity'],
        where: { projectId, status: 'OPEN' },
        _count: { _all: true },
      }),
      this.prisma.auditIssue.groupBy({
        by: ['category'],
        where: { projectId, status: 'OPEN' },
        _count: { _all: true },
      }),
      this.prisma.auditIssue.groupBy({
        by: ['ruleId'],
        where: { projectId, status: 'OPEN' },
        _count: { _all: true },
        orderBy: { _count: { ruleId: 'desc' } },
        take: 50,
      }),
      this.prisma.auditIssue.groupBy({ by: ['status'], where: { projectId }, _count: { _all: true } }),
    ]);
    return {
      bySeverity: Object.fromEntries(bySeverity.map((r) => [r.severity, r._count._all])),
      byCategory: Object.fromEntries(byCategory.map((r) => [r.category, r._count._all])),
      byStatus: Object.fromEntries(byStatus.map((r) => [r.status, r._count._all])),
      rules: byRule.map((r) => {
        const rule = getAuditRule(r.ruleId);
        return {
          ruleId: r.ruleId,
          count: r._count._all,
          title: rule?.title ?? r.ruleId,
          category: rule?.category ?? null,
          severity: rule?.severity ?? null,
        };
      }),
    };
  }

  private async loadIssue(user: AuthUser, issueId: string, permission: 'project.read' | 'issue.update') {
    const issue = await this.prisma.auditIssue.findUnique({ where: { id: issueId } });
    if (!issue) throw Errors.notFound('Issue');
    await requireProjectAccess(this.prisma, user, issue.projectId, permission);
    return issue;
  }

  async issueDetail(user: AuthUser, issueId: string) {
    const issue = await this.loadIssue(user, issueId, 'project.read');
    const history = await this.prisma.auditIssueOccurrence.findMany({
      where: { issueId },
      include: { auditRun: { select: { id: true, createdAt: true, score: true } } },
      orderBy: { auditRun: { createdAt: 'desc' } },
      take: 20,
    });
    return {
      ...toIssueDto(issue),
      history: history.map((h) => ({
        auditRunId: h.auditRun.id,
        detectedAt: h.auditRun.createdAt.toISOString(),
        severity: h.severity,
        crawledPageId: h.crawledPageId,
      })),
    };
  }

  async updateIssue(user: AuthUser, issueId: string, status: 'OPEN' | 'IGNORED') {
    const issue = await this.loadIssue(user, issueId, 'issue.update');
    if (issue.status === 'RESOLVED' && status === 'IGNORED')
      throw Errors.conflict('Resolved issues cannot be ignored.');
    const updated = await this.prisma.auditIssue.update({
      where: { id: issueId },
      data: { status, ignoredAt: status === 'IGNORED' ? new Date() : null },
    });
    return toIssueDto(updated);
  }

  async crawlJob(user: AuthUser, crawlJobId: string) {
    const crawl = await this.prisma.crawlJob.findUnique({ where: { id: crawlJobId } });
    if (!crawl?.projectId) throw Errors.notFound('Crawl job');
    await requireProjectAccess(this.prisma, user, crawl.projectId, 'project.read');
    const { plan } = await getWorkspacePlan(
      this.prisma,
      (await this.prisma.project.findUniqueOrThrow({ where: { id: crawl.projectId } })).workspaceId,
    );
    return {
      id: crawl.id,
      status: crawl.status,
      progress: crawl.progress,
      pagesCrawled: crawl.pagesCrawled,
      pagesFailed: crawl.pagesFailed,
      pagesDiscovered: crawl.pagesDiscovered,
      settings: crawl.settings,
      planPageLimit: plan.limits.pagesPerAudit,
      startedAt: iso(crawl.startedAt),
      finishedAt: iso(crawl.finishedAt),
      cancelRequested: Boolean(crawl.cancelRequestedAt),
    };
  }
}
