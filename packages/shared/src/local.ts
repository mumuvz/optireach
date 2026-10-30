// Local SEO: business profile (types, presence, goals), business locations, local rank tracking on geographic grids,
// and local competitors. Every rank shown comes from a stored observation with its provider and capture time;
// manual entries are labeled as manual and are never presented as live Google rankings.
import { z } from 'zod';
import { LLM_PROVIDER_KEYS } from './enums';
import { countryCodeSchema, languageCodeSchema } from './schemas/common';

// ---------------- Business profile ----------------

export const BUSINESS_TYPES = [
  'LOCAL_STOREFRONT',
  'SERVICE_AREA',
  'RETAIL_STORE',
  'ECOMMERCE',
  'MERCHANT_SELLER',
  'MULTI_LOCATION',
  'AGENCY_CLIENT',
] as const;
export type BusinessType = (typeof BUSINESS_TYPES)[number];
export const BUSINESS_TYPE_LABELS: Record<BusinessType, string> = {
  LOCAL_STOREFRONT: 'Local business with premises customers visit',
  SERVICE_AREA: 'Service-area business (you go to customers)',
  RETAIL_STORE: 'Retail store',
  ECOMMERCE: 'Online store (ecommerce)',
  MERCHANT_SELLER: 'Sells products through Google Merchant Center',
  MULTI_LOCATION: 'Several branches or locations',
  AGENCY_CLIENT: 'Managed by an agency',
};

/** What the business says about its Google Business Profile (verified only when a connected account confirms it). */
export const PROFILE_PRESENCE = [
  'CONNECTED',
  'VERIFIED_NOT_CONNECTED',
  'UNVERIFIED',
  'NONE',
  'UNKNOWN',
] as const;
export type ProfilePresence = (typeof PROFILE_PRESENCE)[number];
export const PROFILE_PRESENCE_LABELS: Record<ProfilePresence, string> = {
  CONNECTED: 'Connected to OptiReach',
  VERIFIED_NOT_CONNECTED: 'Has a verified profile (not connected yet)',
  UNVERIFIED: 'Has a profile that is not verified',
  NONE: 'No Business Profile',
  UNKNOWN: 'Not sure',
};

export const BUSINESS_GOALS = [
  'MORE_CALLS',
  'MORE_VISITS',
  'MORE_DIRECTION_REQUESTS',
  'MORE_ONLINE_SALES',
  'MORE_LEADS',
  'BRAND_AWARENESS',
  'AI_RECOMMENDATIONS',
] as const;
export type BusinessGoal = (typeof BUSINESS_GOALS)[number];
export const BUSINESS_GOAL_LABELS: Record<BusinessGoal, string> = {
  MORE_CALLS: 'More phone calls',
  MORE_VISITS: 'More store visits',
  MORE_DIRECTION_REQUESTS: 'More direction requests',
  MORE_ONLINE_SALES: 'More online sales',
  MORE_LEADS: 'More enquiries and leads',
  BRAND_AWARENESS: 'Be known in the area',
  AI_RECOMMENDATIONS: 'Be recommended by AI assistants',
};

const urlListSchema = z.array(z.url().max(500)).max(20).default([]);
const shortList = (max: number, each = 120) =>
  z.array(z.string().trim().min(1).max(each)).max(max).default([]);

/** Stored on the project (`projects.businessProfile`). Only what the business provided; nothing is inferred. */
export const businessProfileSchema = z.object({
  types: z.array(z.enum(BUSINESS_TYPES)).max(BUSINESS_TYPES.length).default([]),
  legalName: z.string().trim().max(200).nullable().default(null),
  primaryCategory: z.string().trim().max(120).nullable().default(null),
  secondaryCategories: shortList(10),
  profilePresence: z.enum(PROFILE_PRESENCE).default('UNKNOWN'),
  hasMerchantCenter: z.boolean().default(false),
  productFeedUrl: z.url().max(1000).nullable().default(null),
  services: shortList(50),
  products: shortList(50),
  localities: shortList(50),
  socialProfiles: urlListSchema,
  directories: urlListSchema,
  goals: z.array(z.enum(BUSINESS_GOALS)).max(BUSINESS_GOALS.length).default([]),
});
export type BusinessProfile = z.output<typeof businessProfileSchema>;
export type BusinessProfileInput = z.input<typeof businessProfileSchema>;

export const EMPTY_BUSINESS_PROFILE: BusinessProfile = businessProfileSchema.parse({});

// ---------------- Locations ----------------

export const LOCATION_KINDS = ['STOREFRONT', 'SERVICE_AREA', 'HYBRID'] as const;
export type LocationKind = (typeof LOCATION_KINDS)[number];
export const LOCATION_KIND_LABELS: Record<LocationKind, string> = {
  STOREFRONT: 'Customers visit this address',
  SERVICE_AREA: 'Serves customers at their location (address hidden)',
  HYBRID: 'Both: visits and service area',
};

export const WEEKDAYS = [
  'MONDAY',
  'TUESDAY',
  'WEDNESDAY',
  'THURSDAY',
  'FRIDAY',
  'SATURDAY',
  'SUNDAY',
] as const;
export type Weekday = (typeof WEEKDAYS)[number];

