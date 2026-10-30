// Periodic housekeeping (stuck-job reconciliation, expiry cleanup) plus the scheduled tasks the
// worker passes in (scheduled audits and visibility checks, weekly summaries, daily syncs).
import { purgeExpiredProfileData } from '@surfaced/core/local';
import type { QueueName } from '@surfaced/core/queue';
import type { MaintenanceJobData } from '@surfaced/core/queue';
import type { Job } from 'bullmq';
import type { WorkerContext } from '../runtime';

/** A RUNNING job whose heartbeat is older than this, and that BullMQ no longer runs, is considered stuck. */
const STUCK_AFTER_MS = 15 * 60 * 1000;
/** A QUEUED job that is unknown to BullMQ after this long was lost (e.g. Redis was flushed). */
const LOST_AFTER_MS = 60 * 60 * 1000;

export async function reconcileStuckJobs(ctx: WorkerContext): Promise<{ failed: number }> {
  const now = Date.now();
  const candidates = await ctx.prisma.backgroundJob.findMany({
    where: {
      OR: [
        { status: 'RUNNING', heartbeatAt: { lt: new Date(now - STUCK_AFTER_MS) } },
        { status: 'QUEUED', createdAt: { lt: new Date(now - LOST_AFTER_MS) } },
      ],
    },
    take: 200,
  });
  let failed = 0;
  for (const job of candidates) {
    const state = await ctx.queues.getState(job.queueName as QueueName, job.id).catch(() => 'unknown');
    if (
      state === 'active' ||
      state === 'waiting' ||
      state === 'delayed' ||
      state === 'prioritized' ||
      state === 'unknown'
    )
      continue;
    const message =
      job.status === 'RUNNING'
        ? 'The worker stopped responding while processing this job. Please start it again.'
        : 'This job was lost from the queue before it started. Please start it again.';
    await ctx.prisma.backgroundJob.update({
      where: { id: job.id },
      data: { status: 'FAILED', error: message, finishedAt: new Date() },
    });
    if (job.entityType === 'CrawlJob' && job.entityId) {
      await ctx.prisma.crawlJob.updateMany({
        where: { id: job.entityId, status: { in: ['QUEUED', 'RUNNING'] } },
        data: { status: 'FAILED', errorMessage: message, finishedAt: new Date() },
      });
      await ctx.prisma.auditRun.updateMany({
        where: { crawlJobId: job.entityId, status: { in: ['QUEUED', 'RUNNING'] } },
        data: { status: 'FAILED', errorMessage: message, finishedAt: new Date() },
      });
    }
    // A report left "queued" or "running" would block every later trends report of its project.
    if (job.entityType === 'TrendReport' && job.entityId) {
      await ctx.prisma.trendReport.updateMany({
        where: { id: job.entityId, status: { in: ['QUEUED', 'RUNNING'] } },
        data: { status: 'FAILED', errorMessage: message, finishedAt: new Date() },
      });
    }
    if (job.entityType === 'LocalRankScan' && job.entityId) {
      await ctx.prisma.localRankScan.updateMany({
        where: { id: job.entityId, status: { in: ['QUEUED', 'RUNNING'] }, source: { not: 'MANUAL' } },
        data: { status: 'FAILED', errorMessage: message, finishedAt: new Date() },
      });
    }
    if (job.entityType === 'AuditRun' && job.entityId) {
      await ctx.prisma.auditRun.updateMany({
        where: { id: job.entityId, status: { in: ['QUEUED', 'RUNNING'] } },
        data: { status: 'FAILED', errorMessage: message, finishedAt: new Date() },
      });
    }
    failed += 1;
  }
  if (failed) ctx.logger.warn({ failed }, 'Marked stuck or lost jobs as failed');
  return { failed };
}

export async function cleanupExpired(ctx: WorkerContext) {
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 3600 * 1000);
  const [sessions, tokens, states] = await Promise.all([
    ctx.prisma.session.deleteMany({ where: { expiresAt: { lt: now } } }),
    ctx.prisma.userToken.deleteMany({
      where: { OR: [{ expiresAt: { lt: weekAgo } }, { usedAt: { lt: weekAgo } }] },
    }),
    ctx.prisma.oAuthState.deleteMany({ where: { expiresAt: { lt: now } } }),
  ]);
  // Expired anonymous audits: remove their crawl data (pages and links cascade from the crawl job).
  const expired = await ctx.prisma.publicAudit.findMany({
    where: { expiresAt: { lt: now } },
    select: { id: true, crawlJobId: true },
    take: 500,
  });
  const crawlIds = expired.map((a) => a.crawlJobId).filter((id): id is string => Boolean(id));
  await ctx.prisma.publicAudit.deleteMany({ where: { id: { in: expired.map((a) => a.id) } } });
  if (crawlIds.length)
    await ctx.prisma.crawlJob.deleteMany({ where: { id: { in: crawlIds }, projectId: null } });
  // Development billing has no provider to end subscriptions, so apply scheduled cancellations here.
  const devEnded = await ctx.prisma.subscription.updateMany({
    where: {
      provider: 'DEV',
      cancelAtPeriodEnd: true,
      status: { not: 'CANCELED' },
      currentPeriodEnd: { lt: now },
    },
    data: { status: 'CANCELED', canceledAt: now },
  });
  // Trends provider request outcomes are kept for 90 days (provider status shows the latest ones).
  const trendEvents = await ctx.prisma.trendProviderEvent.deleteMany({
    where: { createdAt: { lt: new Date(now.getTime() - 90 * 24 * 3600 * 1000) } },
  });
  // Google allows Business Profile content to be stored for at most 30 days.
  const profileData = await purgeExpiredProfileData(ctx.prisma, now);
  return {
    trendProviderEvents: trendEvents.count,
    businessProfile: profileData,
    sessions: sessions.count,
    tokens: tokens.count,
    oauthStates: states.count,
    publicAudits: expired.length,
    devSubscriptionsEnded: devEnded.count,
  };
}

export function maintenanceProcessor(
  ctx: WorkerContext,
  scheduled: Record<string, () => Promise<unknown>> = {},
) {
  return async (job: Job<MaintenanceJobData>) => {
    switch (job.data.task) {
      case 'stuck-jobs':
        return reconcileStuckJobs(ctx);
      case 'cleanup':
        return cleanupExpired(ctx);
      default: {
        const task = scheduled[job.data.task];
        if (!task) {
          ctx.logger.warn({ task: job.data.task }, 'Unknown maintenance task');
          return { skipped: true };
        }
        return task();
      }
    }
  };
}
