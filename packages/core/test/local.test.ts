import { gridPoints, summarizeGrid } from '@surfaced/shared';
import { describe, expect, it } from 'vitest';
import { resetEnvCache } from '../src/env';
import {
  CustomHttpLocalRankProvider,
  competitorShowings,
  isTargetResult,
  parseCustomSerpResults,
  parseLocalObservationsCsv,
  type LocalRankFetch,
  type LocalRankRequest,
} from '../src/local';

async function withEnv<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const before = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  resetEnvCache();
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(before)) process.env[k] = v ?? '';
    resetEnvCache();
  }
}

const request: LocalRankRequest = {
  query: 'best jewellers in surat',
  latitude: 21.1702,
  longitude: 72.8311,
  surface: 'MAPS',
  language: 'en',
  device: 'mobile',
  depth: 20,
  zoom: 15,
};

describe('grid geometry and summaries', () => {
  it('places points spacing apart around the centre', () => {
    const points = gridPoints(21.1702, 72.8311, 3, 1);
    expect(points).toHaveLength(9);
    expect(points[4]).toEqual({ row: 1, col: 1, latitude: 21.1702, longitude: 72.8311 });
    // About 1 km north and 1 km east of the centre.
    expect(points[1]!.latitude - 21.1702).toBeCloseTo(1 / 110.574, 5);
    expect(points[5]!.longitude - 72.8311).toBeCloseTo(1 / (111.32 * Math.cos((21.1702 * Math.PI) / 180)), 5);
    expect(gridPoints(21.17, 72.83, 1, 2)).toHaveLength(1);
  });

  it('computes grid visibility over measured points only', () => {
    const summary = summarizeGrid([
      { status: 'FOUND', rank: 1 },
      { status: 'FOUND', rank: 3 },
      { status: 'FOUND', rank: 7 },
      { status: 'NOT_FOUND', rank: null },
      { status: 'FAILED', rank: null },
      { status: 'PENDING', rank: null },
    ]);
    expect(summary).toEqual({
      pointsPlanned: 6,
      pointsMeasured: 4,
      pointsFailed: 1,
      coverage: 66.7,
      top3: 2,
      top10: 3,
      notFound: 1,
      top3Share: 50,
      top10Share: 75,
      averageRankFound: 3.7,
    });
    expect(summarizeGrid([{ status: 'FAILED', rank: null }]).top3Share).toBeNull();
  });
});

describe('matching the tracked business', () => {
  const target = { names: ['Navkar Jewellers'], placeId: 'ChIJ-navkar', domains: ['navkar.example'] };

  it('matches by place ID, website or exactly the same name, never by a similar name', () => {
    expect(isTargetResult({ title: 'Anything', placeId: 'ChIJ-navkar', domain: null }, target)).toBe(true);
    expect(isTargetResult({ title: 'Anything', placeId: null, domain: 'www.navkar.example' }, target)).toBe(
      true,
    );
    expect(isTargetResult({ title: 'NAVKAR  jewellers', placeId: null, domain: null }, target)).toBe(true);
    expect(isTargetResult({ title: 'Navkar Jewellers Athwa', placeId: null, domain: null }, target)).toBe(
      false,
    );
    expect(
      isTargetResult({ title: 'Navkar Gems', placeId: 'other', domain: 'navkargems.example' }, target),
    ).toBe(false);
  });

  it('counts each business once per measured point', () => {
    const results = (names: string[]) => names.map((title, i) => ({ rank: i + 1, title, placeId: null, cid: null, domain: null, category: null, rating: 4.8, reviewCount: 10 + i, address: null, latitude: null, longitude: null, isTarget: title === 'Us', competitorId: null })); // prettier-ignore
    const showings = competitorShowings([
      { status: 'FOUND', results: results(['A', 'Us', 'B']) },
      { status: 'NOT_FOUND', results: results(['A', 'C', 'D', 'B']) },
      { status: 'FAILED', results: results(['Z']) },
    ]);
    expect(showings.map((s) => [s.name, s.appearances, s.top3, s.averageRank, s.bestRank])).toEqual([
      ['A', 2, 2, 1, 1],
      ['B', 2, 1, 3.5, 3],
      ['Us', 1, 1, 2, 2],
      ['C', 1, 1, 2, 2],
      ['D', 1, 1, 3, 3],
    ]);
    expect(showings.find((s) => s.name === 'Z')).toBeUndefined();
  });
});

