// Crawl → audit pipeline executed by the worker (and directly by integration tests).
import {
  DEFAULT_SCORING_CONFIG,
  combinePageCaps,
  crawlSettingsSchema,
  DEFAULT_CRAWL_SETTINGS,
} from '@surfaced/shared';
import {
  crawlSite,
  urlHash,
  type CrawledPageRecord,
  type SafeFetcher,
  type SafeFetcherOptions,
} from '../crawler';
import type { PrismaClient } from '../db';
import { queueEmail } from '../email';
import { getEnv } from '../env';
import { createJobRecord, enqueueJobRecord, type JobTracker } from '../jobs';
import { getLogger } from '../logger';
import { notifyWorkspace } from '../notifications';
import type { QueueGateway } from '../queue';
import { syncAuditRecommendations } from '../recommendations';
import { analyzeSite } from './analyze';
import { pageRecordToCreateData } from './model';
import {
  crawlSummaryColumns,
  loadAnalysisInput,
  persistProjectAudit,
  summarizeForPublicAudit,
} from './persist';

export interface PipelineDeps {
  prisma: PrismaClient;
  queues: QueueGateway;
  fetcherOptions?: SafeFetcherOptions;
  /** Replaces the network fetcher (the seed's in-memory demo site); fetcherOptions still apply to the URL policy. */
  fetcher?: SafeFetcher;
}

const MAX_LINKS_PER_PAGE = 300;

export interface CrawlOutcome {
  status: 'completed' | 'cancelled';
  pagesCrawled: number;
  auditJobId: string | null;
}

export async function executeCrawlJob(
  deps: PipelineDeps,
  crawlJobId: string,
  tracker: JobTracker,
): Promise<CrawlOutcome> {
  const { prisma } = deps;
  const env = getEnv();
  const crawl = await prisma.crawlJob.findUniqueOrThrow({
    where: { id: crawlJobId },
    include: { publicAudit: true, project: true },
  });

  // Retries restart from a clean slate so pages are never duplicated.
  await prisma.crawledLink.deleteMany({ where: { crawlJobId } });
  await prisma.crawledPage.deleteMany({ where: { crawlJobId } });
  await prisma.crawlJob.update({
    where: { id: crawlJobId },
    data: {
      status: 'RUNNING',
      startedAt: crawl.startedAt ?? new Date(),
      pagesCrawled: 0,
      pagesFailed: 0,
      pagesDiscovered: 0,
      progress: 0,
      errorMessage: null,
    },
  });
  if (crawl.publicAudit)
    await prisma.publicAudit.update({ where: { id: crawl.publicAudit.id }, data: { status: 'RUNNING' } });

  const parsed = crawlSettingsSchema.partial().safeParse(crawl.settings);
  const settings = { ...DEFAULT_CRAWL_SETTINGS, ...(parsed.success ? parsed.data : {}) };
  let lastCounterWrite = 0;

  const persistPage = async (record: CrawledPageRecord) => {
    const page = await prisma.crawledPage.create({
      data: pageRecordToCreateData(crawlJobId, record),
      select: { id: true },
    });
    const seen = new Set<string>();
    const links = record.internalLinks
      .filter((l) => (seen.has(l.url) ? false : (seen.add(l.url), true)))
      .slice(0, MAX_LINKS_PER_PAGE)
      .map((l) => ({
        crawlJobId,
        fromPageId: page.id,
        toUrl: l.url.slice(0, 2048),
        toUrlHash: urlHash(l.url),
        anchorText: l.anchorText.slice(0, 255) || null,
        nofollow: l.nofollow,
      }));
    if (links.length) await prisma.crawledLink.createMany({ data: links, skipDuplicates: true });
  };

  const summary = await crawlSite(
    {
      startUrl: crawl.startUrl,
      maxPages: combinePageCaps(settings.maxPages, env.CRAWLER_MAX_PAGES_HARD_LIMIT),
      maxDepth: settings.maxDepth,
      includeSubdomains: settings.includeSubdomains,
      crawlDelayMs: settings.crawlDelayMs,
      concurrency: env.CRAWLER_CONCURRENCY,
      fetcher: deps.fetcher,
      fetcherOptions: deps.fetcherOptions,
    },
    {
      onPage: persistPage,
      onProgress: async ({ crawled, failed, discovered, maxPages }) => {
        // Without a page cap the total is unknown until the crawl ends, so progress follows pages found so far.
        const total = maxPages ?? Math.max(discovered, crawled);
        const percent = Math.min(95, 5 + (90 * crawled) / Math.max(1, total));
        await tracker.progress(
          percent,
          maxPages
            ? `Crawled ${crawled} of up to ${maxPages} pages`
            : `Crawled ${crawled} of ${Math.max(discovered, crawled)} pages found so far`,
        );
        const now = Date.now();
        if (now - lastCounterWrite > 1500) {
          lastCounterWrite = now;
          await prisma.crawlJob.update({
            where: { id: crawlJobId },
            data: {
              pagesCrawled: crawled,
              pagesFailed: failed,
              pagesDiscovered: discovered,
              progress: Math.round(percent),
            },
          });
        }
      },
      isCancelled: async () => {
        if (await tracker.isCancelRequested()) return true;
        const current = await prisma.crawlJob.findUnique({
          where: { id: crawlJobId },
          select: { cancelRequestedAt: true },
        });
        return Boolean(current?.cancelRequestedAt);
      },
    },
  );

  await prisma.crawlJob.update({
    where: { id: crawlJobId },
    data: {
      ...crawlSummaryColumns(summary),
      pagesCrawled: summary.pagesCrawled,
      pagesFailed: summary.pagesFailed,
      pagesDiscovered: summary.pagesDiscovered,
      progress: summary.cancelled ? undefined : 100,
      status: summary.cancelled ? 'CANCELLED' : 'SUCCEEDED',
      finishedAt: new Date(),
    },
  });

  if (summary.cancelled) {
    await prisma.auditRun.updateMany({
      where: { crawlJobId, status: 'QUEUED' },
      data: { status: 'CANCELLED', finishedAt: new Date() },
    });
    if (crawl.publicAudit) {
      await prisma.publicAudit.update({ where: { id: crawl.publicAudit.id }, data: { status: 'CANCELLED' } });
    }
    return { status: 'cancelled', pagesCrawled: summary.pagesCrawled, auditJobId: null };
  }

  // Queue the analysis step.
  let auditRunId: string | undefined;
  if (crawl.projectId) {
    const run =
      (await prisma.auditRun.findFirst({
        where: { crawlJobId, status: 'QUEUED' },
        orderBy: { createdAt: 'desc' },
      })) ??
      (await prisma.auditRun.create({
        data: {
          projectId: crawl.projectId,
          crawlJobId,
          scoringVersion: DEFAULT_SCORING_CONFIG.version,
          weights: DEFAULT_SCORING_CONFIG as never,
          isDemo: crawl.isDemo,
        },
      }));
    auditRunId = run.id;
  }
  const auditJob = await createJobRecord(prisma, {
    type: 'AUDIT',
    queue: 'audit',
    workspaceId: crawl.project?.workspaceId ?? null,
    projectId: crawl.projectId,
    userId: crawl.createdById,
    entityType: auditRunId ? 'AuditRun' : 'PublicAudit',
    entityId: auditRunId ?? crawl.publicAudit?.id,
    payload: { crawlJobId },
  });
  await enqueueJobRecord(prisma, deps.queues, auditJob, 'audit', {
    backgroundJobId: auditJob.id,
    crawlJobId,
    auditRunId,
    publicAuditId: crawl.publicAudit?.id,
  });
  return { status: 'completed', pagesCrawled: summary.pagesCrawled, auditJobId: auditJob.id };
}

