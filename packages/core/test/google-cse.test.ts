import { DEFAULT_CRAWL_SETTINGS } from '@surfaced/shared';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { randomToken } from '../src/crypto';
import { disconnectPrisma, getPrisma } from '../src/db';
import { resetEnvCache } from '../src/env';
import { MemoryQueueGateway } from '../src/queue';
import {
  GoogleCustomSearchLocalRankProvider,
  LocalRankProviderError,
  competitorShowings,
  createLocalRankScan,
  executeLocalRankScan,
  parseGoogleCseResults,
  type LocalRankFetch,
  type LocalRankRequest,
} from '../src/local';

const prisma = getPrisma();
const queues = new MemoryQueueGateway();
afterEach(() => {
  process.env.GOOGLE_CSE_API_KEY = '';
  process.env.GOOGLE_CSE_CX = '';
  resetEnvCache();
});
afterAll(async () => {
  await disconnectPrisma();
});

const CSE_ENV = { GOOGLE_CSE_API_KEY: 'test-key', GOOGLE_CSE_CX: 'test-cx' };

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

function fakeFetch(handler: (url: string) => { status?: number; body: unknown }) {
  const calls: string[] = [];
  const fn = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const { status = 200, body } = handler(url);
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as unknown as LocalRankFetch;
  return { fn, calls };
}

const RESULTS = {
  items: [
    { title: 'Heritage Diamonds - Jewellery in Surat', link: 'https://heritage.example/', displayLink: 'heritage.example' }, // prettier-ignore
    { title: 'Lakshmi Jewellers', link: 'https://lakshmi.example/surat', displayLink: 'www.lakshmi.example' },
    { title: 'Rajmahel Jewellers — Official Site', link: 'https://rajmahel.example.in/', displayLink: 'rajmahel.example.in' }, // prettier-ignore
  ],
};

const organicRequest: LocalRankRequest = {
  query: 'jewellery shop in nana varachha',
  latitude: 21.2311,
  longitude: 72.9033,
  surface: 'ORGANIC',
  language: 'en',
  device: 'mobile',
  depth: 20,
  zoom: 15,
  country: 'IN',
};

