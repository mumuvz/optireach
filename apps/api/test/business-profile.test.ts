import { encryptSecret } from '@surfaced/core/crypto';
import { disconnectPrisma, getPrisma } from '@surfaced/core/db';
import type { HttpFetch } from '@surfaced/core/integrations';
import { syncBusinessProfile } from '@surfaced/core/local';
import { getLogger } from '@surfaced/core/logger';
import { MemoryQueueGateway } from '@surfaced/core/queue';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { registerClient } from './helpers';

const prisma = getPrisma();
afterAll(async () => {
  await disconnectPrisma();
});

/** Stands in for Google: every Business Profile request is answered here; nothing reaches the network. */
function fakeGoogle() {
  const calls: { url: string; method: string; body: string | null }[] = [];
  let denyNext = false;
  const location = {
    name: 'locations/111',
    title: 'Navkar Jewellers',
    phoneNumbers: { primaryPhone: '+91 261 000 0000' },
    categories: { primaryCategory: { name: 'categories/gcid:jewelry_store', displayName: 'Jewelry store' } },
    storefrontAddress: { regionCode: 'IN', postalCode: '395007', locality: 'Surat', addressLines: ['Shop 4, Ghod Dod Road'] }, // prettier-ignore
    regularHours: { periods: [{ openDay: 'MONDAY', openTime: { hours: 10 }, closeDay: 'MONDAY', closeTime: { hours: 20 } }] }, // prettier-ignore
    openInfo: { status: 'OPEN' },
    metadata: { placeId: 'ChIJ-navkar', hasVoiceOfMerchant: true },
  };
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: typeof init?.body === 'string' ? init.body : null });
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (denyNext) {
      denyNext = false;
      return json({ error: { code: 403, status: 'PERMISSION_DENIED', message: 'Business Profile API has not been used in project 123' } }, 403); // prettier-ignore
    }
    if (url.startsWith('https://mybusinessaccountmanagement.googleapis.com/v1/accounts'))
      return json({ accounts: [{ name: 'accounts/9', accountName: 'Navkar Group', type: 'PERSONAL', role: 'PRIMARY_OWNER' }] }); // prettier-ignore
    if (url.startsWith('https://mybusinessbusinessinformation.googleapis.com/v1/accounts/9/locations'))
      return json({ locations: [location] });
    if (url.startsWith('https://mybusinessbusinessinformation.googleapis.com/v1/locations/111'))
      return json(location);
    if (url.includes('locations/111:fetchMultiDailyMetricsTimeSeries')) {
      const day = (d: number) => ({ year: 2026, month: 10, day: d });
      return json({
        multiDailyMetricTimeSeries: [
          {
            dailyMetricTimeSeries: [
              { dailyMetric: 'CALL_CLICKS', timeSeries: { datedValues: [{ date: day(20), value: '3' }, { date: day(21), value: '2' }] } }, // prettier-ignore
              { dailyMetric: 'BUSINESS_IMPRESSIONS_MOBILE_MAPS', timeSeries: { datedValues: [{ date: day(20), value: '40' }] } }, // prettier-ignore
            ],
          },
        ],
      });
    }
    if (
      url.startsWith('https://mybusiness.googleapis.com/v4/accounts/9/locations/111/reviews/r1/reply') &&
      method === 'PUT'
    )
      return json({ comment: JSON.parse(String(init?.body)).comment, updateTime: '2026-10-24T09:00:00Z' });
    if (url.startsWith('https://mybusiness.googleapis.com/v4/accounts/9/locations/111/reviews'))
      return json({
        reviews: [
          { name: 'accounts/9/locations/111/reviews/r1', reviewer: { displayName: 'Asha Patel' }, starRating: 'TWO', comment: 'Waited 40 minutes', createTime: '2026-10-20T10:00:00Z' }, // prettier-ignore
          { name: 'accounts/9/locations/111/reviews/r2', reviewer: { isAnonymous: true }, starRating: 'FIVE', createTime: '2026-10-19T10:00:00Z', reviewReply: { comment: 'Thank you!' } }, // prettier-ignore
        ],
        averageRating: 3.5,
        totalReviewCount: 2,
      });
    return json({ error: { code: 404, status: 'NOT_FOUND', message: `Unexpected ${url}` } }, 404);
  }) as HttpFetch;
  return { fn, calls, deny: () => (denyNext = true) };
}