const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$|^24:00$/, 'Use HH:MM');
export const openingPeriodSchema = z
  .object({ day: z.enum(WEEKDAYS), open: timeSchema, close: timeSchema })
  .refine((p) => p.close > p.open || p.close === '00:00', {
    message: 'Closing time must be after opening time',
  });
export type OpeningPeriod = z.infer<typeof openingPeriodSchema>;

const latitudeSchema = z.number().min(-90).max(90);
const longitudeSchema = z.number().min(-180).max(180);

export const locationInputSchema = z
  .object({
    name: z.string().trim().min(2, 'Enter the business name').max(200),
    kind: z.enum(LOCATION_KINDS).default('STOREFRONT'),
    primaryCategory: z.string().trim().max(120).nullable().default(null),
    secondaryCategories: shortList(10),
    addressLine1: z.string().trim().max(200).nullable().default(null),
    addressLine2: z.string().trim().max(200).nullable().default(null),
    /** Neighbourhood or locality, e.g. Mota Varachha. */
    locality: z.string().trim().max(120).nullable().default(null),
    city: z.string().trim().min(2, 'Enter the city').max(120),
    region: z.string().trim().max(120).nullable().default(null),
    postalCode: z.string().trim().max(20).nullable().default(null),
    country: countryCodeSchema,
    /** Places or postal codes served (service-area businesses). */
    serviceAreas: shortList(30),
    latitude: latitudeSchema.nullable().default(null),
    longitude: longitudeSchema.nullable().default(null),
    phone: z.string().trim().max(40).nullable().default(null),
    email: z.email().max(254).nullable().default(null),
    websiteUrl: z.url().max(2048).nullable().default(null),
    openingHours: z.array(openingPeriodSchema).max(28).default([]),
    isPrimary: z.boolean().default(false),
    /** Google place ID, when filled from a Google link or a linked Business Profile (used to recognise the business in rank results). */
    placeId: z.string().trim().max(200).nullable().default(null),
  })
  .superRefine((v, ctx) => {
    if ((v.latitude === null) !== (v.longitude === null))
      ctx.addIssue({
        code: 'custom',
        path: ['longitude'],
        message: 'Enter both latitude and longitude, or neither',
      });
    if (v.kind !== 'SERVICE_AREA' && !v.addressLine1)
      ctx.addIssue({
        code: 'custom',
        path: ['addressLine1'],
        message: 'Enter the street address customers visit',
      });
    if (v.kind === 'SERVICE_AREA' && !v.serviceAreas.length)
      ctx.addIssue({ code: 'custom', path: ['serviceAreas'], message: 'Add at least one area you serve' });
  });
export type LocationInput = z.input<typeof locationInputSchema>;
export type LocationData = z.output<typeof locationInputSchema>;

export const LOCATION_SOURCES = ['MANUAL', 'BUSINESS_PROFILE', 'IMPORT'] as const;
export type LocationSource = (typeof LOCATION_SOURCES)[number];

export interface LocationDto extends LocationData {
  id: string;
  projectId: string;
  source: LocationSource;
  /** Business Profile location resource, when linked through a connected account. */
  profileLocationName: string | null;
  createdAt: string;
  updatedAt: string;
}

// ---------------- Local rank tracking ----------------

export const LOCAL_SURFACES = ['MAPS', 'LOCAL_PACK', 'ORGANIC'] as const;
export type LocalSurface = (typeof LOCAL_SURFACES)[number];
export const LOCAL_SURFACE_LABELS: Record<LocalSurface, string> = {
  MAPS: 'Google Maps',
  LOCAL_PACK: 'Local pack (map results on the search page)',
  ORGANIC: 'Organic search results',
};

export const RANK_FREQUENCIES = ['MANUAL', 'WEEKLY', 'MONTHLY'] as const;
export type RankFrequency = (typeof RANK_FREQUENCIES)[number];

/** Grid sizes: odd so the business sits at the centre point. */
export const GRID_SIZES = [1, 3, 5, 7, 9] as const;
export const GRID_SPACING_KM = { min: 0.2, max: 10 } as const;
/** Results checked per point; a business beyond this depth is "not found in the top N". */
export const RANK_DEPTHS = [10, 20, 50, 100] as const;

export const localRankQueryInputSchema = z.object({
  query: z.string().trim().min(2, 'Enter a search query').max(200),
  locationId: z.string().min(1).max(32),
  surface: z.enum(LOCAL_SURFACES).default('MAPS'),
  language: languageCodeSchema.default('en'),
  device: z.enum(['desktop', 'mobile']).default('mobile'),
  gridSize: z
    .int()
    .refine((n) => (GRID_SIZES as readonly number[]).includes(n), 'Choose a grid size of 1, 3, 5, 7 or 9')
    .default(5),
  spacingKm: z.number().min(GRID_SPACING_KM.min).max(GRID_SPACING_KM.max).default(1),
  depth: z
    .int()
    .refine((n) => (RANK_DEPTHS as readonly number[]).includes(n), 'Choose a depth of 10, 20, 50 or 100')
    .default(20),
  /** Centre of the grid; defaults to the location's coordinates. */
  centerLatitude: latitudeSchema.nullable().default(null),
  centerLongitude: longitudeSchema.nullable().default(null),
  frequency: z.enum(RANK_FREQUENCIES).default('MANUAL'),
});
export type LocalRankQueryInput = z.input<typeof localRankQueryInputSchema>;

