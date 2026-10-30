import { afterAll, describe, expect, it } from 'vitest';
import { disconnectPrisma, getPrisma, parseMysqlUrl } from '../src/db';
import { JobTracker, createJobRecord, enqueueJobRecord, requestJobCancellation, toJobDto } from '../src/jobs';
import { MemoryQueueGateway } from '../src/queue';

afterAll(async () => {
  await disconnectPrisma();
});

describe('parseMysqlUrl', () => {
  it('decodes percent-encoded credentials', () => {
    expect(parseMysqlUrl('mysql://root:Pa%40ss@127.0.0.1:3307/app_test')).toEqual({
      host: '127.0.0.1',
      port: 3307,
      user: 'root',
      password: 'Pa@ss',
      database: 'app_test',
    });
    expect(parseMysqlUrl('mysql://u:p@db/app').port).toBe(3306);
    expect(() => parseMysqlUrl('postgres://u:p@db/app')).toThrow(/mysql/);
    expect(() => parseMysqlUrl('mysql://u:p@db')).toThrow(/database name/);
  });
});

describe('background job records', () => {
  const prisma = getPrisma();

  it('connects to the isolated test database', async () => {
    const rows = await prisma.$queryRaw<{ db: string }[]>`SELECT DATABASE() AS db`;
    expect(rows[0]?.db).toMatch(/_test$/);
  });

  it('creates, enqueues, tracks and completes a job', async () => {
    const gateway = new MemoryQueueGateway();
    const job = await createJobRecord(prisma, {
      type: 'MAINTENANCE',
      queue: 'maintenance',
      payload: { note: 'test' },
    });
    expect(job.status).toBe('QUEUED');

    await enqueueJobRecord(prisma, gateway, job, 'email', {
      backgroundJobId: job.id,
      deliveryId: 'd1',
      encryptedMessage: 'v1.x.y.z',
    });
    expect(gateway.jobs).toHaveLength(1);
    expect(gateway.jobs[0]).toMatchObject({ queue: 'email', jobId: job.id, opts: { attempts: 3 } });

    const tracker = new JobTracker(prisma, job.id, 0);
    const running = await tracker.start(1);
    expect(running?.status).toBe('RUNNING');
    await tracker.progress(42.4, 'Halfway', true);
    await tracker.succeed({ pages: 3 });

    const done = await prisma.backgroundJob.findUniqueOrThrow({ where: { id: job.id } });
    const dto = toJobDto(done);
    expect(dto).toMatchObject({ status: 'SUCCEEDED', progress: 100, result: { pages: 3 }, attempts: 1 });
    expect(dto.finishedAt).not.toBeNull();
  });

  it('marks the record failed when the queue is unavailable', async () => {
    const gateway = new MemoryQueueGateway();
    gateway.failNext = true;
    const job = await createJobRecord(prisma, { type: 'MAINTENANCE', queue: 'maintenance' });
    await expect(
      enqueueJobRecord(prisma, gateway, job, 'maintenance', { task: 'cleanup' }),
    ).rejects.toMatchObject({
      status: 503,
      code: 'SERVICE_UNAVAILABLE',
    });
    const failed = await prisma.backgroundJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(failed.status).toBe('FAILED');
    expect(failed.error).toMatch(/Could not enqueue/);
  });

  it('cancels queued jobs immediately and running jobs cooperatively', async () => {
    const gateway = new MemoryQueueGateway();
    const queued = await createJobRecord(prisma, { type: 'MAINTENANCE', queue: 'maintenance' });
    await enqueueJobRecord(prisma, gateway, queued, 'maintenance', { task: 'cleanup' });
    const cancelled = await requestJobCancellation(prisma, gateway, queued);
    expect(cancelled.status).toBe('CANCELLED');
    expect(gateway.jobs).toHaveLength(0);

    const running = await createJobRecord(prisma, { type: 'MAINTENANCE', queue: 'maintenance' });
    const tracker = new JobTracker(prisma, running.id, 0);
    await tracker.start(1);
    const requested = await requestJobCancellation(prisma, gateway, { ...running, status: 'RUNNING' });
    expect(requested.status).toBe('RUNNING');
    expect(requested.cancelRequestedAt).not.toBeNull();
    await expect(tracker.throwIfCancelled()).rejects.toThrow('Job was cancelled');
    await tracker.cancel();
    const final = await prisma.backgroundJob.findUniqueOrThrow({ where: { id: running.id } });
    expect(final.status).toBe('CANCELLED');

    await expect(requestJobCancellation(prisma, gateway, final)).rejects.toMatchObject({ status: 409 });
  });

  it('keeps a failed attempt queued for retry until the final attempt', async () => {
    const job = await createJobRecord(prisma, { type: 'MAINTENANCE', queue: 'maintenance' });
    const tracker = new JobTracker(prisma, job.id, 0);
    await tracker.start(1);
    await tracker.fail(new Error('transient'), false);
    expect((await prisma.backgroundJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('QUEUED');
    await tracker.start(2);
    await tracker.fail(new Error('permanent'), true);
    const failed = await prisma.backgroundJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(failed).toMatchObject({ status: 'FAILED', attempts: 2, error: 'permanent' });
  });
});