const google = fakeGoogle();
const queues = new MemoryQueueGateway();
const { app } = createApp({
  prisma,
  queues,
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
      { name: 'Navkar Jewellers', addressLine1: 'Shop 4, Ghod Dod Road', city: 'Surat', postalCode: '395007', country: 'IN', phone: '0261 000 0000' }, // prettier-ignore
    ],
  });
  expect(res.status).toBe(201);
  const projectId = res.body.data.id as string;
  const [location] = (await owner.client.get(`/projects/${projectId}/locations`)).body.data;
  return { ...owner, projectId, locationId: location.id as string };
}

/** The OAuth flow itself is covered in core; here the connection is created as the callback would leave it. */
async function connect(projectId: string, workspaceId: string) {
  return prisma.integration.create({
    data: {
      workspaceId,
      projectId,
      provider: 'GOOGLE_BUSINESS_PROFILE',
      status: 'CONNECTED',
      externalAccount: 'owner@example.test',
      token: {
        create: { accessTokenEnc: encryptSecret('ya29.test'), expiresAt: new Date(Date.now() + 3600_000) },
      },
    },
  });
}

describe('Business Profile connection and linking', () => {
  it('lists the integration as implemented and refuses to connect without an OAuth client', async () => {
    const { client, projectId } = await setup();
    const catalog = (await client.get(`/projects/${projectId}/integrations`)).body.data;
    expect(catalog.find((e: { provider: string }) => e.provider === 'GOOGLE_BUSINESS_PROFILE')).toMatchObject(
      {
        availability: 'implemented',
        configured: false,
      },
    );
    const connectRes = await client.post(
      `/projects/${projectId}/integrations/google-business-profile/connect`,
    );
    expect(connectRes.status).toBe(503);
    const status = (await client.get(`/projects/${projectId}/business-profile`)).body.data;
    expect(status).toMatchObject({ configured: false, integration: null, retentionDays: 30 });
    // Not connected: the audit reads the entered details and says so.
    const detail = (await client.get(`/projects/${projectId}/locations/${status.locations[0].id}/business-profile`)).body.data; // prettier-ignore
    expect(detail.audit.source).toBe('MANUAL');
    expect(detail.profile).toBeNull();
    expect((await client.get(`/projects/${projectId}/business-profile/accounts`)).status).toBe(409);
  });

  it('links a profile, syncs it, and shows the audit, metrics and reviews; unlinking deletes the stored data', async () => {
    const { client, projectId, workspaceId, locationId } = await setup();
    // Two locations need a paid plan (Free allows one).
    await client.post('/billing/checkout', { workspaceId, planKey: 'GROWTH', interval: 'MONTH' });
    const integration = await connect(projectId, workspaceId);
    const accounts = (await client.get(`/projects/${projectId}/business-profile/accounts`)).body.data;
    expect(accounts).toEqual([expect.objectContaining({ name: 'accounts/9', accountName: 'Navkar Group' })]);
    const options = (await client.get(`/projects/${projectId}/business-profile/locations?account=accounts/9`)).body.data; // prettier-ignore
    expect(options).toEqual([expect.objectContaining({ name: 'locations/111', linkedLocationId: null, address: 'Shop 4, Ghod Dod Road, Surat 395007' })]); // prettier-ignore
    expect(
      (await client.get(`/projects/${projectId}/business-profile/locations?account=../../x`)).status,
    ).toBe(400);

    const linked = await client.post(`/projects/${projectId}/business-profile/links`, {
      accountName: 'accounts/9',
      profileLocationName: 'locations/111',
      locationId,
    });
    expect(linked.status).toBe(201);
    expect(linked.body.data).toMatchObject({
      id: locationId,
      profileLocationName: 'locations/111',
      placeId: 'ChIJ-navkar',
    });
    expect(queues.jobs.some((j) => j.queue === 'integration-sync' && (j.data as { integrationId?: string }).integrationId === integration.id)).toBe(true); // prettier-ignore
    // The same profile cannot be linked to a second location.
    const second = await client.post(`/projects/${projectId}/locations`, { name: 'Branch', addressLine1: 'Adajan', city: 'Surat', country: 'IN' }); // prettier-ignore
    const dup = await client.post(`/projects/${projectId}/business-profile/links`, { accountName: 'accounts/9', profileLocationName: 'locations/111', locationId: second.body.data.id }); // prettier-ignore
    expect(dup.status).toBe(409);

    // The worker's sync, with the same fake Google.
    await syncBusinessProfile(prisma, integration.id, google.fn, new Date('2026-10-24T08:00:00Z'));
    const detail = (await client.get(`/projects/${projectId}/locations/${locationId}/business-profile`)).body
      .data;
    expect(detail.audit.source).toBe('BUSINESS_PROFILE');
    expect(detail.audit.checks.find((c: { key: string }) => c.key === 'website').status).toBe(
      'not_applicable',
    );
    expect(detail.reviewTotals).toEqual({ averageRating: 3.5, totalReviewCount: 2 });
    expect(detail.unansweredReviews).toBe(1);
    expect(detail.reviews.map((r: { starRating: number }) => r.starRating)).toEqual([2, 5]);
    expect(detail.reviews[1]).toMatchObject({
      isAnonymous: true,
      reviewerName: null,
      reply: { comment: 'Thank you!' },
    });
    const calls = detail.metrics.metrics.find((m: { metric: string }) => m.metric === 'CALL_CLICKS');
    expect(calls).toMatchObject({ current: 5, previous: null, label: 'Call button clicks' });
    expect(detail.metrics.daily.at(-1)).toMatchObject({ date: '2026-10-21', actions: 2 });

    const status = (await client.get(`/projects/${projectId}/business-profile`)).body.data;
    expect(status.locations.find((l: { id: string }) => l.id === locationId)).toMatchObject({
      unansweredReviews: 1,
    });
    // The dashboard shows Google's own numbers for the profile, with their source.
    const overview = (await client.get(`/projects/${projectId}/local/overview?locationId=${locationId}`)).body
      .data;
    const card = (key: string) => overview.cards.find((c: { key: string }) => c.key === key);
    expect(card('business_profile')).toMatchObject({ state: 'ok', value: '40 profile views', previous: null, source: expect.stringMatching(/Performance API/) }); // prettier-ignore
    expect(card('business_profile').lines[0]).toEqual({ label: 'Calls', value: '5' });
    expect(card('reviews')).toMatchObject({
      state: 'ok',
      value: '3.5★',
      source: expect.stringMatching(/Business Profile/),
    });
    expect(card('reviews').lines[1]).toEqual({ label: 'Recent reviews without a reply', value: '1' });

    // Another workspace cannot see any of it.
    const stranger = await registerClient(app);
    expect((await stranger.client.get(`/projects/${projectId}/locations/${locationId}/business-profile`)).status).toBe(404); // prettier-ignore

    expect(
      (await client.delete(`/projects/${projectId}/locations/${locationId}/business-profile`)).status,
    ).toBe(204);
    expect(await prisma.businessReview.count({ where: { locationId } })).toBe(0);
    expect(await prisma.businessProfileSnapshot.count({ where: { locationId } })).toBe(0);
  });

  it('disconnecting revokes access and deletes the stored profile data, keeping the link for reconnecting', async () => {
    const { client, projectId, workspaceId, locationId } = await setup();
    const integration = await connect(projectId, workspaceId);
    await client.post(`/projects/${projectId}/business-profile/links`, { accountName: 'accounts/9', profileLocationName: 'locations/111', locationId }); // prettier-ignore
    await syncBusinessProfile(prisma, integration.id, google.fn);
    expect(await prisma.businessReview.count({ where: { locationId } })).toBe(2);
    expect((await client.delete(`/integrations/${integration.id}`)).status).toBe(204);
    expect(google.calls.at(-1)!.url).toMatch(/^https:\/\/oauth2\.googleapis\.com\/revoke\?token=/);
    expect(await prisma.businessReview.count({ where: { locationId } })).toBe(0);
    expect(await prisma.businessProfileMetric.count({ where: { locationId } })).toBe(0);
    expect(await prisma.businessLocation.findUniqueOrThrow({ where: { id: locationId } })).toMatchObject({ profileLocationName: 'locations/111' }); // prettier-ignore
    expect((await client.get(`/projects/${projectId}/business-profile`)).body.data.integration).toBeNull();
  });

  it('shows Google’s reason when the API is not approved for the project', async () => {
    const { client, projectId, workspaceId } = await setup();
    await connect(projectId, workspaceId);
    google.deny();
    const res = await client.get(`/projects/${projectId}/business-profile/accounts`);
    expect(res.status).toBe(502);
    expect(res.body.error).toMatchObject({ code: 'UPSTREAM_ERROR' });
    expect(res.body.error.message).toMatch(
      /approved for this Google Cloud project.*has not been used in project 123/,
    );
  });
});

