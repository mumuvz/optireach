import { errorMessage } from '@surfaced/core/errors';
import { executeLocalRankScan, runLocalCollection } from '@surfaced/core/local';
import type { LocalJobData } from '@surfaced/core/queue';
import type { Job } from 'bullmq';
import { runTracked, type WorkerContext } from '../runtime';

/**
 * Local rank scans: one provider request per grid point, then the summary and local competitors. A job carrying a
 * collection run ID is an automatic batch collection instead (batch after batch until its target or the source ends).
 */
export function localProcessor(ctx: WorkerContext) {
  return async (job: Job<LocalJobData>) => {
    const scanId = job.data.scanId;
    const runId = job.data.collectionRunId;
    if (runId)
      return runTracked(
        ctx,
        job,
        async (tracker) => {
          await tracker.progress(1, 'Collecting batches', true);
          return runLocalCollection(ctx.prisma, scanId, {
            runId,
            backgroundJobId: job.data.backgroundJobId,
            onProgress: ({ batches, state }) =>
              tracker.progress(
                Math.min(95, 1 + batches),
                state === 'IN_PROGRESS' ? `Collected ${batches} batch${batches === 1 ? '' : 'es'}` : `Collection ${state.toLowerCase().replace('_', ' ')}`, // prettier-ignore
              ),
          });
        },
        async (error) => {
          // An unexpected failure stops this run only; the collection keeps every batch and can be retried.
          await ctx.prisma.localRankScan.updateMany({
            where: { id: scanId, collectionRunId: runId, captureState: 'IN_PROGRESS' },
            data: { captureState: 'FAILED', captureReason: `Stopped by an error: ${errorMessage(error)}`.slice(0, 2000) }, // prettier-ignore
          });
        },
      );
    return runTracked(
      ctx,
      job,
      async (tracker) => {
        await tracker.progress(5, 'Checking grid points', true);
        return executeLocalRankScan(ctx.prisma, scanId, {
          backgroundJobId: job.data.backgroundJobId,
          onProgress: (done, total) =>
            tracker.progress(
              5 + Math.round((90 * done) / Math.max(1, total)),
              `Checked ${done} of ${total} points`,
            ),
        });
      },
      async (error) => {
        await ctx.prisma.localRankScan.update({
          where: { id: scanId },
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
