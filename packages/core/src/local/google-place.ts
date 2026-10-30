// Fill a location from a Google link (share.google, maps.app.goo.gl, a Google Maps or Search URL).
//  1. Short links are resolved by reading redirect headers only, from an allowlist of Google hosts. Google's pages
//     are never fetched or parsed: the final URL itself carries the name, sometimes the coordinates and IDs.
//  2. With GOOGLE_MAPS_API_KEY, the official Places API (New) returns the address, phone, hours, category, website
//     and position. Google permits filling a form this way; the user reviews the values and saves them as their own.
import { WEEKDAYS, type LocationInput, type OpeningPeriod, type Weekday } from '@surfaced/shared';
import { getEnv } from '../env';
import { Errors } from '../errors';

type Fetch = typeof fetch;

export interface GoogleLinkInfo {
  finalUrl: string;
  name: string | null;
  latitude: number | null;
  longitude: number | null;
  placeId: string | null;
  /** Google Maps customer ID (cid / ludocid) when the URL has one. */
  cid: string | null;
  /** Knowledge Graph ID (kgmid) of a Google Search result. */
  kgmid: string | null;
}

const SHORT_HOSTS = new Set(['share.google', 'maps.app.goo.gl', 'goo.gl', 'g.page', 'g.co']);
const isGoogleHost = (host: string) =>
  SHORT_HOSTS.has(host) || /^(www\.|maps\.)?google\.(com|co\.[a-z]{2}|com\.[a-z]{2}|[a-z]{2})$/.test(host);

function needsResolving(url: URL): boolean {
  return (
    SHORT_HOSTS.has(url.hostname) ||
    url.pathname.startsWith('/share.google') ||
    url.pathname.startsWith('/url')
  );
}

/** Reads what a Google URL says about the place, without fetching anything. */
export function parseGoogleUrl(raw: string): GoogleLinkInfo {
  const url = new URL(raw);
  const text = decodeURIComponent(raw);
  const pinned = text.match(/!3d(-?\d{1,3}\.\d+)!4d(-?\d{1,3}\.\d+)/);
  const centre = text.match(/@(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)/);
  const ll = (url.searchParams.get('ll') ?? url.searchParams.get('q') ?? '').match(
    /^(-?\d{1,3}\.\d+),\s*(-?\d{1,3}\.\d+)$/,
  );
  const coords = pinned ?? ll ?? centre;
  const placeName = url.pathname.match(/\/maps\/place\/([^/]+)/)?.[1];
  const q = url.searchParams.get('q');
  const name = placeName
    ? decodeURIComponent(placeName.replace(/\+/g, ' '))
    : q && !ll
      ? q.replace(/\+/g, ' ')
      : null;
  return {
    finalUrl: url.toString(),
    name: name?.trim().slice(0, 200) || null,
    latitude: coords ? Number(coords[1]) : null,
    longitude: coords ? Number(coords[2]) : null,
    placeId:
      url.searchParams.get('query_place_id') ??
      url.searchParams.get('place_id') ??
      text.match(/place_id:(ChIJ[\w-]{10,})/)?.[1] ??
      null,
    cid: url.searchParams.get('cid') ?? url.searchParams.get('ludocid') ?? null,
    kgmid: url.searchParams.get('kgmid') ?? null,
  };
}

/** Follows redirects of a Google short link (headers only, Google hosts only, at most 6 hops). */
export async function resolveGoogleLink(raw: string, httpFetch: Fetch = fetch): Promise<GoogleLinkInfo> {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw Errors.badRequest('Paste the full link, starting with https://');
  }
  for (let hop = 0; hop < 6; hop++) {
    if (url.protocol !== 'https:' || !isGoogleHost(url.hostname))
      throw Errors.badRequest(
        'Use a link from Google Maps or Google Search (for example the Share link of your listing).',
      );
    if (!needsResolving(url)) return parseGoogleUrl(url.toString());
    let response: Response;
    try {
      response = await httpFetch(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(10_000), headers: { 'User-Agent': 'Mozilla/5.0 (compatible; link resolver)' } }); // prettier-ignore
    } catch {
      throw Errors.unavailable(
        'Google could not be reached to open the link. Try again, or paste the coordinates.',
      );
    }
    await response.body?.cancel().catch(() => undefined);
    const location = response.headers.get('location');
    if (response.status < 300 || response.status >= 400 || !location)
      throw Errors.badRequest(
        'This link does not lead to a Google place. Open it, then copy the address bar instead.',
      );
    url = new URL(location, url);
  }
  throw Errors.badRequest('The link redirects too many times.');
}

// ---------------- Places API (New) ----------------

