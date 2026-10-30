import { errorMessage } from '@surfaced/core/errors';
import type { TrendJobData } from '@surfaced/core/queue';
import { executeTrendReport } from '@surfaced/core/trends';
import type { Job } from 'bullmq';
import { runTracked, type WorkerContext } from '../runtime';

/** Keyword trends reports: fetch from the report's provider (unless imported or cached), then compare with the site. */
export function trendsProcessor(ctx: WorkerContext) {
  return async (job: Job<TrendJobData>) => {
    const reportId = job.data.trendReportId;
    return runTracked(
      ctx,
      job,
      async (tracker) => {
        await tracker.progress(10, 'Fetching Google Trends data and checking your pages', true);
        return executeTrendReport(ctx.prisma, reportId, { backgroundJobId: job.data.backgroundJobId });
      },
      async (error) => {
        await ctx.prisma.trendReport.update({
          where: { id: reportId },
          data: {
            status: 'FAILED',
            errorMessage: errorMessage(error).slice(0, 2000),
            finishedAt: new Date(),
          },
        });
      },
    );
  };
}