export const LOCAL_RANK_SOURCES = [
  'GOOGLE_CSE',
  'OSM',
  'CUSTOM',
  'MANUAL',
  'IMPORT',
  'GOOGLE_CAPTURE',
  'FIXTURE',
] as const;
export type LocalRankSource = (typeof LOCAL_RANK_SOURCES)[number];
export const LOCAL_RANK_SOURCE_LABELS: Record<LocalRankSource, string> = {
  GOOGLE_CSE: 'Google organic (Programmable Search API)',
  OSM: 'OpenStreetMap discovery (community data, distance-ordered)',
  CUSTOM: 'Your own collection service',
  MANUAL: 'Manual observation (entered by a person)',
  IMPORT: 'Imported observations (CSV)',
  GOOGLE_CAPTURE: 'Google results page you saved (order as Google showed it to you)',
  FIXTURE: 'Development fixture (not real Google data)',
};

export type GridPointStatus = 'FOUND' | 'NOT_FOUND' | 'FAILED' | 'PENDING';

/** One business listed at a grid point, as the provider returned it. */
export interface LocalResult {
  rank: number;
  title: string;
  placeId: string | null;
  cid: string | null;
  domain: string | null;
  category: string | null;
  rating: number | null;
  reviewCount: number | null;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  /** True when this result is the tracked business (matched by place ID, website or exact name). */
  isTarget: boolean;
  competitorId: string | null;
  /** True when the source identified this listing as sponsored/paid (not an organic result). Optional on
   * older observations collected before sponsored status was captured. */
  sponsored?: boolean;
  /** The continuation batch/page the listing came from (1 for the first view). */
  batch?: number;
  /** Position within its batch, exactly as the source displayed it. */
  sourcePosition?: number;
  /** Position in the combined sequence across batches — set only when the source established continuity. */
  cumulativePosition?: number | null;
  /** The business's own website, when the source listed one. */
  website?: string | null;
  /** A link to the business on Google Maps, when the source provided one or a Google place identifier. */
  mapsUrl?: string | null;
  /** Google's Knowledge Graph entity ID for the business, when the source carried it (Google page captures). */
  entityId?: string | null;
  /** Later observations of this same listing (multi-page captures): kept once, every sighting recorded. */
  alsoSeen?: { batch: number; sourcePosition: number; cumulativePosition: number | null }[];
  /** Profile details the listing showed (Google page captures; absent on older observations and other sources).
   * Hours as shown when the page was saved, e.g. "Open · Closes 8 pm". */
  hours?: string | null;
  /** Service options as shown, e.g. ["In-store shopping", "Delivery"]. */
  serviceOptions?: string[];
  /** Whether the listing showed a phone number (the number itself is not stored). */
  phoneShown?: boolean;
  /** The customer-review quote the listing showed, without quotation marks. */
  reviewSnippet?: string | null;
  /** Whether the business profile lists a website (from the saved page's own data); absent when not known. */
  websiteListed?: boolean;
}

/** How a scan's result order was obtained — so a discovery list is never shown as a Google search ranking. */
export const LOCAL_OBSERVATION_TYPES = [
  'observed_search_position',
  'discovery_order',
  'estimated_visibility',
] as const;
export type LocalObservationType = (typeof LOCAL_OBSERVATION_TYPES)[number];
export const LOCAL_OBSERVATION_TYPE_LABELS: Record<LocalObservationType, string> = {
  observed_search_position: 'Observed search position (order as shown by the source)',
  discovery_order: 'Discovery order (not a search ranking)',
  estimated_visibility: 'Development sample (not real data)',
};
/** The observation type implied by a collection source. Custom/manual/organic preserve the source's shown order. */
export function observationTypeForSource(source: LocalRankSource): LocalObservationType {
  if (source === 'OSM') return 'discovery_order';
  if (source === 'FIXTURE') return 'estimated_visibility';
  return 'observed_search_position';
}

export interface GridPointDto {
  row: number;
  col: number;
  latitude: number;
  longitude: number;
  status: GridPointStatus;
  /** Rank of the tracked business, null when not found within `depth` or not measured. */
  rank: number | null;
  error: string | null;
  results: LocalResult[];
}

/**
 * Grid visibility: of the points measured successfully, the share where the business ranks in the top 3
 * (`top3Share`). Failed points are left out of the denominator, and `coverage` says how many were measured.
 */
export interface GridSummary {
  pointsPlanned: number;
  pointsMeasured: number;
  pointsFailed: number;
  coverage: number;
  top3: number;
  top10: number;
  notFound: number;
  top3Share: number | null;
  top10Share: number | null;
  /** Average rank over points where the business was found (null when never found). */
  averageRankFound: number | null;
}

export function summarizeGrid(points: Pick<GridPointDto, 'status' | 'rank'>[]): GridSummary {
  const measured = points.filter((p) => p.status === 'FOUND' || p.status === 'NOT_FOUND');
  const found = measured.filter((p) => p.status === 'FOUND' && p.rank !== null);
  const top3 = found.filter((p) => p.rank! <= 3).length;
  const top10 = found.filter((p) => p.rank! <= 10).length;
  const share = (n: number) => (measured.length ? Math.round((n / measured.length) * 1000) / 10 : null);
  return {
    pointsPlanned: points.length,
    pointsMeasured: measured.length,
    pointsFailed: points.filter((p) => p.status === 'FAILED').length,
    coverage: points.length ? Math.round((measured.length / points.length) * 1000) / 10 : 0,
    top3,
    top10,
    notFound: measured.length - found.length,
    top3Share: share(top3),
    top10Share: share(top10),
    averageRankFound: found.length
      ? Math.round((found.reduce((s, p) => s + p.rank!, 0) / found.length) * 10) / 10
      : null,
  };
}

