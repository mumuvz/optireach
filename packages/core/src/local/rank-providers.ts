// Local rank providers: who is listed for a query at one geographic point. Google offers no API for Maps or
// local-pack rankings, so live points come from the operator's own permitted collection: OpenStreetMap discovery
// (free, community data, distance-ordered — not a Google ranking), the official Google Programmable Search API for
// organic web results, or the operator's own collection service (SERP_PROVIDER=custom). Manual entries and CSV
// imports are stored through the same model but labeled as such; the development fixture is refused in production.
// A provider that fails returns an explicit error for that point; nothing is filled in.
import { createHash } from 'node:crypto';
import {
  LOCAL_OBSERVATION_TYPES,
  LOCAL_RANK_SOURCE_LABELS,
  type LocalObservationType,
  type LocalRankSource,
  type LocalSurface,
} from '@surfaced/shared';
import { getEnv } from '../env';
import { errorMessage } from '../errors';

export type LocalRankFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface LocalRankRequest {
  query: string;
  latitude: number;
  longitude: number;
  surface: LocalSurface;
  language: string;
  device: 'desktop' | 'mobile';
  depth: number;
  /** Map zoom used for Maps searches (DataForSEO "lat,lng,zoom"); about 14 covers a few kilometres. */
  zoom: number;
  /** ISO country of the tracked location. Used by sources that localise by country (Google Custom Search). */
  country?: string;
}

/** A business as the provider listed it. Matching to the tracked business and competitors happens later. */
export interface ProviderLocalResult {
  rank: number;
  title: string;
  placeId: string | null;
  cid: string | null;
  domain: string | null;
  url: string | null;
  category: string | null;
  rating: number | null;
  reviewCount: number | null;
  address: string | null;
  phone: string | null;
  latitude: number | null;
  longitude: number | null;
  /** True/false when the source flagged this listing as sponsored/paid; omitted when the source does not say. */
  sponsored?: boolean;
  /** The continuation batch/page this listing came from (1 for the first view); omitted means a single view. */
  batch?: number;
  /** Position within its batch, exactly as the source presented it; omitted falls back to `rank`. */
  sourcePosition?: number;
  /** Position across all batches combined — present only when the source establishes continuity. */
  cumulativePosition?: number | null;
  /** A Google Maps link for the business, when the source provided one or a Google place identifier. */
  mapsUrl?: string | null;
  /** Google's Knowledge Graph entity ID for the business (e.g. "/g/11fk2bz1w2"), when the source carried it. */
  entityId?: string | null;
  /** Profile details the listing showed, when the source carried them (see LocalResult). */
  hours?: string | null;
  serviceOptions?: string[];
  phoneShown?: boolean;
  reviewSnippet?: string | null;
  websiteListed?: boolean;
}

export interface LocalRankResult {
  results: ProviderLocalResult[];
  costUsd: number;
  /** When the provider says it collected the results. */
  checkedAt: Date;
  /** How this order was obtained (observed search position, discovery order, …). Defaulted per source if unset. */
  observationType?: LocalObservationType;
}

export class LocalRankProviderError extends Error {
  constructor(
    readonly provider: LocalRankSource,
    readonly code: 'NOT_CONFIGURED' | 'RATE_LIMITED' | 'TIMEOUT' | 'UNSUPPORTED' | 'ERROR',
    message: string,
    /** How long the source asked to wait before the next request (a Retry-After header), when it said. */
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = 'LocalRankProviderError';
  }

  get permanent(): boolean {
    return this.code === 'NOT_CONFIGURED' || this.code === 'UNSUPPORTED';
  }
}

export interface LocalRankProvider {
  readonly key: LocalRankSource;
  readonly label: string;
  /** Surfaces it can measure. */
  readonly surfaces: readonly LocalSurface[];
  /** Whether it fetches live results (manual and import do not). */
  readonly live: boolean;
  configured(): { configured: boolean; detail: string };
  fetchPoint?(request: LocalRankRequest, fetchImpl?: LocalRankFetch): Promise<LocalRankResult>;
  /** Automatic batch collection: what the source supports. Absent when the source cannot collect in batches. */
  readonly batching?: LocalBatchCapability;
  /** One batch of up to request.limit results, following the source's own pagination (cursor = where to continue). */
  fetchBatch?(request: LocalBatchRequest, fetchImpl?: LocalRankFetch): Promise<LocalBatchResult>;
}

export interface LocalBatchRequest extends LocalRankRequest {
  /** Results wanted in this batch (at most the source's maxBatchSize). */
  limit: number;
  /** The source's cursor from the previous batch; null for the first batch. */
  cursor: string | null;
}

export interface LocalBatchResult {
  /** In the order the source returned them; never re-sorted. */
  results: ProviderLocalResult[];
  /** Position of the first result in the source's overall order (0-based); null when the source does not say. */
  offset: number | null;
  /** Cursor for the next batch; null when the source has nothing further. */
  nextCursor: string | null;
  costUsd: number;
  checkedAt: Date;
  observationType: LocalObservationType;
  /** What this batch covered, in words (shown with the batch). */
  note: string | null;
}

export interface LocalBatchCapability {
  maxBatchSize: number;
  /** The least pause between requests the source requires (the collection uses the larger of this and its own). */
  minDelayMs: number;
  /** How the source pages, in words. */
  pagination: string;
  /** What the order means. */
  observationType: LocalObservationType;
  /** True only when the source returns the order a Google search showed. */
  googleRanking: boolean;
}

