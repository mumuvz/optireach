import { disconnectPrisma } from '@surfaced/core/db';
import { resetEnvCache } from '@surfaced/core/env';
import {
  executeLocalRankScan,
  setLocalRankProviderOverrides,
  type LocalRankProvider,
  type LocalRankRequest,
  type ProviderLocalResult,
} from '@surfaced/core/local';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createTestApp, registerClient } from './helpers';

const { app, queues, prisma } = createTestApp();

afterAll(async () => {
  await disconnectPrisma();
});
afterEach(() => {
  setLocalRankProviderOverrides({});
  process.env.LOCAL_RANK_FIXTURES = '';
  resetEnvCache();
});

const surat = {
  name: 'Navkar Jewellers',
  kind: 'STOREFRONT',
  primaryCategory: 'Jewellery store',
  addressLine1: 'Shop 4, Ghod Dod Road',
  locality: 'Athwa',
  city: 'Surat',
  region: 'Gujarat',
  postalCode: '395007',
  country: 'IN',
  latitude: 21.1702,
  longitude: 72.8311,
  phone: '+91 261 000 0000',
  openingHours: [{ day: 'MONDAY', open: '10:00', close: '20:00' }],
};

function result(rank: number, title: string, extra: Partial<ProviderLocalResult> = {}): ProviderLocalResult {
  return { rank, title, placeId: `pl-${title.toLowerCase().replace(/\W+/g, '-')}`, cid: null, domain: null, url: null, category: 'Jewelry store', rating: 4.5, reviewCount: 100, address: null, phone: null, latitude: null, longitude: null, ...extra }; // prettier-ignore
}

/** A stand-in for the licensed provider: answers from a function of the point, never reaches the network. */
function fakeProvider(
  answer: (req: LocalRankRequest, call: number) => ProviderLocalResult[] | Error,
): LocalRankProvider {
  let calls = 0;
  return {
    key: 'CUSTOM',
    label: 'Your own collection service',
    surfaces: ['MAPS', 'LOCAL_PACK', 'ORGANIC'],
    live: true,
    configured: () => ({ configured: true, detail: 'test' }),
    fetchPoint: async (req) => {
      const out = answer(req, ++calls);
      if (out instanceof Error) throw out;
      return { results: out, costUsd: 0.002, checkedAt: new Date('2026-10-23T10:00:00Z') };
    },
  };
}

async function setup(plan: 'FREE' | 'GROWTH' = 'FREE') {
  const owner = await registerClient(app);
  if (plan !== 'FREE') {
    const change = await owner.client.post('/billing/checkout', { workspaceId: owner.workspaceId, planKey: plan, interval: 'MONTH' }); // prettier-ignore
    expect(change.status).toBe(200);
  }
  const res = await owner.client.post('/projects', {
    workspaceId: owner.workspaceId,
    name: 'Navkar Jewellers',
    targetCountries: ['IN'],
    targetLanguages: ['en'],
    businessProfile: { types: ['LOCAL_STOREFRONT', 'RETAIL_STORE'], profilePresence: 'NONE', products: ['gold jewellery'], localities: ['Athwa', 'Adajan'], goals: ['MORE_VISITS'] }, // prettier-ignore
    locations: [surat],
  });
  expect(res.status).toBe(201);
  const projectId = res.body.data.id as string;
  const locations = (await owner.client.get(`/projects/${projectId}/locations`)).body.data;
  return { ...owner, projectId, locationId: locations[0].id as string, project: res.body.data };
}

