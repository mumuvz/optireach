// Automatic batch collection. The source is a TEST-ONLY fake provider (registered through the provider override),
// returning synthetic businesses; it is never selectable in production. It pages with a numeric cursor like a real
// source and can be told to fail, rate-limit, loop or repeat itself.
import { disconnectPrisma } from '@surfaced/core/db';
import {
  LocalRankProviderError,
  runLocalCollection,
  setLocalRankProviderOverrides,
  type LocalBatchRequest,
  type LocalBatchResult,
  type LocalRankProvider,
  type ProviderLocalResult,
} from '@surfaced/core/local';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createTestApp, registerClient } from './helpers';

const { app, queues, prisma } = createTestApp();
afterAll(async () => {
  await disconnectPrisma();
});
afterEach(() => setLocalRankProviderOverrides({}));

const biz = (n: number): ProviderLocalResult => ({ rank: n, title: `Business ${n}`, placeId: `place-${n}`, cid: null, domain: null, url: null, category: 'Jewelry store', rating: 4.5, reviewCount: 10, address: `${n} Ring Rd`, phone: null, latitude: null, longitude: null }); // prettier-ignore

/** A synthetic source: `pages[k]` is what the cursor String(offset) returns; behaviour hooks per cursor. */
function source(
  pages: Record<string, { items: number[]; next: string | null }>,
  hooks: { before?: (cursor: string) => Promise<void> | void } = {},
) {
  const calls: { cursor: string | null; limit: number }[] = [];
  const provider: LocalRankProvider = {
    key: 'CUSTOM',
    label: 'Your own collection service',
    surfaces: ['MAPS', 'LOCAL_PACK', 'ORGANIC'],
    live: true,
    configured: () => ({ configured: true, detail: 'test source' }),
    batching: { maxBatchSize: 20, minDelayMs: 0, pagination: 'test cursor', observationType: 'observed_search_position', googleRanking: false }, // prettier-ignore
    fetchBatch: async (req: LocalBatchRequest): Promise<LocalBatchResult> => {
      const cursor = req.cursor ?? '0';
      calls.push({ cursor: req.cursor, limit: req.limit });
      await hooks.before?.(cursor);
      const page = pages[cursor];
      if (!page) throw new Error(`unexpected cursor ${cursor}`);
      return { results: page.items.slice(0, req.limit).map(biz), offset: Number(cursor), nextCursor: page.next, costUsd: 0, checkedAt: new Date(), observationType: 'observed_search_position', note: null }; // prettier-ignore
    },
  };
  return { provider, calls };
}
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
/** 50 businesses in batches of 20 / 20 / 11; the second batch repeats Business 5. */
const FIFTY = {
  '0': { items: range(1, 20), next: '20' },
  '20': { items: [...range(21, 39), 5], next: '40' },
  '40': { items: range(40, 50), next: null },
};

async function setup() {
  const { client, workspaceId } = await registerClient(app);
  const project = (await client.post('/projects', { workspaceId, name: 'Batch Co', targetCountries: ['IN'], targetLanguages: ['en'], locations: [{ name: 'Batch Co', kind: 'STOREFRONT', addressLine1: 'Ring Rd', city: 'Surat', country: 'IN', latitude: 21.17, longitude: 72.83 }] })).body.data; // prettier-ignore
  const location = (await client.get(`/projects/${project.id}/locations`)).body.data[0];
  const query = (await client.post(`/projects/${project.id}/local/queries`, { query: 'best jewellery shop in surat', locationId: location.id, gridSize: 1 })).body.data; // prettier-ignore
  const start = (body: Record<string, unknown> = {}) =>
    client.post(`/projects/${project.id}/local/queries/${query.id}/collections`, {
      source: 'CUSTOM',
      ...body,
    });
  const control = (scanId: string, action: string) =>
    client.post(`/projects/${project.id}/local/scans/${scanId}/collection/${action}`);
  const scan = async (scanId: string) => (await client.get(`/projects/${project.id}/local/scans/${scanId}`)).body.data; // prettier-ignore
  return { client, projectId: project.id as string, queryId: query.id as string, start, control, scan };
}
/** The run ID of the latest job queued for a scan (what the worker would run). */
const runIdOf = (scanId: string) =>
  [...queues.jobs].reverse().find((j) => (j.data as { scanId?: string }).scanId === scanId)!.data as { collectionRunId: string }; // prettier-ignore

