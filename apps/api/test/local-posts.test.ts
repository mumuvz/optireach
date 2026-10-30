import { encryptSecret } from '@surfaced/core/crypto';
import { disconnectPrisma, getPrisma } from '@surfaced/core/db';
import type { HttpFetch } from '@surfaced/core/integrations';
import { publishDueLocalPosts } from '@surfaced/core/local';
import { getLogger } from '@surfaced/core/logger';
import { MemoryQueueGateway } from '@surfaced/core/queue';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { registerClient } from './helpers';

const prisma = getPrisma();
afterAll(async () => {
  await disconnectPrisma();
});

/** Answers only the localPosts POST; anything else is an unexpected call. */
function fakeGoogle() {
  const calls: { url: string; method: string; body: string | null }[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: typeof init?.body === 'string' ? init.body : null });
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (/\/v4\/accounts\/9\/locations\/111\/localPosts$/.test(url) && method === 'POST')
      return json({
        name: 'accounts/9/locations/111/localPosts/p1',
        searchUrl: 'https://www.google.com/maps/post/p1',
      });
    return json({ error: { code: 404, status: 'NOT_FOUND', message: `Unexpected ${url}` } }, 404);
  }) as HttpFetch;
  return { fn, calls };
}

const google = fakeGoogle();
const { app } = createApp({
  prisma,
  queues: new MemoryQueueGateway(),
  redis: null,
  logger: getLogger('api-test'),
  rateLimitMultiplier: 100,
  httpFetch: google.fn,
});

async function setup() {
  const owner = await registerClient(app);
  const res = await owner.client.post('/projects', {
    workspaceId: owner.workspaceId,
    name: 'Navkar Jewellers',
    targetCountries: ['IN'],
    targetLanguages: ['en'],
    locations: [
      { name: 'Navkar Jewellers', addressLine1: 'Shop 4, Ghod Dod Road', city: 'Surat', country: 'IN' }, // prettier-ignore
    ],
  });
  const projectId = res.body.data.id as string;
  const [location] = (await owner.client.get(`/projects/${projectId}/locations`)).body.data;
  // Connect Business Profile and link the location, as the OAuth callback + link flow would leave them.
  await prisma.integration.create({
    data: {
      workspaceId: owner.workspaceId,
      projectId,
      provider: 'GOOGLE_BUSINESS_PROFILE',
      status: 'CONNECTED',
      externalAccount: 'owner@example.test',
      token: {
        create: { accessTokenEnc: encryptSecret('ya29.test'), expiresAt: new Date(Date.now() + 3600_000) },
      },
    },
  });
  await prisma.businessLocation.update({
    where: { id: location.id },
    data: { profileAccountName: 'accounts/9', profileLocationName: 'locations/111' },
  });
  return { ...owner, projectId, locationId: location.id as string };
}

async function approveLatest(projectId: string, postId: string, client: Awaited<ReturnType<typeof registerClient>>['client']) {
  await client.post(`/projects/${projectId}/local/posts/${postId}/request-approval`);
  const approval = await prisma.approvalRequest.findFirstOrThrow({
    where: { entityType: 'LOCAL_POST', entityId: postId, status: 'PENDING' },
  });
  expect((await client.post(`/approvals/${approval.id}/decision`, { decision: 'APPROVED' })).status).toBe(200);
  return approval.id;
}

