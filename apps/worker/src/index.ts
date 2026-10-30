import { processAccountDeletions } from '@surfaced/core/accounts';
import { disconnectPrisma, getPrisma } from '@surfaced/core/db';
import { getEnv } from '@surfaced/core/env';
import { getLogger } from '@surfaced/core/logger';
import { BullQueueGateway, QUEUE_NAMES, type QueueName } from '@surfaced/core/queue';
import { runScheduledTrendRefreshes } from '@surfaced/core/trends';
import { publishDueLocalPosts, runScheduledLocalRankScans } from '@surfaced/core/local';
import { createRedisConnection } from '@surfaced/core/redis';
import {
  queueIntegrationSyncs,
  runScheduledAudits,
  runScheduledVisibility,
  sendWeeklySummaries,
} from '@surfaced/core/scheduling';
import { Worker, type Processor, type WorkerOptions } from 'bullmq';
import { auditProcessor, crawlProcessor } from './processors/audit';
import { competitorProcessor } from './processors/competitor';
import { contentProcessor } from './processors/content';
import { emailProcessor } from './processors/email';
import { integrationSyncProcessor } from './processors/integration';
import { maintenanceProcessor } from './processors/maintenance';
import { reportProcessor } from './processors/report';
import { trendsProcessor } from './processors/trends';
import { localProcessor } from './processors/local';
import { visibilityProcessor } from './processors/visibility';
import type { WorkerContext } from './runtime';

const env = getEnv();
const logger = getLogger('worker');
const prisma = getPrisma();
const queues = new BullQueueGateway();
const ctx: WorkerContext = { prisma, queues, logger };

const schedulerDeps = { prisma, queues, logger: getLogger('scheduler') };
const scheduledTasks = {
  'scheduled-audits': () => runScheduledAudits(schedulerDeps),
  'scheduled-visibility': () => runScheduledVisibility(schedulerDeps),
  'scheduled-trends': () => runScheduledTrendRefreshes(schedulerDeps),
  'scheduled-local-ranks': () => runScheduledLocalRankScans(schedulerDeps),
  'scheduled-local-posts': () => publishDueLocalPosts(schedulerDeps.prisma),
  'weekly-summary': () => sendWeeklySummaries(schedulerDeps),
  'integration-sync': () => queueIntegrationSyncs(schedulerDeps),
  'account-deletions': () => processAccountDeletions(schedulerDeps),
};

interface WorkerSpec {
  queue: QueueName;
  processor: Processor;
  options?: Partial<WorkerOptions>;
}

const specs: WorkerSpec[] = [
  {
    queue: QUEUE_NAMES.crawl,
    processor: crawlProcessor(ctx) as Processor,
    options: { concurrency: 2, lockDuration: 60_000 },
  },
  {
    queue: QUEUE_NAMES.audit,
    processor: auditProcessor(ctx) as Processor,
    // Crawls have no page cap, and the rule engine analyzes a whole crawl in one synchronous pass. The lock must
    // outlast that pass on very large sites, or the job would be retried while it is still running.
    options: { concurrency: 2, lockDuration: 300_000 },
  },
  {
    queue: QUEUE_NAMES.visibility,
    processor: visibilityProcessor(ctx) as Processor,
    // Each run calls providers itself with bounded parallelism; cap concurrent runs and starts per minute.
    options: { concurrency: 2, lockDuration: 120_000, limiter: { max: 30, duration: 60_000 } },
  },
  {
    queue: QUEUE_NAMES.content,
    processor: contentProcessor(ctx) as Processor,
    options: { concurrency: 2, lockDuration: 180_000, limiter: { max: 20, duration: 60_000 } },
  },
  {
    queue: QUEUE_NAMES.competitor,
    processor: competitorProcessor(ctx) as Processor,
    options: { concurrency: 2, lockDuration: 120_000 },
  },
  // Live trends providers are slow and rate-limited (the pytrends service also spaces its own requests to Google).
  {
    queue: QUEUE_NAMES.trends,
    processor: trendsProcessor(ctx) as Processor,
    options: { concurrency: 2, lockDuration: 180_000, limiter: { max: 10, duration: 60_000 } },
  },
  // Each scan makes one provider request per grid point; cap scans started per minute.
  {
    queue: QUEUE_NAMES.local,
    processor: localProcessor(ctx) as Processor,
    options: { concurrency: 2, lockDuration: 180_000, limiter: { max: 20, duration: 60_000 } },
  },
  // PDF rendering launches Chromium; keep report concurrency low.
  {
    queue: QUEUE_NAMES.report,
    processor: reportProcessor(ctx) as Processor,
    options: { concurrency: 1, lockDuration: 180_000 },
  },
  {
    queue: QUEUE_NAMES.integrationSync,
    processor: integrationSyncProcessor(ctx) as Processor,
    options: { concurrency: 2, limiter: { max: 10, duration: 60_000 } },
  },
  { queue: QUEUE_NAMES.email, processor: emailProcessor(ctx) as Processor, options: { concurrency: 5 } },
  {
    queue: QUEUE_NAMES.maintenance,
    processor: maintenanceProcessor(ctx, scheduledTasks) as Processor,
    options: { concurrency: 1 },
  },
];

