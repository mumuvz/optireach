import { disconnectPrisma } from '@surfaced/core/db';
import { createJobRecord } from '@surfaced/core/jobs';
import { afterAll, describe, expect, it } from 'vitest';
import { createTestApp, emailTokenFor, registerClient } from './helpers';

const { app, queues, prisma } = createTestApp();

afterAll(async () => {
  await disconnectPrisma();
});

async function verify(email: string) {
  await prisma.user.update({ where: { email }, data: { emailVerifiedAt: new Date() } });
}

async function setPlan(workspaceId: string, key: string) {
  const plan = await prisma.subscriptionPlan.findUniqueOrThrow({ where: { key } });
  await prisma.subscription.update({ where: { workspaceId }, data: { planId: plan.id } });
}

describe('workspace tenant isolation', () => {
  it("returns 404 for every operation on another customer's workspace", async () => {
    const a = await registerClient(app);
    const b = await registerClient(app);

    expect((await a.client.get(`/workspaces/${b.workspaceId}`)).status).toBe(404);
    expect((await a.client.get(`/workspaces/${b.workspaceId}/members`)).status).toBe(404);
    expect((await a.client.get(`/workspaces/${b.workspaceId}/audit-logs`)).status).toBe(404);
    expect((await a.client.patch(`/workspaces/${b.workspaceId}`, { name: 'Hijacked' })).status).toBe(404);
    expect((await a.client.post(`/workspaces/${b.workspaceId}/invitations`, { email: a.email })).status).toBe(
      404,
    );
    expect((await a.client.post(`/workspaces/${b.workspaceId}/switch`)).status).toBe(404);

    const list = await a.client.get('/workspaces');
    expect(list.body.data.map((w: { id: string }) => w.id)).toEqual([a.workspaceId]);
    const untouched = await prisma.workspace.findUniqueOrThrow({ where: { id: b.workspaceId } });
    expect(untouched.name).not.toBe('Hijacked');
  });

  it("hides another workspace's background jobs", async () => {
    const a = await registerClient(app);
    const b = await registerClient(app);
    const job = await createJobRecord(prisma, { type: 'CRAWL', queue: 'crawl', workspaceId: b.workspaceId });
    expect((await a.client.get(`/jobs/${job.id}`)).status).toBe(404);
    expect((await a.client.post(`/jobs/${job.id}/cancel`)).status).toBe(404);
    expect((await b.client.get(`/jobs/${job.id}`)).status).toBe(200);
  });
});