// ---------------- Google Programmable Search (Custom Search JSON API) ----------------
// The official Google API for ORGANIC web results (the blue links), free up to 100 searches/day. It is NOT the Maps
// local pack — no free, permitted source provides that — and it localises only by country, not by coordinate. So it
// measures a national organic SERP position, clearly labelled, never Maps. One request serves a whole scan (the
// result is national), so a geographic grid of several points reuses it; a 1×1 grid is recommended for organic.
const GOOGLE_CSE_ENDPOINT = 'https://www.googleapis.com/customsearch/v1';
/** Custom Search returns at most 10 results per request; one page keeps a scan to one of the 100 free daily searches. */
const GOOGLE_CSE_MAX_RESULTS = 10;

function googleCseConfig() {
  const env = getEnv();
  return env.GOOGLE_CSE_API_KEY && env.GOOGLE_CSE_CX
    ? { apiKey: env.GOOGLE_CSE_API_KEY, cx: env.GOOGLE_CSE_CX }
    : null;
}

interface GoogleCseItem {
  title?: string;
  link?: string;
  displayLink?: string;
  snippet?: string;
}

/** Parses a Custom Search response into ranked organic results (web pages, so no place ID, rating or coordinates). */
export function parseGoogleCseResults(items: GoogleCseItem[]): ProviderLocalResult[] {
  return items
    .filter((i) => i.link)
    .map((i, n) => ({
      rank: n + 1,
      title: (i.title ?? i.displayLink ?? '').slice(0, 255),
      placeId: null,
      cid: null,
      domain: i.displayLink ? i.displayLink.replace(/^www\./, '').toLowerCase() : null,
      url: i.link ?? null,
      category: null,
      rating: null,
      reviewCount: null,
      address: null,
      phone: null,
      latitude: null,
      longitude: null,
    }));
}

export class GoogleCustomSearchLocalRankProvider implements LocalRankProvider {
  readonly key = 'GOOGLE_CSE' as const;
  readonly label = LOCAL_RANK_SOURCE_LABELS.GOOGLE_CSE;
  /** Organic web results only; the Maps local pack is not available from any free, permitted source. */
  readonly surfaces = ['ORGANIC'] as const;
  readonly live = true;
  /** One real request per scan: the result is national, so every grid point of a scan reuses it. */
  private cached: LocalRankResult | null = null;

  configured() {
    return googleCseConfig()
      ? {
          configured: true,
          detail:
            'Google Programmable Search (Custom Search JSON API): real Google ORGANIC web results, free up to 100 searches a day. Not the Maps local pack, and country-level only (not specific to each grid point).',
        }
      : {
          configured: false,
          detail:
            'Set GOOGLE_CSE_API_KEY and GOOGLE_CSE_CX (a free Google API key and Programmable Search Engine ID). It returns Google organic web results, not the Maps local pack.',
        };
  }

  async fetchPoint(request: LocalRankRequest, fetchImpl: LocalRankFetch = fetch): Promise<LocalRankResult> {
    const config = googleCseConfig();
    if (!config) throw new LocalRankProviderError('GOOGLE_CSE', 'NOT_CONFIGURED', this.configured().detail);
    if (request.surface !== 'ORGANIC')
      throw new LocalRankProviderError(
        'GOOGLE_CSE',
        'UNSUPPORTED',
        'Google Custom Search returns organic web results only, not the Maps local pack. Use Maps with a licensed provider, or record it manually.',
      );
    if (this.cached) return this.cached;
    const params = new URLSearchParams({
      key: config.apiKey,
      cx: config.cx,
      q: request.query,
      num: String(Math.min(GOOGLE_CSE_MAX_RESULTS, Math.max(1, request.depth))),
      hl: request.language,
      safe: 'off',
    });
    // Country-level localisation only; the API has no coordinate parameter.
    if (request.country) params.set('gl', request.country.toLowerCase());
    let response: Response;
    try {
      response = await fetchImpl(`${GOOGLE_CSE_ENDPOINT}?${params.toString()}`, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      const timedOut =
        error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      throw new LocalRankProviderError(
        'GOOGLE_CSE',
        timedOut ? 'TIMEOUT' : 'ERROR',
        timedOut
          ? 'Google Custom Search did not answer within 20 seconds.'
          : `Google Custom Search could not be reached: ${errorMessage(error)}`,
      );
    }
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: { message?: string; errors?: { reason?: string }[] } }; // prettier-ignore
      const reason = body.error?.errors?.[0]?.reason ?? '';
      const detail = body.error?.message ? ` Google: ${body.error.message.slice(0, 200)}` : '';
      if (response.status === 429 || reason === 'rateLimitExceeded' || reason === 'dailyLimitExceeded' || reason === 'userRateLimitExceeded') // prettier-ignore
        throw new LocalRankProviderError('GOOGLE_CSE', 'RATE_LIMITED', `Google Custom Search daily free limit (100 searches) or rate limit reached.${detail}`); // prettier-ignore
      if (response.status === 400 || response.status === 401 || response.status === 403)
        throw new LocalRankProviderError('GOOGLE_CSE', 'NOT_CONFIGURED', `Google Custom Search rejected the key or engine ID (HTTP ${response.status}).${detail} Check GOOGLE_CSE_API_KEY and GOOGLE_CSE_CX.`); // prettier-ignore
      throw new LocalRankProviderError('GOOGLE_CSE', 'ERROR', `Google Custom Search returned HTTP ${response.status}.${detail}`); // prettier-ignore
    }
    const json = (await response.json()) as { items?: GoogleCseItem[] };
    const result: LocalRankResult = {
      results: parseGoogleCseResults(json.items ?? []),
      costUsd: 0,
      checkedAt: new Date(),
    };
    this.cached = result;
    return result;
  }
}