const workers = specs.map(({ queue, processor, options }) => {
  const worker = new Worker(queue, processor, {
    connection: createRedisConnection('worker'),
    prefix: env.QUEUE_PREFIX,
    concurrency: 1,
    ...options,
  });
  worker.on('failed', (job, error) =>
    logger.warn({ queue, jobId: job?.id, attempts: job?.attemptsMade, err: error.message }, 'Job failed'),
  );
  worker.on('error', (error) => logger.error({ queue, err: error }, 'Worker error'));
  return worker;
});

async function registerSchedulers(): Promise<void> {
  const maintenance = queues.queue(QUEUE_NAMES.maintenance);
  await maintenance.upsertJobScheduler(
    'stuck-jobs',
    { every: 5 * 60 * 1000 },
    { name: 'stuck-jobs', data: { task: 'stuck-jobs' } },
  );
  await maintenance.upsertJobScheduler(
    'cleanup',
    { pattern: '0 15 * * * *', tz: 'UTC' },
    { name: 'cleanup', data: { task: 'cleanup' } },
  );
  // Due audits and prompts are claimed per item, so a 15-minute tick only bounds how late they start.
  await maintenance.upsertJobScheduler(
    'scheduled-audits',
    { every: 15 * 60 * 1000 },
    { name: 'scheduled-audits', data: { task: 'scheduled-audits' } },
  );
  await maintenance.upsertJobScheduler(
    'scheduled-visibility',
    { every: 15 * 60 * 1000 },
    { name: 'scheduled-visibility', data: { task: 'scheduled-visibility' } },
  );
  await maintenance.upsertJobScheduler(
    'scheduled-trends',
    { every: 60 * 60 * 1000 },
    { name: 'scheduled-trends', data: { task: 'scheduled-trends' } },
  );
  await maintenance.upsertJobScheduler(
    'scheduled-local-ranks',
    { every: 60 * 60 * 1000 },
    { name: 'scheduled-local-ranks', data: { task: 'scheduled-local-ranks' } },
  );
  await maintenance.upsertJobScheduler(
    'scheduled-local-posts',
    { every: 5 * 60 * 1000 },
    { name: 'scheduled-local-posts', data: { task: 'scheduled-local-posts' } },
  );
  await maintenance.upsertJobScheduler(
    'integration-sync',
    { pattern: '0 30 3 * * *', tz: 'UTC' },
    { name: 'integration-sync', data: { task: 'integration-sync' } },
  );
  await maintenance.upsertJobScheduler(
    'weekly-summary',
    { pattern: '0 0 8 * * 1', tz: 'UTC' },
    { name: 'weekly-summary', data: { task: 'weekly-summary' } },
  );
  await maintenance.upsertJobScheduler(
    'account-deletions',
    { pattern: '0 0 4 * * *', tz: 'UTC' },
    { name: 'account-deletions', data: { task: 'account-deletions' } },
  );
}

registerSchedulers()
  .then(() => logger.info({ queues: specs.map((s) => s.queue), prefix: env.QUEUE_PREFIX }, 'Worker started'))
  .catch((error) => logger.error({ err: error }, 'Could not register job schedulers'));

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Shutting down worker (waiting for active jobs)');
  const force = setTimeout(() => process.exit(1), 30_000);
  force.unref();
  await Promise.allSettled(workers.map((w) => w.close()));
  await Promise.allSettled([queues.close(), disconnectPrisma()]);
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => logger.error({ err: reason }, 'Unhandled promise rejection'));
