// Queue names, typed payloads and an injectable gateway. The API only ever enqueues through a
// QueueGateway so tests can swap in MemoryQueueGateway; the worker consumes the same queue names.
import { Queue, type JobsOptions } from 'bullmq';
import { getEnv } from '../env';
import { createRedisConnection, type Redis } from '../redis';

export const QUEUE_NAMES = {
  crawl: 'crawl',
  audit: 'audit',
  visibility: 'visibility',
  content: 'content',
  competitor: 'competitor',
  /** Keyword trends reports: provider fetches are slow and rate-limited, so they have their own queue. */
  trends: 'trends',
  /** Local rank grid scans (one provider request per grid point). */
  local: 'local',
  report: 'report',
  integrationSync: 'integration-sync',
  email: 'email',
  maintenance: 'maintenance',
} as const;
export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];
export const ALL_QUEUES = Object.values(QUEUE_NAMES) as QueueName[];

/** Every job carries the id of its persistent BackgroundJob record (also used as the BullMQ job id). */
export interface BaseJobData {
  backgroundJobId: string;
}

export interface CrawlJobData extends BaseJobData {
  crawlJobId: string;
}
export interface AuditJobData extends BaseJobData {
  crawlJobId: string;
  auditRunId?: string;
  publicAuditId?: string;
}
export interface VisibilityJobData extends BaseJobData {
  runId: string;
}
export interface ContentJobData extends BaseJobData {
  /** 'trend_report' only for jobs queued before trends had their own queue. */
  kind: 'content_generation' | 'keyword_suggestions' | 'brief_ideas' | 'answerability' | 'trend_report';
  trendReportId?: string;
}
export interface TrendJobData extends BaseJobData {
  trendReportId: string;
}
export interface LocalJobData extends BaseJobData {
  scanId: string;
  /** Set for a batch collection run: the run it belongs to (a newer run, after pause/resume, supersedes it). */
  collectionRunId?: string;
}
/** The competitor queue runs public-page snapshots, competitor gap analyses and SEO comparisons. */
export type CompetitorJobData = BaseJobData &
  ({ snapshotId: string } | { gapAnalysisId: string } | { seoComparisonId: string });
export interface ReportJobData extends BaseJobData {
  reportId: string;
}
export interface IntegrationSyncJobData extends BaseJobData {
  integrationId: string;
}
export interface EmailJobData extends BaseJobData {
  deliveryId: string;
  /** AES-256-GCM encrypted RenderedEmail (may contain single-use links; never stored in MySQL). */
  encryptedMessage: string;
}
export interface MaintenanceJobData {
  task:
    | 'stuck-jobs'
    | 'cleanup'
    | 'scheduled-visibility'
    | 'scheduled-trends'
    | 'scheduled-local-ranks'
    | 'scheduled-local-posts'
    | 'scheduled-audits'
    | 'weekly-summary'
    | 'integration-sync'
    | 'account-deletions';
}

export interface QueuePayloads {
  crawl: CrawlJobData;
  audit: AuditJobData;
  visibility: VisibilityJobData;
  content: ContentJobData;
  competitor: CompetitorJobData;
  trends: TrendJobData;
  local: LocalJobData;
  report: ReportJobData;
  'integration-sync': IntegrationSyncJobData;
  email: EmailJobData;
  maintenance: MaintenanceJobData;
}

export interface EnqueueOptions {
  attempts?: number;
  delayMs?: number;
  priority?: number;
  /** Base delay for exponential backoff between attempts. */
  backoffMs?: number;
}

export interface QueueGateway {
  enqueue<Q extends QueueName>(
    queue: Q,
    jobId: string,
    data: QueuePayloads[Q],
    opts?: EnqueueOptions,
  ): Promise<void>;
  /** Removes a job that has not started yet. Returns true when something was removed. */
  remove(queue: QueueName, jobId: string): Promise<boolean>;
  /** BullMQ job state, or null if unknown (used for stuck-job reconciliation). */
  getState(queue: QueueName, jobId: string): Promise<string | null>;
  /** Moves a failed job back to waiting with a fresh attempt budget. Returns false if it is not in the failed set. */
  retry(queue: QueueName, jobId: string): Promise<boolean>;
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

/** Default job options: bounded retention so Redis does not grow without limit. */
export function defaultJobOptions(opts: EnqueueOptions = {}): JobsOptions {
  return {
    attempts: opts.attempts ?? 3,
    backoff: { type: 'exponential', delay: opts.backoffMs ?? 5000 },
    delay: opts.delayMs,
    priority: opts.priority,
    removeOnComplete: { age: 24 * 3600, count: 2000 },
    removeOnFail: { age: 14 * 24 * 3600, count: 5000 },
  };
}

export class BullQueueGateway implements QueueGateway {
  private readonly queues = new Map<QueueName, Queue>();
  private readonly connection: Redis;
  private readonly prefix: string;

