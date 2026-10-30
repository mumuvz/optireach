import { disconnectPrisma } from '@surfaced/core/db';
import { afterAll, describe, expect, it } from 'vitest';
import { createTestApp, emailTokenFor, registerClient } from './helpers';

const { app, queues, prisma } = createTestApp();

afterAll(async () => {
  await disconnectPrisma();
});

function projectBody(workspaceId: string, overrides: Record<string, unknown> = {}) {
  return {
    workspaceId,
    name: 'Acme Outdoor',
    websiteUrl: 'acme-outdoor.example.com',
    industry: 'ecommerce',
    targetCountries: ['US', 'GB'],
    targetLanguages: ['en'],
    competitors: [{ name: 'Rival Gear', domain: 'https://www.rival-gear.example.com' }],
    primaryKeywords: ['hiking boots', 'trail running shoes'],
    ...overrides,
  };
}

async function setPlan(workspaceId: string, key: string) {
  const plan = await prisma.subscriptionPlan.findUniqueOrThrow({ where: { key } });
  await prisma.subscription.update({ where: { workspaceId }, data: { planId: plan.id } });
}

describe('project management', () => {
  it('creates, reads, updates, lists and deletes a project', async () => {
    const { client, workspaceId } = await registerClient(app);
    const created = await client.post('/projects', projectBody(workspaceId));
    expect(created.status).toBe(201);
    const project = created.body.data;
    expect(project).toMatchObject({
      name: 'Acme Outdoor',
      websiteUrl: 'https://acme-outdoor.example.com/',
      domain: 'acme-outdoor.example.com',
      targetCountries: ['US', 'GB'],
      primaryKeywords: ['hiking boots', 'trail running shoes'],
      auditSchedule: 'MANUAL',
      latestScore: null,
    });
    expect(project.competitors).toHaveLength(1);
    expect(project.competitors[0].domain).toBe('rival-gear.example.com');
    // Audits crawl every page by default: no page or depth cap on any default plan.
    expect(project.crawlSettings).toMatchObject({ maxPages: null, maxDepth: null });

    const updated = await client.patch(`/projects/${project.id}`, {
      description: 'Outdoor equipment retailer',
      primaryKeywords: ['hiking boots', 'waterproof jackets'],
      crawlSettings: { maxPages: 5000, maxDepth: 3 },
    });
    expect(updated.status).toBe(200);
    expect(updated.body.data.primaryKeywords).toEqual(['hiking boots', 'waterproof jackets']);
    expect(updated.body.data.crawlSettings).toMatchObject({ maxPages: 5000, maxDepth: 3 });

    const uncapped = await client.patch(`/projects/${project.id}`, {
      crawlSettings: { maxPages: null, maxDepth: null },
    });
    expect(uncapped.body.data.crawlSettings).toMatchObject({ maxPages: null, maxDepth: null });

    const list = await client.get(`/projects?workspaceId=${workspaceId}`);
    expect(list.body.data.map((p: { id: string }) => p.id)).toEqual([project.id]);

    const history = await client.get(`/projects/${project.id}/history`);
    expect(history.status).toBe(200);
    expect(history.body.data.map((e: { title: string }) => e.title)).toEqual(
      expect.arrayContaining(['Project created', 'Project updated']),
    );

    expect((await client.delete(`/projects/${project.id}`)).status).toBe(204);
    expect((await client.get(`/projects/${project.id}`)).status).toBe(404);
    expect(await prisma.projectCompetitor.count({ where: { projectId: project.id } })).toBe(0);
  });

  it('enforces the Free plan limits for projects and competitors', async () => {
    const { client, workspaceId } = await registerClient(app);
    expect((await client.post('/projects', projectBody(workspaceId))).status).toBe(201);
    const second = await client.post(
      '/projects',
      projectBody(workspaceId, { websiteUrl: 'second.example.com', competitors: [] }),
    );
    expect(second.status).toBe(402);
    expect(second.body.error).toMatchObject({
      code: 'PLAN_LIMIT_REACHED',
      details: { kind: 'projects', limit: 1 },
    });

    await setPlan(workspaceId, 'STARTER');
    const tooManyCompetitors = await client.post(
      '/projects',
      projectBody(workspaceId, {
        websiteUrl: 'third.example.com',
        competitors: ['a', 'b', 'c', 'd'].map((x) => ({ name: x, domain: `${x}.example.net` })),
      }),
    );
    expect(tooManyCompetitors.status).toBe(402);
  });

  it('rejects internal or private websites and duplicate domains', async () => {
    const { client, workspaceId } = await registerClient(app);
    await setPlan(workspaceId, 'GROWTH');
    for (const websiteUrl of [
      'http://127.0.0.1/',
      'http://localhost:3000',
      'http://10.0.0.8/',
      'http://router.local/',
      'https://example.com:8443/',
    ]) {
      const res = await client.post('/projects', projectBody(workspaceId, { websiteUrl, competitors: [] }));
      expect(res.status, websiteUrl).toBe(422);
      expect(res.body.error.code).toBe('UNSUPPORTED_TARGET');
    }
    expect((await client.post('/projects', projectBody(workspaceId))).status).toBe(201);
    const dup = await client.post(
      '/projects',
      projectBody(workspaceId, { websiteUrl: 'https://www.acme-outdoor.example.com/shop' }),
    );
    expect(dup.status).toBe(409);
  });

  it('manages competitors with validation', async () => {
    const { client, workspaceId } = await registerClient(app);
    const project = (await client.post('/projects', projectBody(workspaceId, { competitors: [] }))).body.data;
    const own = await client.post(`/projects/${project.id}/competitors`, {
      name: 'Self',
      domain: 'acme-outdoor.example.com',
    });
    expect(own.status).toBe(400);
    const added = await client.post(`/projects/${project.id}/competitors`, {
      name: 'Trail Co',
      domain: 'trailco.example.org',
      aliases: ['TrailCo'],
    });
    expect(added.status).toBe(201);
    expect(
      (
        await client.post(`/projects/${project.id}/competitors`, {
          name: 'Again',
          domain: 'trailco.example.org',
        })
      ).status,
    ).toBe(409);
    const patched = await client.patch(`/projects/${project.id}/competitors/${added.body.data.id}`, {
      notes: 'Main rival',
    });
    expect(patched.body.data.notes).toBe('Main rival');
    expect((await client.delete(`/projects/${project.id}/competitors/${added.body.data.id}`)).status).toBe(
      204,
    );
    expect((await client.get(`/projects/${project.id}/competitors`)).body.data).toHaveLength(0);
  });
});

