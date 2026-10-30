import { UnsafeTargetError } from '@surfaced/core/crawler';
import { getLogger } from '@surfaced/core/logger';
import { MemoryQueueGateway } from '@surfaced/core/queue';
import { UnrecoverableError, type Job } from 'bullmq';
import { describe, expect, it } from 'vitest';
import { maintenanceProcessor } from '../src/processors/maintenance';
import { isPermanentError, type WorkerContext } from '../src/runtime';

const ctx: WorkerContext = {
  prisma: {} as WorkerContext['prisma'],
  queues: new MemoryQueueGateway(),
  logger: getLogger('worker-test'),
};
const job = (task: string) => ({ data: { task } }) as unknown as Job<{ task: 'stuck-jobs' }>;

describe('maintenance processor', () => {
  it('dispatches scheduled tasks registered by the worker', async () => {
    const calls: string[] = [];
    const processor = maintenanceProcessor(ctx, {
      'weekly-summary': async () => {
        calls.push('weekly-summary');
        return { sent: 2 };
      },
      'account-deletions': async () => ({ deleted: 0, deferred: [] }),
    });
    await expect(processor(job('weekly-summary'))).resolves.toEqual({ sent: 2 });
    await expect(processor(job('account-deletions'))).resolves.toEqual({ deleted: 0, deferred: [] });
    expect(calls).toEqual(['weekly-summary']);
  });

  it('skips unknown tasks instead of failing the queue', async () => {
    await expect(maintenanceProcessor(ctx)(job('not-a-task'))).resolves.toEqual({ skipped: true });
  });
});

describe('permanent errors', () => {
  it('treats SSRF policy violations and unrecoverable errors as non-retryable', () => {
    expect(isPermanentError(new UnsafeTargetError('PRIVATE_ADDRESS', 'Private address'))).toBe(true);
    expect(isPermanentError(new UnrecoverableError('stop'))).toBe(true);
    expect(isPermanentError(new Error('ECONNRESET'))).toBe(false);
  });
});
