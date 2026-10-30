import { executeSeoComparison, type SiteCrawler } from '@surfaced/core/competitors';
import { disconnectPrisma } from '@surfaced/core/db';
import { afterAll, describe, expect, it } from 'vitest';
import { createTestApp, registerClient } from './helpers';

const { app, queues, prisma } = createTestApp();

afterAll(async () => {
  await disconnectPrisma();
});

async function setPlan(workspaceId: string, key: string) {
  const plan = await prisma.subscriptionPlan.findUniqueOrThrow({ where: { key } });
  await prisma.subscription.update({ where: { workspaceId }, data: { planId: plan.id } });
}

async function setup(competitors = [{ name: 'Rival', domain: 'rival-seo.example.net' }]) {
  const owner = await registerClient(app);
  const res = await owner.client.post('/projects', {
    workspaceId: owner.workspaceId,
    name: 'Acme Invites',
    websiteUrl: 'acme-invites-seo.example.com',
    targetCountries: ['IN'],
    targetLanguages: ['en'],
    competitors,
  });
  return {
    ...owner,
    projectId: res.body.data.id as string,
    competitorIds: (res.body.data.competitors as { id: string }[]).map((c) => c.id),
  };
}

/** No network in API tests: every site reports that it could not be read. */
const offlineCrawler: SiteCrawler = async () => ({
  status: 'UNREACHABLE',
  error: 'Offline test crawler.',
  input: null,
  pagesCrawled: 0,
  limitReached: false,
  timeLimitReached: false,
});

describe('SEO comparison API', () => {
  it('is gated to plans with competitor analysis', async () => {
    const { client, projectId } = await setup();
    expect((await client.get(`/projects/${projectId}/seo-comparisons/latest`)).status).toBe(402);
    expect((await client.post(`/projects/${projectId}/seo-comparisons`, {})).status).toBe(402);
  });

  it('needs competitors and accepts at most five', async () => {
    const none = await setup([]);
    await setPlan(none.workspaceId, 'GROWTH');
    const res = await none.client.post(`/projects/${none.projectId}/seo-comparisons`, {});
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/Add at least one competitor/);

    const { client, projectId, workspaceId } = await setup();
    await setPlan(workspaceId, 'GROWTH');
    const ids = Array.from({ length: 6 }, (_, i) => `c${i}aaaaaaaaaaaaaaaaaaaaaaa`);
    expect((await client.post(`/projects/${projectId}/seo-comparisons`, { competitorIds: ids })).status).toBe(
      400,
    );
  });

  it('queues one comparison at a time, counts competitor snapshots and saves suggestions', async () => {
    const { client, projectId, workspaceId, competitorIds } = await setup();
    await setPlan(workspaceId, 'GROWTH');
    const started = await client.post(`/projects/${projectId}/seo-comparisons`, {});
    expect(started.status).toBe(202);
    const { comparisonId, jobId } = started.body.data as { comparisonId: string; jobId: string };
    expect(queues.jobs.find((j) => j.jobId === jobId)?.data).toMatchObject({ seoComparisonId: comparisonId });
    expect((await client.post(`/projects/${projectId}/seo-comparisons`, {})).status).toBe(409);
    const usage = await prisma.usageRecord.findFirst({
      where: { idempotencyKey: `seo-comparison:${comparisonId}` },
    });
    expect(usage).toMatchObject({ metric: 'COMPETITOR_SNAPSHOT', quantity: competitorIds.length });

    const queued = await client.get(`/projects/${projectId}/seo-comparisons/latest`);
    expect(queued.body.data).toMatchObject({ status: 'QUEUED', competitorIds, result: null });

    await executeSeoComparison(prisma, comparisonId, { crawler: offlineCrawler });
    const done = (await client.get(`/projects/${projectId}/seo-comparisons/latest`)).body.data;
    expect(done.status).toBe('SUCCEEDED');
    expect(done.result.sites.map((s: { status: string }) => s.status)).toEqual([
      'UNREACHABLE',
      'UNREACHABLE',
    ]);
    expect(done.result.suggestions).toEqual([
      expect.objectContaining({ key: 'site-unreadable', priority: 1 }),
    ]);

    const save = (suggestionKey: string) =>
      client.post(`/projects/${projectId}/seo-comparisons/${comparisonId}/recommendations`, {
        suggestionKey,
      });
    const first = await save('site-unreadable');
    expect(first.status).toBe(200);
    expect(first.body.data).toMatchObject({ created: true, recommendation: { source: 'COMPETITOR' } });
    expect((await save('site-unreadable')).body.data.created).toBe(false);
    expect((await save('nope')).status).toBe(404);
  });

  it('keeps comparisons inside their tenant', async () => {
    const { projectId, workspaceId } = await setup();
    await setPlan(workspaceId, 'GROWTH');
    const outsider = await registerClient(app);
    await setPlan(outsider.workspaceId, 'GROWTH');
    expect((await outsider.client.get(`/projects/${projectId}/seo-comparisons/latest`)).status).toBe(404);
    expect((await outsider.client.post(`/projects/${projectId}/seo-comparisons`, {})).status).toBe(404);
  });
});
