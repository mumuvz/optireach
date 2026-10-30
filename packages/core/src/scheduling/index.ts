// Scheduled work, run by the worker's maintenance queue. Each task re-checks the workspace plan
// (feature flags and monthly quotas) when it runs, so a downgrade stops scheduled work. Usage is
// recorded exactly as for a manual run. Due items are claimed with a conditional update before any
// work starts, so overlapping scheduler ticks cannot start the same item twice, and a failure
// waits for the next period instead of retrying in a tight loop.
import {
  DEFAULT_NOTIFICATION_PREFS,
  DEFAULT_SCORING_CONFIG,
  VISIBILITY_PROVIDER_KEYS,
  combinePageCaps,
  crawlSettingsSchema,
  DEFAULT_CRAWL_SETTINGS,
  isFrequencyAllowed,
  notificationPrefsSchema,
  type AuditSchedule,
  type CrawlSettings,
  type PlanLimits,
  type VisibilityProviderKey,
} from '@surfaced/shared';
import { getWorkspacePlan } from '../billing';
import { UnsafeTargetError, assertUrlPolicy } from '../crawler';
import type { Project, PrismaClient } from '../db';
import { queueEmail } from '../email';
import { getEnv } from '../env';
import { errorMessage } from '../errors';
import { createJobRecord, enqueueJobRecord } from '../jobs';
import type { Logger } from '../logger';
import { notifyWorkspace } from '../notifications';
import type { QueueGateway } from '../queue';
import { assertMonthlyQuota, recordUsage, withWorkspaceLock } from '../usage';
import { getVisibilityProvider, nextPromptRun } from '../visibility';

export interface SchedulerDeps {
  prisma: PrismaClient;
  queues: QueueGateway;
  logger: Logger;
  /** Injectable clock for tests. */
  now?: () => Date;
}

export interface SkippedItem {
  id: string;
  reason: string;
}

export function nextAuditDate(schedule: AuditSchedule, from = new Date()): Date | null {
  if (schedule === 'MANUAL') return null;
  const next = new Date(from);
  if (schedule === 'WEEKLY') next.setUTCDate(next.getUTCDate() + 7);
  else next.setUTCMonth(next.getUTCMonth() + 1);
  return next;
}

/**
 * Merges stored crawl settings (invalid values fall back to defaults) with an optional patch and
 * clamps the page cap to the plan and the server's hard limit. With no project, plan or server cap the
 * result is null: the crawl covers every page it can reach.
 */
export function clampCrawlSettings(
  current: unknown,
  limits: PlanLimits,
  patch: Partial<CrawlSettings> = {},
): CrawlSettings {
  const parsed = crawlSettingsSchema.partial().safeParse(current ?? {});
  const merged = { ...DEFAULT_CRAWL_SETTINGS, ...(parsed.success ? parsed.data : {}), ...patch };
  const maxPages = combinePageCaps(
    merged.maxPages,
    limits.pagesPerAudit,
    getEnv().CRAWLER_MAX_PAGES_HARD_LIMIT,
  );
  return crawlSettingsSchema.parse({ ...merged, maxPages });
}

// ---------------- Scheduled audits ----------------

async function startScheduledAudit(deps: SchedulerDeps, project: Project): Promise<string | null> {
  const { prisma } = deps;
  const { limits } = await getWorkspacePlan(prisma, project.workspaceId);
  if (!limits.scheduledAudits) return 'The workspace plan does not include scheduled audits.';
  if (!project.websiteUrl) return 'The business has no website to audit.';
  const websiteUrl = project.websiteUrl;
  try {
    assertUrlPolicy(new URL(websiteUrl));
  } catch (error) {
    if (error instanceof UnsafeTargetError) return `The website address is not allowed: ${error.message}`;
    throw error;
  }
  const active = await prisma.crawlJob.findFirst({
    where: { projectId: project.id, status: { in: ['QUEUED', 'RUNNING'] } },
    select: { id: true },
  });
  if (active) return 'An audit was already running.';

  const created = await withWorkspaceLock(prisma, project.workspaceId, async (tx) => {
    const { limits: locked } = await assertMonthlyQuota(tx, project.workspaceId, 'AUDIT_RUN');
    const crawl = await tx.crawlJob.create({
      data: {
        projectId: project.id,
        startUrl: websiteUrl,
        settings: clampCrawlSettings(project.crawlSettings, locked),
        trigger: 'SCHEDULED',
        isDemo: project.isDemo,
      },
    });
    const run = await tx.auditRun.create({
      data: {
        projectId: project.id,
        crawlJobId: crawl.id,
        scoringVersion: DEFAULT_SCORING_CONFIG.version,
        weights: DEFAULT_SCORING_CONFIG as never,
        isDemo: project.isDemo,
      },
    });
    await recordUsage(tx, {
      workspaceId: project.workspaceId,
      projectId: project.id,
      metric: 'AUDIT_RUN',
      quantity: 1,
      idempotencyKey: `audit:${crawl.id}`,
    });
    const job = await createJobRecord(tx, {
      type: 'CRAWL',
      queue: 'crawl',
      workspaceId: project.workspaceId,
      projectId: project.id,
      entityType: 'CrawlJob',
      entityId: crawl.id,
      payload: { crawlJobId: crawl.id, auditRunId: run.id, trigger: 'SCHEDULED' },
      maxAttempts: 2,
      message: 'Queued (scheduled)',
    });
    return { crawl, job };
  });
  await enqueueJobRecord(prisma, deps.queues, created.job, 'crawl', {
    backgroundJobId: created.job.id,
    crawlJobId: created.crawl.id,
  });
  return null;
}

