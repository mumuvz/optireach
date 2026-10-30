import { executeCompetitorSnapshot } from '@surfaced/core/competitors';
import { disconnectPrisma } from '@surfaced/core/db';
import { afterAll, describe, expect, it } from 'vitest';
import { createTestApp, registerClient } from './helpers';

const { app, prisma } = createTestApp();

afterAll(async () => {
  await disconnectPrisma();
});

async function setPlan(workspaceId: string, key: string) {
  const plan = await prisma.subscriptionPlan.findUniqueOrThrow({ where: { key } });
  await prisma.subscription.update({ where: { workspaceId }, data: { planId: plan.id } });
}

/** Project with two competitors and three observations whose mentions/citations are known exactly. */
async function setup() {
  const owner = await registerClient(app);
  const res = await owner.client.post('/projects', {
    workspaceId: owner.workspaceId,
    name: 'Acme Analytics',
    websiteUrl: 'acme-analytics.example.com',
    targetCountries: ['US'],
    targetLanguages: ['en'],
    competitors: [
      { name: 'Alpha Insights', domain: 'alpha.example.net' },
      { name: 'Beta Metrics', domain: 'beta.example.org' },
    ],
  });
  const projectId = res.body.data.id as string;
  const [alpha, beta] = res.body.data.competitors as { id: string }[];
  const prompt = await prisma.aiPrompt.create({
    data: {
      projectId,
      text: 'Best analytics tool for SaaS?',
      country: 'US',
      language: 'en',
      targetBrand: 'Acme Analytics',
      providers: ['mock_demo'],
    },
  });
  const run = await prisma.aiVisibilityRun.create({ data: { projectId, status: 'SUCCEEDED' } });
  const make = async (
    i: number,
    brand: boolean,
    competitors: { id: string; name: string }[],
    domains: string[],
  ) =>
    prisma.aiVisibilityObservation.create({
      data: {
        runId: run.id,
        promptId: prompt.id,
        projectId,
        provider: 'openai_web_search',
        country: 'US',
        language: 'en',
        promptText: prompt.text,
        status: 'SUCCEEDED',
        answerText: 'stored answer',
        brandMentioned: brand,
        brandRank: brand ? 2 : null,
        idempotencyKey: `${run.id}:${prompt.id}:obs${i}`,
        mentions: {
          create: [
            ...(brand
              ? [
                  {
                    entityType: 'BRAND' as const,
                    entityName: 'Acme Analytics',
                    matchedText: 'Acme Analytics',
                    matchType: 'NAME' as const,
                    position: 20,
                    rank: 2,
                  },
                ]
              : []),
            ...competitors.map((c, idx) => ({
              entityType: 'COMPETITOR' as const,
              competitorId: c.id,
              entityName: c.name,
              matchedText: c.name,
              matchType: 'NAME' as const,
              position: idx,
              rank: idx + 1,
            })),
          ],
        },
        citations: {
          create: domains.map((domain, idx) => ({
            url: `https://${domain}/page`,
            domain,
            position: idx + 1,
            sourceType: 'INLINE_CITATION' as const,
          })),
        },
      },
    });
  await make(1, true, [{ id: alpha!.id, name: 'Alpha Insights' }], ['reviews.example.com']);
  await make(2, false, [{ id: alpha!.id, name: 'Alpha Insights' }], ['directory.example.org']);
  await make(
    3,
    false,
    [
      { id: alpha!.id, name: 'Alpha Insights' },
      { id: beta!.id, name: 'Beta Metrics' },
    ],
    ['directory.example.org'],
  );
  return { ...owner, projectId, alpha: alpha!, beta: beta!, promptId: prompt.id };
}

describe('competitor analysis', () => {
  it('is gated to plans that include competitor analysis', async () => {
    const { client, projectId } = await setup();
    const res = await client.get(`/projects/${projectId}/competitors/comparison`);
    expect(res.status).toBe(402);
    expect(res.body.error.details).toMatchObject({ feature: 'competitorAnalysis', plan: 'FREE' });
  });

  it('compares mentions, citations, ranks and sources from stored observations', async () => {
    const { client, projectId, workspaceId, alpha, beta, promptId } = await setup();
    await setPlan(workspaceId, 'GROWTH');
    const res = await client.get(`/projects/${projectId}/competitors/comparison`);
    expect(res.status).toBe(200);
    const [brand, a, b] = res.body.data.entities;
    expect(brand).toMatchObject({ isBrand: true, mentions: 1, averageRank: 2 });
    expect(brand.mentionRate).toBeCloseTo(1 / 3);
    expect(a).toMatchObject({ id: alpha.id, mentions: 3, mentionRate: 1, averageRank: 1 });
    expect(b).toMatchObject({ id: beta.id, mentions: 1 });
    expect(brand.shareOfVoice).toBeCloseTo(1 / 5);
    const alphaSources = res.body.data.sources.find(
      (s: { competitorId: string }) => s.competitorId === alpha.id,
    );
    expect(alphaSources).toMatchObject({
      shared: ['reviews.example.com'],
      onlyWithCompetitor: ['directory.example.org'],
    });

    const gaps = await client.get(`/projects/${projectId}/competitors/topic-gaps`);
    expect(gaps.body.data).toHaveLength(1);
    expect(gaps.body.data[0]).toMatchObject({
      promptId,
      observations: 3,
      brandAbsentWhileCompetitorsPresent: 2,
    });
    expect(gaps.body.data[0].competitorsMentioned[0]).toEqual({ name: 'Alpha Insights', count: 2 });

    const trend = await client.get(`/projects/${projectId}/competitors/trend?bucket=day`);
    expect(trend.body.data.points[0].competitors[alpha.id]).toBe(1);

    const metadata = await client.get(`/projects/${projectId}/competitors/metadata`);
    expect(metadata.body.data[0]).toMatchObject({ isBrand: true, source: 'none' }); // no crawl yet: nothing estimated
  });

  it('refuses to snapshot competitor domains that the SSRF policy blocks', async () => {
    const { client, projectId, workspaceId } = await setup();
    await setPlan(workspaceId, 'GROWTH');
    const internal = await prisma.projectCompetitor.create({
      data: { projectId, name: 'Internal', domain: '10.0.0.5' },
    });
    const start = await client.post(`/projects/${projectId}/competitors/${internal.id}/snapshot`);
    expect(start.status).toBe(202);
    await expect(
      executeCompetitorSnapshot(prisma, start.body.data.snapshotId, { allowlist: [] }),
    ).rejects.toMatchObject({ name: 'UnsafeTargetError' });
  });
});