describe('Business Profile posts', () => {
  it('drafts (AI and manual), approves and publishes a post to Google only with approval', async () => {
    const { client, projectId } = await setup();

    const providers = (await client.get(`/projects/${projectId}/local/post-providers`)).body.data as {
      key: string;
      configured: boolean;
      isDefault: boolean;
    }[];
    expect(providers.find((p) => p.key === 'dev')).toMatchObject({ configured: true, isDefault: true });

    // AI draft: labelled as a development template, counts as one content generation.
    const ai = await client.post(`/projects/${projectId}/local/posts`, {
      locationId: (await client.get(`/projects/${projectId}/locations`)).body.data[0].id,
      generate: true,
      topic: 'weekend gold exchange offer',
    });
    expect(ai.status).toBe(201);
    expect(ai.body.data).toMatchObject({ origin: 'AI', model: 'dev-template', status: 'DRAFT' });
    expect(ai.body.data.summary.length).toBeGreaterThan(0);
    expect(
      await prisma.usageRecord.findFirst({ where: { idempotencyKey: `local-post:${ai.body.data.id}` } }),
    ).toMatchObject({ metric: 'CONTENT_GENERATION' });

    // Manual draft with a call-to-action button.
    const locationId = (await client.get(`/projects/${projectId}/locations`)).body.data[0].id as string;
    const post = await client.post(`/projects/${projectId}/local/posts`, {
      locationId,
      summary: 'New diwali collection now in store. Visit us this weekend.',
      ctaType: 'LEARN_MORE',
      ctaUrl: 'https://navkar.example.com/diwali',
    });
    expect(post.status).toBe(201);
    const postId = post.body.data.id as string;
    expect(post.body.data).toMatchObject({ origin: 'HUMAN', status: 'DRAFT', ctaType: 'LEARN_MORE' });

    // Publishing without approval is refused; nothing reaches Google.
    expect((await client.post(`/projects/${projectId}/local/posts/${postId}/publish`)).status).toBe(409);
    expect(google.calls.some((c) => c.method === 'POST')).toBe(false);

    await approveLatest(projectId, postId, client);
    const published = await client.post(`/projects/${projectId}/local/posts/${postId}/publish`);
    expect(published.status).toBe(200);
    expect(published.body.data).toMatchObject({ status: 'PUBLISHED', googleName: 'accounts/9/locations/111/localPosts/p1' }); // prettier-ignore
    expect(google.calls.some((c) => c.method === 'POST' && /localPosts$/.test(c.url))).toBe(true);
    const body = JSON.parse(google.calls.find((c) => c.method === 'POST')!.body!);
    expect(body).toMatchObject({ summary: 'New diwali collection now in store. Visit us this weekend.', topicType: 'STANDARD', callToAction: { actionType: 'LEARN_MORE', url: 'https://navkar.example.com/diwali' } }); // prettier-ignore
    expect(
      await prisma.auditLog.findFirst({ where: { action: 'local_post.published', targetId: postId } }),
    ).not.toBeNull();
  });

  it('defers a future-dated post to SCHEDULED and the tick publishes it when due', async () => {
    const { client, projectId, locationId } = await setup();
    const future = new Date(Date.now() + 2 * 3600_000);
    const post = await client.post(`/projects/${projectId}/local/posts`, {
      locationId,
      summary: 'Open this Sunday for the festival.',
      scheduledAt: future.toISOString(),
    });
    const postId = post.body.data.id as string;
    await approveLatest(projectId, postId, client);

    // Approved + future-dated → SCHEDULED, nothing published yet.
    const scheduled = await client.post(`/projects/${projectId}/local/posts/${postId}/publish`);
    expect(scheduled.body.data.status).toBe('SCHEDULED');

    // The tick publishes posts whose time has come.
    const result = await publishDueLocalPosts(prisma, {
      now: new Date(future.getTime() + 60_000),
      httpFetch: google.fn,
    });
    expect(result.published).toBeGreaterThanOrEqual(1);
    const after = await prisma.localPost.findUniqueOrThrow({ where: { id: postId } });
    expect(after.status).toBe('PUBLISHED');
  });

  it("prevents access to another workspace's posts", async () => {
    const b = await setup();
    const manual = await b.client.post(`/projects/${b.projectId}/local/posts`, {
      locationId: b.locationId,
      summary: 'Private post',
    });
    const postId = manual.body.data.id as string;
    const a = await registerClient(app);
    expect((await a.client.get(`/projects/${b.projectId}/local/posts`)).status).toBe(404);
    expect((await a.client.post(`/projects/${b.projectId}/local/posts/${postId}/publish`)).status).toBe(404);
  });
});
