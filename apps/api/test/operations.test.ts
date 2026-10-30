// Agency client workspaces, the Client role, approvals and team tasks through the HTTP API.
import { requestApproval } from '@surfaced/core/approvals';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, emailTokenFor, registerClient, type TestClient } from './helpers';

const { app, queues, prisma } = createTestApp();

async function setPlan(workspaceId: string, key: string) {
  const plan = await prisma.subscriptionPlan.findUniqueOrThrow({ where: { key } });
  await prisma.subscription.update({ where: { workspaceId }, data: { planId: plan.id, status: 'ACTIVE' } });
}

async function verify(email: string) {
  await prisma.user.update({ where: { email }, data: { emailVerifiedAt: new Date() } });
}

let agency: Awaited<ReturnType<typeof registerClient>>;
let agencyMember: Awaited<ReturnType<typeof registerClient>>;
let outsider: Awaited<ReturnType<typeof registerClient>>;

beforeAll(async () => {
  agency = await registerClient(app, { name: 'Agency Admin' });
  agencyMember = await registerClient(app, { name: 'Agency Writer' });
  outsider = await registerClient(app, { name: 'Outsider' });
  await verify(agency.email);
  // The writer joins the agency workspace as a member.
  await prisma.workspaceMember.create({
    data: { workspaceId: agency.workspaceId, userId: agencyMember.me.user.id, role: 'MEMBER' },
  });
});
afterAll(async () => {
  await queues.close();
});