describe('recommendations', () => {
  it('generates evidence-based recommendations and supports the status workflow', async () => {
    const { client, projectId, promptId } = await setup();
    const regen = await client.post(`/projects/${projectId}/recommendations/regenerate`);
    expect(regen.status).toBe(200);
    expect(regen.body.data.visibility.created).toBe(2);

    const list = await client.get(`/projects/${projectId}/recommendations`);
    const items = list.body.data.items as {
      id: string;
      category: string;
      title: string;
      evidence: Record<string, unknown>;
    }[];
    const gapRec = items.find((r) => r.category === 'AEO')!;
    expect(gapRec.evidence.promptId).toBe(promptId);
    expect(gapRec.title).toMatch(/Best analytics tool for SaaS/);
    const sourceRec = items.find((r) => r.category === 'GEO')!;
    expect(sourceRec.evidence.domain).toBe('directory.example.org');
    expect(list.body.data.byStatus.OPEN).toBe(2);

    // Generated recommendations carry a default owner role, effort and a verification step.
    expect(gapRec).toMatchObject({ ownerRole: 'WRITER', effort: 'LARGE' });
    expect((gapRec as unknown as { verification: string }).verification).toBeTruthy();

    const planned = await client.patch(`/recommendations/${gapRec.id}`, { status: 'PLANNED', ownerRole: 'SEO', effort: 'MEDIUM' }); // prettier-ignore
    expect(planned.body.data).toMatchObject({ status: 'PLANNED', ownerRole: 'SEO', effort: 'MEDIUM' });
    expect(planned.body.data.plannedAt).not.toBeNull();
    const started = await client.patch(`/recommendations/${gapRec.id}`, { status: 'IN_PROGRESS' });
    expect(started.body.data.startedAt).not.toBeNull();
    const done = await client.patch(`/recommendations/${gapRec.id}`, { status: 'COMPLETED' });
    expect(done.body.data.completedAt).not.toBeNull();
    // Verify is a human confirmation after completion; it records who and when.
    const verified = await client.patch(`/recommendations/${gapRec.id}`, { status: 'VERIFIED' });
    expect(verified.body.data).toMatchObject({
      status: 'VERIFIED',
      verifiedBy: { name: expect.any(String) },
    });
    expect(verified.body.data.verifiedAt).not.toBeNull();

    // Blocking needs a reason.
    expect((await client.patch(`/recommendations/${gapRec.id}`, { status: 'BLOCKED' })).status).toBe(400);
    const blocked = await client.patch(`/recommendations/${gapRec.id}`, { status: 'BLOCKED', blockedReason: 'Waiting on the design team' }); // prettier-ignore
    expect(blocked.body.data).toMatchObject({
      status: 'BLOCKED',
      blockedReason: 'Waiting on the design team',
    });
    // Unblocking clears the block and the earlier verification.
    const unblocked = await client.patch(`/recommendations/${gapRec.id}`, { status: 'OPEN' });
    expect(unblocked.body.data).toMatchObject({ status: 'OPEN', blockedReason: null, verifiedAt: null });
    const dismissed = await client.patch(`/recommendations/${sourceRec.id}`, {
      status: 'DISMISSED',
      dismissedReason: 'Not relevant for us',
    });
    expect(dismissed.body.data).toMatchObject({
      status: 'DISMISSED',
      dismissedReason: 'Not relevant for us',
    });
    const reopened = await client.patch(`/recommendations/${sourceRec.id}`, { status: 'OPEN' });
    expect(reopened.body.data).toMatchObject({ status: 'OPEN', dismissedAt: null, dismissedReason: null });
    expect((await client.patch(`/recommendations/${gapRec.id}`, { assigneeId: 'u'.repeat(25) })).status).toBe(
      400,
    );

    // Dismissed recommendations stay dismissed when regenerated.
    await client.patch(`/recommendations/${sourceRec.id}`, { status: 'DISMISSED' });
    await client.post(`/projects/${projectId}/recommendations/regenerate`);
    expect((await client.get(`/recommendations/${sourceRec.id}`)).body.data.status).toBe('DISMISSED');

    const other = await registerClient(app);
    expect((await other.client.get(`/recommendations/${gapRec.id}`)).status).toBe(404);
    expect((await other.client.get(`/projects/${projectId}/recommendations`)).status).toBe(404);
    expect((await other.client.patch(`/recommendations/${gapRec.id}`, { status: 'DISMISSED' })).status).toBe(
      404,
    );
  });
});
