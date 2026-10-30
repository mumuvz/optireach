import { getLlmProvider } from '@surfaced/core/ai';
import { executeAnswerabilityRun, type AnswerabilityRunPayload } from '@surfaced/core/answerability';
import {
  executeBriefIdeas,
  executeContentGeneration,
  type BriefIdeasPayload,
  type ContentJobPayload,
} from '@surfaced/core/content';
import { errorMessage } from '@surfaced/core/errors';
import { executeKeywordSuggestions, type KeywordSuggestionPayload } from '@surfaced/core/keywords';
import type { ContentJobData } from '@surfaced/core/queue';
import { executeTrendReport } from '@surfaced/core/trends';
import type { Job } from 'bullmq';
import { runTracked, type WorkerContext } from '../runtime';

export function contentProcessor(ctx: WorkerContext) {
  return async (job: Job<ContentJobData>) => {
    const reportId = job.data.trendReportId;
    if (job.data.kind === 'trend_report' && reportId)
      return runTracked(
        ctx,
        job,
        async (tracker) => {
          await tracker.progress(10, 'Reading Google Trends data and checking your pages', true);
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
    if (job.data.kind === 'answerability')
      return runTracked(
        ctx,
        job,
        async (tracker) => {
          await tracker.progress(10, 'Assessing answerability from your page structure', true);
          const record = await ctx.prisma.backgroundJob.findUniqueOrThrow({
            where: { id: job.data.backgroundJobId },
            select: { payload: true },
          });
          const payload = record.payload as unknown as AnswerabilityRunPayload;
          await executeAnswerabilityRun(ctx.prisma, payload.runId, {
            backgroundJobId: job.data.backgroundJobId,
            llm: getLlmProvider(payload.provider ?? undefined),
          });
          return { runId: payload.runId };
        },
        async (error) => {
          const record = await ctx.prisma.backgroundJob.findUnique({
            where: { id: job.data.backgroundJobId },
            select: { payload: true },
          });
          const runId = (record?.payload as { runId?: string } | null)?.runId;
          if (runId)
            await ctx.prisma.answerabilityRun.update({
              where: { id: runId },
              data: {
                status: 'FAILED',
                errorMessage: errorMessage(error).slice(0, 2000),
                finishedAt: new Date(),
              },
            });
        },
      );
    return runTracked(ctx, job, async (tracker) => {
      const record = await ctx.prisma.backgroundJob.findUniqueOrThrow({
        where: { id: job.data.backgroundJobId },
        select: { payload: true },
      });
      const message =
        job.data.kind === 'keyword_suggestions'
          ? 'Generating keyword ideas'
          : job.data.kind === 'brief_ideas'
            ? 'Generating a content brief'
            : 'Generating content';
      await tracker.progress(10, message, true);
      if (job.data.kind === 'keyword_suggestions') {
        const payload = record.payload as unknown as KeywordSuggestionPayload;
        // Run on the provider the request chose (to compare providers), or the server default when none was set.
        return executeKeywordSuggestions(
          ctx.prisma,
          job.data.backgroundJobId,
          payload,
          getLlmProvider(payload.provider ?? undefined),
        );
      }
      if (job.data.kind === 'brief_ideas') {
        const payload = record.payload as unknown as BriefIdeasPayload;
        return executeBriefIdeas(
          ctx.prisma,
          job.data.backgroundJobId,
          payload,
          getLlmProvider(payload.provider ?? undefined),
        );
      }
      return executeContentGeneration(
        ctx.prisma,
        job.data.backgroundJobId,
        record.payload as unknown as ContentJobPayload,
      );
    });
  };
}
