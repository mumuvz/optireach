import {
  executeCompetitorSnapshot,
  executeGapAnalysis,
  executeSeoComparison,
} from '@surfaced/core/competitors';
import { getEnv } from '@surfaced/core/env';
import { errorMessage } from '@surfaced/core/errors';
import type { CompetitorJobData } from '@surfaced/core/queue';
import type { Job } from 'bullmq';
import { runTracked, type WorkerContext } from '../runtime';

export function competitorProcessor(ctx: WorkerContext) {
  return async (job: Job<CompetitorJobData>) => {
    const data = job.data;
    if ('gapAnalysisId' in data)
      return runTracked(
        ctx,
        job,
        (tracker) =>
          executeGapAnalysis(ctx.prisma, data.gapAnalysisId, {
            fetcherOptions: { allowlist: getEnv().crawlerDevAllowlist },
            backgroundJobId: data.backgroundJobId,
            onProgress: (percent, message) => tracker.progress(percent, message),
          }),
        async (error) => {
          await ctx.prisma.visibilityGapAnalysis.update({
            where: { id: data.gapAnalysisId },
            data: {
              status: 'FAILED',
              errorMessage: errorMessage(error).slice(0, 2000),
              finishedAt: new Date(),
            },
          });
        },
      );
    if ('seoComparisonId' in data)
      return runTracked(
        ctx,
        job,
        (tracker) =>
          executeSeoComparison(ctx.prisma, data.seoComparisonId, {
            fetcherOptions: { allowlist: getEnv().crawlerDevAllowlist },
            onProgress: (percent, message) => tracker.progress(percent, message),
          }),
        async (error) => {
          await ctx.prisma.seoComparison.update({
            where: { id: data.seoComparisonId },
            data: {
              status: 'FAILED',
              errorMessage: errorMessage(error).slice(0, 2000),
              finishedAt: new Date(),
            },
          });
        },
      );
    return runTracked(
      ctx,
      job,
      () =>
        executeCompetitorSnapshot(ctx.prisma, data.snapshotId, {
          allowlist: getEnv().crawlerDevAllowlist,
        }),
      async (error) => {
        await ctx.prisma.competitorSnapshot.update({
          where: { id: data.snapshotId },
          data: { status: 'FAILED', errorMessage: errorMessage(error).slice(0, 2000) },
        });
      },
    );
  };
}
