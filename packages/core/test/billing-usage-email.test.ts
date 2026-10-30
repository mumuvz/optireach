import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureDefaultPlans, getWorkspacePlan, listPlans } from '../src/billing';
import { randomToken } from '../src/crypto';
import { disconnectPrisma, getPrisma } from '../src/db';
import { ConsoleEmailProvider, deliverQueuedEmail, queueEmail, renderEmail } from '../src/email';
import { MemoryQueueGateway } from '../src/queue';
import { assertCountLimit, assertMonthlyQuota, getUsageSummary, recordUsage } from '../src/usage';

const prisma = getPrisma();

async function createWorkspace(planKey: string | null) {
  const workspace = await prisma.workspace.create({
    data: { name: 'Test WS', slug: `test-${randomToken(6).toLowerCase()}` },
  });
  if (planKey) {
    const plan = await prisma.subscriptionPlan.findUniqueOrThrow({ where: { key: planKey } });
    await prisma.subscription.create({
      data: { workspaceId: workspace.id, planId: plan.id, status: 'ACTIVE' },
    });
  }
  return workspace;
}

beforeAll(async () => {
  await ensureDefaultPlans(prisma);
});

afterAll(async () => {
  await disconnectPrisma();
});

describe('plans', () => {
  it('seeds the default plans idempotently and lists them in order', async () => {
    await ensureDefaultPlans(prisma);
    const plans = await listPlans(prisma);
    expect(plans.map((p) => p.key)).toEqual(['FREE', 'STARTER', 'GROWTH', 'AGENCY']);
    expect(plans[1]?.priceMonthly).toBe(49);
    expect(plans[3]?.limits.whiteLabelReports).toBe(true);
  });

  it('falls back to Free for canceled or missing subscriptions', async () => {
    const none = await createWorkspace(null);
    expect((await getWorkspacePlan(prisma, none.id)).plan.key).toBe('FREE');

    const growth = await createWorkspace('GROWTH');
    expect((await getWorkspacePlan(prisma, growth.id)).plan.key).toBe('GROWTH');
    await prisma.subscription.update({ where: { workspaceId: growth.id }, data: { status: 'CANCELED' } });
    const after = await getWorkspacePlan(prisma, growth.id);
    expect(after.plan.key).toBe('FREE');
    expect(after.subscription?.status).toBe('CANCELED');
  });
});

describe('usage metering', () => {
  it('records each billable event once', async () => {
    const ws = await createWorkspace('FREE');
    const event = {
      workspaceId: ws.id,
      metric: 'AUDIT_RUN' as const,
      quantity: 1,
      idempotencyKey: `audit:${randomToken(8)}`,
    };
    expect(await recordUsage(prisma, event)).toBe(true);
    expect(await recordUsage(prisma, event)).toBe(false); // retry of the same job
    const summary = await getUsageSummary(prisma, ws.id);
    expect(summary.metrics.find((m) => m.metric === 'AUDIT_RUN')).toMatchObject({ used: 1, limit: 4 });
  });

  it('enforces monthly quotas with a 402 plan-limit error', async () => {
    const ws = await createWorkspace('FREE'); // 4 audits per month
    for (let i = 0; i < 4; i++) {
      await assertMonthlyQuota(prisma, ws.id, 'AUDIT_RUN');
      await recordUsage(prisma, {
        workspaceId: ws.id,
        metric: 'AUDIT_RUN',
        quantity: 1,
        idempotencyKey: `a:${ws.id}:${i}`,
      });
    }
    await expect(assertMonthlyQuota(prisma, ws.id, 'AUDIT_RUN')).rejects.toMatchObject({
      status: 402,
      code: 'PLAN_LIMIT_REACHED',
      details: { metric: 'AUDIT_RUN', limit: 4, used: 4 },
    });
  });

  it('enforces count limits', async () => {
    const ws = await createWorkspace('FREE'); // 1 project
    await expect(assertCountLimit(prisma, ws.id, 'projects', 0)).resolves.toBeDefined();
    await expect(assertCountLimit(prisma, ws.id, 'projects', 1)).rejects.toMatchObject({ status: 402 });
  });
});

describe('email', () => {
  let outDir: string;
  beforeAll(async () => {
    outDir = await mkdtemp(path.join(os.tmpdir(), 'surfaced-mail-'));
  });
  afterAll(async () => {
    await rm(outDir, { recursive: true, force: true });
  });

  it('escapes user-controlled values in templates', () => {
    const email = renderEmail(
      'verify_email',
      { name: '<img src=x onerror=alert(1)>', url: 'https://app.test/v?t=1' },
      'Surfaced',
    );
    expect(email.html).not.toContain('<img src=x');
    expect(email.html).toContain('&lt;img');
    expect(email.text).toContain('https://app.test/v?t=1');
  });

  it('queues encrypted messages and records LOGGED_LOCALLY (never SENT) in console mode', async () => {
    const gateway = new MemoryQueueGateway();
    const deliveryId = await queueEmail(prisma, gateway, {
      to: 'person@example.com',
      template: 'password_reset',
      data: { name: 'Pat', url: 'https://app.test/reset-password?token=SECRET123' },
    });
    const queued = gateway.jobs[0]!;
    expect(queued.queue).toBe('email');
    const payload = queued.data as { encryptedMessage: string };
    expect(payload.encryptedMessage).not.toContain('SECRET123');

    const record = await prisma.backgroundJob.findUniqueOrThrow({ where: { id: queued.jobId } });
    expect(JSON.stringify(record.payload)).not.toContain('SECRET123');

    const result = await deliverQueuedEmail(
      prisma,
      deliveryId,
      payload.encryptedMessage,
      new ConsoleEmailProvider(outDir),
    );
    expect(result.status).toBe('LOGGED_LOCALLY');
    const delivery = await prisma.emailDelivery.findUniqueOrThrow({ where: { id: deliveryId } });
    expect(delivery.status).toBe('LOGGED_LOCALLY');
    expect(delivery.sentAt).toBeNull();
    const eml = await readFile(result.localPath!, 'utf8');
    expect(eml).toContain('person@example.com');

    // A retry after success does not send again.
    const again = await deliverQueuedEmail(
      prisma,
      deliveryId,
      payload.encryptedMessage,
      new ConsoleEmailProvider(outDir),
    );
    expect(again.status).toBe('LOGGED_LOCALLY');
  });
});
