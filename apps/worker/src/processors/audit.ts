import { executeAuditJob, executeCrawlJob } from '@surfaced/core/audit';
import { getEnv } from '@surfaced/core/env';
import { errorMessage } from '@surfaced/core/errors';
import type { AuditJobData, CrawlJobData } from '@surfaced/core/queue';
import type { Job } from 'bullmq';
import { runTracked, type WorkerContext } from '../runtime';

function fetcherOptions() {
  return { allowlist: getEnv().crawlerDevAllowlist };
}

export function crawlProcessor(ctx: WorkerContext) {
  return async (job: Job<CrawlJobData>) => {
    const { crawlJobId } = job.data;
    const outcome = await runTracked(
      ctx,
      job,
      async (tracker) => {
        const result = await executeCrawlJob(
          { prisma: ctx.prisma, queues: ctx.queues, fetcherOptions: fetcherOptions() },
          crawlJobId,
          tracker,
        );
        return result.status === 'cancelled' ? { cancelled: true as const } : result;
      },
      async (error) => {
        const message = `Crawl failed: ${errorMessage(error)}`.slice(0, 2000);
        await ctx.prisma.crawlJob.update({
          where: { id: crawlJobId },
          data: { status: 'FAILED', errorMessage: message, finishedAt: new Date() },
        });
        await ctx.prisma.auditRun.updateMany({
          where: { crawlJobId, status: { in: ['QUEUED', 'RUNNING'] } },
          data: { status: 'FAILED', errorMessage: message, finishedAt: new Date() },
        });
        await ctx.prisma.publicAudit.updateMany({
          where: { crawlJobId },
          data: { status: 'FAILED', errorMessage: message },
        });
      },
    );
    if (outcome.cancelled) {
      await ctx.prisma.crawlJob.updateMany({
        where: { id: crawlJobId, status: { in: ['QUEUED', 'RUNNING'] } },
        data: { status: 'CANCELLED', finishedAt: new Date() },
      });
      await ctx.prisma.auditRun.updateMany({
        where: { crawlJobId, status: { in: ['QUEUED', 'RUNNING'] } },
        data: { status: 'CANCELLED', finishedAt: new Date() },
      });
    }
    return outcome;
  };
}

export function auditProcessor(ctx: WorkerContext) {
  return async (job: Job<AuditJobData>) =>
    runTracked(
      ctx,
      job,
      (tracker) => executeAuditJob({ prisma: ctx.prisma, queues: ctx.queues }, job.data, tracker),
      async (error) => {
        const message = `Audit analysis failed: ${errorMessage(error)}`.slice(0, 2000);
        if (job.data.auditRunId) {
          await ctx.prisma.auditRun.update({
            where: { id: job.data.auditRunId },
            data: { status: 'FAILED', errorMessage: message, finishedAt: new Date() },
          });
        }
        if (job.data.publicAuditId) {
          await ctx.prisma.publicAudit.update({
            where: { id: job.data.publicAuditId },
            data: { status: 'FAILED', errorMessage: message },
          });
        }
      },
    );
}