export async function runScheduledAudits(
  deps: SchedulerDeps,
): Promise<{ started: number; skipped: SkippedItem[] }> {
  const { prisma } = deps;
  const now = deps.now?.() ?? new Date();
  const due = await prisma.project.findMany({
    where: { auditSchedule: { not: 'MANUAL' }, nextAuditAt: { lte: now }, websiteUrl: { not: null } },
    orderBy: { nextAuditAt: 'asc' },
    take: 50,
  });
  let started = 0;
  const skipped: SkippedItem[] = [];
  for (const project of due) {
    const claimed = await prisma.project.updateMany({
      where: { id: project.id, nextAuditAt: project.nextAuditAt },
      data: { nextAuditAt: nextAuditDate(project.auditSchedule, now) },
    });
    if (claimed.count === 0) continue;
    let reason: string | null;
    try {
      reason = await startScheduledAudit(deps, project);
    } catch (error) {
      reason = errorMessage(error);
    }
    if (reason === null) {
      started += 1;
      continue;
    }
    skipped.push({ id: project.id, reason });
    await notifyWorkspace(
      prisma,
      project.workspaceId,
      {
        type: 'scheduled_audit_skipped',
        title: `Scheduled audit skipped for ${project.name}`,
        body: reason,
        link: `/app/p/${project.id}/audits`,
      },
      ['OWNER', 'ADMIN'],
    );
  }
  if (started || skipped.length)
    deps.logger.info({ started, skipped: skipped.length }, 'Scheduled audits processed');
  return { started, skipped };
}

// ---------------- Scheduled AI visibility checks ----------------