/** Grid point coordinates: `size` × `size` points, `spacingKm` apart, centred on the business. */
export function gridPoints(
  centerLatitude: number,
  centerLongitude: number,
  size: number,
  spacingKm: number,
): { row: number; col: number; latitude: number; longitude: number }[] {
  const half = Math.floor(size / 2);
  const kmPerDegreeLat = 110.574;
  const kmPerDegreeLng = 111.32 * Math.cos((centerLatitude * Math.PI) / 180);
  const out = [];
  for (let row = 0; row < size; row++)
    for (let col = 0; col < size; col++)
      out.push({
        row,
        col,
        latitude: Math.round((centerLatitude + ((half - row) * spacingKm) / kmPerDegreeLat) * 1e7) / 1e7,
        longitude: Math.round((centerLongitude + ((col - half) * spacingKm) / Math.max(kmPerDegreeLng, 1e-6)) * 1e7) / 1e7, // prettier-ignore
      });
  return out;
}

export interface LocalRankQueryDto {
  id: string;
  locationId: string;
  query: string;
  surface: LocalSurface;
  language: string;
  device: 'desktop' | 'mobile';
  gridSize: number;
  spacingKm: number;
  depth: number;
  centerLatitude: number;
  centerLongitude: number;
  frequency: RankFrequency;
  nextRunAt: string | null;
  status: 'ACTIVE' | 'PAUSED';
  latestScan: LocalRankScanSummaryDto | null;
  createdAt: string;
}

export interface LocalRankScanSummaryDto {
  id: string;
  queryId: string;
  source: LocalRankSource;
  status: 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
  trigger: 'MANUAL' | 'SCHEDULED';
  summary: GridSummary;
  costUsd: number | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface LocalRankScanDto extends LocalRankScanSummaryDto {
  query: string;
  surface: LocalSurface;
  language: string;
  device: 'desktop' | 'mobile';
  gridSize: number;
  spacingKm: number;
  depth: number;
  centerLatitude: number;
  centerLongitude: number;
  points: GridPointDto[];
  /** How the result order was obtained; null on older scans (treat as the per-source default). */
  observationType: LocalObservationType | null;
  /** Whether the collection fully succeeded, partly succeeded, failed, or is still running. */
  collectionStatus: CollectionStatus;
  /** For Google page captures: each saved page (batch), its address, offset and outcome. Null for other sources. */
  captureBatches: GoogleCaptureBatchDto[] | null;
  /** For Google page collections: target, state and counts. Null for other sources. */
  captureProgress: GoogleCaptureProgressDto | null;
  /** What the measurement can and cannot show (source, manual entry, depth, coverage). */
  limitations: string[];
  errorMessage: string | null;
  jobId: string | null;
}

/** A competitor's showing in one scan (comparable only within that scan). */
export interface LocalCompetitorShowing {
  competitorId: string | null;
  name: string;
  placeId: string | null;
  domain: string | null;
  category: string | null;
  /** Points where it was listed within the depth, out of the points measured. */
  appearances: number;
  top3: number;
  averageRank: number | null;
  bestRank: number | null;
  rating: number | null;
  reviewCount: number | null;
  isTarget: boolean;
  status: 'SUGGESTED' | 'CONFIRMED' | 'DISMISSED' | null;
}

export const manualPointSchema = z.object({
  row: z.int().min(0).max(8),
  col: z.int().min(0).max(8),
  /** Businesses in the order they were shown, top first. */
  results: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(255),
        rating: z.number().min(0).max(5).nullable().default(null),
        reviewCount: z.int().min(0).max(10_000_000).nullable().default(null),
        domain: z.string().trim().max(253).nullable().default(null),
        isTarget: z.boolean().default(false),
      }),
    )
    .max(100),
  /** Where and when the person looked (kept with the observation). */
  observedAt: z.iso.datetime().optional(),
  note: z.string().trim().max(500).optional(),
});
export type ManualPointInput = z.input<typeof manualPointSchema>;

/** Import local observations from a CSV (columns row, col, business, and optionally rank, is_tracked_business, …). */
export const localImportSchema = z.object({
  csv: z.string().min(1).max(2_000_000),
});
export type LocalImportInput = z.input<typeof localImportSchema>;

export interface LocalImportResultDto {
  scanId: string;
  pointsImported: number;
  rowsParsed: number;
  errors: string[];
}

// ---------------- Google results page capture ----------------
// The user opens a Google Search results address in their own browser and saves the page; OptiReach parses that
// saved page. OptiReach itself never requests google.com/search (robots.txt disallows /search for automated clients).

/** places: the local results list (udm=local or tbm=lcl, e.g. after "More places"). search: main results with a local
 * pack. maps: a Google Maps search's results list (google.com/maps/search/…), which loads more results as it scrolls. */