describe('invitations and roles', () => {
  it('requires a verified email and respects the Free plan team limit', async () => {
    const owner = await registerClient(app);
    const unverified = await owner.client.post(`/workspaces/${owner.workspaceId}/invitations`, {
      email: 'x@example.test',
    });
    expect(unverified.status).toBe(403);
    expect(unverified.body.error.code).toBe('EMAIL_NOT_VERIFIED');

    await verify(owner.email);
    const overLimit = await owner.client.post(`/workspaces/${owner.workspaceId}/invitations`, {
      email: 'x@example.test',
    });
    expect(overLimit.status).toBe(402);
    expect(overLimit.body.error).toMatchObject({
      code: 'PLAN_LIMIT_REACHED',
      details: { kind: 'teamMembers', limit: 1 },
    });
  });

  it('invites, accepts with the matching account only, and enforces role rules', async () => {
    const owner = await registerClient(app);
    await verify(owner.email);
    await setPlan(owner.workspaceId, 'GROWTH');

    const invitee = await registerClient(app);
    const stranger = await registerClient(app);
    const invite = await owner.client.post(`/workspaces/${owner.workspaceId}/invitations`, {
      email: invitee.email,
      role: 'MEMBER',
    });
    expect(invite.status).toBe(201);
    const token = await emailTokenFor(queues, invitee.email, 'workspace_invitation');

    const wrongAccount = await stranger.client.post('/workspaces/invitations/accept', { token });
    expect(wrongAccount.status).toBe(403);
    const accepted = await invitee.client.post('/workspaces/invitations/accept', { token });
    expect(accepted.status).toBe(200);
    expect(accepted.body.data).toMatchObject({ id: owner.workspaceId, role: 'MEMBER' });
    expect((await invitee.client.post('/workspaces/invitations/accept', { token })).status).toBe(400);

    const members = await owner.client.get(`/workspaces/${owner.workspaceId}/members`);
    expect(members.body.data).toHaveLength(2);
    const ownerMember = members.body.data.find((m: { role: string }) => m.role === 'OWNER');
    const memberRow = members.body.data.find((m: { role: string }) => m.role === 'MEMBER');

    // Members cannot manage people, see billing-level logs, or invite.
    expect(
      (
        await invitee.client.patch(`/workspaces/${owner.workspaceId}/members/${ownerMember.id}`, {
          role: 'MEMBER',
        })
      ).status,
    ).toBe(403);
    expect((await invitee.client.get(`/workspaces/${owner.workspaceId}/audit-logs`)).status).toBe(403);
    expect(
      (await invitee.client.post(`/workspaces/${owner.workspaceId}/invitations`, { email: 'z@example.test' }))
        .status,
    ).toBe(403);
    expect((await invitee.client.get(`/workspaces/${owner.workspaceId}/members`)).status).toBe(200);

    // Owner promotes the member to admin; the admin still cannot demote the owner.
    expect(
      (
        await owner.client.patch(`/workspaces/${owner.workspaceId}/members/${memberRow.id}`, {
          role: 'ADMIN',
        })
      ).status,
    ).toBe(200);
    const demote = await invitee.client.patch(`/workspaces/${owner.workspaceId}/members/${ownerMember.id}`, {
      role: 'MEMBER',
    });
    expect(demote.status).toBe(403);
    expect(demote.body.error.message).toMatch(/owner/i);

    // The only owner cannot leave; the admin can.
    const ownerLeaves = await owner.client.delete(
      `/workspaces/${owner.workspaceId}/members/${ownerMember.id}`,
    );
    expect(ownerLeaves.status).toBe(409);
    expect(
      (await invitee.client.delete(`/workspaces/${owner.workspaceId}/members/${memberRow.id}`)).status,
    ).toBe(204);
    expect((await invitee.client.get(`/workspaces/${owner.workspaceId}`)).status).toBe(404);

    const log = await owner.client.get(`/workspaces/${owner.workspaceId}/audit-logs`);
    const actions = log.body.data.map((l: { action: string }) => l.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'workspace.member_invited',
        'workspace.member_joined',
        'workspace.member_role_changed',
        'workspace.member_left',
      ]),
    );
  });

  it('creates additional workspaces and switches the current one', async () => {
    const user = await registerClient(app);
    const createdWs = await user.client.post('/workspaces', { name: 'Client Work' });
    expect(createdWs.status).toBe(201);
    expect(createdWs.body.data.role).toBe('OWNER');
    const me = await user.client.get('/auth/me');
    expect(me.body.data.currentWorkspaceId).toBe(createdWs.body.data.id);
    await user.client.post(`/workspaces/${user.workspaceId}/switch`);
    expect((await user.client.get('/auth/me')).body.data.currentWorkspaceId).toBe(user.workspaceId);
  });

  it('gates white-label settings by plan', async () => {
    const owner = await registerClient(app);
    const denied = await owner.client.patch(`/workspaces/${owner.workspaceId}`, {
      whiteLabel: { enabled: true, brandName: 'Agency Co' },
    });
    expect(denied.status).toBe(402);
    await setPlan(owner.workspaceId, 'AGENCY');
    const allowed = await owner.client.patch(`/workspaces/${owner.workspaceId}`, {
      whiteLabel: { enabled: true, brandName: 'Agency Co' },
    });
    expect(allowed.status).toBe(200);
    expect(allowed.body.data.whiteLabel).toMatchObject({ enabled: true, brandName: 'Agency Co' });
  });
});