export interface AuditOutcome {
  score: number;
  issues: number;
  pagesAnalyzed: number;
}

export async function executeAuditJob(
  deps: PipelineDeps,
  data: { crawlJobId: string; auditRunId?: string; publicAuditId?: string },
  tracker: JobTracker,
): Promise<AuditOutcome> {
  const { prisma } = deps;
  await tracker.progress(10, 'Loading crawl data', true);
  const input = await loadAnalysisInput(prisma, data.crawlJobId);
  await tracker.progress(30, 'Applying audit rules', true);
  const result = analyzeSite(input);

  if (data.publicAuditId) {
    await prisma.publicAudit.update({
      where: { id: data.publicAuditId },
      data: { status: 'SUCCEEDED', result: summarizeForPublicAudit(result) as never },
    });
    return { score: result.score.score, issues: result.issues.length, pagesAnalyzed: result.pagesAnalyzed };
  }
  if (!data.auditRunId) throw new Error('auditRunId is required for project audits');

  const run = await prisma.auditRun.findUniqueOrThrow({
    where: { id: data.auditRunId },
    include: { project: true },
  });
  if (!run.project) throw new Error('Audit run has no project');
  await prisma.auditRun.update({
    where: { id: run.id },
    data: { status: 'RUNNING', startedAt: run.startedAt ?? new Date() },
  });
  await tracker.progress(60, 'Saving issues', true);
  const outcome = await persistProjectAudit(prisma, {
    projectId: run.project.id,
    auditRunId: run.id,
    result,
    input,
  });
  await tracker.progress(85, 'Updating recommendations', true);
  await syncAuditRecommendations(prisma, run.project.id, run.id);

  const project = run.project;
  const link = `/app/p/${project.id}/audits/${run.id}`;
  const userIds = await notifyWorkspace(prisma, project.workspaceId, {
    type: 'audit.completed',
    title: `Audit completed for ${project.name}`,
    body: `Site health index ${result.score.score}/100 · ${result.issues.length} issues (${outcome.newIssues} new, ${outcome.resolvedIssues} resolved).`,
    link,
  });
  await emailOptedInUsers(deps, userIds, 'auditCompleted', (user) =>
    queueEmail(prisma, deps.queues, {
      to: user.email,
      template: 'audit_completed',
      data: {
        projectName: project.name,
        score: result.score.score,
        issues: result.issues.length,
        url: `${getEnv().APP_URL}${link}`,
      },
      userId: user.id,
      workspaceId: project.workspaceId,
    }),
  );
  return { score: result.score.score, issues: result.issues.length, pagesAnalyzed: result.pagesAnalyzed };
}

/** Sends an email to each user whose notification preference `pref` is enabled (default on). */
export async function emailOptedInUsers(
  deps: PipelineDeps,
  userIds: string[],
  pref: 'auditCompleted' | 'reportReady' | 'billing' | 'weeklySummary',
  send: (user: { id: string; email: string; name: string }) => Promise<unknown>,
): Promise<void> {
  if (!userIds.length) return;
  const users = await deps.prisma.user.findMany({
    where: { id: { in: userIds }, disabledAt: null },
    select: { id: true, email: true, name: true, notificationPrefs: true },
  });
  for (const user of users) {
    const prefs = (user.notificationPrefs ?? {}) as Record<string, unknown>;
    if (prefs[pref] === false) continue;
    try {
      await send(user);
    } catch (error) {
      getLogger('pipeline').warn({ err: error, userId: user.id }, 'Could not queue notification email');
    }
  }
}