export type GoogleSearchSurface = 'places' | 'search' | 'maps';

export interface GoogleSearchUrlInfo {
  url: string;
  host: string;
  /** The search as typed (q=). */
  query: string;
  /** Google's result offset for this page (start=); 0 for the first page. */
  start: number;
  /** True when the address carries an explicit start= offset (which establishes the page's place in the order). */
  hasStart: boolean;
  surface: GoogleSearchSurface;
  language: string | null;
  country: string | null;
  /** Location named in the address (decoded uule=, or near=), when present. */
  location: string | null;
  /** Google Maps addresses: the centre of the map the search was made on ("/@lat,lng,…"), when present. */
  mapCenter?: { latitude: number; longitude: number } | null;
}

export type GoogleSearchUrlResult = { ok: true; info: GoogleSearchUrlInfo } | { ok: false; reason: string };

const GOOGLE_SEARCH_HOST = /^(www\.)?google\.(com|[a-z]{2,3}|com?\.[a-z]{2})$/;
const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Minimal, dependency-free base64 (and base64url) decoding to UTF-8; null when the input is not valid. */
function decodeBase64Utf8(input: string): string | null {
  const clean = input.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of clean) {
    const value = BASE64.indexOf(ch);
    if (value < 0) return null;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes));
  } catch {
    return null;
  }
}

/**
 * Google's `uule` parameter in its canonical-name form ("w+CAIQICI" + a length character + base64 of the location
 * name). Other forms (encoded coordinates) are not decoded and return null rather than a guess.
 */
export function decodeGoogleUule(raw: string | null): string | null {
  if (!raw) return null;
  const value = raw.replace(/ /g, '+'); // URLSearchParams turns "+" into spaces
  const prefix = 'w+CAIQICI';
  if (!value.startsWith(prefix) || value.length < prefix.length + 3) return null;
  const name = decodeBase64Utf8(value.slice(prefix.length + 1))?.trim();
  return name && /^[\p{L}\p{N}][\p{L}\p{N} ,.'&()-]{0,199}$/u.test(name) ? name : null;
}

/**
 * Validates a Google Search results address, or a Google Maps search address, and reads its search, offset and
 * context parameters. Nothing is fetched.
 */
export function parseGoogleSearchUrl(input: string): GoogleSearchUrlResult {
  const fail = (reason: string): GoogleSearchUrlResult => ({ ok: false, reason });
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return fail('This is not a valid web address.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    return fail('Use the https:// address of the Google page.');
  const host = url.hostname.toLowerCase();
  if (!GOOGLE_SEARCH_HOST.test(host))
    return fail('This is not a Google Search address (google.com or a Google country domain).');
  // A Google Maps search: /maps/search/<search>/@<lat>,<lng>,<zoom>/… (seen on a real saved Maps page). Its results
  // list is one continuous list from the first result, so its offset is always known.
  const maps = /^\/maps\/search\/([^/]+)(?:\/@(-?\d{1,2}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?),)?/.exec(
    url.pathname,
  );
  if (maps) {
    let search: string;
    try {
      search = decodeURIComponent(maps[1]!.replace(/\+/g, ' ')).replace(/\s+/g, ' ').trim();
    } catch {
      return fail('The Google Maps address has an unreadable search.');
    }
    if (!search) return fail('The Google Maps address has no search.');
    const [lat, lng] = [Number(maps[2]), Number(maps[3])];
    return {
      ok: true,
      info: {
        url: url.toString(),
        host,
        query: search.slice(0, 200),
        start: 0,
        hasStart: true,
        surface: 'maps',
        language: url.searchParams.get('hl')?.trim().slice(0, 12) || null,
        country: url.searchParams.get('gl')?.trim().slice(0, 4) || null,
        location: null,
        mapCenter:
          maps[2] && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { latitude: lat, longitude: lng } : null,
      },
    };
  }
  if (url.pathname !== '/search')
    return fail(
      url.pathname.startsWith('/maps')
        ? 'Use the address of a Google Maps search (google.com/maps/search/…) or of Google Search results (google.com/search?q=…).'
        : 'Use a Google Search results address (google.com/search?q=…).',
    );
  const query = (url.searchParams.get('q') ?? '').trim();
  if (!query) return fail('The address has no search (q=…).');
  const startRaw = url.searchParams.get('start');
  const hasStart = Boolean(startRaw && /^\d{1,4}$/.test(startRaw));
  const udm = url.searchParams.get('udm');
  const tbm = url.searchParams.get('tbm');
  const near = url.searchParams.get('near')?.trim() || null;
  return {
    ok: true,
    info: {
      url: url.toString(),
      host,
      query: query.slice(0, 200),
      start: hasStart ? Number(startRaw) : 0,
      hasStart,
      // udm=local is the Places view "More places" opens (seen on a real saved page); tbm=lcl is the older local finder.
      surface: udm === 'local' || tbm === 'lcl' ? 'places' : 'search',
      language: url.searchParams.get('hl')?.trim().slice(0, 12) || null,
      country: url.searchParams.get('gl')?.trim().slice(0, 4) || null,
      location: decodeGoogleUule(url.searchParams.get('uule')) ?? (near ? near.slice(0, 200) : null),
    },
  };
}

/**
 * For an MHTML ("Save as single file") archive, keeps only the top-level headers (which carry the saved address and
 * time) and the main HTML part — the only part read for listings — dropping embedded images, styles and fonts, which
 * can make the file several MB. Anything that is not an MHTML archive is returned unchanged.
 */
export function compactSavedPage(text: string): string {
  const unfold = (s: string) => s.replace(/\r?\n(?=[ \t])/g, '');
  const headerEnd = text.slice(0, 20_000).search(/\r?\n\r?\n/);
  if (headerEnd < 0) return text;
  const head = unfold(text.slice(0, headerEnd));
  if (!/^MIME-Version:/im.test(head) || !/multipart\/related/i.test(head)) return text;
  const boundary = /boundary="?([^";\r\n]+)"?/i.exec(head)?.[1]?.trim();
  if (!boundary) return text;
  const delimiter = `--${boundary}`;
  const htmlPart = text
    .slice(headerEnd)
    .split(delimiter)
    .find((part) => {
      const body = part.replace(/^\r?\n/, '');
      const sep = body.search(/\r?\n\r?\n/);
      return sep >= 0 && /Content-Type:\s*text\/html/i.test(unfold(body.slice(0, sep)));
    });
  if (!htmlPart) return text;
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  return `${text.slice(0, headerEnd)}${nl}${nl}${delimiter}${htmlPart}${delimiter}--${nl}`;
}