type Row = { title: string; rank: number; batch: number; sourcePosition: number; cumulativePosition?: number; alsoSeen?: { batch: number; sourcePosition: number; cumulativePosition: number | null }[] }; // prettier-ignore

describe('automatic batch collection', () => {
  it('collects batches of up to 20 by the source’s cursor, waits between requests, de-duplicates, and stops when the source ends', async () => {
    const { start, scan } = await setup();
    const fake = source(FIFTY);
    setLocalRankProviderOverrides({ CUSTOM: fake.provider });
    const started = await start();
    expect(started.status).toBe(202);
    const id = started.body.data.scanId as string;
    const waits: number[] = [];
    const run = await runLocalCollection(prisma, id, { runId: runIdOf(id).collectionRunId, sleep: async (ms) => void waits.push(ms) }); // prettier-ignore
    expect(run).toEqual({ state: 'SOURCE_EXHAUSTED', batches: 3 });
    // The source's own pagination was followed, 20 at a time, with the default 2 s between requests.
    expect(fake.calls).toEqual([{ cursor: null, limit: 20 }, { cursor: '20', limit: 20 }, { cursor: '40', limit: 20 }]); // prettier-ignore
    expect(waits).toEqual([2000, 2000]);
    const done = await scan(id);
    expect(done).toMatchObject({ status: 'SUCCEEDED', collectionStatus: 'successful' });
    expect(done.captureProgress).toMatchObject({ state: 'SOURCE_EXHAUSTED', target: 1000, uniqueBusinesses: 50, duplicatesSkipped: 1, pagesProcessed: 3, source: 'CUSTOM', sourceLabel: 'Your own collection service', observationType: 'observed_search_position', automatic: true, batchSize: 20, delayMs: 2000, hasMore: false, reason: expect.stringMatching(/Batch 3 \(results from #41\) came with no further cursor.*50 unique/) }); // prettier-ignore
    const rows = done.points[0].results as Row[];
    expect(rows).toHaveLength(50);
    // Business 5 keeps its first observed position (#5); its second sighting (#40) is recorded on it.
    expect(rows.find((r) => r.title === 'Business 5')).toMatchObject({ rank: 5, batch: 1, sourcePosition: 5, alsoSeen: [{ batch: 2, sourcePosition: 20, cumulativePosition: 40 }] }); // prettier-ignore
    // Positions follow the source's own offsets: batch 2 held a repeat at #40, so Business 50 is #51 at the source.
    expect(rows.find((r) => r.title === 'Business 50')).toMatchObject({
      rank: 51,
      batch: 3,
      sourcePosition: 11,
    });
    expect(done.limitations.join(' ')).toMatch(/Collected automatically from Your own collection service in 3 batches of up to 20, at least 2s apart/); // prettier-ignore
  });

  it('stops successfully at the configured target, with the configured batch size and delay', async () => {
    const { start, scan } = await setup();
    const fake = source(FIFTY);
    setLocalRankProviderOverrides({ CUSTOM: fake.provider });
    const id = (await start({ target: 25, batchSize: 10, delayMs: 3000 })).body.data.scanId as string;
    const pages10 = { '0': { items: range(1, 10), next: '10' }, '10': { items: range(11, 20), next: '20' }, '20': { items: range(21, 30), next: '30' }, '30': { items: range(31, 40), next: null } }; // prettier-ignore
    setLocalRankProviderOverrides({ CUSTOM: source(pages10).provider });
    const waits: number[] = [];
    const run = await runLocalCollection(prisma, id, { runId: runIdOf(id).collectionRunId, sleep: async (ms) => void waits.push(ms) }); // prettier-ignore
    expect(run.state).toBe('TARGET_REACHED');
    expect(waits).toEqual([3000, 3000]);
    expect((await scan(id)).captureProgress).toMatchObject({ state: 'TARGET_REACHED', uniqueBusinesses: 30, target: 25, batchSize: 10, delayMs: 3000 }); // prettier-ignore
  });

  it('pauses (keeping the batch in flight), resumes from the saved cursor, and stops a superseded run', async () => {
    const { start, control, scan } = await setup();
    let id = '';
    const fake = source(FIFTY, { before: async (cursor) => void (cursor === '20' && (await control(id, 'pause'))) }); // prettier-ignore
    setLocalRankProviderOverrides({ CUSTOM: fake.provider });
    id = (await start()).body.data.scanId as string;
    const firstRun = runIdOf(id).collectionRunId;
    const paused = await runLocalCollection(prisma, id, { runId: firstRun, sleep: async () => {} });
    expect(paused).toEqual({ state: 'PAUSED', batches: 2 }); // batch 2 was in flight and is kept
    expect((await scan(id)).captureProgress).toMatchObject({ state: 'PAUSED', uniqueBusinesses: 39, hasMore: true, reason: expect.stringMatching(/Paused by you/) }); // prettier-ignore
    expect((await control(id, 'pause')).status).toBe(409);

    setLocalRankProviderOverrides({ CUSTOM: source(FIFTY).provider });
    expect((await control(id, 'resume')).status).toBe(200);
    const secondRun = runIdOf(id).collectionRunId;
    expect(secondRun).not.toBe(firstRun);
    // The old run, if it were still alive, stops at once.
    expect(await runLocalCollection(prisma, id, { runId: firstRun, sleep: async () => {} })).toEqual({ state: 'IN_PROGRESS', batches: 0 }); // prettier-ignore
    const resumed = await runLocalCollection(prisma, id, { runId: secondRun, sleep: async () => {} });
    expect(resumed).toEqual({ state: 'SOURCE_EXHAUSTED', batches: 1 }); // only the remaining batch was requested
    expect((await scan(id)).captureProgress).toMatchObject({ uniqueBusinesses: 50, pagesProcessed: 3 });
  });

  it('stops on a refusal keeping every batch, and Retry continues from the same cursor', async () => {
    const { start, control, scan } = await setup();
    let refuse = true;
    const fake = source(FIFTY, {
      before: (cursor) => {
        if (cursor === '20' && refuse) throw new LocalRankProviderError('CUSTOM', 'NOT_CONFIGURED', 'The service rejected the token.'); // prettier-ignore
      },
    });
    setLocalRankProviderOverrides({ CUSTOM: fake.provider });
    const id = (await start()).body.data.scanId as string;
    const failed = await runLocalCollection(prisma, id, {
      runId: runIdOf(id).collectionRunId,
      sleep: async () => {},
    });
    expect(failed).toEqual({ state: 'FAILED', batches: 1 });
    expect((await scan(id)).captureProgress).toMatchObject({ state: 'FAILED', uniqueBusinesses: 20, reason: expect.stringMatching(/Stopped: The service rejected the token\..*Retry continues from batch 2/) }); // prettier-ignore
    refuse = false;
    expect((await control(id, 'retry')).status).toBe(200);
    const retried = await runLocalCollection(prisma, id, {
      runId: runIdOf(id).collectionRunId,
      sleep: async () => {},
    });
    expect(retried).toEqual({ state: 'SOURCE_EXHAUSTED', batches: 2 });
    expect(fake.calls.map((c) => c.cursor)).toEqual([null, '20', '20', '40']); // never restarted from the beginning
    expect((await scan(id)).captureProgress.uniqueBusinesses).toBe(50);
  });

  it('backs off on rate limits (honouring Retry-After), and stops when the limit persists', async () => {
    const { start, scan } = await setup();
    let limited = 1;
    const fake = source(FIFTY, {
      before: (cursor) => {
        if (cursor === '20' && limited-- > 0) throw new LocalRankProviderError('CUSTOM', 'RATE_LIMITED', 'Slow down.', 5000); // prettier-ignore
      },
    });
    setLocalRankProviderOverrides({ CUSTOM: fake.provider });
    const id = (await start()).body.data.scanId as string;
    const waits: number[] = [];
    const run = await runLocalCollection(prisma, id, { runId: runIdOf(id).collectionRunId, sleep: async (ms) => void waits.push(ms) }); // prettier-ignore
    expect(run.state).toBe('SOURCE_EXHAUSTED');
    expect(waits).toEqual([2000, 5000, 2000]); // the normal pause, the source's Retry-After, the normal pause

    const always = await setup();
    setLocalRankProviderOverrides({ CUSTOM: source(FIFTY, { before: () => { throw new LocalRankProviderError('CUSTOM', 'RATE_LIMITED', 'Slow down.'); } }).provider }); // prettier-ignore
    const id2 = (await always.start()).body.data.scanId as string;
    const backoff: number[] = [];
    const stopped = await runLocalCollection(prisma, id2, { runId: runIdOf(id2).collectionRunId, sleep: async (ms) => void backoff.push(ms) }); // prettier-ignore
    expect(stopped).toEqual({ state: 'FAILED', batches: 0 });
    expect(backoff).toEqual([4000, 8000, 16000]); // longer each time, then it stops instead of hammering the source
    expect((await always.scan(id2)).captureProgress.reason).toMatch(/Stopped: Slow down\./);
    expect(await scan(id)).toBeTruthy();
  });

  it('detects a cursor that loops back and batches with nothing new', async () => {
    const loop = await setup();
    setLocalRankProviderOverrides({ CUSTOM: source({ '0': { items: range(1, 20), next: '20' }, '20': { items: range(21, 30), next: '0' } }).provider }); // prettier-ignore
    const loopId = (await loop.start()).body.data.scanId as string;
    expect((await runLocalCollection(prisma, loopId, { runId: runIdOf(loopId).collectionRunId, sleep: async () => {} })).state).toBe('SOURCE_EXHAUSTED'); // prettier-ignore
    expect((await loop.scan(loopId)).captureProgress.reason).toMatch(
      /cursor leads back to results already collected/,
    );

    const same = await setup();
    setLocalRankProviderOverrides({ CUSTOM: source({ '0': { items: range(1, 5), next: '5' }, '5': { items: range(1, 5), next: '10' }, '10': { items: range(1, 5), next: '15' }, '15': { items: range(6, 9), next: null } }).provider }); // prettier-ignore
    const sameId = (await same.start()).body.data.scanId as string;
    expect((await runLocalCollection(prisma, sameId, { runId: runIdOf(sameId).collectionRunId, sleep: async () => {} })).state).toBe('SOURCE_EXHAUSTED'); // prettier-ignore
    expect((await same.scan(sameId)).captureProgress).toMatchObject({ uniqueBusinesses: 5, pagesRepeated: 2, reason: expect.stringMatching(/last 2 batches added no new businesses/) }); // prettier-ignore
  });

  it('cancels keeping everything collected, validates settings and sources, and isolates tenants', async () => {
    const { client, projectId, queryId, start, control, scan } = await setup();
    let id = '';
    setLocalRankProviderOverrides({ CUSTOM: source(FIFTY, { before: async (c) => void (c === '20' && (await control(id, 'cancel'))) }).provider }); // prettier-ignore
    id = (await start()).body.data.scanId as string;
    // A second collection of the same query cannot start while this one is open.
    expect((await start()).status).toBe(409);
    await runLocalCollection(prisma, id, { runId: runIdOf(id).collectionRunId, sleep: async () => {} });
    const cancelled = await scan(id);
    expect(cancelled).toMatchObject({ status: 'SUCCEEDED', collectionStatus: 'partial', captureProgress: { state: 'CANCELLED', uniqueBusinesses: 20 } }); // prettier-ignore
    expect((await control(id, 'resume')).status).toBe(409);
    // Settings and sources are validated.
    expect((await start({ batchSize: 21 })).status).toBe(400);
    expect((await start({ delayMs: 100 })).status).toBe(400);
    expect((await start({ source: 'MANUAL' })).status).toBe(400);
    setLocalRankProviderOverrides({});
    expect((await start({ source: 'OSM' })).status).toBe(503); // configured only with SERP_PROVIDER=osm
    // Other workspaces cannot start or control it.
    const outsider = await registerClient(app);
    expect((await outsider.client.post(`/projects/${projectId}/local/queries/${queryId}/collections`, { source: 'CUSTOM' })).status).toBe(404); // prettier-ignore
    expect((await outsider.client.post(`/projects/${projectId}/local/scans/${id}/collection/retry`)).status).toBe(404); // prettier-ignore
    // The status lists batch-capable sources and what their order means.
    const status = (await client.get(`/projects/${projectId}/local/status`)).body.data;
    expect(status.batchSources.find((s: { key: string }) => s.key === 'OSM')).toMatchObject({ observationType: 'discovery_order', googleRanking: false, maxBatchSize: 20, minDelayMs: 1000 }); // prettier-ignore
  });
});
