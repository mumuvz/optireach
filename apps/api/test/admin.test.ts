import { randomToken } from '@surfaced/core/crypto';
import { disconnectPrisma } from '@surfaced/core/db';
import { getEnv } from '@surfaced/core/env';
import { DEFAULT_PLANS } from '@surfaced/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { API, DEFAULT_PASSWORD, TestClient, createTestApp, registerClient } from './helpers';

const { app, queues, prisma } = createTestApp();

let admin: Awaited<ReturnType<typeof registerClient>>;
const planKey = `ADMINTEST_${randomToken(6)
  .toUpperCase()
  .replace(/[^A-Z0-9]/g, 'X')}`;

beforeAll(async () => {
  admin = await registerClient(app, { name: 'Platform Admin' });
  await prisma.user.update({ where: { id: admin.me.user.id }, data: { platformRole: 'ADMIN' } });
  const starter = DEFAULT_PLANS.find((p) => p.key === 'STARTER')!;
  // A dedicated inactive plan, so editing it cannot affect other test files running in parallel.
  await prisma.subscriptionPlan.create({
    data: {
      key: planKey,
      name: 'Admin test',
      description: 'Test plan',
      priceMonthly: '1.00',
      priceYearly: '10.00',
      limits: starter.limits,
      features: [],
      isActive: false,
      sortOrder: 999,
    },
  });
});

afterAll(async () => {
  await prisma.subscriptionPlan.deleteMany({ where: { key: planKey } });
  await disconnectPrisma();
});

describe('admin access', () => {
  it('hides the admin area from anonymous users and regular members', async () => {
    expect((await request(app).get(`${API}/admin/overview`)).status).toBe(401);
    const member = await registerClient(app);
    const res = await member.client.get('/admin/overview');
    expect(res.status).toBe(404);
    expect((await member.client.patch(`/admin/plans/${planKey}`, { name: 'Hacked' })).status).toBe(404);
  });

  it('returns platform totals and never exposes secrets in system status', async () => {
    const overview = await admin.client.get('/admin/overview');
    expect(overview.status).toBe(200);
    expect(overview.body.data.users.total).toBeGreaterThanOrEqual(1);
    expect(
      overview.body.data.subscriptions.find((s: { planKey: string }) => s.planKey === 'FREE').total,
    ).toBeGreaterThanOrEqual(1);

    const system = await admin.client.get('/admin/system');
    expect(system.status).toBe(200);
    expect(system.body.data.checks).toMatchObject({ database: true, queue: true });
    const text = JSON.stringify(system.body);
    const env = getEnv();
    for (const secret of [env.SESSION_SECRET, env.ENCRYPTION_KEY]) expect(text).not.toContain(secret);
    expect(
      system.body.data.providers.integrations.find(
        (i: { provider: string }) => i.provider === 'GOOGLE_ANALYTICS_4',
      ).availability,
    ).toBe('planned');
  });
});

describe('user management', () => {
  it('disables a user (signing them out everywhere), records it, and re-enables them', async () => {
    const target = await registerClient(app, { name: 'Target Person' });
    const found = await admin.client.get(`/admin/users?q=${encodeURIComponent(target.email)}`);
    expect(found.body.data).toHaveLength(1);
    expect(found.body.data[0]).toMatchObject({ email: target.email, workspaceCount: 1, disabledAt: null });
    expect(JSON.stringify(found.body)).not.toContain('passwordHash');

    expect((await admin.client.patch(`/admin/users/${target.me.user.id}`, { disabled: true })).status).toBe(
      400,
    );
    const disabled = await admin.client.patch(`/admin/users/${target.me.user.id}`, {
      disabled: true,
      reason: 'Abuse report #12',
    });
    expect(disabled.status).toBe(200);
    expect(disabled.body.data.revokedSessions).toBeGreaterThanOrEqual(1);
    expect((await target.client.get('/auth/me')).status).toBe(401);
    const relogin = await new TestClient(app)
      .init()
      .then((c) => c.post('/auth/login', { email: target.email, password: DEFAULT_PASSWORD }));
    expect(relogin.body.error.code).toBe('ACCOUNT_DISABLED');

    const detail = await admin.client.get(`/admin/users/${target.me.user.id}`);
    expect(detail.body.data).toMatchObject({ disabledReason: 'Abuse report #12', activeSessions: 0 });
    expect(detail.body.data.memberships[0].role).toBe('OWNER');

    const logs = await admin.client.get(
      `/admin/audit-logs?action=admin.user_disabled&actorUserId=${admin.me.user.id}`,
    );
    expect(logs.body.data.some((l: { targetId: string }) => l.targetId === target.me.user.id)).toBe(true);

    expect((await admin.client.patch(`/admin/users/${target.me.user.id}`, { disabled: false })).status).toBe(
      200,
    );
    const login = await new TestClient(app)
      .init()
      .then((c) => c.post('/auth/login', { email: target.email, password: DEFAULT_PASSWORD }));
    expect(login.status).toBe(200);
  });

  it('refuses to let an admin disable their own account', async () => {
    const res = await admin.client.patch(`/admin/users/${admin.me.user.id}`, {
      disabled: true,
      reason: 'oops',
    });
    expect(res.status).toBe(409);
  });

  it('lists workspaces with owners, plan and counts', async () => {
    const owner = await registerClient(app, { name: 'Workspace Owner' });
    const ws = await prisma.workspace.findUniqueOrThrow({ where: { id: owner.workspaceId } });
    const res = await admin.client.get(`/admin/workspaces?q=${encodeURIComponent(ws.slug)}`);
    expect(res.body.data[0]).toMatchObject({
      id: ws.id,
      plan: { key: 'FREE' },
      memberCount: 1,
      projectCount: 0,
    });
    expect(res.body.data[0].owners[0].email).toBe(owner.email);
    const detail = await admin.client.get(`/admin/workspaces/${ws.id}`);
    expect(detail.body.data.usage.plan.key).toBe('FREE');
    expect((await admin.client.get('/admin/workspaces/cl0000000000000000000000')).status).toBe(404);
  });
});

