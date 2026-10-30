import { UnsafeTargetError } from '@surfaced/core/crawler';
import type { PrismaClient } from '@surfaced/core/db';
import { errorMessage } from '@surfaced/core/errors';
import { JobCancelledError, JobTracker } from '@surfaced/core/jobs';
import { TrendProviderError } from '@surfaced/core/trends';
import { LocalRankProviderError } from '@surfaced/core/local';
import type { Logger } from '@surfaced/core/logger';
import type { QueueGateway } from '@surfaced/core/queue';
import { UnrecoverableError, type Job } from 'bullmq';

export interface WorkerContext {
  prisma: PrismaClient;
  queues: QueueGateway;
  logger: Logger;
}

export interface TrackedOutcome<T> {
  result?: T;
  /** Set when the processor finished by honouring a cancellation request. */
  cancelled?: boolean;
  /** Set when the job record was missing or already cancelled before start. */
  skipped?: boolean;
}

/** Errors that will never succeed on retry. */
export function isPermanentError(error: unknown): boolean {
  return (
    error instanceof UnrecoverableError ||
    error instanceof UnsafeTargetError ||
    // Rate limits, refusals and missing setup: retrying soon would only repeat the request.
    (error instanceof TrendProviderError && error.permanent) ||
    (error instanceof LocalRankProviderError && error.permanent)
  );
}

/**
 * Runs a processor while keeping the persistent BackgroundJob record in sync with BullMQ:
 * attempts, progress/heartbeat (via the tracker), cancellation and final failure.
 */
export async function runTracked<T>(
  ctx: WorkerContext,
  job: Job<{ backgroundJobId: string }>,
  handler: (tracker: JobTracker) => Promise<T | { cancelled: true }>,
  onFinalFailure?: (error: unknown) => Promise<void>,
): Promise<TrackedOutcome<T>> {
  const tracker = new JobTracker(ctx.prisma, job.data.backgroundJobId);
  const attempt = job.attemptsMade + 1;
  const record = await tracker.start(attempt);
  if (!record) return { skipped: true };
  try {
    const result = await handler(tracker);
    if (result && typeof result === 'object' && 'cancelled' in result && result.cancelled === true) {
      await tracker.cancel('Cancelled by request');
      return { cancelled: true };
    }
    await tracker.succeed((result ?? null) as never);
    return { result: result as T };
  } catch (error) {
    if (error instanceof JobCancelledError) {
      await tracker.cancel('Cancelled by request');
      return { cancelled: true };
    }
    const permanent = isPermanentError(error);
    const final = permanent || attempt >= (job.opts.attempts ?? 1);
    ctx.logger.warn(
      { jobId: job.id, queue: job.queueName, attempt, final, err: errorMessage(error) },
      'Job attempt failed',
    );
    await tracker.fail(error, final);
    if (final && onFinalFailure)
      await onFinalFailure(error).catch((e) => ctx.logger.error({ err: e }, 'onFinalFailure hook failed'));
    // Permanent errors must not be retried by BullMQ.
    if (permanent && !(error instanceof UnrecoverableError))
      throw new UnrecoverableError(errorMessage(error));
    throw error;
  }
}