describe('businesses without a website', () => {
  it('complete onboarding with a location and get clear refusals for website-only features', async () => {
    const { client, projectId, project } = await setup('GROWTH');
    expect(project).toMatchObject({
      websiteUrl: null,
      domain: null,
      businessProfile: { types: ['LOCAL_STOREFRONT', 'RETAIL_STORE'], profilePresence: 'NONE', localities: ['Athwa', 'Adajan'] }, // prettier-ignore
    });
    const locations = (await client.get(`/projects/${projectId}/locations`)).body.data;
    expect(locations).toMatchObject([{ name: 'Navkar Jewellers', city: 'Surat', isPrimary: true, latitude: 21.1702, source: 'MANUAL', openingHours: [{ day: 'MONDAY', open: '10:00', close: '20:00' }] }]); // prettier-ignore
    const audit = await client.post(`/projects/${projectId}/audits`, {});
    expect(audit.status).toBe(400);
    expect(audit.body.error.message).toMatch(/needs a website/);
    expect((await client.post(`/projects/${projectId}/gap-analyses`)).status).toBe(400);
    expect((await client.post(`/projects/${projectId}/seo-comparisons`, {})).status).toBe(400);
    // A website can be added later.
    const updated = await client.patch(`/projects/${projectId}`, {
      websiteUrl: 'https://navkar-jewellers.example.com',
    });
    expect(updated.body.data).toMatchObject({ domain: 'navkar-jewellers.example.com' });
  });

  it('validate locations and enforce the plan location limit', async () => {
    const { client, projectId, locationId } = await setup();
    const bad = await client.post(`/projects/${projectId}/locations`, {
      ...surat,
      addressLine1: null,
      latitude: 21.1,
    });
    expect(bad.status).toBe(400);
    // The Free plan includes one business location.
    const second = await client.post(`/projects/${projectId}/locations`, { ...surat, name: 'Navkar Adajan' });
    expect(second.status).toBe(402);
    const edited = await client.send('put', `/projects/${projectId}/locations/${locationId}`, { ...surat, kind: 'SERVICE_AREA', addressLine1: null, serviceAreas: ['Surat city'] }); // prettier-ignore
    expect(edited.body.data).toMatchObject({ kind: 'SERVICE_AREA', serviceAreas: ['Surat city'] });
    const outsider = await registerClient(app);
    expect((await outsider.client.get(`/projects/${projectId}/locations`)).status).toBe(404);
    expect((await client.delete(`/projects/${projectId}/locations/${locationId}`)).status).toBe(204);
    expect((await client.get(`/projects/${projectId}/locations`)).body.data).toEqual([]);
  });
});