describe('review replies', () => {
  async function linkedAndSynced() {
    const ctx = await setup();
    const integration = await connect(ctx.projectId, ctx.workspaceId);
    await ctx.client.post(`/projects/${ctx.projectId}/business-profile/links`, { accountName: 'accounts/9', profileLocationName: 'locations/111', locationId: ctx.locationId }); // prettier-ignore
    await syncBusinessProfile(prisma, integration.id, google.fn);
    const detail = (await ctx.client.get(`/projects/${ctx.projectId}/locations/${ctx.locationId}/business-profile`)).body.data; // prettier-ignore
    const review = detail.reviews.find((r: { reviewName: string }) => r.reviewName.endsWith('/r1'));
    return { ...ctx, reviewId: review.id as string };
  }

  it('publishes only an approved reply, only with publish permission, and only the approved text', async () => {
    const { client, projectId, workspaceId, reviewId } = await linkedAndSynced();
    const draft = await client.post(`/projects/${projectId}/reviews/${reviewId}/replies`, { generate: true, instructions: 'Apologise for the wait' }); // prettier-ignore
    expect(draft.status).toBe(201);
    // The development adapter is labeled as a template, not AI output; drafting counts as one AI generation.
    expect(draft.body.data).toMatchObject({
      origin: 'AI',
      model: 'dev-template',
      status: 'DRAFT',
      canPublish: false,
    });
    const replyId = draft.body.data.id as string;
    expect(await prisma.usageRecord.findFirst({ where: { idempotencyKey: `review-reply:${replyId}` } })).toMatchObject({ metric: 'CONTENT_GENERATION' }); // prettier-ignore

    // Publishing without approval is refused and nothing reaches Google.
    const putsBefore = google.calls.filter((c) => c.method === 'PUT').length;
    const early = await client.post(`/projects/${projectId}/review-replies/${replyId}/publish`);
    expect(early.status).toBe(409);
    const edited = await client.patch(`/projects/${projectId}/review-replies/${replyId}`, { comment: 'Sorry for the 40-minute wait, Asha. Please call us so we can make it right.' }); // prettier-ignore
    expect(edited.body.data.status).toBe('DRAFT');
    const asked = await client.post(`/projects/${projectId}/review-replies/${replyId}/request-approval`);
    expect(asked.body.data).toMatchObject({ status: 'AWAITING_APPROVAL', approval: { status: 'PENDING', coversCurrentText: true } }); // prettier-ignore
    expect((await client.post(`/projects/${projectId}/review-replies/${replyId}/publish`)).status).toBe(409);

    const approvalId = asked.body.data.approval.id as string;
    const approval = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: approvalId } });
    expect(approval.snapshot).toMatchObject({ reply: 'Sorry for the 40-minute wait, Asha. Please call us so we can make it right.' }); // prettier-ignore
    expect(JSON.stringify(approval.snapshot)).not.toContain('Waited 40 minutes');
    expect((await client.post(`/approvals/${approvalId}/decision`, { decision: 'APPROVED' })).status).toBe(
      200,
    );

    // A member may draft but not publish.
    const member = await registerClient(app);
    await prisma.workspaceMember.create({ data: { workspaceId, userId: member.me.user.id, role: 'MEMBER' } });
    expect(
      (await member.client.post(`/projects/${projectId}/review-replies/${replyId}/publish`)).status,
    ).toBe(403);
    expect(google.calls.filter((c) => c.method === 'PUT')).toHaveLength(putsBefore);

    const published = await client.post(`/projects/${projectId}/review-replies/${replyId}/publish`);
    expect(published.status).toBe(200);
    expect(published.body.data).toMatchObject({ status: 'PUBLISHED', canPublish: false });
    const put = google.calls.filter((c) => c.method === 'PUT').at(-1)!;
    expect(put.url).toBe('https://mybusiness.googleapis.com/v4/accounts/9/locations/111/reviews/r1/reply');
    expect(JSON.parse(put.body!)).toEqual({ comment: 'Sorry for the 40-minute wait, Asha. Please call us so we can make it right.' }); // prettier-ignore
    const review = await prisma.businessReview.findUniqueOrThrow({ where: { id: reviewId } });
    expect(review.replyComment).toMatch(/^Sorry for the 40-minute wait/);
    expect(await prisma.auditLog.findFirst({ where: { action: 'review_reply.published', targetId: replyId } })).not.toBeNull(); // prettier-ignore
    expect((await client.post(`/projects/${projectId}/review-replies/${replyId}/publish`)).status).toBe(409);
  });

  it('summarises reviews into sentiment and themes, labeled as a dev template, isolated per tenant', async () => {
    const { client, projectId, locationId, workspaceId } = await linkedAndSynced();
    const res = await client.post(`/projects/${projectId}/locations/${locationId}/review-summary`);
    expect(res.status).toBe(200);
    // Two reviews synced (r1 2★ with text, r2 5★ no text); the dev adapter counts sentiment from stars only.
    expect(res.body.data).toMatchObject({
      isDevAdapter: true,
      model: 'dev-template',
      reviewCount: 2,
      themes: [],
      sentiment: { positive: 1, neutral: 0, negative: 1 },
    });
    expect(await prisma.businessReviewSummary.count({ where: { locationId } })).toBe(1);
    expect(await prisma.usageRecord.findFirst({ where: { workspaceId, idempotencyKey: { contains: 'review-summary:' } } })).toMatchObject({ metric: 'CONTENT_GENERATION' }); // prettier-ignore
    // The summary is shown on the location detail, and regenerating replaces (not duplicates) it.
    const detail = (await client.get(`/projects/${projectId}/locations/${locationId}/business-profile`)).body.data; // prettier-ignore
    expect(detail.reviewSummary).toMatchObject({ isDevAdapter: true, reviewCount: 2, stale: false });
    expect((await client.post(`/projects/${projectId}/locations/${locationId}/review-summary`)).status).toBe(200); // prettier-ignore
    expect(await prisma.businessReviewSummary.count({ where: { locationId } })).toBe(1);
    const stranger = await registerClient(app);
    expect((await stranger.client.post(`/projects/${projectId}/locations/${locationId}/review-summary`)).status).toBe(404); // prettier-ignore
  });

  it('needs a new approval after the text changes, and withdraws the pending one', async () => {
    const { client, projectId, reviewId } = await linkedAndSynced();
    const draft = await client.post(`/projects/${projectId}/reviews/${reviewId}/replies`, { comment: 'Thank you for the feedback.' }); // prettier-ignore
    expect(draft.body.data).toMatchObject({ origin: 'HUMAN', model: null });
    const replyId = draft.body.data.id as string;
    const asked = await client.post(`/projects/${projectId}/review-replies/${replyId}/request-approval`);
    const firstApproval = asked.body.data.approval.id as string;
    await client.post(`/approvals/${firstApproval}/decision`, { decision: 'APPROVED' });
    // Edited after approval: the old approval no longer covers the text.
    const edited = await client.patch(`/projects/${projectId}/review-replies/${replyId}`, { comment: 'Thank you, we have shared this with the team.' }); // prettier-ignore
    expect(edited.body.data).toMatchObject({ status: 'DRAFT', canPublish: false, approval: { coversCurrentText: false } }); // prettier-ignore
    await client.post(`/projects/${projectId}/review-replies/${replyId}/request-approval`);
    const publish = await client.post(`/projects/${projectId}/review-replies/${replyId}/publish`);
    expect(publish.status).toBe(409);
    expect(publish.body.error.details).toMatchObject({ reason: 'APPROVAL_REQUIRED' });

    // A new draft for the same review discards the old one and withdraws its pending approval.
    const replacement = await client.post(`/projects/${projectId}/reviews/${reviewId}/replies`, { comment: 'Another reply' }); // prettier-ignore
    expect(replacement.status).toBe(201);
    expect(await prisma.reviewReply.findUniqueOrThrow({ where: { id: replyId } })).toMatchObject({
      status: 'DISCARDED',
    });
    expect(await prisma.approvalRequest.count({ where: { entityId: replyId, status: 'PENDING' } })).toBe(0);
    // Google allows replies of up to 4096 bytes.
    const tooLong = await client.patch(`/projects/${projectId}/review-replies/${replacement.body.data.id}`, { comment: 'ગ'.repeat(1400) }); // prettier-ignore
    expect(tooLong.status).toBe(400);
  });
});