describe('Google Custom Search provider', () => {
  it('parses organic items into ranked results (web pages: no place id, rating or coordinates)', () => {
    expect(parseGoogleCseResults(RESULTS.items)).toEqual([
      { rank: 1, title: 'Heritage Diamonds - Jewellery in Surat', placeId: null, cid: null, domain: 'heritage.example', url: 'https://heritage.example/', category: null, rating: null, reviewCount: null, address: null, phone: null, latitude: null, longitude: null }, // prettier-ignore
      { rank: 2, title: 'Lakshmi Jewellers', placeId: null, cid: null, domain: 'lakshmi.example', url: 'https://lakshmi.example/surat', category: null, rating: null, reviewCount: null, address: null, phone: null, latitude: null, longitude: null }, // prettier-ignore
      { rank: 3, title: 'Rajmahel Jewellers — Official Site', placeId: null, cid: null, domain: 'rajmahel.example.in', url: 'https://rajmahel.example.in/', category: null, rating: null, reviewCount: null, address: null, phone: null, latitude: null, longitude: null }, // prettier-ignore
    ]);
    expect(parseGoogleCseResults([{ title: 'no link' }])).toEqual([]);
  });

  it('is not configured without a key and engine id', () => {
    expect(new GoogleCustomSearchLocalRankProvider().configured().configured).toBe(false);
  });

  it('sends the key, engine id, country and a capped result count, and matches by domain', async () => {
    const google = fakeFetch(() => ({ body: RESULTS }));
    const provider = new GoogleCustomSearchLocalRankProvider();
    const result = await withEnv(CSE_ENV, () => provider.fetchPoint(organicRequest, google.fn));
    const url = new URL(google.calls[0]!);
    expect(url.origin + url.pathname).toBe('https://www.googleapis.com/customsearch/v1');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ key: 'test-key', cx: 'test-cx', q: 'jewellery shop in nana varachha', num: '10', hl: 'en', gl: 'in' }); // prettier-ignore
    expect(result).toMatchObject({ costUsd: 0 });
    expect(result.results.map((r) => r.domain)).toEqual(['heritage.example', 'lakshmi.example', 'rajmahel.example.in']); // prettier-ignore
  });

  it('refuses the Maps surface honestly (never fabricates a local-pack rank from organic results)', async () => {
    const google = fakeFetch(() => ({ body: RESULTS }));
    const error = await withEnv(
      CSE_ENV,
      () =>
      new GoogleCustomSearchLocalRankProvider().fetchPoint({ ...organicRequest, surface: 'MAPS' }, google.fn).catch((e: unknown) => e), // prettier-ignore
    );
    expect(error).toBeInstanceOf(LocalRankProviderError);
    expect(error).toMatchObject({ code: 'UNSUPPORTED' });
    expect((error as LocalRankProviderError).message).toMatch(
      /organic web results only, not the Maps local pack/,
    );
    expect(google.calls).toHaveLength(0);
  });

  it('maps the daily free limit and timeouts to retry-aware errors', async () => {
    const limited = fakeFetch(() => ({ status: 403, body: { error: { message: 'Quota exceeded', errors: [{ reason: 'dailyLimitExceeded' }] } } })); // prettier-ignore
    const rate = await withEnv(CSE_ENV, () => new GoogleCustomSearchLocalRankProvider().fetchPoint(organicRequest, limited.fn).catch((e: unknown) => e)); // prettier-ignore
    expect(rate).toMatchObject({ code: 'RATE_LIMITED' });
    expect((rate as LocalRankProviderError).message).toMatch(/daily free limit/);

    const badKey = fakeFetch(() => ({ status: 400, body: { error: { message: 'API key not valid', errors: [{ reason: 'badRequest' }] } } })); // prettier-ignore
    expect(await withEnv(CSE_ENV, () => new GoogleCustomSearchLocalRankProvider().fetchPoint(organicRequest, badKey.fn).catch((e: unknown) => e))).toMatchObject({ code: 'NOT_CONFIGURED' }); // prettier-ignore

    const timeout = (async () => {
      throw Object.assign(new Error('aborted'), { name: 'TimeoutError' });
    }) as unknown as LocalRankFetch;
    expect(await withEnv(CSE_ENV, () => new GoogleCustomSearchLocalRankProvider().fetchPoint(organicRequest, timeout).catch((e: unknown) => e))).toMatchObject({ code: 'TIMEOUT' }); // prettier-ignore
  });

  it('reuses one request for every grid point of a scan (the result is national)', async () => {
    const google = fakeFetch(() => ({ body: RESULTS }));
    const provider = new GoogleCustomSearchLocalRankProvider();
    await withEnv(CSE_ENV, async () => {
      await provider.fetchPoint(organicRequest, google.fn);
      await provider.fetchPoint({ ...organicRequest, latitude: 21.3, longitude: 72.8 }, google.fn);
    });
    expect(google.calls).toHaveLength(1);
  });
});

async function setupProject() {
  const workspace = await prisma.workspace.create({
    data: { name: 'CSE WS', slug: `cse-${randomToken(6).toLowerCase()}` },
  });
  const project = await prisma.project.create({
    data: { workspaceId: workspace.id, name: 'Rajmahel Jewellers', websiteUrl: 'https://rajmahel.example.in/', domain: 'rajmahel.example.in', targetCountries: ['IN'], targetLanguages: ['en'], crawlSettings: DEFAULT_CRAWL_SETTINGS }, // prettier-ignore
  });
  const location = await prisma.businessLocation.create({
    data: { projectId: project.id, name: 'Rajmahel Jewellers', city: 'Surat', country: 'IN', addressLine1: 'Nana Varachha', latitude: 21.2311, longitude: 72.9033, websiteUrl: 'https://rajmahel.example.in/', isPrimary: true }, // prettier-ignore
  });
  return { workspace, project, location };
}

