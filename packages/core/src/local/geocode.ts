// Address to map position for business locations, through OpenStreetMap's Nominatim (or a self-hosted instance).
// Nominatim's usage policy allows light use only: at most one request per second, an identifying User-Agent, results
// cached, attribution shown. Lookups run only when a user asks, and the user confirms (or drags) the pin before saving.
import { getEnv } from '../env';
import { Errors } from '../errors';

export interface GeocodeCandidate {
  latitude: number;
  longitude: number;
  label: string;
  /** address: the building or house. street: the street. area: postal code, neighbourhood or city (approximate). */
  precision: 'address' | 'street' | 'area';
  /** What was searched to find it (the full address, or a fallback such as the postal code). */
  matchedOn: string;
}

export interface GeocodeQuery {
  addressLine1?: string | null;
  locality?: string | null;
  city: string;
  region?: string | null;
  postalCode?: string | null;
  country: string;
}

type Fetch = typeof fetch;
const CACHE_MS = 24 * 3600 * 1000;
const cache = new Map<string, { at: number; value: GeocodeCandidate[] }>();
let lastRequestAt = 0;
let queue: Promise<unknown> = Promise.resolve();

/** Serializes requests with at least one second between them (Nominatim's limit). */
function throttled<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(async () => {
    const wait = lastRequestAt + 1100 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastRequestAt = Date.now();
    return fn();
  });
  queue = run.catch(() => undefined);
  return run;
}

function precisionOf(placeRank: number | undefined): GeocodeCandidate['precision'] {
  if (placeRank === undefined) return 'area';
  if (placeRank >= 28) return 'address';
  if (placeRank >= 26) return 'street';
  return 'area';
}

async function search(q: string, country: string, httpFetch: Fetch): Promise<GeocodeCandidate[]> {
  const env = getEnv();
  const key = `${country}|${q.toLowerCase()}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const url = new URL('/search', env.GEOCODER_URL);
  url.search = new URLSearchParams({ format: 'jsonv2', limit: '5', countrycodes: country.toLowerCase(), q, addressdetails: '0' }).toString(); // prettier-ignore
  const response = await throttled(() =>
    httpFetch(url, {
      headers: {
        'User-Agent': `${env.APP_NAME ?? 'Surfaced'} geocoder (${env.APP_URL})`,
        'Accept-Language': 'en',
      },
      signal: AbortSignal.timeout(15_000),
    }),
  ).catch(() => {
    throw Errors.unavailable('The map lookup service could not be reached. Paste the coordinates instead.');
  });
  if (response.status === 429 || response.status === 403)
    throw Errors.unavailable(
      'The map lookup service is busy. Try again in a minute, or paste the coordinates.',
    );
  if (!response.ok) throw Errors.unavailable(`The map lookup service returned HTTP ${response.status}.`);
  const rows = (await response.json()) as {
    lat?: string;
    lon?: string;
    display_name?: string;
    place_rank?: number;
  }[];
  const value = rows
    .map((r) => ({
      latitude: Number(r.lat),
      longitude: Number(r.lon),
      label: r.display_name ?? q,
      precision: precisionOf(r.place_rank),
      matchedOn: q,
    }))
    .filter((r) => Number.isFinite(r.latitude) && Number.isFinite(r.longitude));
  cache.set(key, { at: Date.now(), value });
  return value;
}

/**
 * Tries the full address first, then the postal code with the city, then the locality with the city. Indian
 * addresses with society or landmark names are often not in OpenStreetMap, so a fallback gives an approximate point
 * that the user drags onto the shop.
 */
export async function geocodeLocation(
  query: GeocodeQuery,
  httpFetch: Fetch = fetch,
): Promise<GeocodeCandidate[]> {
  if (getEnv().GEOCODER === 'none')
    throw Errors.providerNotConfigured('Map lookup', {
      detail: 'GEOCODER=none. Paste the coordinates instead.',
    });
  const parts = (...xs: (string | null | undefined)[]) =>
    xs
      .map((x) => x?.trim())
      .filter(Boolean)
      .join(', ');
  const attempts = [
    parts(query.addressLine1, query.locality, query.city, query.postalCode),
    query.postalCode ? parts(query.postalCode, query.city) : '',
    query.locality ? parts(query.locality, query.city) : '',
    parts(query.city, query.region),
  ].filter((q, i, all) => q && all.indexOf(q) === i);
  for (const q of attempts) {
    const found = await search(q, query.country, httpFetch);
    if (found.length) return found;
  }
  return [];
}

/** Test hook. */
export function resetGeocodeCache(): void {
  cache.clear();
  lastRequestAt = 0;
}