describe('plans', () => {
  it('edits plans with validated limits and protects the Free plan', async () => {
    const list = await admin.client.get('/admin/plans');
    expect(list.body.data.find((p: { key: string }) => p.key === planKey)).toMatchObject({
      isActive: false,
      subscriptionCount: 0,
    });

    const starter = DEFAULT_PLANS.find((p) => p.key === 'STARTER')!;
    const updated = await admin.client.patch(`/admin/plans/${planKey}`, {
      name: 'Admin test (edited)',
      priceMonthly: 19.99,
      limits: { ...starter.limits, projects: 7 },
      features: ['Seven projects'],
    });
    expect(updated.status).toBe(200);
    expect(updated.body.data).toMatchObject({
      name: 'Admin test (edited)',
      priceMonthly: 19.99,
      features: ['Seven projects'],
    });
    expect(updated.body.data.limits.projects).toBe(7);

    const invalid = await admin.client.patch(`/admin/plans/${planKey}`, { limits: { projects: -1 } });
    expect(invalid.status).toBe(400);
    const fractional = await admin.client.patch(`/admin/plans/${planKey}`, { priceMonthly: 1.234 });
    expect(fractional.status).toBe(400);

    const free = await admin.client.patch('/admin/plans/FREE', { isActive: false });
    expect(free.status).toBe(409);
    expect((await admin.client.patch('/admin/plans/NOPE_PLAN', { name: 'x' })).status).toBe(404);
  });
});

describe('jobs', () => {
  async function failedJob(type: 'REPORT' | 'CRAWL', queueName: 'report' | 'crawl') {
    return prisma.backgroundJob.create({
      data: {
        type,
        queueName,
        status: 'FAILED',
        attempts: 3,
        maxAttempts: 3,
        error: 'Chromium crashed',
        message: 'Failed',
        finishedAt: new Date(),
      },
    });
  }

  it('retries failed jobs that the queue still holds, and refuses unsafe types', async () => {
    const job = await failedJob('REPORT', 'report');
    queues.failed.set(job.id, {
      queue: 'report',
      jobId: job.id,
      data: { backgroundJobId: job.id, reportId: 'r1' },
    });

    const listed = await admin.client.get('/admin/jobs?status=FAILED&type=REPORT&pageSize=100');
    expect(listed.body.data.find((j: { id: string }) => j.id === job.id)).toMatchObject({
      retryable: true,
      queueName: 'report',
    });

    const retried = await admin.client.post(`/admin/jobs/${job.id}/retry`);
    expect(retried.status).toBe(202);
    expect(retried.body.data).toMatchObject({ status: 'QUEUED', attempts: 0, error: null });
    expect(queues.jobs.some((j) => j.jobId === job.id)).toBe(true);
    expect((await admin.client.post(`/admin/jobs/${job.id}/retry`)).status).toBe(409);

    const gone = await failedJob('REPORT', 'report');
    const missing = await admin.client.post(`/admin/jobs/${gone.id}/retry`);
    expect(missing.status).toBe(409);
    expect(await prisma.backgroundJob.findUniqueOrThrow({ where: { id: gone.id } })).toMatchObject({
      status: 'FAILED',
      attempts: 3,
      error: 'Chromium crashed',
    });

    const crawl = await failedJob('CRAWL', 'crawl');
    const refused = await admin.client.post(`/admin/jobs/${crawl.id}/retry`);
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toMatch(/Start the action again/);

    expect((await admin.client.get('/admin/jobs?type=NOT_A_TYPE')).status).toBe(400);
  });
});

describe('usage', () => {
  it('reports monthly totals and validates the period', async () => {
    const res = await admin.client.get('/admin/usage?period=2026-10');
    expect(res.status).toBe(200);
    expect(res.body.data.periodKey).toBe('2026-10');
    expect(res.body.data.totals.map((t: { metric: string }) => t.metric)).toContain('CRAWL_PAGES');
    expect((await admin.client.get('/admin/usage?period=2026-13')).status).toBe(400);
  });
});