// ---------------- OpenStreetMap (community discovery; permitted, free) ----------------
// A permitted, no-cost source of real local businesses from OpenStreetMap (Overpass for mapped categories, with a
// Nominatim free-text fallback). It lists the businesses mapped near each point ORDERED BY DISTANCE — this is
// DISCOVERY, not a Google Maps ranking, and OSM carries no ratings or review counts. Coverage depends on what the
// OSM community has mapped. Used for competitor discovery and distance-based local presence, clearly labelled,
// and never presented as a Google local-pack ranking. Respects OSM fair-use with a politeness delay and timeouts.

const OSM_RADIUS_M = 3000;
const OSM_MAX_RESULTS = 50;

/** Maps a local search phrase to an OSM tag filter. Null when no category is recognised (Nominatim free-text fallback). */
export function osmCategoryFor(query: string): { key: string; value: string } | null {
  const q = query.toLowerCase();
  const table: [RegExp, { key: string; value: string }][] = [
    [/jewell|jewel|gold|diamond/, { key: 'shop', value: 'jewelry' }],
    [/dentist|dental/, { key: 'amenity', value: 'dentist' }],
    [/clinic|physician|doctor/, { key: 'amenity', value: 'clinic' }],
    [/hospital/, { key: 'amenity', value: 'hospital' }],
    [/pharmac|chemist|medical store/, { key: 'amenity', value: 'pharmacy' }],
    [/restaurant|dining|thali|biryani|dhaba/, { key: 'amenity', value: 'restaurant' }],
    [/cafe|coffee/, { key: 'amenity', value: 'cafe' }],
    [/bakery|cake/, { key: 'shop', value: 'bakery' }],
    [/salon|parlour|parlor|beauty|spa/, { key: 'shop', value: 'beauty' }],
    [/barber|hairdress|hair salon/, { key: 'shop', value: 'hairdresser' }],
    [/gym|fitness/, { key: 'leisure', value: 'fitness_centre' }],
    [/hotel|lodge/, { key: 'tourism', value: 'hotel' }],
    [/electronic|mobile shop|mobile store/, { key: 'shop', value: 'electronics' }],
    [/clothing|garment|boutique|apparel/, { key: 'shop', value: 'clothes' }],
    [/furniture/, { key: 'shop', value: 'furniture' }],
    [/supermarket|grocery|kirana|general store/, { key: 'shop', value: 'supermarket' }],
    [/school|coaching|tuition|academy/, { key: 'amenity', value: 'school' }],
    [/car repair|garage|mechanic/, { key: 'shop', value: 'car_repair' }],
    [/real estate|property dealer/, { key: 'office', value: 'estate_agent' }],
    [/lawyer|advocate|legal/, { key: 'office', value: 'lawyer' }],
  ];
  for (const [re, tag] of table) if (re.test(q)) return tag;
  return null;
}