/** Saved pages accepted per request (more can be added to the same collection afterwards). */
export const GOOGLE_CAPTURE_MAX_PAGES = 10;
export const GOOGLE_CAPTURE_DEFAULT_TARGET = 1000;
export const GOOGLE_CAPTURE_MAX_TARGET = 5000;
/** Characters accepted per saved page (after MHTML compaction). */
export const GOOGLE_CAPTURE_MAX_PAGE_CHARS = 8_000_000;

/** One saved page: the HTML, and its address when known (the browser usually records it inside the file). */
export const googleCapturePageSchema = z.object({
  url: z.string().trim().min(1).max(4096).optional(),
  html: z.string().min(1).max(GOOGLE_CAPTURE_MAX_PAGE_CHARS),
});

/** Saved results pages, in the order they were viewed (page 1 first). Each page is the address and the saved HTML. */
export const googleCaptureSchema = z.object({
  pages: z.array(googleCapturePageSchema).min(1).max(GOOGLE_CAPTURE_MAX_PAGES),
  /** Unique businesses to collect before the collection is complete (more pages are then not needed). */
  target: z.int().min(1).max(GOOGLE_CAPTURE_MAX_TARGET).default(GOOGLE_CAPTURE_DEFAULT_TARGET),
});
export type GoogleCaptureInput = z.input<typeof googleCaptureSchema>;

/** More saved pages for an existing collection (the next pages, in the order viewed). */
export const googleCaptureAppendSchema = z.object({
  pages: z.array(googleCapturePageSchema).min(1).max(GOOGLE_CAPTURE_MAX_PAGES),
});
export type GoogleCaptureAppendInput = z.input<typeof googleCaptureAppendSchema>;

/** successful: everything parsed. partial: some pages or points failed. failed: nothing could be read. unavailable: no
 * local listings exist in what was supplied. in_progress: still collecting. */
export type CollectionStatus = 'successful' | 'partial' | 'failed' | 'unavailable' | 'in_progress';

/**
 * A multi-batch collection (saved pages, or an automatic source). IN_PROGRESS: collecting (or waiting for the next
 * saved page). PAUSED: paused by the user; resumable. TARGET_REACHED: the unique-business target was collected.
 * SOURCE_EXHAUSTED: the source has no further batch (no next page/cursor, a loop, or batches with nothing new).
 * PARTIAL: a page capture stopped by the user. CANCELLED: an automatic collection cancelled by the user (everything
 * collected is kept). FAILED: stopped by an error (an automatic collection can be retried from where it stopped).
 */
export const GOOGLE_CAPTURE_STATES = ['IN_PROGRESS', 'PAUSED', 'TARGET_REACHED', 'SOURCE_EXHAUSTED', 'PARTIAL', 'CANCELLED', 'FAILED'] as const; // prettier-ignore
export type GoogleCaptureState = (typeof GOOGLE_CAPTURE_STATES)[number];
export const COLLECTION_STATES = GOOGLE_CAPTURE_STATES;
export type CollectionState = GoogleCaptureState;

/** Automatic batch collection settings: records per batch, the pause between source requests, and the target. */
export const COLLECTION_MAX_BATCH_SIZE = 20;
export const COLLECTION_DEFAULT_DELAY_MS = 2000;
export const COLLECTION_MIN_DELAY_MS = 500;
export const COLLECTION_MAX_DELAY_MS = 60_000;

/** Start an automatic collection of a tracked query (its keyword and location) from a configured source. */
export const localCollectionStartSchema = z.object({
  source: z.enum(LOCAL_RANK_SOURCES),
  target: z.int().min(1).max(GOOGLE_CAPTURE_MAX_TARGET).default(GOOGLE_CAPTURE_DEFAULT_TARGET),
  batchSize: z.int().min(1).max(COLLECTION_MAX_BATCH_SIZE).default(COLLECTION_MAX_BATCH_SIZE),
  delayMs: z
    .int()
    .min(COLLECTION_MIN_DELAY_MS)
    .max(COLLECTION_MAX_DELAY_MS)
    .default(COLLECTION_DEFAULT_DELAY_MS),
});
export type LocalCollectionStartInput = z.input<typeof localCollectionStartSchema>;
export const COLLECTION_ACTIONS = ['pause', 'resume', 'cancel', 'retry'] as const;
export type CollectionAction = (typeof COLLECTION_ACTIONS)[number];

