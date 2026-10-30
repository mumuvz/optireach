import { afterEach, describe, expect, it } from 'vitest';
import {
  OsmLocalRankProvider,
  osmCategoryFor,
  parseNominatimResults,
  parseOverpassResults,
  type LocalRankFetch,
  type LocalRankRequest,
} from '../src/local/rank-providers';
import { resetEnvCache } from '../src/env';

afterEach(() => {
  process.env.SERP_PROVIDER = 'none';
  resetEnvCache();
});

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

function fakeFetch(handler: (url: string, init: RequestInit) => { status?: number; body: unknown }) {
  const calls: { url: string; method: string }[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, method: init.method ?? 'GET' });
    const { status = 200, body } = handler(url, init);
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as unknown as LocalRankFetch;
  return { fn, calls };
}

const center = { lat: 21.17, lng: 72.83 };
const req = (over: Partial<LocalRankRequest> = {}): LocalRankRequest => ({
  query: 'best jewellers in surat',
  latitude: 21.17,
  longitude: 72.83,
  surface: 'MAPS',
  language: 'en',
  device: 'mobile',
  depth: 20,
  zoom: 14,
  country: 'IN',
  ...over,
});

describe('OSM category mapping', () => {
  it('maps common local business phrases to OSM tags, and leaves unknown ones for the free-text fallback', () => {
    expect(osmCategoryFor('best jewellers in surat')).toEqual({ key: 'shop', value: 'jewelry' });
    expect(osmCategoryFor('dentists near adajan')).toEqual({ key: 'amenity', value: 'dentist' });
    expect(osmCategoryFor('restaurants in vesu')).toEqual({ key: 'amenity', value: 'restaurant' });
    expect(osmCategoryFor('zzz something unmappable')).toBeNull();
  });
});

describe('OSM result normalization', () => {
  it('drops nameless/invalid-coordinate elements, de-duplicates, and orders by distance', () => {
    const results = parseOverpassResults(
      [
        { type: 'node', id: 1, lat: 21.171, lon: 72.831, tags: { name: 'Shree Ornaments', website: 'https://shree.example', phone: '123', 'addr:street': 'Ghod Dod Road', 'addr:city': 'Surat' } }, // prettier-ignore
        { type: 'way', id: 2, center: { lat: 21.178, lon: 72.838 }, tags: { name: 'Royal Gems', 'contact:website': 'royal.example' } }, // prettier-ignore
        { type: 'node', id: 3, lat: 21.172, lon: 72.832, tags: {} }, // no name → dropped
        { type: 'node', id: 4, lat: 999, lon: 72.83, tags: { name: 'Bad Coords' } }, // invalid lat → dropped
        { type: 'node', id: 1, lat: 21.171, lon: 72.831, tags: { name: 'Shree Ornaments' } }, // duplicate id
      ],
      center,
      'shop=jewelry',
    );
    expect(results.map((r) => r.title)).toEqual(['Shree Ornaments', 'Royal Gems']); // nearest first
    expect(results[0]).toMatchObject({ rank: 1, placeId: 'osm:node/1', domain: 'shree.example', rating: null, reviewCount: null, address: 'Ghod Dod Road, Surat' }); // prettier-ignore
    expect(results[1]).toMatchObject({ rank: 2, placeId: 'osm:way/2', domain: 'royal.example' });
  });

  it('parses Nominatim free-text results by distance', () => {
    const results = parseNominatimResults(
      [
        { osm_type: 'node', osm_id: 9, name: 'Far Shop', lat: '21.20', lon: '72.86' },
        { osm_type: 'node', osm_id: 8, display_name: 'Near Shop, Surat', lat: '21.171', lon: '72.831', extratags: { website: 'near.example' } }, // prettier-ignore
        { osm_type: 'node', osm_id: 7, lat: 'bad', lon: '72.83', name: 'No Coords' }, // invalid → dropped
      ],
      center,
    );
    expect(results.map((r) => r.title)).toEqual(['Near Shop', 'Far Shop']);
    expect(results[0]).toMatchObject({ domain: 'near.example', placeId: 'osm:node/8' });
  });
});

