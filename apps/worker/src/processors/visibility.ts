import { errorMessage } from '@surfaced/core/errors';
import type { VisibilityJobData } from '@surfaced/core/queue';
import { executeVisibilityRun } from '@surfaced/core/visibility';
import type { Job } from 'bullmq';
import { runTracked, type WorkerContext } from '../runtime';

export function visibilityProcessor(ctx: WorkerContext) {
  return async (job: Job<VisibilityJobData>) =>
    runTracked(
      ctx,
      job,
      async (tracker) => {
        const record = await ctx.prisma.backgroundJob.findUniqueOrThrow({
          where: { id: job.data.backgroundJobId },
          select: { payload: true },
        });
        const promptIds = ((record.payload ?? {}) as { promptIds?: string[] }).promptIds ?? null;
        return executeVisibilityRun(ctx.prisma, job.data.runId, promptIds, tracker);
      },
      async (error) => {
        await ctx.prisma.aiVisibilityRun.update({
          where: { id: job.data.runId },
          data: {
            status: 'FAILED',
            errorMessage: `Run failed: ${errorMessage(error)}`.slice(0, 2000),
            finishedAt: new Date(),
          },
        });
      },
    );
}