describe('CSV import of local observations', () => {
  it('groups rows by grid point and preserves the order given (by rank, else file order)', () => {
    const csv = [
      'row,col,business,rank,is_tracked_business,rating,review_count,domain',
      '0,0,Rajmahal Jewellers,2,yes,4.9,9000,rajmahal.example',
      '0,0,Jeweller A,1,no,3.9,120,www.jeweller-a.example',
      '0,0,Jeweller C,3,no,,,',
      '1,1,Only Here,,no,4.1,10,',
    ].join('\n');
    const parsed = parseLocalObservationsCsv(csv, 3);
    expect(parsed.errors).toEqual([]);
    expect(parsed.rowsParsed).toBe(4);
    const p00 = parsed.points.find((p) => p.row === 0 && p.col === 0)!;
    // Sorted by the file's rank: Jeweller A (1), Rajmahal (2, best rating but stays 2), Jeweller C (3).
    expect(p00.results.map((r) => [r.rank, r.title, r.isTarget])).toEqual([
      [1, 'Jeweller A', false],
      [2, 'Rajmahal Jewellers', true],
      [3, 'Jeweller C', false],
    ]);
    expect(p00.results[0]).toMatchObject({ domain: 'jeweller-a.example', rating: 3.9, reviewCount: 120 });
    expect(p00.results[2]).toMatchObject({ rating: null, reviewCount: null, domain: null });
    expect(parsed.points.find((p) => p.row === 1 && p.col === 1)!.results).toHaveLength(1);
  });

  it('keeps the file order within a point when no rank column values are given', () => {
    const csv = ['row,col,business', '0,0,First', '0,0,Second', '0,0,Third'].join('\n');
    const parsed = parseLocalObservationsCsv(csv, 1);
    expect(parsed.points[0]!.results.map((r) => r.title)).toEqual(['First', 'Second', 'Third']);
    expect(parsed.points[0]!.results.map((r) => r.rank)).toEqual([null, null, null]);
  });

  it('skips rows outside the grid or without a business name and reports them, without failing the whole file', () => {
    const csv = ['row,col,business', '0,0,Good', '9,9,Outside The Grid', '0,0,'].join('\n');
    const parsed = parseLocalObservationsCsv(csv, 3);
    expect(parsed.rowsParsed).toBe(1);
    expect(parsed.points).toHaveLength(1);
    expect(parsed.errors).toHaveLength(2);
    expect(parsed.errors.join(' ')).toMatch(/outside the 3×3 grid/);
    expect(parsed.errors.join(' ')).toMatch(/no business name/);
  });

  it('rejects a file missing a required column', () => {
    const parsed = parseLocalObservationsCsv('row,business\n0,X', 3);
    expect(parsed.points).toEqual([]);
    expect(parsed.errors[0]).toMatch(/Missing required column\(s\): col/);
  });
});