/** A source that can collect in batches automatically, as the status endpoint reports it. */
export interface LocalBatchSourceDto {
  key: LocalRankSource;
  label: string;
  configured: boolean;
  detail: string;
  /** What the order means: an observed search position, or discovery order (not a ranking). */
  observationType: LocalObservationType;
  /** True only for a source that returns the order a Google search showed. */
  googleRanking: boolean;
  maxBatchSize: number;
  minDelayMs: number;
  /** How the source pages (its real mechanism), e.g. a cursor from the service, or a widening search area. */
  pagination: string;
}

export interface GoogleCaptureBatchDto {
  batch: number;
  /** The page's address (entered, or recorded by the browser in the saved file); null when unknown. */
  url: string | null;
  /** Google's result offset for the page (start=); meaningful only when offsetKnown. */
  start: number;
  /** False when the page's place in the overall order cannot be established (positions stay page-local). */
  offsetKnown: boolean;
  /** repeated: the same page (address or listings) was already captured, so nothing was added. */
  status: 'parsed' | 'failed' | 'unavailable' | 'repeated';
  /** Listings read from the page. */
  listings: number;
  /** Listings added to the collection (not seen before). */
  newListings: number;
  /** Listings already collected from an earlier page (kept once; this observation is recorded on it). */
  duplicates: number;
  sponsored: number;
  /** The next-page address this page links to (from the page itself), when it has one. */
  nextUrl: string | null;
  /** When the browser saved the page (when the file records it), else when it was submitted. */
  capturedAt: string;
  error: string | null;
  notes: string[];
}

export interface GoogleCaptureProgressDto {
  scanId: string;
  state: GoogleCaptureState;
  target: number;
  /** Distinct businesses collected (an ad and an organic listing of the same business count once). */
  uniqueBusinesses: number;
  /** Listings stored (each distinct listing once, in observed order). */
  listingsStored: number;
  /** Listings read across all pages, including repeats. */
  listingsExtracted: number;
  duplicatesSkipped: number;
  pagesProcessed: number;
  pagesFailed: number;
  pagesRepeated: number;
  /** Listings without any identifier or address, which therefore cannot be checked for duplicates. */
  withoutIdentifier: number;
  /** The next page to open and save (from the last page's own next link), when the collection continues. */
  nextUrl: string | null;
  /** Why the collection ended, or the last problem while it is in progress. */
  reason: string | null;
  query: string;
  notes: string[];
  /** The source the listings come from, as stored on the scan. */
  source: LocalRankSource;
  sourceLabel: string;
  /** What the order means (a discovery order is never a Google ranking). */
  observationType: LocalObservationType;
  /** True for an automatic collection (a configured source), false for saved Google pages. */
  automatic: boolean;
  /** Automatic collections: records per batch and the pause between requests. */
  batchSize: number | null;
  delayMs: number | null;
  /** Automatic collections: whether the source returned a cursor for a further batch. */
  hasMore: boolean;
}

export interface GoogleCaptureResultDto {
  /** The scan the capture was stored in; null when nothing could be stored (unavailable). */
  scanId: string | null;
  /** Outcome of the pages in this request. */
  collectionStatus: CollectionStatus;
  query: string;
  surface: GoogleSearchSurface;
  location: string | null;
  /** Listings read from the pages in this request. */
  listings: number;
  /** The pages in this request, as stored. */
  batches: GoogleCaptureBatchDto[];
  limitations: string[];
  /** The whole collection after this request. */
  progress: GoogleCaptureProgressDto | null;
}

// ---------------- Local Search & AI Visibility overview ----------------

export const OVERVIEW_CARD_KEYS = [
  'maps',
  'local_rankings',
  'organic',
  'ai_mode',
  'chatgpt',
  'gemini',
  'merchant',
  'business_profile',
  'competitors',
  'reviews',
  'product_health',
  'local_health',
  'recommendations',
] as const;
export type OverviewCardKey = (typeof OVERVIEW_CARD_KEYS)[number];

/**
 * ok: measured data. empty: set up but nothing collected yet. connect: needs an account connection. unavailable: no
 * data source in this installation yet. unsupported: cannot be measured reliably (no official API, no provider).
 */
export type OverviewCardState = 'ok' | 'empty' | 'connect' | 'unavailable' | 'unsupported';

export interface OverviewCard {
  key: OverviewCardKey;
  title: string;
  state: OverviewCardState;
  /** Current value as shown (already formatted, with its unit). */
  value: string | null;
  previous: string | null;
  change: {
    absolute: string;
    percent: number | null;
    direction: 'up' | 'down' | 'flat';
    good: boolean | null;
  } | null;
  dateRange: string | null;
  place: string | null;
  source: string | null;
  lastCollectedAt: string | null;
  freshness: 'fresh' | 'stale' | null;
  limitations: string[];
  /** One line per query, provider or item when the card covers several. */
  lines: { label: string; value: string; note?: string }[];
  action: { label: string; to: string } | null;
}