interface PlacesPlace {
  id?: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  addressComponents?: { longText?: string; shortText?: string; types?: string[] }[];
  location?: { latitude?: number; longitude?: number };
  nationalPhoneNumber?: string;
  internationalPhoneNumber?: string;
  regularOpeningHours?: { periods?: { open?: { day?: number; hour?: number; minute?: number }; close?: { day?: number; hour?: number; minute?: number } }[] }; // prettier-ignore
  primaryTypeDisplayName?: { text?: string };
  websiteUri?: string;
  googleMapsUri?: string;
  businessStatus?: string;
}

const FIELDS = ['id', 'displayName', 'formattedAddress', 'addressComponents', 'location', 'nationalPhoneNumber', 'internationalPhoneNumber', 'regularOpeningHours', 'primaryTypeDisplayName', 'websiteUri', 'googleMapsUri', 'businessStatus']; // prettier-ignore
/** Places days: 0 is Sunday. */
const DAY: Weekday[] = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
const hhmm = (h = 0, m = 0) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;

export function hoursFromPlaces(
  periods: NonNullable<PlacesPlace['regularOpeningHours']>['periods'] = [],
): OpeningPeriod[] {
  // Always open: one period opening Sunday 00:00 with no close.
  if (periods.length === 1 && !periods[0]!.close && !periods[0]!.open?.hour && !periods[0]!.open?.minute)
    return WEEKDAYS.map((day) => ({ day, open: '00:00', close: '24:00' }));
  const out: OpeningPeriod[] = [];
  for (const p of periods) {
    if (p.open?.day === undefined || !p.close || p.close.day === undefined) continue;
    const open = hhmm(p.open.hour, p.open.minute);
    const close = hhmm(p.close.hour, p.close.minute);
    if (p.close.day === p.open.day)
      out.push({ day: DAY[p.open.day]!, open, close: close === '00:00' ? '24:00' : close });
    else {
      out.push({ day: DAY[p.open.day]!, open, close: '24:00' });
      if (close !== '00:00') out.push({ day: DAY[p.close.day]!, open: '00:00', close });
    }
  }
  return out.slice(0, 28);
}

function addressFromPlaces(p: PlacesPlace) {
  const comp = (type: string, short = false) => {
    const c = p.addressComponents?.find((x) => x.types?.includes(type));
    return (short ? c?.shortText : c?.longText) ?? null;
  };
  const city = comp('locality') ?? comp('administrative_area_level_3') ?? comp('administrative_area_level_2');
  const region = comp('administrative_area_level_1');
  const postalCode = comp('postal_code');
  const country = comp('country', true);
  const locality = comp('sublocality_level_1') ?? comp('neighborhood');
  // The street part of the formatted address: everything before the locality, city, region, postcode and country.
  const drop = [locality, city, region, postalCode, comp('country')]
    .filter(Boolean)
    .map((s) => s!.toLowerCase());
  const parts = (p.formattedAddress ?? '').split(/,\s*/).filter((part) => {
    const lower = part.toLowerCase();
    return !drop.some(
      (d) => lower === d || lower.startsWith(`${d} `) || (postalCode && lower.endsWith(postalCode)),
    );
  });
  return {
    addressLine1: parts.join(', ').slice(0, 200) || null,
    locality,
    city,
    region,
    postalCode,
    country,
  };
}

export interface GooglePlaceFill {
  /** Values to put in the location form (only what Google returned). */
  fields: Partial<LocationInput> & { placeId?: string | null };
  filled: string[];
  source: 'places_api' | 'link';
  googleMapsUri: string | null;
  notes: string[];
}