describe('Custom collection provider (operator-hosted)', () => {
  it('preserves the exact order the service returns and never re-ranks by rating or distance', () => {
    // Rajmahal has by far the best rating but the service returned it at position 2 — it must stay at 2.
    const results = parseCustomSerpResults([
      { title: 'Jeweller A', latitude: 21.2, longitude: 72.9, rating: 3.1, reviewCount: 10 },
      {
        title: 'Rajmahal Jewellers',
        rank: 2,
        domain: 'www.rajmahal.example',
        rating: 4.9,
        reviewCount: 9000,
      },
      { title: '   ' }, // blank title → dropped, not reordered
      { title: 'Jeweller C' },
    ]);
    expect(results.map((r) => [r.rank, r.title])).toEqual([
      [1, 'Jeweller A'],
      [2, 'Rajmahal Jewellers'],
      [3, 'Jeweller C'],
    ]);
    expect(results[1]).toMatchObject({ domain: 'rajmahal.example' });
  });

  it('is off unless SERP_PROVIDER=custom with CUSTOM_SERP_URL, and POSTs the query, coordinates and token', async () => {
    const provider = new CustomHttpLocalRankProvider();
    await expect(provider.fetchPoint(request)).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
    await withEnv(
      { SERP_PROVIDER: 'custom', CUSTOM_SERP_URL: 'https://scraper.example/collect', CUSTOM_SERP_TOKEN: 't' },
      async () => {
        const calls: { url: string; body: Record<string, unknown>; auth: string | null }[] = [];
        const fake: LocalRankFetch = async (url, init) => {
          calls.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown>, auth: new Headers(init.headers).get('authorization') }); // prettier-ignore
          return new Response(
            JSON.stringify({
              results: [
                { title: 'A', rank: 1 },
                { title: 'B', rank: 2 },
              ],
            }),
          );
        };
        const result = await provider.fetchPoint(request, fake);
        expect(calls[0]!.url).toBe('https://scraper.example/collect');
        expect(calls[0]!.body).toMatchObject({ query: 'best jewellers in surat', latitude: 21.1702, surface: 'MAPS', depth: 20 }); // prettier-ignore
        expect(calls[0]!.auth).toBe('Bearer t');
        expect(result.results.map((r) => [r.rank, r.title])).toEqual([[1, 'A'], [2, 'B']]); // prettier-ignore
      },
    );
  });

  it('distinguishes sponsored from organic and records the batch and source position the service supplied', () => {
    // A representative response: one sponsored listing above the organic results, with explicit batch/position.
    const results = parseCustomSerpResults([
      { title: 'Paid Jeweller', sponsored: true, batch: 1, sourcePosition: 1 },
      { title: 'Jeweller A', sponsored: false, batch: 1, sourcePosition: 2 },
      { title: 'Rajmahal Jewellers', batch: 1, sourcePosition: 3 },
    ]);
    expect(results.map((r) => [r.title, r.sponsored, r.batch, r.sourcePosition])).toEqual([
      ['Paid Jeweller', true, 1, 1],
      ['Jeweller A', false, 1, 2],
      ['Rajmahal Jewellers', undefined, 1, 3],
    ]);
    // A single, non-continuous view establishes no cross-batch sequence.
    expect(results.every((r) => r.cumulativePosition === null)).toBe(true);
  });

  it('keeps multiple batches in order but does NOT invent a continuous ranking unless the source declares it', () => {
    const batched = [
      { title: 'A', batch: 1 },
      { title: 'B', batch: 1 },
      { title: 'C', batch: 2 },
      { title: 'D', batch: 2 },
    ];
    // Without continuity: order preserved, within-batch positions restart per batch, no cumulative position.
    const discrete = parseCustomSerpResults(batched);
    expect(discrete.map((r) => [r.title, r.batch, r.sourcePosition, r.cumulativePosition])).toEqual([
      ['A', 1, 1, null],
      ['B', 1, 2, null],
      ['C', 2, 1, null],
      ['D', 2, 2, null],
    ]);
    // With the source declaring continuity: a cumulative position is assigned across the batches, in order.
    const continuous = parseCustomSerpResults(batched, { continuous: true });
    expect(continuous.map((r) => [r.title, r.batch, r.cumulativePosition])).toEqual([
      ['A', 1, 1],
      ['B', 1, 2],
      ['C', 2, 3],
      ['D', 2, 4],
    ]);
  });

  it('passes the source-declared observation type and continuity through fetchPoint', async () => {
    await withEnv(
      { SERP_PROVIDER: 'custom', CUSTOM_SERP_URL: 'https://scraper.example/collect' },
      async () => {
        const fake: LocalRankFetch = async () =>
          new Response(
            JSON.stringify({
              observationType: 'discovery_order',
              continuous: true,
              results: [
                { title: 'A', batch: 1 },
                { title: 'B', batch: 2 },
              ],
            }),
          );
        const result = await new CustomHttpLocalRankProvider().fetchPoint(request, fake);
        expect(result.observationType).toBe('discovery_order');
        expect(result.results.map((r) => [r.title, r.cumulativePosition])).toEqual([['A', 1], ['B', 2]]); // prettier-ignore
      },
    );
  });

  it('ignores an unknown observation type rather than storing a made-up one', async () => {
    await withEnv(
      { SERP_PROVIDER: 'custom', CUSTOM_SERP_URL: 'https://scraper.example/collect' },
      async () => {
        const fake: LocalRankFetch = async () =>
          new Response(JSON.stringify({ observationType: 'totally-made-up', results: [{ title: 'A' }] }));
        const result = await new CustomHttpLocalRankProvider().fetchPoint(request, fake);
        expect(result.observationType).toBeUndefined();
      },
    );
  });

  it('reports failures without inventing results', async () => {
    await withEnv(
      { SERP_PROVIDER: 'custom', CUSTOM_SERP_URL: 'https://scraper.example/collect' },
      async () => {
        const status =
          (code: number): LocalRankFetch =>
          async () =>
            new Response('{}', { status: code });
        await expect(new CustomHttpLocalRankProvider().fetchPoint(request, status(429))).rejects.toMatchObject({ code: 'RATE_LIMITED' }); // prettier-ignore
        await expect(new CustomHttpLocalRankProvider().fetchPoint(request, status(500))).rejects.toMatchObject({ code: 'ERROR' }); // prettier-ignore
        const badShape: LocalRankFetch = async () => new Response(JSON.stringify({ foo: 1 }));
        await expect(new CustomHttpLocalRankProvider().fetchPoint(request, badShape)).rejects.toMatchObject({ code: 'ERROR' }); // prettier-ignore
      },
    );
  });
});