describe('profile field write-back (LOCATION_CHANGE)', () => {
  async function linked() {
    const ctx = await setup();
    const integration = await connect(ctx.projectId, ctx.workspaceId);
    await ctx.client.post(`/projects/${ctx.projectId}/business-profile/links`, { accountName: 'accounts/9', profileLocationName: 'locations/111', locationId: ctx.locationId }); // prettier-ignore
    await syncBusinessProfile(prisma, integration.id, google.fn);
    return ctx;
  }

  it('publishes profile edits to Google only after approval, only with publish permission, only the approved values', async () => {
    const { client, projectId, workspaceId, locationId } = await linked();
    // A proposal sends only the changed fields.
    const created = await client.post(`/projects/${projectId}/locations/${locationId}/profile-changes`, {
      title: 'Navkar Jewellers & Sons',
      websiteUri: 'https://navkar.example',
    });
    expect(created.status).toBe(201);
    const changeId = created.body.data.id as string;
    expect(created.body.data).toMatchObject({ status: 'DRAFT', fields: { title: 'Navkar Jewellers & Sons', websiteUri: 'https://navkar.example' }, canPublish: false }); // prettier-ignore
    expect(created.body.data.fields.primaryPhone).toBeUndefined();

    // Publishing without approval is refused; nothing is PATCHed to Google.
    const patchesBefore = google.calls.filter((c) => c.method === 'PATCH').length;
    expect((await client.post(`/projects/${projectId}/profile-changes/${changeId}/publish`)).status).toBe(
      409,
    );

    const asked = await client.post(`/projects/${projectId}/profile-changes/${changeId}/request-approval`);
    expect(asked.body.data).toMatchObject({ status: 'AWAITING_APPROVAL', approval: { status: 'PENDING', coversCurrentText: true } }); // prettier-ignore
    const approvalId = asked.body.data.approval.id as string;
    const approval = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: approvalId } });
    expect(approval.entityType).toBe('LOCATION_CHANGE');
    expect(approval.snapshot).toMatchObject({ fields: { title: 'Navkar Jewellers & Sons', websiteUri: 'https://navkar.example' } }); // prettier-ignore
    expect((await client.post(`/approvals/${approvalId}/decision`, { decision: 'APPROVED' })).status).toBe(
      200,
    );

    // A member may propose but not publish.
    const member = await registerClient(app);
    await prisma.workspaceMember.create({ data: { workspaceId, userId: member.me.user.id, role: 'MEMBER' } });
    expect((await member.client.post(`/projects/${projectId}/profile-changes/${changeId}/publish`)).status).toBe(403); // prettier-ignore
    expect(google.calls.filter((c) => c.method === 'PATCH')).toHaveLength(patchesBefore);

    const published = await client.post(`/projects/${projectId}/profile-changes/${changeId}/publish`);
    expect(published.status).toBe(200);
    expect(published.body.data).toMatchObject({ status: 'PUBLISHED', canPublish: false });
    const patch = google.calls.filter((c) => c.method === 'PATCH').at(-1)!;
    expect(patch.url).toContain('https://mybusinessbusinessinformation.googleapis.com/v1/locations/111?updateMask='); // prettier-ignore
    expect(decodeURIComponent(patch.url)).toContain('updateMask=title,websiteUri');
    expect(JSON.parse(patch.body!)).toEqual({ title: 'Navkar Jewellers & Sons', websiteUri: 'https://navkar.example' }); // prettier-ignore
    expect(await prisma.auditLog.findFirst({ where: { action: 'profile_change.published', targetId: locationId } })).not.toBeNull(); // prettier-ignore
    expect((await client.post(`/projects/${projectId}/profile-changes/${changeId}/publish`)).status).toBe(
      409,
    );
  });

  it('needs a new approval after the values change, validates input, and isolates tenants', async () => {
    const { client, projectId, locationId } = await linked();
    const created = await client.post(`/projects/${projectId}/locations/${locationId}/profile-changes`, { description: 'Family jewellers since 1980.' }); // prettier-ignore
    const changeId = created.body.data.id as string;
    const asked = await client.post(`/projects/${projectId}/profile-changes/${changeId}/request-approval`);
    const firstApproval = asked.body.data.approval.id as string;
    // Editing the proposal withdraws the pending approval and returns to DRAFT.
    const edited = await client.patch(`/projects/${projectId}/profile-changes/${changeId}`, { description: 'Family jewellers in Surat since 1980.' }); // prettier-ignore
    expect(edited.body.data.status).toBe('DRAFT');
    expect(await prisma.approvalRequest.findUniqueOrThrow({ where: { id: firstApproval } })).toMatchObject({ status: 'WITHDRAWN' }); // prettier-ignore
    // A bad website URL is a 400, and an empty proposal (no changed fields) is a 400.
    expect((await client.post(`/projects/${projectId}/locations/${locationId}/profile-changes`, { websiteUri: 'not-a-url' })).status).toBe(400); // prettier-ignore
    expect((await client.post(`/projects/${projectId}/locations/${locationId}/profile-changes`, {})).status).toBe(400); // prettier-ignore
    // Another tenant cannot touch this change.
    const stranger = await registerClient(app);
    expect((await stranger.client.post(`/projects/${projectId}/profile-changes/${changeId}/publish`)).status).toBe(404); // prettier-ignore
    expect((await stranger.client.delete(`/projects/${projectId}/profile-changes/${changeId}`)).status).toBe(404); // prettier-ignore
  });
});
