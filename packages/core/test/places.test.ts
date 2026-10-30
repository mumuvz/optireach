import { describe, expect, it } from 'vitest';
import { resetEnvCache } from '../src/env';
import {
  fillFromGoogleLink,
  geocodeLocation,
  hoursFromPlaces,
  parseGoogleUrl,
  resetGeocodeCache,
  resolveGoogleLink,
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

type Handler = (url: string, init: RequestInit) => { status?: number; body?: unknown; location?: string };
function fakeFetch(handler: Handler) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    const { status = 200, body, location } = handler(url, init ?? {});
    return new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...(location ? { location } : {}) },
    });
  }) as typeof fetch;
  return { fn, calls };
}

const SEARCH_URL =
  'https://www.google.com/search?kgmid=/g/11xl9ptrwt&q=Rajmahel+Jewellers&source=sh/x/loc/uni/m1/1';
const shareRedirects: Handler = (url) =>
  url === 'https://share.google/ebekx1ZVuwOS8qmLa'
    ? { status: 302, location: 'https://www.google.com/share.google?q=ebekx1ZVuwOS8qmLa' }
    : url === 'https://www.google.com/share.google?q=ebekx1ZVuwOS8qmLa'
      ? { status: 301, location: SEARCH_URL }
      : { status: 404, body: {} };

describe('Google links', () => {
  it('reads the name, pin and IDs from the URL itself', () => {
    expect(parseGoogleUrl('https://www.google.com/maps/place/Rajmahel+Jewellers/@21.23,72.90,17z/data=!3m1!4b1!4m6!3m5!1s0x0:0x1!8m2!3d21.2311221!4d72.9033775!16s')).toMatchObject({ name: 'Rajmahel Jewellers', latitude: 21.2311221, longitude: 72.9033775 }); // prettier-ignore
    expect(parseGoogleUrl(SEARCH_URL)).toMatchObject({
      name: 'Rajmahel Jewellers',
      kgmid: '/g/11xl9ptrwt',
      latitude: null,
    });
    expect(parseGoogleUrl('https://maps.google.com/?q=21.17,72.83')).toMatchObject({
      name: null,
      latitude: 21.17,
      longitude: 72.83,
    });
    expect(parseGoogleUrl('https://www.google.com/maps/search/?api=1&query=x&query_place_id=ChIJabc123defghi')).toMatchObject({ placeId: 'ChIJabc123defghi' }); // prettier-ignore
  });

  it('follows share links by redirect headers only, and only on Google hosts', async () => {
    const google = fakeFetch(shareRedirects);
    const info = await resolveGoogleLink('https://share.google/ebekx1ZVuwOS8qmLa', google.fn);
    expect(info).toMatchObject({ name: 'Rajmahel Jewellers', kgmid: '/g/11xl9ptrwt' });
    expect(google.calls).toHaveLength(2);
    expect(google.calls.every((c) => c.init.redirect === 'manual')).toBe(true);
    // The final Google Search page is never requested.
    expect(google.calls.some((c) => c.url.startsWith('https://www.google.com/search'))).toBe(false);
    await expect(resolveGoogleLink('https://example.com/maps/place/x', google.fn)).rejects.toThrow(
      /link from Google Maps/,
    );
    await expect(resolveGoogleLink('http://share.google/x', google.fn)).rejects.toThrow(
      /link from Google Maps/,
    );
    const offsite = fakeFetch(() => ({ status: 302, location: 'https://evil.example/' }));
    await expect(resolveGoogleLink('https://maps.app.goo.gl/abc', offsite.fn)).rejects.toThrow(
      /link from Google Maps/,
    );
  });
});