export async function runScheduledVisibility(
  deps: SchedulerDeps,
): Promise<{ runs: number; prompts: number; skipped: SkippedItem[] }> {
  const { prisma } = deps;
  const now = deps.now?.() ?? new Date();
  const due = await prisma.aiPrompt.findMany({
    where: { status: 'ACTIVE', frequency: { not: 'MANUAL' }, nextRunAt: { lte: now } },
    select: {
      id: true,
      projectId: true,
      providers: true,
      frequency: true,
      nextRunAt: true,
      project: { select: { id: true, name: true, workspaceId: true } },
    },
    orderBy: { nextRunAt: 'asc' },
    take: 500,
  });
  const byProject = new Map<string, typeof due>();
  for (const prompt of due)
    byProject.set(prompt.projectId, [...(byProject.get(prompt.projectId) ?? []), prompt]);

  let runs = 0;
  let promptCount = 0;
  const skipped: SkippedItem[] = [];
  for (const [projectId, prompts] of byProject) {
    const project = prompts[0]!.project;
    // A run already in progress (for example a manual one) is not interrupted; these prompts stay
    // due and are picked up by the next tick.
    const active = await prisma.aiVisibilityRun.findFirst({
      where: { projectId, status: { in: ['QUEUED', 'RUNNING'] } },
      select: { id: true },
    });
    if (active) continue;

    const { limits } = await getWorkspacePlan(prisma, project.workspaceId);
    const claimedIds: string[] = [];
    let checks = 0;
    let reason: string | null = null;
    for (const prompt of prompts) {
      const claimed = await prisma.aiPrompt.updateMany({
        where: { id: prompt.id, nextRunAt: prompt.nextRunAt },
        data: { nextRunAt: nextPromptRun(prompt.frequency, now) },
      });
      if (claimed.count === 0) continue;
      if (!isFrequencyAllowed(limits, prompt.frequency)) {
        reason = `The workspace plan does not include ${prompt.frequency.toLowerCase()} checks.`;
        continue;
      }
      const providers = (Array.isArray(prompt.providers) ? prompt.providers : []).filter(
        (p): p is VisibilityProviderKey => (VISIBILITY_PROVIDER_KEYS as readonly unknown[]).includes(p),
      );
      const unconfigured = providers.find((key) => !getVisibilityProvider(key).status().configured);
      if (unconfigured) {
        reason = `${getVisibilityProvider(unconfigured).meta.label} is not configured on this server.`;
        continue;
      }
      claimedIds.push(prompt.id);
      checks += providers.length;
    }
    if (claimedIds.length > 0) {
      try {
        const { run, job } = await withWorkspaceLock(prisma, project.workspaceId, async (tx) => {
          await assertMonthlyQuota(tx, project.workspaceId, 'VISIBILITY_CHECK', checks);
          const run = await tx.aiVisibilityRun.create({
            data: { projectId, trigger: 'SCHEDULED', promptCount: claimedIds.length },
          });
          const job = await createJobRecord(tx, {
            type: 'VISIBILITY_RUN',
            queue: 'visibility',
            workspaceId: project.workspaceId,
            projectId,
            entityType: 'AiVisibilityRun',
            entityId: run.id,
            payload: { runId: run.id, promptIds: claimedIds, plannedChecks: checks, trigger: 'SCHEDULED' },
            maxAttempts: 2,
            message: 'Queued (scheduled)',
          });
          return { run, job };
        });
        await enqueueJobRecord(prisma, deps.queues, job, 'visibility', {
          backgroundJobId: job.id,
          runId: run.id,
        });
        runs += 1;
        promptCount += claimedIds.length;
      } catch (error) {
        reason = errorMessage(error);
      }
    }
    if (reason) {
      skipped.push({ id: projectId, reason });
      await notifyWorkspace(
        prisma,
        project.workspaceId,
        {
          type: 'scheduled_visibility_skipped',
          title: `Some scheduled AI visibility checks were skipped for ${project.name}`,
          body: reason,
          link: `/app/p/${projectId}/visibility`,
        },
        ['OWNER', 'ADMIN'],
      );
    }
  }
  if (runs || skipped.length)
    deps.logger.info(
      { runs, prompts: promptCount, skipped: skipped.length },
      'Scheduled visibility checks processed',
    );
  return { runs, prompts: promptCount, skipped };
}

// ---------------- Daily Search Console and Business Profile sync ----------------

export async function queueIntegrationSyncs(deps: SchedulerDeps): Promise<{ queued: number }> {
  const { prisma } = deps;
  const now = deps.now?.() ?? new Date();
  const staleBefore = new Date(now.getTime() - 20 * 3600 * 1000);
  const integrations = await prisma.integration.findMany({
    where: {
      provider: { in: ['GOOGLE_SEARCH_CONSOLE', 'GOOGLE_BUSINESS_PROFILE', 'GOOGLE_MERCHANT_CENTER'] },
      status: 'CONNECTED',
      OR: [{ lastSyncAt: null }, { lastSyncAt: { lt: staleBefore } }],
    },
    include: { project: { select: { workspaceId: true } } },
    take: 500,
  });
  let queued = 0;
  for (const integration of integrations) {
    if (integration.provider === 'GOOGLE_BUSINESS_PROFILE') {
      // Daily, so stored Business Profile data never gets close to Google's 30-day storage limit.
      const linked = await prisma.businessLocation.count({
        where: { projectId: integration.projectId, archivedAt: null, profileLocationName: { not: null } },
      });
      if (!linked) continue;
    } else if (integration.provider === 'GOOGLE_MERCHANT_CENTER') {
      if (!(integration.config as { accountId?: unknown } | null)?.accountId) continue;
    } else {
      const siteUrl = (integration.config as { siteUrl?: unknown } | null)?.siteUrl;
      if (typeof siteUrl !== 'string' || !siteUrl) continue;
    }
    const pending = await prisma.backgroundJob.findFirst({
      where: { type: 'INTEGRATION_SYNC', entityId: integration.id, status: { in: ['QUEUED', 'RUNNING'] } },
      select: { id: true },
    });
    if (pending) continue;
    const job = await createJobRecord(prisma, {
      type: 'INTEGRATION_SYNC',
      queue: 'integration-sync',
      workspaceId: integration.project.workspaceId,
      projectId: integration.projectId,
      entityType: 'Integration',
      entityId: integration.id,
      payload: { integrationId: integration.id, trigger: 'SCHEDULED' },
      message: 'Queued (daily sync)',
    });
    await enqueueJobRecord(prisma, deps.queues, job, 'integration-sync', {
      backgroundJobId: job.id,
      integrationId: integration.id,
    });
    queued += 1;
  }
  return { queued };
}

// ---------------- Weekly summary email ----------------

const pct = (part: number, whole: number) => `${Math.round((part / whole) * 100)}%`;