describe('project tenant isolation', () => {
  it("prevents user A from reading or modifying user B's project by id", async () => {
    const a = await registerClient(app);
    const b = await registerClient(app);
    const bProject = (await b.client.post('/projects', projectBody(b.workspaceId))).body.data;

    expect((await a.client.get(`/projects/${bProject.id}`)).status).toBe(404);
    expect((await a.client.patch(`/projects/${bProject.id}`, { name: 'Taken over' })).status).toBe(404);
    expect((await a.client.delete(`/projects/${bProject.id}`)).status).toBe(404);
    expect((await a.client.get(`/projects/${bProject.id}/history`)).status).toBe(404);
    expect((await a.client.get(`/projects/${bProject.id}/competitors`)).status).toBe(404);
    expect(
      (await a.client.post(`/projects/${bProject.id}/competitors`, { name: 'X', domain: 'x.example.com' }))
        .status,
    ).toBe(404);
    expect((await a.client.get(`/projects?workspaceId=${b.workspaceId}`)).status).toBe(404);
    expect(
      (await a.client.post('/projects', projectBody(b.workspaceId, { websiteUrl: 'sneaky.example.com' })))
        .status,
    ).toBe(404);

    const still = await prisma.project.findUniqueOrThrow({ where: { id: bProject.id } });
    expect(still.name).toBe('Acme Outdoor');
  });

  it('lets members read but not delete projects or manage competitors', async () => {
    const owner = await registerClient(app);
    await prisma.user.update({ where: { email: owner.email }, data: { emailVerifiedAt: new Date() } });
    await setPlan(owner.workspaceId, 'GROWTH');
    const project = (await owner.client.post('/projects', projectBody(owner.workspaceId))).body.data;

    const member = await registerClient(app);
    await owner.client.post(`/workspaces/${owner.workspaceId}/invitations`, {
      email: member.email,
      role: 'MEMBER',
    });
    const token = await emailTokenFor(queues, member.email, 'workspace_invitation');
    expect((await member.client.post('/workspaces/invitations/accept', { token })).status).toBe(200);

    expect((await member.client.get(`/projects/${project.id}`)).status).toBe(200);
    expect((await member.client.delete(`/projects/${project.id}`)).status).toBe(403);
    expect((await member.client.patch(`/projects/${project.id}`, { name: 'Renamed' })).status).toBe(403);
    expect(
      (
        await member.client.post(`/projects/${project.id}/competitors`, {
          name: 'Y',
          domain: 'y.example.com',
        })
      ).status,
    ).toBe(403);
  });
});
