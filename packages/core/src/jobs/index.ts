// Persistent job records (background_job_records). The BullMQ job id always equals the record id,
// so the API can report status, retries and cancellation even if Redis state is lost.
import type { BackgroundJobType, JobDto } from '@surfaced/shared';
import type { BackgroundJob, Prisma, PrismaClient } from '../db';
import { Errors, errorMessage } from '../errors';
import type { EnqueueOptions, QueueGateway, QueueName, QueuePayloads } from '../queue';

export interface CreateJobParams {
  type: BackgroundJobType;
  queue: QueueName;
  workspaceId?: string | null;
  projectId?: string | null;
  userId?: string | null;
  payload?: Prisma.InputJsonValue;
  entityType?: string;
  entityId?: string;
  maxAttempts?: number;
  message?: string;
}

export function createJobRecord(prisma: PrismaClient | Prisma.TransactionClient, params: CreateJobParams) {
  return prisma.backgroundJob.create({
    data: {
      type: params.type,
      queueName: params.queue,
      workspaceId: params.workspaceId ?? null,
      projectId: params.projectId ?? null,
      userId: params.userId ?? null,
      payload: params.payload,
      entityType: params.entityType,
      entityId: params.entityId,
      maxAttempts: params.maxAttempts ?? 3,
      message: params.message ?? 'Queued',
    },
  });
}

/**
 * Adds an existing job record to its queue. If Redis is unavailable the record is marked FAILED
 * (so nothing is left "queued" forever) and a 503 is raised to the caller.
 */
export async function enqueueJobRecord<Q extends QueueName>(
  prisma: PrismaClient,
  gateway: QueueGateway,
  job: Pick<BackgroundJob, 'id' | 'maxAttempts'>,
  queue: Q,
  data: QueuePayloads[Q],
  opts: EnqueueOptions = {},
): Promise<void> {
  try {
    await gateway.enqueue(queue, job.id, data, { attempts: job.maxAttempts, ...opts });
  } catch (error) {
    await prisma.backgroundJob.update({
      where: { id: job.id },
      data: { status: 'FAILED', error: `Could not enqueue: ${errorMessage(error)}`, finishedAt: new Date() },
    });
    throw Errors.unavailable('The job queue is unavailable. Please try again in a moment.');
  }
}

/** Marks a job for cancellation. Queued jobs are removed from the queue and cancelled immediately. */
export async function requestJobCancellation(
  prisma: PrismaClient,
  gateway: QueueGateway,
  job: Pick<BackgroundJob, 'id' | 'status' | 'queueName'>,
): Promise<BackgroundJob> {
  if (job.status !== 'QUEUED' && job.status !== 'RUNNING') {
    throw Errors.conflict('This job has already finished.');
  }
  const now = new Date();
  if (job.status === 'QUEUED') {
    const removed = await gateway.remove(job.queueName as QueueName, job.id).catch(() => false);
    if (removed) {
      return prisma.backgroundJob.update({
        where: { id: job.id },
        data: {
          status: 'CANCELLED',
          cancelRequestedAt: now,
          finishedAt: now,
          message: 'Cancelled before it started',
        },
      });
    }
  }
  return prisma.backgroundJob.update({
    where: { id: job.id },
    data: { cancelRequestedAt: now, message: 'Cancellation requested' },
  });
}

export class JobCancelledError extends Error {
  constructor() {
    super('Job was cancelled');
    this.name = 'JobCancelledError';
  }
}

/** Worker-side helper that keeps the persistent record in sync with processing. */
export class JobTracker {
  private lastWrite = 0;
  private lastCancelCheck = 0;
  private cancelled = false;

  constructor(
    private readonly prisma: PrismaClient,
    readonly jobId: string,
    private readonly minWriteIntervalMs = 1000,
  ) {}

  async start(attempt: number): Promise<BackgroundJob | null> {
    const job = await this.prisma.backgroundJob.findUnique({ where: { id: this.jobId } });
    if (!job) return null;
    if (job.cancelRequestedAt) {
      await this.cancel('Cancelled before it started');
      return null;
    }
    const now = new Date();
    return this.prisma.backgroundJob.update({
      where: { id: this.jobId },
      data: {
        status: 'RUNNING',
        attempts: attempt,
        startedAt: job.startedAt ?? now,
        heartbeatAt: now,
        message: attempt > 1 ? `Retrying (attempt ${attempt})` : 'Running',
        error: null,
      },
    });
  }

  /** Throttled progress update (0–100). Pass force=true for milestones. */
  async progress(percent: number, message?: string, force = false): Promise<void> {
    const now = Date.now();
    if (!force && now - this.lastWrite < this.minWriteIntervalMs) return;
    this.lastWrite = now;
    await this.prisma.backgroundJob.update({
      where: { id: this.jobId },
      data: {
        progress: Math.max(0, Math.min(100, Math.round(percent))),
        heartbeatAt: new Date(now),
        ...(message ? { message: message.slice(0, 500) } : {}),
      },
    });
  }

  async heartbeat(): Promise<void> {
    await this.prisma.backgroundJob.update({ where: { id: this.jobId }, data: { heartbeatAt: new Date() } });
  }

  /** Checks (at most every 2s) whether cancellation was requested. */
  async isCancelRequested(): Promise<boolean> {
    if (this.cancelled) return true;
    const now = Date.now();
    if (now - this.lastCancelCheck < 2000) return false;
    this.lastCancelCheck = now;
    const job = await this.prisma.backgroundJob.findUnique({
      where: { id: this.jobId },
      select: { cancelRequestedAt: true },
    });
    this.cancelled = Boolean(job?.cancelRequestedAt);
    return this.cancelled;
  }

  async throwIfCancelled(): Promise<void> {
    if (await this.isCancelRequested()) throw new JobCancelledError();
  }

  async succeed(result?: Prisma.InputJsonValue, message = 'Completed'): Promise<void> {
    await this.prisma.backgroundJob.update({
      where: { id: this.jobId },
      data: {
        status: 'SUCCEEDED',
        progress: 100,
        result,
        message,
        finishedAt: new Date(),
        heartbeatAt: new Date(),
      },
    });
  }

  /** Records a failure. When `final` is false the job stays QUEUED for BullMQ's next attempt. */
  async fail(error: unknown, final: boolean): Promise<void> {
    const text = errorMessage(error).slice(0, 4000);
    await this.prisma.backgroundJob.update({
      where: { id: this.jobId },
      data: final
        ? { status: 'FAILED', error: text, message: 'Failed', finishedAt: new Date() }
        : { status: 'QUEUED', error: text, message: 'Waiting to retry' },
    });
  }

  async cancel(message = 'Cancelled'): Promise<void> {
    this.cancelled = true;
    await this.prisma.backgroundJob.update({
      where: { id: this.jobId },
      data: { status: 'CANCELLED', message, finishedAt: new Date() },
    });
  }
}

export function toJobDto(job: BackgroundJob): JobDto {
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    progress: job.progress,
    message: job.message,
    error: job.error,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    entityType: job.entityType,
    entityId: job.entityId,
    result: job.result ?? null,
    cancelRequested: Boolean(job.cancelRequestedAt),
    createdAt: job.createdAt.toISOString(),
    startedAt: job.startedAt?.toISOString() ?? null,
    finishedAt: job.finishedAt?.toISOString() ?? null,
  };
}