  constructor(connection?: Redis) {
    this.connection = connection ?? createRedisConnection('producer');
    this.prefix = getEnv().QUEUE_PREFIX;
  }

  queue(name: QueueName): Queue {
    let queue = this.queues.get(name);
    if (!queue) {
      queue = new Queue(name, { connection: this.connection, prefix: this.prefix });
      this.queues.set(name, queue);
    }
    return queue;
  }

  async enqueue<Q extends QueueName>(
    name: Q,
    jobId: string,
    data: QueuePayloads[Q],
    opts?: EnqueueOptions,
  ): Promise<void> {
    await this.queue(name).add(name, data, { ...defaultJobOptions(opts), jobId });
  }

  async remove(name: QueueName, jobId: string): Promise<boolean> {
    const job = await this.queue(name).getJob(jobId);
    if (!job) return false;
    const state = await job.getState();
    if (state !== 'waiting' && state !== 'delayed' && state !== 'prioritized' && state !== 'waiting-children')
      return false;
    await job.remove();
    return true;
  }

  async getState(name: QueueName, jobId: string): Promise<string | null> {
    const job = await this.queue(name).getJob(jobId);
    if (!job) return null;
    return job.getState();
  }

  async retry(name: QueueName, jobId: string): Promise<boolean> {
    const job = await this.queue(name).getJob(jobId);
    if (!job || (await job.getState()) !== 'failed') return false;
    await job.retry('failed', { resetAttemptsMade: true, resetAttemptsStarted: true });
    return true;
  }

  async ping(): Promise<boolean> {
    try {
      return (await this.connection.ping()) === 'PONG';
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await Promise.all([...this.queues.values()].map((q) => q.close()));
    this.queues.clear();
    await this.connection.quit().catch(() => this.connection.disconnect());
  }
}

export interface MemoryQueuedJob {
  queue: QueueName;
  jobId: string;
  data: unknown;
  opts?: EnqueueOptions;
}

/** In-memory gateway for tests: records enqueued jobs instead of talking to Redis. */
export class MemoryQueueGateway implements QueueGateway {
  readonly jobs: MemoryQueuedJob[] = [];
  /** Job ids that tests mark as failed in "Redis", so retry() can find them. */
  readonly failed = new Map<string, MemoryQueuedJob>();
  failNext = false;

  async enqueue<Q extends QueueName>(
    queue: Q,
    jobId: string,
    data: QueuePayloads[Q],
    opts?: EnqueueOptions,
  ): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('Simulated queue outage');
    }
    this.jobs.push({ queue, jobId, data, opts });
  }

  async remove(queue: QueueName, jobId: string): Promise<boolean> {
    const index = this.jobs.findIndex((j) => j.queue === queue && j.jobId === jobId);
    if (index === -1) return false;
    this.jobs.splice(index, 1);
    return true;
  }

  async getState(queue: QueueName, jobId: string): Promise<string | null> {
    return this.jobs.some((j) => j.queue === queue && j.jobId === jobId) ? 'waiting' : null;
  }

  async retry(queue: QueueName, jobId: string): Promise<boolean> {
    const job = this.failed.get(jobId);
    if (!job || job.queue !== queue) return false;
    this.failed.delete(jobId);
    this.jobs.push(job);
    return true;
  }

  async ping(): Promise<boolean> {
    return true;
  }

  async close(): Promise<void> {
    this.jobs.length = 0;
    this.failed.clear();
  }

  /** Removes and returns all jobs for a queue (lets tests run processors manually). */
  drain(queue: QueueName): MemoryQueuedJob[] {
    const taken = this.jobs.filter((j) => j.queue === queue);
    for (const job of taken) this.jobs.splice(this.jobs.indexOf(job), 1);
    return taken;
  }
}
