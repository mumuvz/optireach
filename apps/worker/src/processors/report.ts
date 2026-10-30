import { errorMessage } from '@surfaced/core/errors';
import type { ReportJobData } from '@surfaced/core/queue';
import { executeReportJob } from '@surfaced/core/reports';
import type { Job } from 'bullmq';
import { runTracked, type WorkerContext } from '../runtime';

export function reportProcessor(ctx: WorkerContext) {
  return async (job: Job<ReportJobData>) =>
    runTracked(
      ctx,
      job,
      (tracker) => executeReportJob({ prisma: ctx.prisma, queues: ctx.queues }, job.data.reportId, tracker),
      async (error) => {
        await ctx.prisma.report.update({
          where: { id: job.data.reportId },
          data: { status: 'FAILED', errorMessage: errorMessage(error).slice(0, 2000) },
        });
      },
    );
}