describe('OSM provider fetchPoint', () => {
  it('queries Overpass for a mapped category and returns distance-ordered discovery results', async () => {
    const osm = new OsmLocalRankProvider();
    const google = fakeFetch((url) => {
      expect(url).toMatch(/overpass/);
      return {
        body: {
          elements: [
            { type: 'node', id: 1, lat: 21.171, lon: 72.831, tags: { name: 'Shree Ornaments' } },
            { type: 'node', id: 2, lat: 21.179, lon: 72.839, tags: { name: 'Royal Gems' } },
          ],
        },
      };
    });
    const result = await withEnv({ SERP_PROVIDER: 'osm' }, () => osm.fetchPoint(req(), google.fn));
    expect(result.costUsd).toBe(0);
    expect(result.results.map((r) => r.title)).toEqual(['Shree Ornaments', 'Royal Gems']);
    expect(google.calls[0]).toMatchObject({ method: 'POST' });
  });

  it('falls back to Nominatim for an unmapped query', async () => {
    const osm = new OsmLocalRankProvider();
    const google = fakeFetch((url) => {
      expect(url).toMatch(/\/search\?/);
      return { body: [{ osm_type: 'node', osm_id: 5, name: 'Some Place', lat: '21.171', lon: '72.831' }] };
    });
    const result = await withEnv({ SERP_PROVIDER: 'osm' }, () =>
      osm.fetchPoint(req({ query: 'zzz unmappable thing' }), google.fn),
    );
    expect(result.results.map((r) => r.title)).toEqual(['Some Place']);
    expect(google.calls[0]).toMatchObject({ method: 'GET' });
  });

  it('is honest about what it does not support, and reports configuration and rate limits', async () => {
    const osm = new OsmLocalRankProvider();
    // Organic/local-pack are not available from OpenStreetMap.
    await expect(
      withEnv({ SERP_PROVIDER: 'osm' }, () => osm.fetchPoint(req({ surface: 'ORGANIC' }), fakeFetch(() => ({ body: {} })).fn)), // prettier-ignore
    ).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    // Not enabled unless SERP_PROVIDER=osm.
    await expect(osm.fetchPoint(req(), fakeFetch(() => ({ body: {} })).fn)).rejects.toMatchObject({ code: 'NOT_CONFIGURED' }); // prettier-ignore
    // Fair-use rate limiting surfaces honestly.
    const limited = fakeFetch(() => ({ status: 429, body: {} }));
    await expect(
      withEnv({ SERP_PROVIDER: 'osm' }, () => osm.fetchPoint(req(), limited.fn)),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    expect(osm.configured().configured).toBe(false);
  });
});

describe('OpenStreetMap batch collection (simulated Overpass responses)', () => {
  // Shops 1, 2, 5 and 10 km north of the centre (1° latitude ≈ 111 km).
  const shop = (id: number, km: number) => ({ type: 'node', id, lat: 21.17 + km / 111, lon: 72.83, tags: { name: `Shop ${km}km`, shop: 'jewelry' } }); // prettier-ignore
  const within = (radiusM: number) => [shop(1, 1), shop(2, 2), shop(3, 5), shop(4, 10)].filter((_, i) => [1, 2, 5, 10][i]! * 1000 <= radiusM); // prettier-ignore
  const queries: string[] = [];
  const overpass = () =>
    fakeFetch((_url, init) => {
      const ql = decodeURIComponent(String(init.body).replace(/^data=/, ''));
      queries.push(ql);
      return { body: { elements: within(Number(/around:(\d+)/.exec(ql)![1])) } };
    });
  const batchReq = (limit: number, cursor: string | null) => ({ ...req(), limit, cursor });

  it('takes batches from each radius in distance order and widens the radius only when a ring is used up', async () => {
    await withEnv({ SERP_PROVIDER: 'osm' }, async () => {
      const p = new OsmLocalRankProvider();
      const net = overpass();
      const seen: { titles: string[]; offset: number | null; ranks: number[] }[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < 6; i++) {
        const b = await p.fetchBatch(batchReq(1, cursor), net.fn);
        seen.push({
          titles: b.results.map((r) => r.title),
          offset: b.offset,
          ranks: b.results.map((r) => r.rank),
        });
        expect(b.observationType).toBe('discovery_order');
        cursor = b.nextCursor;
        if (!cursor) break;
      }
      // Nearest first across rings; overall positions continue from ring to ring.
      expect(seen).toEqual([
        { titles: ['Shop 1km'], offset: 0, ranks: [1] },
        { titles: ['Shop 2km'], offset: 1, ranks: [2] },
        { titles: ['Shop 5km'], offset: 2, ranks: [3] },
        { titles: ['Shop 10km'], offset: 3, ranks: [4] },
        { titles: [], offset: 4, ranks: [] }, // the 25 km ring adds nothing: the source is exhausted
      ]);
      expect(cursor).toBeNull();
      // One request per radius (3, 6, 12, 25 km) — two batches from the 3 km ring did not repeat its request —
      // and no server-side count limit (which would cut by OpenStreetMap's internal order, not distance).
      expect(net.calls).toHaveLength(4);
      expect(queries.every((q) => q.endsWith('out center tags;'))).toBe(true);
    });
  });

  it('is refused unless OpenStreetMap is the configured source', async () => {
    await expect(new OsmLocalRankProvider().fetchBatch(batchReq(20, null), overpass().fn)).rejects.toMatchObject({ code: 'NOT_CONFIGURED' }); // prettier-ignore
  });
});