describe('local rank grid', () => {
  it('refuses live scans without a licensed provider and explains the setup', async () => {
    const { client, projectId, locationId } = await setup('GROWTH');
    const query = await client.post(`/projects/${projectId}/local/queries`, { query: 'best jewellers in surat', locationId, gridSize: 3, spacingKm: 1 }); // prettier-ignore
    expect(query.status).toBe(201);
    expect(query.body.data).toMatchObject({
      centerLatitude: 21.1702,
      centerLongitude: 72.8311,
      surface: 'MAPS',
      depth: 20,
    });
    const scan = await client.post(`/projects/${projectId}/local/queries/${query.body.data.id}/scans`, { source: 'CUSTOM' }); // prettier-ignore
    expect(scan.status).toBe(503);
    expect(scan.body.error.details.setup).toMatch(/CUSTOM_SERP_URL/);
    const status = (await client.get(`/projects/${projectId}/local/status`)).body.data;
    expect(status).toMatchObject({
      defaultLiveSource: null,
      hasWebsite: false,
      locations: { used: 1, limit: 10 },
    });
    expect(status.sources.find((s: { key: string }) => s.key === 'CUSTOM').available).toBe(false);
  });

  it('stores each point with query, place, provider and time, and leaves failed points out of visibility', async () => {
    const { client, projectId, locationId } = await setup('GROWTH');
    const query = (await client.post(`/projects/${projectId}/local/queries`, { query: 'best jewellers in surat', locationId, gridSize: 3, spacingKm: 1, depth: 20 })).body.data; // prettier-ignore
    // Corners: the business is 2nd; edges: not listed; the centre point fails at the provider every time.
    setLocalRankProviderOverrides({
      CUSTOM: fakeProvider((req) => {
        const dLat = Math.abs(req.latitude - 21.1702) > 1e-6;
        const dLng = Math.abs(req.longitude - 72.8311) > 1e-6;
        if (!dLat && !dLng) return new Error('Upstream timeout');
        const atEdge = dLat !== dLng;
        return atEdge
          ? [result(1, 'Kalamandir Jewellers'), result(2, 'Shree Yamunaji Jewellers', { rating: 4.9, reviewCount: 203 })]
          : [result(1, 'Kalamandir Jewellers', { rating: 4.9, reviewCount: 34_500 }), result(2, 'Navkar Jewellers'), result(3, 'KHUSHALBHAI Jewellers')]; // prettier-ignore
      }),
    });
    const started = await client.post(`/projects/${projectId}/local/queries/${query.id}/scans`, { source: 'CUSTOM' }); // prettier-ignore
    expect(started.status).toBe(202);
    const { scanId, jobId } = started.body.data;
    expect(queues.jobs.find((j) => j.jobId === jobId)).toMatchObject({ queue: 'local', data: { scanId } });
    // The operator's own collection is not billed against the licensed-point quota.
    expect(
      await prisma.usageRecord.findFirst({ where: { idempotencyKey: `local-scan:${scanId}` } }),
    ).toBeNull();

    await executeLocalRankScan(prisma, scanId);
    // Running the job again (a retry) only redoes the failed point and never duplicates points.
    await executeLocalRankScan(prisma, scanId);
    expect(await prisma.localRankPoint.count({ where: { scanId } })).toBe(9);
    const scan = (await client.get(`/projects/${projectId}/local/scans/${scanId}`)).body.data;
    expect(scan).toMatchObject({
      status: 'SUCCEEDED',
      source: 'CUSTOM',
      query: 'best jewellers in surat',
      gridSize: 3,
    });
    const failed = scan.points.filter((p: { status: string }) => p.status === 'FAILED');
    expect(failed).toHaveLength(1);
    expect(failed[0].error).toMatch(/Upstream timeout/);
    // 8 points measured: 4 with the business 2nd (top 3), 4 where it is not listed.
    expect(scan.summary).toMatchObject({ pointsPlanned: 9, pointsMeasured: 8, pointsFailed: 1, coverage: 88.9, top3: 4, notFound: 4, top3Share: 50, averageRankFound: 2 }); // prettier-ignore
    expect(scan.limitations.join(' ')).toMatch(/Only 88.9% of the grid points were measured/);
    const found = scan.points.find((p: { status: string }) => p.status === 'FOUND');
    expect(found.results.find((r: { isTarget: boolean }) => r.isTarget)).toMatchObject({
      title: 'Navkar Jewellers',
      rank: 2,
    });

    // Competitors seen near the business are suggested, not confirmed.
    const competitors = (await client.get(`/projects/${projectId}/local/competitors`)).body.data;
    expect(competitors.map((c: { name: string }) => c.name).sort()).toEqual(['KHUSHALBHAI Jewellers', 'Kalamandir Jewellers', 'Shree Yamunaji Jewellers']); // prettier-ignore
    expect(competitors.every((c: { status: string; kind: string; domain: string | null }) => c.status === 'SUGGESTED' && c.kind === 'LOCAL' && c.domain === null)).toBe(true); // prettier-ignore
    expect((await client.get(`/projects/${projectId}/competitors`)).body.data).toEqual([]);
    const kalamandir = competitors.find((c: { name: string }) => c.name === 'Kalamandir Jewellers');
    const confirmed = await client.patch(`/projects/${projectId}/local/competitors/${kalamandir.id}`, { status: 'CONFIRMED' }); // prettier-ignore
    expect(confirmed.body.data).toMatchObject({ status: 'CONFIRMED', rating: 4.9, reviewCount: 34_500 });
    expect((await client.get(`/projects/${projectId}/competitors`)).body.data).toHaveLength(1);

    const comparison = (await client.get(`/projects/${projectId}/local/queries/${query.id}/comparison`)).body
      .data;
    expect(comparison.measured).toBe(8);
    expect(comparison.showings[0]).toMatchObject({ name: 'Kalamandir Jewellers', appearances: 8, top3: 8, averageRank: 1, status: 'CONFIRMED' }); // prettier-ignore
    expect(comparison.showings.find((s: { isTarget: boolean }) => s.isTarget)).toMatchObject({ name: 'Navkar Jewellers', appearances: 4, top3: 4 }); // prettier-ignore

    const csv = await client.get(`/projects/${projectId}/local/scans/${scanId}/export`);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.text.split('\r\n')[0]).toContain('tracked_business_rank,result_rank,business');
    expect(csv.text).toContain('Your own collection service');
    const history = (await client.get(`/projects/${projectId}/local/queries/${query.id}/scans`)).body.data;
    expect(history[0]).toMatchObject({ id: scanId, summary: { top3Share: 50, coverage: 88.9 } });

    expect(await prisma.localRankPoint.findFirst({ where: { scanId, status: 'FAILED' } })).toMatchObject({
      attempts: 2,
    });
    const outsider = await registerClient(app);
    expect((await outsider.client.get(`/projects/${projectId}/local/scans/${scanId}`)).status).toBe(404);
    expect((await outsider.client.get(`/projects/${projectId}/local/scans/${scanId}/export`)).status).toBe(
      404,
    );
    expect((await outsider.client.post(`/projects/${projectId}/local/queries/${query.id}/scans`, { source: 'MANUAL' })).status).toBe(404); // prettier-ignore
  });

  it('carries sponsored, batch, source/cumulative position and the observation type through to the stored scan', async () => {
    const { client, projectId, locationId } = await setup('GROWTH');
    const query = (await client.post(`/projects/${projectId}/local/queries`, { query: 'jewellers near me', locationId, gridSize: 1, spacingKm: 1, depth: 20 })).body.data; // prettier-ignore
    // A representative response: a sponsored listing above the organic ones, and a second continuation batch
    // the source declared continuous (so a cumulative position is carried, not invented here).
    setLocalRankProviderOverrides({
      CUSTOM: {
        key: 'CUSTOM',
        label: 'Your own collection service',
        surfaces: ['MAPS', 'LOCAL_PACK', 'ORGANIC'],
        live: true,
        configured: () => ({ configured: true, detail: 'test' }),
        fetchPoint: async () => ({
          observationType: 'observed_search_position',
          costUsd: 0,
          checkedAt: new Date('2026-10-23T10:00:00Z'),
          results: [
            result(1, 'Paid Jeweller', {
              sponsored: true,
              batch: 1,
              sourcePosition: 1,
              cumulativePosition: 1,
            }),
            result(2, 'Navkar Jewellers', {
              sponsored: false,
              batch: 1,
              sourcePosition: 2,
              cumulativePosition: 2,
            }),
            result(3, 'Kalamandir Jewellers', { batch: 2, sourcePosition: 1, cumulativePosition: 3 }),
          ],
        }),
      },
    });
    const started = await client.post(`/projects/${projectId}/local/queries/${query.id}/scans`, { source: 'CUSTOM' }); // prettier-ignore
    await executeLocalRankScan(prisma, started.body.data.scanId);
    const scanId = started.body.data.scanId as string;
    const scan = (await client.get(`/projects/${projectId}/local/scans/${scanId}`)).body.data;
    expect(scan.observationType).toBe('observed_search_position');
    const point = scan.points[0];
    expect(
      point.results.map(
        (r: {
          title: string;
          sponsored?: boolean;
          batch?: number;
          sourcePosition?: number;
          cumulativePosition?: number | null;
        }) => [
          r.title,
          r.sponsored ?? null,
          r.batch ?? null,
          r.sourcePosition ?? null,
          r.cumulativePosition ?? null,
        ],
      ),
    ).toEqual([
      // prettier-ignore
      ['Paid Jeweller', true, 1, 1, 1],
      ['Navkar Jewellers', false, 1, 2, 2],
      ['Kalamandir Jewellers', null, 2, 1, 3],
    ]);
    // The tracked business keeps its observed position even with a sponsored listing above it.
    expect(point.results.find((r: { isTarget: boolean }) => r.isTarget)).toMatchObject({ title: 'Navkar Jewellers', rank: 2 }); // prettier-ignore
    // Tenant isolation still holds on the metadata-bearing scan.
    const outsider = await registerClient(app);
    expect((await outsider.client.get(`/projects/${projectId}/local/scans/${scanId}`)).status).toBe(404);
  });

  it('does not bill the operator’s own collection against the licensed-point quota', async () => {
    const { client, projectId, locationId } = await setup(); // Free plan: no licensed grid points
    setLocalRankProviderOverrides({ CUSTOM: fakeProvider(() => []) });
    const query = (await client.post(`/projects/${projectId}/local/queries`, { query: 'jewellers near me', locationId, gridSize: 5 })).body.data; // prettier-ignore
    // The operator's own collection is free to the platform, so the scan runs even on the Free plan.
    const scan = await client.post(`/projects/${projectId}/local/queries/${query.id}/scans`, {
      source: 'CUSTOM',
    });
    expect(scan.status).toBe(202);
    expect(
      await prisma.usageRecord.findFirst({
        where: { idempotencyKey: `local-scan:${scan.body.data.scanId}` },
      }),
    ).toBeNull();
  });

  it('records manual observations, labeled as manual, without creating competitor records', async () => {
    const { client, projectId, locationId } = await setup();
    const query = (await client.post(`/projects/${projectId}/local/queries`, { query: 'best jewellers in surat', locationId, gridSize: 1 })).body.data; // prettier-ignore
    const scan = await client.post(`/projects/${projectId}/local/queries/${query.id}/scans`, {
      source: 'MANUAL',
    });
    expect(scan.status).toBe(202);
    const { scanId } = scan.body.data;
    expect((await client.post(`/projects/${projectId}/local/scans/${scanId}/finish`)).status).toBe(400);
    const entered = await client.post(`/projects/${projectId}/local/scans/${scanId}/points`, {
      row: 0,
      col: 0,
      results: [{ title: 'Kalamandir Jewellers - Surat', rating: 4.9, reviewCount: 34500 }, { title: 'Navkar Jewellers Athwa', isTarget: true }], // prettier-ignore
      note: 'Searched on a phone near Athwa Gate',
    });
    expect(entered.body.data).toEqual({ rank: 2 });
    const done = (await client.post(`/projects/${projectId}/local/scans/${scanId}/finish`)).body.data;
    expect(done).toMatchObject({ status: 'SUCCEEDED', source: 'MANUAL', summary: { pointsMeasured: 1, top3: 1, top3Share: 100 } }); // prettier-ignore
    expect(done.limitations.join(' ')).toMatch(/Manual observation: entered by a person/);
    expect(await prisma.projectCompetitor.count({ where: { projectId } })).toBe(0);
  });

  it('imports local observations from a CSV as an import scan, preserving the order given', async () => {
    const { client, projectId, locationId } = await setup();
    const query = (await client.post(`/projects/${projectId}/local/queries`, { query: 'best jewellers in surat', locationId, gridSize: 3, spacingKm: 1 })).body.data; // prettier-ignore
    // A manual scan is the only source a person enters by hand; IMPORT is refused on the scan endpoint.
    expect((await client.post(`/projects/${projectId}/local/queries/${query.id}/scans`, { source: 'IMPORT' })).status).toBe(400); // prettier-ignore
    const csv = [
      'row,col,business,rank,is_tracked_business,rating,review_count,domain',
      '1,1,Kalamandir Jewellers,1,no,4.9,34500,kalamandir.example',
      '1,1,Navkar Jewellers,2,yes,4.6,210,',
      '0,0,Kalamandir Jewellers,1,no,4.9,34500,kalamandir.example',
      '9,9,Outside The Grid,1,no,,,', // skipped and reported
    ].join('\n');
    const res = await client.post(`/projects/${projectId}/local/queries/${query.id}/import`, { csv });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ pointsImported: 2, rowsParsed: 3 });
    expect(res.body.data.errors.join(' ')).toMatch(/outside the 3×3 grid/);
    const scan = (await client.get(`/projects/${projectId}/local/scans/${res.body.data.scanId}`)).body.data;
    expect(scan).toMatchObject({ status: 'SUCCEEDED', source: 'IMPORT', observationType: 'observed_search_position' }); // prettier-ignore
    expect(scan.limitations.join(' ')).toMatch(/Imported observations: shown as provided/);
    const center = scan.points.find((p: { row: number; col: number }) => p.row === 1 && p.col === 1);
    expect(center.rank).toBe(2); // the tracked business was marked at position 2
    expect(center.results.map((r: { rank: number; title: string }) => [r.rank, r.title])).toEqual([[1, 'Kalamandir Jewellers'], [2, 'Navkar Jewellers']]); // prettier-ignore
    expect(center.results.find((r: { isTarget: boolean }) => r.isTarget)).toMatchObject({ title: 'Navkar Jewellers' }); // prettier-ignore
    // An empty or column-short file is a clear 400, not a broken scan.
    expect((await client.post(`/projects/${projectId}/local/queries/${query.id}/import`, { csv: 'row,business\n0,X' })).status).toBe(400); // prettier-ignore
    const outsider = await registerClient(app);
    expect((await outsider.client.post(`/projects/${projectId}/local/queries/${query.id}/import`, { csv })).status).toBe(404); // prettier-ignore
  });

  it('stores saved Google results pages: page order kept, pages continued by Google’s start= offset', async () => {
    const { client, projectId, locationId } = await setup();
    const query = (await client.post(`/projects/${projectId}/local/queries`, { query: 'best jewellery shop in surat', locationId, gridSize: 3 })).body.data; // prettier-ignore
    // SYNTHETIC test markup following the structure of Google's local results (not a real Google page).
    const page = (title: string, items: string) => `<html><head><title>${title} - Google Search</title></head><body><div id="search">${items}</div></body></html>`; // prettier-ignore
    const item = (cid: string, name: string, extra = '') => `<div class="VkpGBb"><a data-cid="${cid}" href="#"><div role="heading">${name}</div>${extra}</a></div>`; // prettier-ignore
    const q = 'best jewellery shop in surat';
    const page1 = page(q, item('11111111111111111111', 'Sponsored Gems', '<span>Sponsored</span><div>4.2 (310) · Jewellery store</div>') + item('22222222222222222222', 'Kalamandir Jewellers', '<div>4.8 (34K) · Jewellery store</div><a href="https://www.kalamandir.example/">Website</a>')); // prettier-ignore
    const page2 = page(q, item('33333333333333333333', 'Navkar Jewellers') + item('44444444444444444444', 'Jeweller E')); // prettier-ignore
    const consent = '<html><title>Before you continue to Google</title><form action="https://consent.google.com/save"></form></html>'; // prettier-ignore
    const url1 = 'https://www.google.com/search?q=best+jewellery+shop+in+surat&udm=local';
    const url2 = `${url1}&start=20`;
    const capture = (pages: { url: string; html: string }[]) => client.post(`/projects/${projectId}/local/queries/${query.id}/google-capture`, { pages }); // prettier-ignore

    // Successful: two pages; page 2 continues at Google's offset (21, 22), never re-sorted.
    const ok = await capture([
      { url: url1, html: page1 },
      { url: url2, html: page2 },
    ]);
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({
      collectionStatus: 'successful',
      query: q,
      surface: 'places',
      listings: 4,
    });
    expect(ok.body.data.batches.map((b: { batch: number; start: number; status: string; listings: number; sponsored: number }) => [b.batch, b.start, b.status, b.listings, b.sponsored])).toEqual([[1, 0, 'parsed', 2, 1], [2, 20, 'parsed', 2, 0]]); // prettier-ignore
    const scan = (await client.get(`/projects/${projectId}/local/scans/${ok.body.data.scanId}`)).body.data;
    expect(scan).toMatchObject({ source: 'GOOGLE_CAPTURE', status: 'SUCCEEDED', collectionStatus: 'successful', observationType: 'observed_search_position', gridSize: 1 }); // prettier-ignore
    expect(scan.captureBatches).toHaveLength(2);
    const results = scan.points[0].results as { rank: number; title: string; batch: number; sourcePosition: number; cumulativePosition: number; sponsored: boolean; isTarget: boolean; website?: string; mapsUrl?: string }[]; // prettier-ignore
    expect(
      results.map((r) => [r.rank, r.title, r.batch, r.sourcePosition, r.cumulativePosition, r.sponsored]),
    ).toEqual([
      [1, 'Sponsored Gems', 1, 1, 1, true],
      [2, 'Kalamandir Jewellers', 1, 2, 2, false],
      [21, 'Navkar Jewellers', 2, 1, 21, false],
      [22, 'Jeweller E', 2, 2, 22, false],
    ]);
    expect(scan.points[0]).toMatchObject({ status: 'FOUND', rank: 21 }); // the tracked business, as observed
    expect(results.find((r) => r.isTarget)).toMatchObject({ title: 'Navkar Jewellers' });
    expect(results[1]).toMatchObject({ website: 'https://www.kalamandir.example/', mapsUrl: 'https://maps.google.com/?cid=22222222222222222222' }); // prettier-ignore
    expect(scan.limitations.join(' ')).toMatch(/OptiReach did not request the page from Google/);

    // Partial: page 2 is Google's consent page → recorded as failed, page 1 kept.
    const partial = await capture([
      { url: url1, html: page1 },
      { url: url2, html: consent },
    ]);
    expect(partial.body.data).toMatchObject({ collectionStatus: 'partial', listings: 2 });
    expect(partial.body.data.batches[1]).toMatchObject({ status: 'failed', error: expect.stringMatching(/consent/) }); // prettier-ignore
    // The collection stays open (resumable): page 1 is kept, and the failed page can be saved again and added.
    expect((await client.get(`/projects/${projectId}/local/scans/${partial.body.data.scanId}`)).body.data).toMatchObject({ collectionStatus: 'in_progress', captureProgress: { state: 'IN_PROGRESS', uniqueBusinesses: 2, reason: expect.stringMatching(/Page 2 was not read: .*consent/) } }); // prettier-ignore

    // Failed: nothing readable → a failed scan is kept for the record, with the reason.
    const failed = await capture([{ url: url1, html: consent }]);
    expect(failed.body.data.collectionStatus).toBe('failed');
    const failedScan = (await client.get(`/projects/${projectId}/local/scans/${failed.body.data.scanId}`))
      .body.data;
    expect(failedScan).toMatchObject({ status: 'FAILED', collectionStatus: 'failed', errorMessage: expect.stringMatching(/consent/) }); // prettier-ignore

    // Unavailable: a results page with no local listings → nothing stored, nothing invented.
    const scansBefore = await prisma.localRankScan.count({ where: { queryId: query.id } });
    const none = await capture([{ url: url1, html: page(q, '<div>web results only</div>') }]);
    expect(none.body.data).toMatchObject({ scanId: null, collectionStatus: 'unavailable', listings: 0 });
    expect(await prisma.localRankScan.count({ where: { queryId: query.id } })).toBe(scansBefore);

    // A file that does not belong to its address is refused for that page.
    const mismatch = await capture([{ url: 'https://www.google.com/search?q=jewellers+in+ahmedabad&udm=local', html: page1 }]); // prettier-ignore
    expect(mismatch.body.data).toMatchObject({ collectionStatus: 'failed' });
    expect(mismatch.body.data.batches[0].error).toMatch(/not “jewellers in ahmedabad”/);
    // Invalid addresses and mixed searches are 400s; the scan endpoint refuses this source.
    expect((await capture([{ url: 'https://www.google.com/maps/search/jewellers', html: page1 }])).status).toBe(400); // prettier-ignore
    expect((await capture([{ url: url1, html: page1 }, { url: 'https://www.google.com/search?q=other&start=20', html: page2 }])).status).toBe(400); // prettier-ignore
    expect((await client.post(`/projects/${projectId}/local/queries/${query.id}/scans`, { source: 'GOOGLE_CAPTURE' })).status).toBe(400); // prettier-ignore
    const outsider = await registerClient(app);
    expect((await outsider.client.post(`/projects/${projectId}/local/queries/${query.id}/google-capture`, { pages: [{ url: url1, html: page1 }] })).status).toBe(404); // prettier-ignore
  });

  it('uses the labeled development fixture only when enabled', async () => {
    const { client, projectId, locationId } = await setup();
    const query = (await client.post(`/projects/${projectId}/local/queries`, { query: 'gold jewellery shop', locationId, gridSize: 3 })).body.data; // prettier-ignore
    expect((await client.post(`/projects/${projectId}/local/queries/${query.id}/scans`, { source: 'FIXTURE' })).status).toBe(503); // prettier-ignore
    process.env.LOCAL_RANK_FIXTURES = 'true';
    resetEnvCache();
    const scan = await client.post(`/projects/${projectId}/local/queries/${query.id}/scans`, {
      source: 'FIXTURE',
    });
    expect(scan.status).toBe(202);
    await executeLocalRankScan(prisma, scan.body.data.scanId);
    const detail = (await client.get(`/projects/${projectId}/local/scans/${scan.body.data.scanId}`)).body
      .data;
    expect(detail.summary.pointsMeasured).toBe(9);
    expect(detail.limitations.join(' ')).toMatch(/not real Google data/);
    // Fixture results never become competitor records, and use no quota.
    expect(await prisma.projectCompetitor.count({ where: { projectId } })).toBe(0);
  });
});