/** Plain-language lines for one project, built only from data recorded in the last 7 days. */
async function projectSummaryLines(
  prisma: PrismaClient,
  project: Pick<Project, 'id' | 'name' | 'domain' | 'isDemo'>,
  since: Date,
): Promise<string[]> {
  const label = `${project.name} (${project.domain})${project.isDemo ? ' [demo data]' : ''}`;
  const [audits, openIssues, newIssues, observations, mentioned, cited] = await Promise.all([
    prisma.auditRun.findMany({
      where: { projectId: project.id, status: 'SUCCEEDED', score: { not: null } },
      orderBy: { finishedAt: 'desc' },
      take: 2,
      select: { score: true, finishedAt: true },
    }),
    prisma.auditIssue.count({ where: { projectId: project.id, status: 'OPEN' } }),
    prisma.auditIssue.count({ where: { projectId: project.id, firstDetectedAt: { gte: since } } }),
    prisma.aiVisibilityObservation.count({
      where: { projectId: project.id, status: 'SUCCEEDED', observedAt: { gte: since } },
    }),
    prisma.aiVisibilityObservation.count({
      where: { projectId: project.id, status: 'SUCCEEDED', observedAt: { gte: since }, brandMentioned: true },
    }),
    prisma.aiVisibilityObservation.count({
      where: { projectId: project.id, status: 'SUCCEEDED', observedAt: { gte: since }, brandCited: true },
    }),
  ]);
  const lines: string[] = [];
  const latest = audits[0];
  if (latest?.finishedAt && latest.finishedAt >= since) {
    const previous = audits[1];
    const delta = previous?.score != null && latest.score != null ? latest.score - previous.score : null;
    const change = delta === null ? '' : ` (${delta >= 0 ? '+' : ''}${delta} since the previous audit)`;
    lines.push(
      `${label}: site health index ${latest.score}/100${change}; ${openIssues} open issues, ${newIssues} first detected this week.`,
    );
  } else if (openIssues > 0) {
    lines.push(`${label}: no audit ran this week; ${openIssues} issues are still open.`);
  }
  if (observations > 0) {
    lines.push(
      `${label}: your brand was mentioned in ${mentioned} of ${observations} successful AI answers (${pct(mentioned, observations)}) and an owned page was cited in ${cited} (${pct(cited, observations)}).`,
    );
  }
  return lines;
}

/**
 * Sends one summary per opted-in, verified user covering up to 10 projects. Users who received a
 * summary in the last 6 days are skipped, so a retried job does not send duplicates.
 */
export async function sendWeeklySummaries(deps: SchedulerDeps): Promise<{ sent: number; skipped: number }> {
  const { prisma } = deps;
  const now = deps.now?.() ?? new Date();
  const since = new Date(now.getTime() - 7 * 24 * 3600 * 1000);
  const recentCutoff = new Date(now.getTime() - 6 * 24 * 3600 * 1000);
  const env = getEnv();
  let sent = 0;
  let skipped = 0;
  let cursor: string | undefined;
  for (;;) {
    const users = await prisma.user.findMany({
      where: { emailVerifiedAt: { not: null }, disabledAt: null, deletionRequestedAt: null },
      select: { id: true, name: true, email: true, notificationPrefs: true },
      orderBy: { id: 'asc' },
      take: 200,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (users.length === 0) break;
    cursor = users[users.length - 1]!.id;
    for (const user of users) {
      const prefs = notificationPrefsSchema.partial().safeParse(user.notificationPrefs ?? {});
      const weekly =
        (prefs.success ? prefs.data.weeklySummary : undefined) ?? DEFAULT_NOTIFICATION_PREFS.weeklySummary;
      if (!weekly) continue;
      const already = await prisma.emailDelivery.findFirst({
        where: { userId: user.id, template: 'weekly_summary', createdAt: { gte: recentCutoff } },
        select: { id: true },
      });
      if (already) {
        skipped += 1;
        continue;
      }
      const projects = await prisma.project.findMany({
        where: { workspace: { members: { some: { userId: user.id } } } },
        select: { id: true, name: true, domain: true, isDemo: true },
        orderBy: { createdAt: 'asc' },
        take: 10,
      });
      const lines = (await Promise.all(projects.map((p) => projectSummaryLines(prisma, p, since)))).flat();
      if (lines.length === 0) continue;
      await queueEmail(prisma, deps.queues, {
        to: user.email,
        userId: user.id,
        template: 'weekly_summary',
        data: { name: user.name, lines, url: `${env.APP_URL}/app` },
      });
      sent += 1;
    }
  }
  deps.logger.info({ sent, skipped }, 'Weekly summaries processed');
  return { sent, skipped };
}