function haversineMeters(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371000;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(bLat - aLat);
  const dLng = rad(bLng - aLng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

const osmValidLat = (n: unknown): n is number =>
  typeof n === 'number' && Number.isFinite(n) && n >= -90 && n <= 90;
const osmValidLng = (n: unknown): n is number =>
  typeof n === 'number' && Number.isFinite(n) && n >= -180 && n <= 180;

function osmDomain(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname
      .replace(/^www\./, '')
      .toLowerCase();
  } catch {
    return null;
  }
}

interface OverpassElement {
  type?: string;
  id?: number;
  lat?: number;
  lon?: number;
  center?: { lat?: number; lon?: number };
  tags?: Record<string, string>;
}

function osmAddress(tags: Record<string, string>): string | null {
  const parts = [
    tags['addr:housenumber'],
    tags['addr:street'],
    tags['addr:suburb'] ?? tags['addr:neighbourhood'],
    tags['addr:city'],
    tags['addr:postcode'],
  ].filter(Boolean);
  return parts.length ? parts.join(', ').slice(0, 300) : null;
}

/** Overpass elements → ranked (distance-ordered) results. Elements without a name or valid coordinates are dropped. */
export function parseOverpassResults(
  elements: OverpassElement[],
  center: { lat: number; lng: number },
  category: string | null,
): ProviderLocalResult[] {
  const seen = new Set<string>();
  const businesses = elements
    .map((el) => {
      const lat = el.lat ?? el.center?.lat;
      const lon = el.lon ?? el.center?.lon;
      const name = el.tags?.name?.trim();
      if (!name || !osmValidLat(lat) || !osmValidLng(lon)) return null;
      const website = el.tags?.website ?? el.tags?.['contact:website'] ?? null;
      return {
        osmId: `osm:${el.type}/${el.id}`,
        name: name.slice(0, 255),
        lat,
        lon,
        website,
        phone: el.tags?.phone ?? el.tags?.['contact:phone'] ?? null,
        address: osmAddress(el.tags ?? {}),
        distance: haversineMeters(center.lat, center.lng, lat, lon),
      };
    })
    .filter((b): b is NonNullable<typeof b> => b !== null)
    .filter((b) => !seen.has(b.osmId) && seen.add(b.osmId))
    .sort((a, b) => a.distance - b.distance);
  return businesses.map((b, n) => ({
    rank: n + 1,
    title: b.name,
    placeId: b.osmId,
    cid: null,
    domain: osmDomain(b.website),
    url: b.website,
    category,
    rating: null, // OpenStreetMap has no ratings or review counts.
    reviewCount: null,
    address: b.address,
    phone: b.phone,
    latitude: b.lat,
    longitude: b.lon,
  }));
}

interface NominatimItem {
  osm_type?: string;
  osm_id?: number;
  display_name?: string;
  name?: string;
  lat?: string;
  lon?: string;
  extratags?: Record<string, string> | null;
}

/** Nominatim free-text results → ranked (distance-ordered) results. */
export function parseNominatimResults(
  items: NominatimItem[],
  center: { lat: number; lng: number },
): ProviderLocalResult[] {
  const seen = new Set<string>();
  const businesses = items
    .map((it) => {
      const lat = it.lat ? Number(it.lat) : NaN;
      const lon = it.lon ? Number(it.lon) : NaN;
      const name = (it.name?.trim() || it.display_name?.split(',')[0]?.trim()) ?? '';
      if (!name || !osmValidLat(lat) || !osmValidLng(lon)) return null;
      const website = it.extratags?.website ?? it.extratags?.['contact:website'] ?? null;
      const id = `osm:${it.osm_type ?? 'n'}/${it.osm_id ?? name}`;
      return {
        id,
        name: name.slice(0, 255),
        lat,
        lon,
        website,
        phone: it.extratags?.phone ?? null,
        address: it.display_name?.slice(0, 300) ?? null,
        distance: haversineMeters(center.lat, center.lng, lat, lon),
      };
    })
    .filter((b): b is NonNullable<typeof b> => b !== null)
    .filter((b) => !seen.has(b.id) && seen.add(b.id))
    .sort((a, b) => a.distance - b.distance);
  return businesses.map((b, n) => ({
    rank: n + 1,
    title: b.name,
    placeId: b.id,
    cid: null,
    domain: osmDomain(b.website),
    url: b.website,
    category: null,
    rating: null,
    reviewCount: null,
    address: b.address,
    phone: b.phone,
    latitude: b.lat,
    longitude: b.lon,
  }));
}

// Politeness delay shared across OSM calls (Overpass and Nominatim fair-use ask for low request rates).
let osmLastCallAt = 0;
async function osmPolite(): Promise<void> {
  const wait = 1000 - (Date.now() - osmLastCallAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  osmLastCallAt = Date.now();
}

/** Search radii an OpenStreetMap batch collection widens through (km). */
const OSM_BATCH_RINGS_KM = [3, 6, 12, 25] as const;
interface OsmCursor {
  ring: number;
  index: number;
  /** Results in the rings before this one (for the overall position). */
  before: number;
}
function parseOsmCursor(raw: string | null): OsmCursor {
  if (!raw) return { ring: 0, index: 0, before: 0 };
  try {
    const c = JSON.parse(raw) as Partial<OsmCursor>;
    const ok = (n: unknown) => Number.isInteger(n) && (n as number) >= 0;
    if (ok(c.ring) && ok(c.index) && ok(c.before) && c.ring! < OSM_BATCH_RINGS_KM.length)
      return c as OsmCursor;
  } catch {
    /* fall through */
  }
  throw new LocalRankProviderError('OSM', 'ERROR', 'The saved OpenStreetMap cursor is not valid.');
}

export class OsmLocalRankProvider implements LocalRankProvider {
  readonly key = 'OSM' as const;
  readonly label = LOCAL_RANK_SOURCE_LABELS.OSM;
  /** Place discovery around a point. Not the Google local pack or organic web results. */
  readonly surfaces = ['MAPS'] as const;
  readonly live = true;

  configured() {
    return getEnv().SERP_PROVIDER === 'osm'
      ? {
          configured: true,
          detail:
            'OpenStreetMap community data (Overpass + Nominatim): real businesses mapped near each point, ordered by distance. This is discovery, not a Google Maps ranking; it has no ratings or review counts and coverage depends on what is mapped in OpenStreetMap.',
        }
      : {
          configured: false,
          detail:
            'Not enabled. Set SERP_PROVIDER=osm to collect real local businesses from OpenStreetMap (free, community data). It is distance-ordered discovery, not a Google Maps ranking.',
        };
  }

  async fetchPoint(request: LocalRankRequest, fetchImpl: LocalRankFetch = fetch): Promise<LocalRankResult> {
    const env = getEnv();
    if (env.SERP_PROVIDER !== 'osm')
      throw new LocalRankProviderError('OSM', 'NOT_CONFIGURED', this.configured().detail);
    if (request.surface !== 'MAPS')
      throw new LocalRankProviderError(
        'OSM',
        'UNSUPPORTED',
        'OpenStreetMap lists places for a map search; it does not provide a local pack or organic web results.',
      );
    const limit = Math.min(OSM_MAX_RESULTS, Math.max(request.depth, 10));
    const center = { lat: request.latitude, lng: request.longitude };
    const category = osmCategoryFor(request.query);
    const userAgent = env.CRAWLER_USER_AGENT;

    if (category) {
      const filter = `${category.key}=${category.value}`;
      const ql = `[out:json][timeout:25];(node[${filter}](around:${OSM_RADIUS_M},${request.latitude},${request.longitude});way[${filter}](around:${OSM_RADIUS_M},${request.latitude},${request.longitude}););out center tags ${limit};`;
      const res = await this.request(
        env.OVERPASS_URL,
        {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': userAgent },
          body: `data=${encodeURIComponent(ql)}`,
          signal: AbortSignal.timeout(30_000),
        },
        fetchImpl,
      );
      const json = (await res.json()) as { elements?: OverpassElement[] };
      return {
        results: parseOverpassResults(json.elements ?? [], center, filter).slice(0, limit),
        costUsd: 0,
        checkedAt: new Date(),
      };
    }

    // Free-text fallback for queries we cannot map to a category: Nominatim search bounded to a box around the point.
    const d = 0.05; // ~5 km
    const params = new URLSearchParams({
      q: request.query,
      format: 'jsonv2',
      limit: String(limit),
      extratags: '1',
      bounded: '1',
      viewbox: `${request.longitude - d},${request.latitude + d},${request.longitude + d},${request.latitude - d}`,
    });
    const res = await this.request(
      `${env.GEOCODER_URL}/search?${params.toString()}`,
      { method: 'GET', headers: { 'user-agent': userAgent, accept: 'application/json' }, signal: AbortSignal.timeout(20_000) }, // prettier-ignore
      fetchImpl,
    );
    const items = (await res.json()) as NominatimItem[];
    return {
      results: parseNominatimResults(Array.isArray(items) ? items : [], center).slice(0, limit),
      costUsd: 0,
      checkedAt: new Date(),
    };
  }

  readonly batching: LocalBatchCapability = {
    maxBatchSize: 20,
    // Overpass and Nominatim fair-use: at most about one request a second (osmPolite also enforces it).
    minDelayMs: 1000,
    pagination: `OpenStreetMap has no pagination: each request returns every mapped match within a radius. Batches are taken from that distance-ordered list, and the radius widens (${OSM_BATCH_RINGS_KM.join(' → ')} km) only when a ring is used up.`,
    observationType: 'discovery_order',
    googleRanking: false,
  };
  /** Each ring's distance-ordered list, fetched once per run (so batches never repeat a request). */
  private readonly ringCache = new Map<string, ProviderLocalResult[]>();

  async fetchBatch(request: LocalBatchRequest, fetchImpl: LocalRankFetch = fetch): Promise<LocalBatchResult> {
    const env = getEnv();
    if (env.SERP_PROVIDER !== 'osm')
      throw new LocalRankProviderError('OSM', 'NOT_CONFIGURED', this.configured().detail);
    const limit = Math.min(this.batching.maxBatchSize, Math.max(1, request.limit));
    const center = { lat: request.latitude, lng: request.longitude };
    const category = osmCategoryFor(request.query);
    const userAgent = env.CRAWLER_USER_AGENT;
    if (!category) {
      // No mapped category: Nominatim free-text search returns one bounded list (no pagination) — a single batch.
      if (request.cursor) return { results: [], offset: null, nextCursor: null, costUsd: 0, checkedAt: new Date(), observationType: 'discovery_order', note: null }; // prettier-ignore
      const d = 0.1; // ~10 km
      const params = new URLSearchParams({ q: request.query, format: 'jsonv2', limit: '40', extratags: '1', bounded: '1', viewbox: `${request.longitude - d},${request.latitude + d},${request.longitude + d},${request.latitude - d}` }); // prettier-ignore
      const res = await this.request(`${env.GEOCODER_URL}/search?${params.toString()}`, { method: 'GET', headers: { 'user-agent': userAgent, accept: 'application/json' }, signal: AbortSignal.timeout(20_000) }, fetchImpl); // prettier-ignore
      const items = (await res.json()) as NominatimItem[];
      const all = parseNominatimResults(Array.isArray(items) ? items : [], center).slice(0, limit);
      return { results: all, offset: 0, nextCursor: null, costUsd: 0, checkedAt: new Date(), observationType: 'discovery_order', note: 'Free-text OpenStreetMap search within about 10 km (one list, no further pages).' }; // prettier-ignore
    }
    const filter = `${category.key}=${category.value}`;
    let cursor = parseOsmCursor(request.cursor);
    for (;;) {
      const radiusKm = OSM_BATCH_RINGS_KM[cursor.ring]!;
      const innerKm = cursor.ring === 0 ? 0 : OSM_BATCH_RINGS_KM[cursor.ring - 1]!;
      const key = `${request.latitude},${request.longitude},${filter},${radiusKm}`;
      let ring = this.ringCache.get(key);
      if (!ring) {
        const m = radiusKm * 1000;
        // No server-side count limit: every match in the radius, sorted by distance here (a limit would truncate
        // by OpenStreetMap's internal order and could drop the nearest businesses).
        const ql = `[out:json][timeout:60];(node[${filter}](around:${m},${request.latitude},${request.longitude});way[${filter}](around:${m},${request.latitude},${request.longitude}););out center tags;`; // prettier-ignore
        const res = await this.request(env.OVERPASS_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': userAgent }, body: `data=${encodeURIComponent(ql)}`, signal: AbortSignal.timeout(70_000) }, fetchImpl); // prettier-ignore
        const json = (await res.json()) as { elements?: OverpassElement[] };
        // This ring only: beyond the previous radius (closer ones were already listed), still in distance order.
        ring = parseOverpassResults(json.elements ?? [], center, filter).filter(
          (r) => r.latitude !== null && r.longitude !== null && haversineMeters(center.lat, center.lng, r.latitude, r.longitude) > innerKm * 1000, // prettier-ignore
        );
        this.ringCache.set(key, ring);
      }
      const slice = ring.slice(cursor.index, cursor.index + limit);
      const nextIndex = cursor.index + slice.length;
      const lastRing = cursor.ring === OSM_BATCH_RINGS_KM.length - 1;
      const next: OsmCursor | null =
        nextIndex < ring.length ? { ...cursor, index: nextIndex } : lastRing ? null : { ring: cursor.ring + 1, index: 0, before: cursor.before + ring.length }; // prettier-ignore
      if (slice.length || !next) {
        const offset = cursor.before + cursor.index;
        return {
          results: slice.map((r, i) => ({ ...r, rank: offset + i + 1 })),
          offset,
          nextCursor: next ? JSON.stringify(next) : null,
          costUsd: 0,
          checkedAt: new Date(),
          observationType: 'discovery_order',
          note: `Mapped in OpenStreetMap ${innerKm ? `${innerKm}–` : 'within '}${radiusKm} km of the location, nearest first.`,
        };
      }
      cursor = next; // an empty ring: widen the radius and continue
    }
  }

  private async request(url: string, init: RequestInit, fetchImpl: LocalRankFetch): Promise<Response> {
    await osmPolite();
    let res: Response;
    try {
      res = await fetchImpl(url, init);
    } catch (error) {
      const timedOut =
        error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      throw new LocalRankProviderError(
        'OSM',
        timedOut ? 'TIMEOUT' : 'ERROR',
        timedOut
          ? 'OpenStreetMap did not answer in time.'
          : `OpenStreetMap could not be reached: ${errorMessage(error)}`,
      );
    }
    if (res.status === 429)
      throw new LocalRankProviderError(
        'OSM',
        'RATE_LIMITED',
        'OpenStreetMap is rate-limiting requests (Overpass/Nominatim fair-use). Use a smaller grid or try again later.',
      );
    if (!res.ok)
      throw new LocalRankProviderError('OSM', 'ERROR', `OpenStreetMap returned HTTP ${res.status}.`);
    return res;
  }
}

// ---------------- Custom collection service (operator-hosted) ----------------
// The operator runs their own local-search collection service and sets SERP_PROVIDER=custom + CUSTOM_SERP_URL. For
// each grid point the app POSTs the exact query, coordinates and context, and stores the returned results IN THE
// ORDER GIVEN, as observed positions, without reordering by rating, distance or anything else. The operator builds
// and is responsible for that service and the compliance of its collection method; this connector only transports
// and validates the data. If the service fails or returns nothing, the point is an explicit error — never invented.

interface CustomSerpResult {
  title?: string;
  rank?: number;
  /** Whether the source flagged this as a sponsored/paid listing. */
  sponsored?: boolean;
  /** Which continuation batch/page this listing came from (>=1). Omitted means the first/only batch. */
  batch?: number;
  /** Position within its batch as the source presented it. Omitted falls back to the order given within the batch. */
  sourcePosition?: number;
  /** Alias some sources use for the within-batch position. */
  position?: number;
  placeId?: string | null;
  cid?: string | null;
  domain?: string | null;
  url?: string | null;
  category?: string | null;
  rating?: number | null;
  reviewCount?: number | null;
  address?: string | null;
  phone?: string | null;
  latitude?: number | null;
  longitude?: number | null;
}

const asPositiveInt = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : null;

/**
 * Normalizes the custom service's results, PRESERVING their given order as observed positions (never re-sorted).
 * `continuous` (set only when the source itself declares the batches form one uninterrupted sequence) is what lets
 * us assign a cumulative position across batches — without it, each result keeps only its within-batch position and
 * we never invent a continuous ranking the source did not establish.
 */
export function parseCustomSerpResults(
  results: CustomSerpResult[],
  options: { continuous?: boolean } = {},
): ProviderLocalResult[] {
  const kept = results.filter((r) => typeof r.title === 'string' && r.title.trim().length > 0);
  const withinBatch = new Map<number, number>();
  let cumulative = 0;
  return kept.map((r) => {
    const batch = asPositiveInt(r.batch) ?? 1;
    const nextWithin = (withinBatch.get(batch) ?? 0) + 1;
    withinBatch.set(batch, nextWithin);
    // Position within its batch: the source's own value if given, otherwise the order it returned them in.
    const sourcePosition = asPositiveInt(r.sourcePosition) ?? asPositiveInt(r.position) ?? nextWithin;
    cumulative += 1;
    const cumulativePosition = options.continuous ? cumulative : null;
    // The position metrics use: the source's explicit rank if it gave one; else the cumulative position when the
    // source established continuity; else the within-batch position. Never re-ranked by rating, distance or anything.
    const rank = asPositiveInt(r.rank) ?? cumulativePosition ?? sourcePosition;
    return {
      rank,
      title: (r.title as string).trim().slice(0, 255),
      placeId: r.placeId ?? null,
      cid: r.cid ?? null,
      domain: r.domain ? r.domain.replace(/^www\./, '').toLowerCase() : null,
      url: r.url ?? null,
      category: r.category ?? null,
      rating: typeof r.rating === 'number' && Number.isFinite(r.rating) ? r.rating : null,
      reviewCount: typeof r.reviewCount === 'number' && Number.isFinite(r.reviewCount) ? r.reviewCount : null,
      address: r.address ?? null,
      phone: r.phone ?? null,
      latitude: osmValidLat(r.latitude) ? r.latitude : null,
      longitude: osmValidLng(r.longitude) ? r.longitude : null,
      sponsored: typeof r.sponsored === 'boolean' ? r.sponsored : undefined,
      batch,
      sourcePosition,
      cumulativePosition,
    };
  });
}

export class CustomHttpLocalRankProvider implements LocalRankProvider {
  readonly key = 'CUSTOM' as const;
  readonly label = LOCAL_RANK_SOURCE_LABELS.CUSTOM;
  readonly surfaces = ['MAPS', 'LOCAL_PACK', 'ORGANIC'] as const;
  readonly live = true;

  configured() {
    const env = getEnv();
    if (env.SERP_PROVIDER !== 'custom')
      return {
        configured: false,
        detail: 'Not enabled. Set SERP_PROVIDER=custom and CUSTOM_SERP_URL to your own collection service.',
      };
    return env.CUSTOM_SERP_URL
      ? {
          configured: true,
          detail:
            'Your own collection service at CUSTOM_SERP_URL. Results are stored in the order it returns them, as observed positions. You build and are responsible for that service and its compliance.',
        }
      : {
          configured: false,
          detail: 'SERP_PROVIDER=custom needs CUSTOM_SERP_URL (your collection service endpoint).',
        };
  }

  readonly batching: LocalBatchCapability = {
    maxBatchSize: 20,
    minDelayMs: 0,
    pagination:
      'Your service’s own cursor: OptiReach sends { limit, cursor } and continues while the service returns nextCursor. Your service declares what its order means; OptiReach shows that declaration and does not verify it.',
    observationType: 'observed_search_position',
    googleRanking: false,
  };

  /** One batch from the operator's service: POST { …point, limit, cursor } → { results, nextCursor?, offset? }. */
  async fetchBatch(request: LocalBatchRequest, fetchImpl: LocalRankFetch = fetch): Promise<LocalBatchResult> {
    const env = getEnv();
    if (env.SERP_PROVIDER !== 'custom' || !env.CUSTOM_SERP_URL)
      throw new LocalRankProviderError('CUSTOM', 'NOT_CONFIGURED', this.configured().detail);
    let response: Response;
    try {
      response = await fetchImpl(env.CUSTOM_SERP_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(env.CUSTOM_SERP_TOKEN ? { authorization: `Bearer ${env.CUSTOM_SERP_TOKEN}` } : {}) }, // prettier-ignore
        body: JSON.stringify({
          query: request.query,
          latitude: request.latitude,
          longitude: request.longitude,
          surface: request.surface,
          language: request.language,
          device: request.device,
          country: request.country ?? null,
          limit: request.limit,
          cursor: request.cursor,
        }),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (error) {
      const timedOut =
        error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      throw new LocalRankProviderError('CUSTOM', timedOut ? 'TIMEOUT' : 'ERROR', timedOut ? 'The custom collection service did not answer within 60 seconds.' : `The custom collection service could not be reached: ${errorMessage(error)}`); // prettier-ignore
    }
    if (response.status === 429) {
      const retryAfter = Number(response.headers.get('retry-after'));
      throw new LocalRankProviderError('CUSTOM', 'RATE_LIMITED', `The custom collection service is rate-limiting requests${Number.isFinite(retryAfter) && retryAfter > 0 ? ` (retry after ${retryAfter}s)` : ''}.`, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : null); // prettier-ignore
    }
    if (response.status === 401 || response.status === 403)
      throw new LocalRankProviderError('CUSTOM', 'NOT_CONFIGURED', 'The custom collection service rejected the token (check CUSTOM_SERP_TOKEN).'); // prettier-ignore
    if (!response.ok)
      throw new LocalRankProviderError('CUSTOM', 'ERROR', `The custom collection service returned HTTP ${response.status}.`); // prettier-ignore
    const json = (await response.json().catch(() => null)) as {
      results?: CustomSerpResult[];
      nextCursor?: unknown;
      offset?: unknown;
      collectedAt?: string;
      continuous?: boolean;
      observationType?: string;
    } | null;
    if (!json || !Array.isArray(json.results))
      throw new LocalRankProviderError('CUSTOM', 'ERROR', 'The custom collection service did not return a { results: [...] } object.'); // prettier-ignore
    const checkedAt = json.collectedAt ? new Date(json.collectedAt) : new Date();
    const offset =
      typeof json.offset === 'number' && Number.isInteger(json.offset) && json.offset >= 0
        ? json.offset
        : null;
    const observationType = (LOCAL_OBSERVATION_TYPES as readonly string[]).includes(
      json.observationType ?? '',
    )
      ? (json.observationType as LocalObservationType)
      : 'observed_search_position';
    return {
      results: parseCustomSerpResults(json.results, { continuous: json.continuous === true }).slice(0, Math.max(1, request.limit)), // prettier-ignore
      offset,
      nextCursor:
        typeof json.nextCursor === 'string' && json.nextCursor.length > 0
          ? json.nextCursor.slice(0, 2000)
          : null,
      costUsd: 0,
      checkedAt: Number.isNaN(checkedAt.getTime()) ? new Date() : checkedAt,
      observationType,
      note: null,
    };
  }

  async fetchPoint(request: LocalRankRequest, fetchImpl: LocalRankFetch = fetch): Promise<LocalRankResult> {
    const env = getEnv();
    if (env.SERP_PROVIDER !== 'custom' || !env.CUSTOM_SERP_URL)
      throw new LocalRankProviderError('CUSTOM', 'NOT_CONFIGURED', this.configured().detail);
    let response: Response;
    try {
      response = await fetchImpl(env.CUSTOM_SERP_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(env.CUSTOM_SERP_TOKEN ? { authorization: `Bearer ${env.CUSTOM_SERP_TOKEN}` } : {}),
        },
        body: JSON.stringify({
          query: request.query,
          latitude: request.latitude,
          longitude: request.longitude,
          surface: request.surface,
          language: request.language,
          device: request.device,
          depth: request.depth,
          country: request.country ?? null,
        }),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (error) {
      const timedOut =
        error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      throw new LocalRankProviderError(
        'CUSTOM',
        timedOut ? 'TIMEOUT' : 'ERROR',
        timedOut
          ? 'The custom collection service did not answer within 60 seconds.'
          : `The custom collection service could not be reached: ${errorMessage(error)}`,
      );
    }
    if (response.status === 429)
      throw new LocalRankProviderError('CUSTOM', 'RATE_LIMITED', 'The custom collection service is rate-limiting requests.'); // prettier-ignore
    if (response.status === 401 || response.status === 403)
      throw new LocalRankProviderError('CUSTOM', 'NOT_CONFIGURED', 'The custom collection service rejected the token (check CUSTOM_SERP_TOKEN).'); // prettier-ignore
    if (!response.ok)
      throw new LocalRankProviderError('CUSTOM', 'ERROR', `The custom collection service returned HTTP ${response.status}.`); // prettier-ignore
    const json = (await response.json().catch(() => null)) as {
      results?: CustomSerpResult[];
      collectedAt?: string;
      /** The source sets this true ONLY when its batches form one uninterrupted sequence (enables cumulative position). */
      continuous?: boolean;
      /** How the order was obtained; honored only if it is one of the known observation types, else defaulted later. */
      observationType?: string;
    } | null;
    if (!json || !Array.isArray(json.results))
      throw new LocalRankProviderError('CUSTOM', 'ERROR', 'The custom collection service did not return a { results: [...] } object.'); // prettier-ignore
    const checkedAt = json.collectedAt ? new Date(json.collectedAt) : new Date();
    const observationType = (LOCAL_OBSERVATION_TYPES as readonly string[]).includes(
      json.observationType ?? '',
    )
      ? (json.observationType as LocalObservationType)
      : undefined;
    return {
      results: parseCustomSerpResults(json.results, { continuous: json.continuous === true }).slice(
        0,
        Math.max(request.depth, 1),
      ),
      costUsd: 0,
      checkedAt: Number.isNaN(checkedAt.getTime()) ? new Date() : checkedAt,
      observationType,
    };
  }
}

// ---------------- Development fixture ----------------

const FIXTURE_NAMES = ['Shree Ornaments', 'Royal Gems & Jewels', 'Navrang Jewellers', 'City Gold House', 'Heritage Diamonds', 'Lakshmi Jewellers', 'Moti Mahal Jewels', 'Sapphire Studio', 'Kanak Jewellery', 'Silver Line Store']; // prettier-ignore

/** Deterministic generated results for development and tests. Clearly labeled; refused in production. */
export class FixtureLocalRankProvider implements LocalRankProvider {
  readonly key = 'FIXTURE' as const;
  readonly label = LOCAL_RANK_SOURCE_LABELS.FIXTURE;
  readonly surfaces = ['MAPS', 'LOCAL_PACK', 'ORGANIC'] as const;
  readonly live = true;

  /** The tracked business name the fixture inserts at a varying rank (set by the scan before fetching). */
  constructor(private readonly targetName: string | null = null) {}

  configured() {
    const env = getEnv();
    if (env.isProduction)
      return { configured: false, detail: 'The development fixture is not available in production.' };
    return env.LOCAL_RANK_FIXTURES
      ? { configured: true, detail: 'Generated sample results for development and tests. Not real Google data.' }
      : { configured: false, detail: 'The development fixture is off (LOCAL_RANK_FIXTURES=true enables it outside production).' }; // prettier-ignore
  }

  async fetchPoint(request: LocalRankRequest): Promise<LocalRankResult> {
    if (getEnv().isProduction)
      throw new LocalRankProviderError('FIXTURE', 'NOT_CONFIGURED', this.configured().detail);
    const seed = createHash('sha256').update(`${request.query}|${request.latitude.toFixed(4)}|${request.longitude.toFixed(4)}`).digest(); // prettier-ignore
    const names = [...FIXTURE_NAMES].sort(
      (a, b) => seed[a.length % 32]! - seed[b.length % 32]! || a.localeCompare(b),
    );
    // The tracked business appears at a rank that depends on the point (sometimes beyond the depth).
    const targetRank = (seed[0]! % 14) + 1;
    const results: ProviderLocalResult[] = [];
    for (let rank = 1, n = 0; rank <= Math.min(request.depth, 12); rank++) {
      const isTarget = this.targetName && rank === targetRank;
      const title = isTarget ? this.targetName! : names[n++ % names.length]!;
      results.push({
        rank,
        title,
        placeId: `fixture-${createHash('sha1').update(title).digest('hex').slice(0, 12)}`,
        cid: null,
        domain: isTarget ? null : `${title.toLowerCase().replace(/[^a-z]+/g, '')}.example`,
        url: null,
        category: 'Jewelry store',
        rating: Math.round((4 + (seed[rank % 32]! % 10) / 10) * 10) / 10,
        reviewCount: 20 + (seed[(rank + 7) % 32]! % 400),
        address: null,
        phone: null,
        latitude: request.latitude,
        longitude: request.longitude,
      });
    }
    return { results, costUsd: 0, checkedAt: new Date() };
  }
}

// ---------------- Registry ----------------

let overrides: Partial<Record<LocalRankSource, LocalRankProvider>> = {};

/** Test hook. */
export function setLocalRankProviderOverrides(
  next: Partial<Record<LocalRankSource, LocalRankProvider>>,
): void {
  overrides = next;
}

export function getLocalRankProvider(
  key: LocalRankSource,
  targetName: string | null = null,
): LocalRankProvider {
  if (overrides[key]) return overrides[key]!;
  if (key === 'GOOGLE_CSE') return new GoogleCustomSearchLocalRankProvider();
  if (key === 'OSM') return new OsmLocalRankProvider();
  if (key === 'CUSTOM') return new CustomHttpLocalRankProvider();
  if (key === 'FIXTURE') return new FixtureLocalRankProvider(targetName);
  return {
    key,
    label: LOCAL_RANK_SOURCE_LABELS[key],
    surfaces: ['MAPS', 'LOCAL_PACK', 'ORGANIC'],
    live: false,
    configured: () => ({ configured: true, detail: key === 'MANUAL' ? 'Enter what you see at a place, labeled as a manual observation.' : key === 'GOOGLE_CAPTURE' ? 'Add a Google results page you saved in your browser; OptiReach reads the saved file.' : 'Import observations from a CSV file.' }), // prettier-ignore
  };
}

/** Live providers the server allows (the fixture only outside production, and only when TRENDS-style flag allows). */
export function liveLocalRankSources(): LocalRankSource[] {
  const env = getEnv();
  const out: LocalRankSource[] = [];
  if (new GoogleCustomSearchLocalRankProvider().configured().configured) out.push('GOOGLE_CSE');
  if (new OsmLocalRankProvider().configured().configured) out.push('OSM');
  if (new CustomHttpLocalRankProvider().configured().configured) out.push('CUSTOM');
  if (!env.isProduction && env.LOCAL_RANK_FIXTURES) out.push('FIXTURE');
  return out;
}