describe('agency client workspaces', () => {
  let clientWorkspaceId = '';
  let clientProjectId = '';
  let client: TestClient;

  it('requires a plan that includes client workspaces', async () => {
    const res = await agency.client.post(`/agency/${agency.workspaceId}/clients`, { name: 'Surat Jewels' });
    expect(res.status).toBe(402);
    await setPlan(agency.workspaceId, 'AGENCY');
  });

  it('creates a client workspace, invites the client, and gives the agency team inherited access', async () => {
    const contact = `client-${Date.now()}@example.test`;
    const res = await agency.client.post(`/agency/${agency.workspaceId}/clients`, {
      name: 'Surat Jewels',
      contactEmail: contact,
      contactRole: 'CLIENT',
    });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ status: 'ACTIVE', billingMode: 'AGENCY', accessRole: 'ADMIN' });
    clientWorkspaceId = res.body.data.clientWorkspaceId;

    // Agency staff reach the client workspace through the agency.
    const listed = await agencyMember.client.get('/workspaces').expect(200);
    expect(listed.body.data.find((w: { id: string }) => w.id === clientWorkspaceId)).toMatchObject({
      via: 'AGENCY',
      role: 'MEMBER',
    });

    // The agency (inherited ADMIN) creates the client's website project.
    const project = await agency.client.post('/projects', {
      workspaceId: clientWorkspaceId,
      name: 'Surat Jewels',
      websiteUrl: 'https://surat-jewels.example.com',
      targetCountries: ['IN'],
      targetLanguages: ['en'],
    });
    expect(project.status).toBe(201);
    clientProjectId = project.body.data.id;

    // The client accepts the emailed invitation and becomes a Client-role member.
    const registered = await registerClient(app, { email: contact, name: 'Client Contact' });
    client = registered.client;
    const token = await emailTokenFor(queues, contact, 'workspace_invitation');
    const accepted = await client.post('/workspaces/invitations/accept', { token });
    expect(accepted.status).toBe(200);
    expect(accepted.body.data).toMatchObject({ id: clientWorkspaceId, role: 'CLIENT' });
  });

  it('lets clients view but not change SEO work, and hides the workspace from outsiders', async () => {
    expect((await client.get(`/projects/${clientProjectId}`)).status).toBe(200);
    expect((await client.post(`/projects/${clientProjectId}/audits`, {})).status).toBe(403);
    expect((await outsider.client.get(`/projects/${clientProjectId}`)).status).toBe(404);
    expect((await outsider.client.get(`/workspaces/${clientWorkspaceId}/agency`)).status).toBe(404);
  });

  it('leaves content approval to the client unless approvals are delegated', async () => {
    const doc = await agencyMember.client.post(`/projects/${clientProjectId}/content/documents`, {
      title: 'Guide to hallmarked gold',
    });
    expect(doc.status).toBe(201);
    const documentId = doc.body.data.id;
    expect(
      (await agencyMember.client.patch(`/content/documents/${documentId}`, { status: 'IN_REVIEW' })).status,
    ).toBe(200);
    const agencyApprove = await agency.client.patch(`/content/documents/${documentId}`, {
      status: 'APPROVED',
    });
    expect(agencyApprove.status).toBe(403);
    expect(agencyApprove.body.error.message).toMatch(/client approves content/);
    // Clients cannot edit content, only decide.
    expect(
      (await client.patch(`/content/documents/${documentId}`, { title: 'Changed by client' })).status,
    ).toBe(403);
    const clientApprove = await client.patch(`/content/documents/${documentId}`, { status: 'APPROVED' });
    expect(clientApprove.status).toBe(200);
    expect(clientApprove.body.data).toMatchObject({
      status: 'APPROVED',
      approvedBy: { name: 'Client Contact' },
    });
  });

  it('routes generic approvals to the client and records the decision', async () => {
    const approval = await requestApproval(prisma, {
      workspaceId: clientWorkspaceId,
      projectId: clientProjectId,
      entityType: 'LOCAL_POST',
      entityId: clientProjectId,
      title: 'Diwali opening hours post',
      snapshot: { summary: 'Open until 10 pm during Diwali week.' },
      requestedById: agency.me.user.id,
    });
    const forAgency = await agency.client.get(`/approvals?workspaceId=${clientWorkspaceId}`).expect(200);
    expect(forAgency.body.data[0]).toMatchObject({ id: approval.id, canDecide: false });
    const forClient = await client.get('/approvals?decidable=true').expect(200);
    expect(forClient.body.data.map((a: { id: string }) => a.id)).toContain(approval.id);

    expect(
      (await agency.client.post(`/approvals/${approval.id}/decision`, { decision: 'APPROVED' })).status,
    ).toBe(403);
    const missingNote = await client.post(`/approvals/${approval.id}/decision`, {
      decision: 'CHANGES_REQUESTED',
    });
    expect(missingNote.status).toBe(400);
    const decided = await client.post(`/approvals/${approval.id}/decision`, { decision: 'APPROVED' });
    expect(decided.status).toBe(200);
    expect(decided.body.data).toMatchObject({ status: 'APPROVED', decidedVia: 'DIRECT_MEMBER' });
    expect((await outsider.client.get(`/approvals/${approval.id}`)).status).toBe(404);
    const detail = await client.get(`/approvals/${approval.id}`).expect(200);
    expect(detail.body.data.snapshot).toEqual({ summary: 'Open until 10 pm during Diwali week.' });
    expect(
      await prisma.auditLog.count({ where: { action: 'approval.decided', targetId: approval.id } }),
    ).toBe(1);
  });

  it('assigns tasks to agency staff and shows clients only client-visible work', async () => {
    const internal = await agency.client.post(`/projects/${clientProjectId}/tasks`, {
      title: 'Audit Business Profile categories',
      type: 'BUSINESS_PROFILE',
      assigneeId: agencyMember.me.user.id,
      dueDate: '2026-11-15',
    });
    expect(internal.status).toBe(201);
    const shared = await agency.client.post(`/projects/${clientProjectId}/tasks`, {
      title: 'Send store photos',
      type: 'LOCAL_SEO',
      clientVisible: true,
    });
    expect(shared.status).toBe(201);
    expect(
      (
        await agency.client.post(`/projects/${clientProjectId}/tasks`, {
          title: 'Bad',
          assigneeId: outsider.me.user.id,
        })
      ).status,
    ).toBe(400);

    const mine = await agencyMember.client.get('/tasks').expect(200);
    expect(mine.body.data.map((t: { id: string }) => t.id)).toContain(internal.body.data.id);
    const clientView = await client.get(`/projects/${clientProjectId}/tasks`).expect(200);
    expect(clientView.body.data.map((t: { title: string }) => t.title)).toEqual(['Send store photos']);
    expect((await client.get(`/tasks/${internal.body.data.id}`)).status).toBe(404);
    expect((await client.patch(`/tasks/${shared.body.data.id}`, { status: 'DONE' })).status).toBe(403);

    const logged = await agencyMember.client.post(`/tasks/${internal.body.data.id}/time`, {
      minutes: 45,
      workDate: '2026-11-02',
    });
    expect(logged.status).toBe(201);
    const done = await agencyMember.client.patch(`/tasks/${internal.body.data.id}`, { status: 'DONE' });
    expect(done.body.data).toMatchObject({ status: 'DONE', minutesLogged: 45 });
    expect(done.body.data.completedAt).not.toBeNull();
    expect(
      (await agency.client.delete(`/tasks/${internal.body.data.id}/time/${logged.body.data.id}`)).status,
    ).toBe(204); // admins may delete entries of their team
  });

  it('keeps an agency from abandoning a client workspace that has no owner of its own', async () => {
    const listed = await agency.client.get(`/agency/${agency.workspaceId}/clients`).expect(200);
    const entry = listed.body.data.clients.find(
      (c: { clientWorkspaceId: string }) => c.clientWorkspaceId === clientWorkspaceId,
    );
    expect(entry).toMatchObject({ hasClientOwner: false, projects: 1 });
    expect((await agency.client.delete(`/agency/${agency.workspaceId}/links/${entry.id}`)).status).toBe(409);
    // Client-role users cannot revoke agency access; owners and admins of the workspace can.
    expect((await client.delete(`/workspaces/${clientWorkspaceId}/agency`)).status).toBe(403);
  });
});