/**
 * One step towards data on the dashboard. done: finished. todo: something the user can do now. admin: needs setup by
 * whoever runs this installation (credentials or a Google approval). optional: useful but not needed.
 */
export interface SetupStep {
  key: string;
  title: string;
  detail: string;
  status: 'done' | 'todo' | 'admin' | 'optional';
  /** Cards this step fills. */
  fills: string[];
  action: { label: string; to: string } | null;
}

export interface LocalOverviewDto {
  generatedAt: string;
  days: number;
  location: { id: string; name: string; city: string } | null;
  hasWebsite: boolean;
  cards: OverviewCard[];
  /** Ordered steps to get data on the cards. */
  setup: SetupStep[];
}

// ---------------- Business Profile posts (localPosts) ----------------

export const LOCAL_POST_TOPIC_TYPES = ['STANDARD', 'OFFER', 'EVENT'] as const;
export type LocalPostTopicType = (typeof LOCAL_POST_TOPIC_TYPES)[number];

/** Call-to-action buttons that carry a URL. NONE means no button; phone-only CALL is not offered here. */
export const LOCAL_POST_CTA_TYPES = ['NONE', 'LEARN_MORE', 'BOOK', 'ORDER', 'SHOP', 'SIGN_UP'] as const;
export type LocalPostCtaType = (typeof LOCAL_POST_CTA_TYPES)[number];
export const LOCAL_POST_CTA_LABELS: Record<LocalPostCtaType, string> = {
  NONE: 'No button',
  LEARN_MORE: 'Learn more',
  BOOK: 'Book',
  ORDER: 'Order online',
  SHOP: 'Shop',
  SIGN_UP: 'Sign up',
};

export const LOCAL_POST_STATUSES = [
  'DRAFT',
  'AWAITING_APPROVAL',
  'SCHEDULED',
  'PUBLISHING',
  'PUBLISHED',
  'FAILED',
  'DISCARDED',
] as const;
export type LocalPostStatus = (typeof LOCAL_POST_STATUSES)[number];
export const LOCAL_POST_STATUS_LABELS: Record<LocalPostStatus, string> = {
  DRAFT: 'Draft',
  AWAITING_APPROVAL: 'Awaiting approval',
  SCHEDULED: 'Scheduled',
  PUBLISHING: 'Publishing',
  PUBLISHED: 'Published',
  FAILED: 'Failed',
  DISCARDED: 'Discarded',
};
export const LOCAL_POST_SUMMARY_MAX = 1500;

/** Create a Business Profile post draft: either written (summary) or generated by AI (generate + topic). */
export const localPostCreateSchema = z
  .object({
    locationId: z.string().trim().min(1).max(32),
    topicType: z.enum(LOCAL_POST_TOPIC_TYPES).default('STANDARD'),
    summary: z.string().trim().max(LOCAL_POST_SUMMARY_MAX).optional(),
    title: z.string().trim().max(255).nullable().default(null),
    ctaType: z.enum(LOCAL_POST_CTA_TYPES).default('NONE'),
    ctaUrl: z.url().max(2048).nullable().default(null),
    scheduledAt: z.coerce.date().nullable().default(null),
    // AI generation (when generate is true, summary may be omitted and is produced by the model):
    generate: z.boolean().default(false),
    topic: z.string().trim().max(200).optional(),
    instructions: z.string().trim().max(1000).optional(),
    provider: z.enum(LLM_PROVIDER_KEYS).optional(),
  })
  .superRefine((v, ctx) => {
    if (!v.generate && !v.summary)
      ctx.addIssue({ code: 'custom', path: ['summary'], message: 'Write the post or turn on AI generation' });
    if (v.ctaType !== 'NONE' && !v.ctaUrl)
      ctx.addIssue({ code: 'custom', path: ['ctaUrl'], message: 'Add the button link' });
  });
export type LocalPostCreateInput = z.input<typeof localPostCreateSchema>;

/** Edit an unpublished post draft. */
export const localPostUpdateSchema = z
  .object({
    topicType: z.enum(LOCAL_POST_TOPIC_TYPES).optional(),
    summary: z.string().trim().min(1).max(LOCAL_POST_SUMMARY_MAX).optional(),
    title: z.string().trim().max(255).nullable().optional(),
    ctaType: z.enum(LOCAL_POST_CTA_TYPES).optional(),
    ctaUrl: z.url().max(2048).nullable().optional(),
    scheduledAt: z.coerce.date().nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' })
  .refine((v) => !(v.ctaType && v.ctaType !== 'NONE' && v.ctaUrl === null), {
    path: ['ctaUrl'],
    message: 'Add the button link',
  });
export type LocalPostUpdateInput = z.input<typeof localPostUpdateSchema>;

export interface LocalPostDto {
  id: string;
  projectId: string;
  locationId: string;
  topicType: string;
  summary: string;
  title: string | null;
  ctaType: string;
  ctaUrl: string | null;
  origin: string;
  model: string | null;
  status: string;
  scheduledAt: string | null;
  googleName: string | null;
  searchUrl: string | null;
  publishedAt: string | null;
  publishError: string | null;
  createdAt: string;
  updatedAt: string;
}