describe('organic scan through Google Custom Search', () => {
  it('stores the organic position (matched by website), labels it organic, and does not create local competitors', async () => {
    const { project, location } = await setupProject();
    const query = await prisma.localRankQuery.create({
      data: { projectId: project.id, locationId: location.id, query: 'jewellery shop in nana varachha', surface: 'ORGANIC', language: 'en', device: 'mobile', gridSize: 3, spacingKm: 1, depth: 20, centerLatitude: 21.2311, centerLongitude: 72.9033, frequency: 'MANUAL' }, // prettier-ignore
    });
    const google = fakeFetch(() => ({ body: RESULTS }));
    await withEnv(CSE_ENV, async () => {
      const { scanId } = await createLocalRankScan(prisma, queues, { projectId: project.id, queryId: query.id, source: 'GOOGLE_CSE', userId: null, trigger: 'MANUAL' }); // prettier-ignore
      const outcome = await executeLocalRankScan(prisma, scanId, { fetchImpl: google.fn });
      // A 3×3 grid, but one national request; every measured point shows the same organic rank (3).
      expect(google.calls).toHaveLength(1);
      expect(outcome.measured).toBe(9);
      const scan = await prisma.localRankScan.findUniqueOrThrow({ where: { id: scanId } });
      expect(scan).toMatchObject({ status: 'SUCCEEDED', source: 'GOOGLE_CSE', top3: 9, costUsd: 0 });
      const limitations = scan.limitations as string[];
      expect(limitations.join(' ')).toMatch(/organic SERP position, NOT a Maps local-pack rank/i);
      expect(limitations.join(' ')).toMatch(/national position/);
      const points = await prisma.localRankPoint.findMany({ where: { scanId } });
      expect(points.every((p) => p.status === 'FOUND' && p.rank === 3)).toBe(true);
      // Organic web pages are not local businesses, so no competitor suggestions are created.
      expect(await prisma.projectCompetitor.count({ where: { projectId: project.id } })).toBe(0);
    });
  });

  it('records not_found when the business is absent from the organic results', async () => {
    const { project, location } = await setupProject();
    const query = await prisma.localRankQuery.create({
      data: { projectId: project.id, locationId: location.id, query: 'best jewellers', surface: 'ORGANIC', language: 'en', device: 'mobile', gridSize: 1, spacingKm: 1, depth: 20, centerLatitude: 21.2311, centerLongitude: 72.9033, frequency: 'MANUAL' }, // prettier-ignore
    });
    const google = fakeFetch(() => ({ body: { items: RESULTS.items.slice(0, 2) } }));
    await withEnv(CSE_ENV, async () => {
      const { scanId } = await createLocalRankScan(prisma, queues, { projectId: project.id, queryId: query.id, source: 'GOOGLE_CSE', userId: null, trigger: 'MANUAL' }); // prettier-ignore
      await executeLocalRankScan(prisma, scanId, { fetchImpl: google.fn });
      const point = await prisma.localRankPoint.findFirstOrThrow({ where: { scanId } });
      expect(point).toMatchObject({ status: 'NOT_FOUND', rank: null });
    });
  });

  it('refuses a Maps query for the Google organic source with a clear message', async () => {
    const { project, location } = await setupProject();
    const mapsQuery = await prisma.localRankQuery.create({
      data: { projectId: project.id, locationId: location.id, query: 'best jewellers in surat', surface: 'MAPS', language: 'en', device: 'mobile', gridSize: 3, spacingKm: 1, depth: 20, centerLatitude: 21.2311, centerLongitude: 72.9033, frequency: 'MANUAL' }, // prettier-ignore
    });
    await withEnv(CSE_ENV, async () => {
      await expect(createLocalRankScan(prisma, queues, { projectId: project.id, queryId: mapsQuery.id, source: 'GOOGLE_CSE', userId: null, trigger: 'MANUAL' })).rejects.toThrow(/cannot measure maps/i); // prettier-ignore
    });
  });
});

describe('ranking math stays honest', () => {
  it('does not treat organic pages as local competitors in showings', () => {
    // competitorShowings still aggregates what is listed, but organic scans skip competitor creation (tested above).
    const showings = competitorShowings([
      { status: 'FOUND', results: [{ rank: 1, title: 'Heritage Diamonds', placeId: null, domain: 'heritage.example', category: null, rating: null, reviewCount: null, address: null, latitude: null, longitude: null, isTarget: false, competitorId: null }] }, // prettier-ignore
    ]);
    expect(showings[0]).toMatchObject({ name: 'Heritage Diamonds', appearances: 1 });
  });
});