describe('filling a location', () => {
  it('without a Places API key, fills only what the link carries and says what is missing', async () => {
    const fill = await fillFromGoogleLink('https://share.google/ebekx1ZVuwOS8qmLa', { city: 'Surat', country: 'IN' }, fakeFetch(shareRedirects).fn); // prettier-ignore
    expect(fill).toMatchObject({ source: 'link', fields: { name: 'Rajmahel Jewellers' }, filled: ['name'] });
    expect(fill.notes.join(' ')).toMatch(/GOOGLE_MAPS_API_KEY/);
  });

  it('with a key, asks the Places API (New) and maps address, phone, hours and category', async () => {
    const google = fakeFetch((url, init) => {
      if (url.startsWith('https://places.googleapis.com/v1/places:searchText'))
        return {
          body: {
            places: [
              {
                id: 'ChIJ-rajmahel',
                displayName: { text: 'Rajmahel Jewellers' },
                formattedAddress:
                  '17, Harekrishna Society, Shyamdham Chowk Road, Nana Varachha, Surat, Gujarat 395006, India',
                addressComponents: [
                  {
                    longText: 'Nana Varachha',
                    shortText: 'Nana Varachha',
                    types: ['sublocality_level_1', 'sublocality', 'political'],
                  },
                  { longText: 'Surat', shortText: 'Surat', types: ['locality', 'political'] },
                  {
                    longText: 'Gujarat',
                    shortText: 'GJ',
                    types: ['administrative_area_level_1', 'political'],
                  },
                  { longText: '395006', shortText: '395006', types: ['postal_code'] },
                  { longText: 'India', shortText: 'IN', types: ['country', 'political'] },
                ],
                location: { latitude: 21.2185, longitude: 72.8892 },
                internationalPhoneNumber: '+91 99099 77695',
                regularOpeningHours: { periods: [{ open: { day: 1, hour: 10, minute: 30 }, close: { day: 1, hour: 20, minute: 0 } }, { open: { day: 6, hour: 18 }, close: { day: 0, hour: 1 } }] }, // prettier-ignore
                primaryTypeDisplayName: { text: 'Jewelry Store' },
                googleMapsUri: 'https://maps.google.com/?cid=123',
                businessStatus: 'OPERATIONAL',
              },
            ],
          },
        };
      return shareRedirects(url, init);
    });
    const fill = await withEnv({ GOOGLE_MAPS_API_KEY: 'maps-key' }, () =>
      fillFromGoogleLink(
        'https://share.google/ebekx1ZVuwOS8qmLa',
        { city: 'Surat', country: 'IN' },
        google.fn,
      ),
    );
    const places = google.calls.find((c) => c.url.includes('places:searchText'))!;
    expect(JSON.parse(String(places.init.body))).toMatchObject({ textQuery: 'Rajmahel Jewellers, Surat', regionCode: 'IN', maxResultCount: 1 }); // prettier-ignore
    const headers = places.init.headers as Record<string, string>;
    expect(headers['X-Goog-Api-Key']).toBe('maps-key');
    expect(headers['X-Goog-FieldMask']).toContain('places.regularOpeningHours');
    expect(fill.source).toBe('places_api');
    expect(fill.fields).toMatchObject({
      name: 'Rajmahel Jewellers',
      addressLine1: '17, Harekrishna Society, Shyamdham Chowk Road',
      locality: 'Nana Varachha',
      city: 'Surat',
      region: 'Gujarat',
      postalCode: '395006',
      country: 'IN',
      latitude: 21.2185,
      longitude: 72.8892,
      phone: '+91 99099 77695',
      primaryCategory: 'Jewelry Store',
      placeId: 'ChIJ-rajmahel',
      openingHours: [
        { day: 'MONDAY', open: '10:30', close: '20:00' },
        { day: 'SATURDAY', open: '18:00', close: '24:00' },
        { day: 'SUNDAY', open: '00:00', close: '01:00' },
      ],
    });
    expect(fill.filled).toEqual([
      'name',
      'address',
      'city',
      'map position',
      'phone',
      'category',
      'opening hours',
    ]);
  });

  it('reads "always open" hours', () => {
    expect(hoursFromPlaces([{ open: { day: 0, hour: 0, minute: 0 } }])).toHaveLength(7);
  });
});

describe('address lookup', () => {
  it('is off in tests by default, and falls back from the full address to the postal code', async () => {
    await expect(geocodeLocation({ city: 'Surat', country: 'IN' })).rejects.toThrow(/Map lookup/);
    resetGeocodeCache();
    const osm = fakeFetch((url) => {
      const q = new URL(url).searchParams.get('q');
      return { body: q === '395013, Surat' ? [{ lat: '21.2311221', lon: '72.9033775', display_name: '395013, Kamrej Taluka, Surat, Gujarat, India', place_rank: 21 }] : [] }; // prettier-ignore
    });
    const found = await withEnv(
      { GEOCODER: 'nominatim' },
      () =>
      geocodeLocation({ addressLine1: '17, opp. Vandana Society, Harekrishna Society', locality: 'Nana Varachha', city: 'Surat', postalCode: '395013', country: 'IN' }, osm.fn), // prettier-ignore
    );
    expect(found).toEqual([{ latitude: 21.2311221, longitude: 72.9033775, label: '395013, Kamrej Taluka, Surat, Gujarat, India', precision: 'area', matchedOn: '395013, Surat' }]); // prettier-ignore
    expect(osm.calls).toHaveLength(2);
    expect(new URL(osm.calls[0]!.url).searchParams.get('countrycodes')).toBe('in');
    expect((osm.calls[0]!.init.headers as Record<string, string>)['User-Agent']).toMatch(/geocoder/);
  });
});