describe('Custom collection service batches (simulated service)', () => {
  it('sends limit and cursor, follows the service’s nextCursor, and passes on Retry-After', async () => {
    await withEnv(
      { SERP_PROVIDER: 'custom', CUSTOM_SERP_URL: 'https://collector.example/collect' },
      async () => {
        const bodies: Record<string, unknown>[] = [];
        const fake: LocalRankFetch = async (_url, init) => {
          const body = JSON.parse(String(init.body)) as { cursor: string | null };
          bodies.push(body);
          return new Response(JSON.stringify(body.cursor ? { results: [{ title: 'C' }], offset: 2 } : { results: [{ title: 'A' }, { title: 'B' }], offset: 0, nextCursor: 'p2', observationType: 'discovery_order' })); // prettier-ignore
        };
        const p = new CustomHttpLocalRankProvider();
        const first = await p.fetchBatch({ ...request, limit: 20, cursor: null }, fake);
        expect(first).toMatchObject({ offset: 0, nextCursor: 'p2', observationType: 'discovery_order' });
        expect(first.results.map((r) => r.title)).toEqual(['A', 'B']);
        const second = await p.fetchBatch({ ...request, limit: 20, cursor: first.nextCursor }, fake);
        expect(second).toMatchObject({ offset: 2, nextCursor: null }); // no cursor back: nothing further
        expect(bodies.map((b) => [b.limit, b.cursor])).toEqual([[20, null], [20, 'p2']]); // prettier-ignore
        const limited: LocalRankFetch = async () =>
          new Response('{}', { status: 429, headers: { 'retry-after': '7' } });
        await expect(p.fetchBatch({ ...request, limit: 20, cursor: null }, limited)).rejects.toMatchObject({ code: 'RATE_LIMITED', retryAfterMs: 7000 }); // prettier-ignore
      },
    );
  });
});