describe('client-requested agency access', () => {
  it('needs the agency to accept, can be delegated, and ends immediately when revoked', async () => {
    const owner = await registerClient(app, { name: 'Shop Owner' });
    const project = await owner.client.post('/projects', {
      workspaceId: owner.workspaceId,
      name: 'Shop',
      websiteUrl: 'https://shop-owner.example.com',
      targetCountries: ['IN'],
      targetLanguages: ['en'],
    });
    expect(project.status).toBe(201);
    const code = (await agency.client.get(`/agency/${agency.workspaceId}/clients`)).body.data.agencyCode;
    expect(
      (await owner.client.post(`/workspaces/${owner.workspaceId}/agency`, { agencyCode: 'no-such-agency' }))
        .status,
    ).toBe(404);
    const requested = await owner.client.post(`/workspaces/${owner.workspaceId}/agency`, {
      agencyCode: code,
    });
    expect(requested.status).toBe(201);
    expect(requested.body.data).toMatchObject({ status: 'PENDING', billingMode: 'CLIENT' });
    // Pending: no access yet.
    expect((await agency.client.get(`/projects/${project.body.data.id}`)).status).toBe(404);

    const accepted = await agency.client.post(
      `/agency/${agency.workspaceId}/links/${requested.body.data.id}/accept`,
    );
    expect(accepted.status).toBe(200);
    expect((await agency.client.get(`/projects/${project.body.data.id}`)).status).toBe(200);

    const delegated = await owner.client.patch(`/workspaces/${owner.workspaceId}/agency`, {
      approvalsDelegated: true,
    });
    expect(delegated.body.data.approvalsDelegated).toBe(true);
    // The agency cannot change its own access level.
    expect(
      (await agency.client.patch(`/workspaces/${owner.workspaceId}/agency`, { accessRole: 'ADMIN' })).status,
    ).toBe(403);

    expect((await owner.client.delete(`/workspaces/${owner.workspaceId}/agency`)).status).toBe(200);
    expect((await agency.client.get(`/projects/${project.body.data.id}`)).status).toBe(404);
  });
});

describe('provider rates (platform administration)', () => {
  it('is hidden from non-admins and records rates and costs for admins', async () => {
    expect((await agency.client.get('/admin/provider-rates')).status).toBe(404);
    await prisma.user.update({ where: { id: outsider.me.user.id }, data: { platformRole: 'ADMIN' } });
    const created = await outsider.client.post('/admin/provider-rates', {
      provider: 'openai',
      operation: 'content_generation',
      unit: 'input_token',
      price: 0.15,
      unitQuantity: 1_000_000,
      effectiveFrom: '2026-01-01',
    });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ provider: 'openai', price: 0.15, unitQuantity: 1_000_000 });
    const costs = await outsider.client.get('/admin/provider-costs').expect(200);
    expect(Array.isArray(costs.body.data.lines)).toBe(true);
    expect((await outsider.client.delete(`/admin/provider-rates/${created.body.data.id}`)).status).toBe(204);
  });
});