async function placesRequest(
  path: string,
  init: RequestInit,
  fieldMask: string,
  httpFetch: Fetch,
): Promise<unknown> {
  const key = getEnv().GOOGLE_MAPS_API_KEY!;
  let response: Response;
  try {
    response = await httpFetch(`https://places.googleapis.com/v1/${path}`, {
      ...init,
      headers: { 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': fieldMask, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw Errors.unavailable('Google Places could not be reached.');
  }
  const json = (await response.json().catch(() => ({}))) as { error?: { message?: string; status?: string } };
  if (!response.ok)
    throw Errors.upstream(
      `Google Places refused the request (HTTP ${response.status}${json.error?.status ? `, ${json.error.status}` : ''}). Check that the Places API (New) is enabled for GOOGLE_MAPS_API_KEY.${json.error?.message ? ` Google: ${json.error.message.slice(0, 200)}` : ''}`,
    );
  return json;
}

/** Location values from a Google link, completed through the Places API when a key is configured. */
export async function fillFromGoogleLink(
  raw: string,
  hint: { city?: string | null; country?: string | null },
  httpFetch: Fetch = fetch,
): Promise<GooglePlaceFill> {
  const info = await resolveGoogleLink(raw, httpFetch);
  const env = getEnv();
  const fromLink: GooglePlaceFill['fields'] = {
    ...(info.name ? { name: info.name } : {}),
    ...(info.latitude !== null && info.longitude !== null
      ? { latitude: info.latitude, longitude: info.longitude }
      : {}),
    ...(info.placeId ? { placeId: info.placeId } : {}),
  };
  const linkFilled = [info.name && 'name', info.latitude !== null && 'map position'].filter(
    (x): x is string => Boolean(x),
  );
  if (!env.GOOGLE_MAPS_API_KEY)
    return {
      fields: fromLink,
      filled: linkFilled,
      source: 'link',
      googleMapsUri: null,
      notes: [
        linkFilled.length
          ? `From the link: ${linkFilled.join(' and ')}.`
          : 'The link itself carries no details of the place.',
        'Address, phone, opening hours and category need the Google Places API: an administrator can add GOOGLE_MAPS_API_KEY. Until then, fill them in and use “Find from address” for the map position.',
      ],
    };
  let place: PlacesPlace | undefined;
  if (info.placeId)
    place = (await placesRequest(`places/${encodeURIComponent(info.placeId)}`, { method: 'GET' }, FIELDS.join(','), httpFetch)) as PlacesPlace; // prettier-ignore
  else if (info.name) {
    const textQuery = [info.name, hint.city].filter(Boolean).join(', ');
    const body = {
      textQuery,
      languageCode: 'en',
      maxResultCount: 1,
      ...(hint.country ? { regionCode: hint.country } : {}),
      ...(info.latitude !== null && info.longitude !== null ? { locationBias: { circle: { center: { latitude: info.latitude, longitude: info.longitude }, radius: 2000 } } } : {}), // prettier-ignore
    };
    const found = (await placesRequest('places:searchText', { method: 'POST', body: JSON.stringify(body) }, FIELDS.map((f) => `places.${f}`).join(','), httpFetch)) as { places?: PlacesPlace[] }; // prettier-ignore
    place = found.places?.[0];
  }
  if (!place)
    return {
      fields: fromLink,
      filled: linkFilled,
      source: 'link',
      googleMapsUri: null,
      notes: [
        'Google Places found no matching place. Check the name and city, or fill the details in by hand.',
      ],
    };
  const address = addressFromPlaces(place);
  const hours = hoursFromPlaces(place.regularOpeningHours?.periods);
  const fields: GooglePlaceFill['fields'] = {
    name: place.displayName?.text?.slice(0, 200) ?? info.name ?? undefined,
    ...(address.addressLine1 ? { addressLine1: address.addressLine1 } : {}),
    ...(address.locality ? { locality: address.locality.slice(0, 120) } : {}),
    ...(address.city ? { city: address.city.slice(0, 120) } : {}),
    ...(address.region ? { region: address.region.slice(0, 120) } : {}),
    ...(address.postalCode ? { postalCode: address.postalCode.slice(0, 20) } : {}),
    ...(address.country && address.country.length === 2 ? { country: address.country } : {}),
    ...(place.location?.latitude !== undefined && place.location.longitude !== undefined ? { latitude: place.location.latitude, longitude: place.location.longitude } : {}), // prettier-ignore
    ...(place.internationalPhoneNumber || place.nationalPhoneNumber ? { phone: (place.internationalPhoneNumber ?? place.nationalPhoneNumber)!.slice(0, 40) } : {}), // prettier-ignore
    ...(place.websiteUri && place.websiteUri.length <= 2048 ? { websiteUrl: place.websiteUri } : {}),
    ...(place.primaryTypeDisplayName?.text
      ? { primaryCategory: place.primaryTypeDisplayName.text.slice(0, 120) }
      : {}),
    ...(hours.length ? { openingHours: hours } : {}),
    ...(place.id ? { placeId: place.id } : {}),
  };
  const labels: Record<string, string> = { name: 'name', addressLine1: 'address', city: 'city', latitude: 'map position', phone: 'phone', websiteUrl: 'website', primaryCategory: 'category', openingHours: 'opening hours' }; // prettier-ignore
  return {
    fields,
    filled: Object.keys(labels)
      .filter((k) => k in fields)
      .map((k) => labels[k]!),
    source: 'places_api',
    googleMapsUri: place.googleMapsUri ?? null,
    notes: [
      'Filled from Google Maps (Places API). Check each value before saving; saved values become your own record and are not updated from Google automatically.',
      ...(place.businessStatus && place.businessStatus !== 'OPERATIONAL' ? [`Google lists this place as ${place.businessStatus.toLowerCase().replace(/_/g, ' ')}.`] : []), // prettier-ignore
    ],
  };
}
