// Google results page capture. The user opens a Google Search results address in their own browser (normal use) and
// saves the page; OptiReach parses that saved page. OptiReach never requests google.com/search itself: Google's
// robots.txt disallows /search for automated clients and its Terms prohibit automated access that ignores robots.txt.
//
// The parser reads listings in the order the page shows them and keeps only what the markup identifies: Google's own
// place identifiers (data-cid / data-ludocid) mark each listing, so the parser does not depend on Google's obfuscated
// CSS class names for identity. Fields that are not identifiable are left empty — nothing is filled in or guessed.
import { createHash } from 'node:crypto';
import {
  GOOGLE_CAPTURE_DEFAULT_TARGET,
  GOOGLE_CAPTURE_MAX_PAGES,
  GOOGLE_CAPTURE_STATES,
  parseGoogleSearchUrl,
  type CollectionStatus,
  type GoogleCaptureBatchDto,
  type GoogleCaptureProgressDto,
  type GoogleCaptureResultDto,
  type GoogleCaptureState,
  type GoogleSearchSurface,
  type GoogleSearchUrlInfo,
  type LocalObservationType,
  type LocalRankSource,
  type LocalResult,
  LOCAL_OBSERVATION_TYPES,
  LOCAL_RANK_SOURCE_LABELS,
  LOCAL_RANK_SOURCES,
  observationTypeForSource,
} from '@surfaced/shared';
import * as cheerio from 'cheerio';
import type { Prisma, PrismaClient } from '../db';
import { Errors } from '../errors';
import type { ProviderLocalResult } from './rank-providers';
import { finishScan, matchTargetFor, normalizeBusinessName, storeResults } from './scans';

/** Listings kept per capture (a few pages of Google's local results). */
const MAX_CAPTURED_LISTINGS = 200;
/** How far up from a listing's identifier element its own block (actions, rating line) is searched. */
const MAX_SCOPE_DEPTH = 6;

export interface CapturedListing {
  /** 1-based position on the page, exactly as shown (sponsored listings included). */
  position: number;
  title: string;
  /** Google's place identifier (CID), from the page markup. */
  cid: string | null;
  /** Google's Knowledge Graph entity ID for the business (e.g. "/g/11fk2bz1w2"), from the card markup. */
  entityId: string | null;
  /** Google's Place ID (ChIJ…), from the page's own data, when it carries one. */
  placeId: string | null;
  rating: number | null;
  reviewCount: number | null;
  /** True when the listing carries a "Sponsored"/"Ad" label; false when it carries none. */
  sponsored: boolean;
  category: string | null;
  /** The address line as the card shows it (phone removed), or an explicitly labelled address; null otherwise. */
  address: string | null;
  website: string | null;
  domain: string | null;
  mapsUrl: string | null;
  /** page: a Maps link on the page. place_id: Google's documented link from the card's CID. null: none shown. */
  mapsUrlSource: 'page' | 'place_id' | null;
  latitude: number | null;
  longitude: number | null;
  /** Profile details from the card's lines, when the card has them (absent: not read from this layout). */
  hours?: string | null;
  serviceOptions?: string[];
  phoneShown?: boolean;
  reviewSnippet?: string | null;
  /** Whether the profile lists a website, from the page's own data (absent: the page's data did not say). */
  websiteListed?: boolean;
}

/** What the page's own listing data (in its scripts) held, and how it matched the result cards. */
export interface EmbeddedDiagnostics {
  /** Businesses in the page's data (Google's feature ID, CID and entity ID together). */
  places: number;
  /** Of those, matched to a result card by entity ID (or CID) and the same name. */
  matched: number;
  /** Same ID as a card but a different name: not used. */
  nameMismatch: number;
  /** Businesses in the page's data that are not a result card: not added (the page showed no position for them). */
  notOnCards: string[];
  /** Cards given coordinates, an exact review count (the card showed it rounded), or a website from the data. */
  coordinates: number;
  exactReviewCounts: number;
  websites: number;
}

/** What the parser saw and skipped, so a capture can be checked for duplicated or missed listings. */
export interface CaptureDiagnostics {
  /** Elements carrying a listing identifier (place CID, or Knowledge Graph entity ID on a card). */
  placeIdElements: number;
  /** Identifier elements nested inside another one (the same card), folded into one listing. */
  nestedSameCard: number;
  /** Cards rendered more than once on the page (same identifier and sponsored status), kept once. */
  repeatedCards: number;
  /** Identified cards skipped because no business name could be read from them. */
  skippedWithoutName: number;
  /** Cards with an entity ID but no listing details (not a business listing), skipped. */
  rejectedNotListing: number;
  /** Names of blocks that look like a listing (a heading next to a rating) but carry no place ID: possibly missed. */
  possibleMissed: string[];
  /** Other listing signals on the page, to diagnose a layout the parser does not read yet. */
  signals: {
    headings: number;
    ratingValues: number;
    ludocidLinks: number;
    mapsPlaceLinks: number;
    lrdLinks: number;
  };
  embedded: EmbeddedDiagnostics;
}

/** Continuation links found on the page itself (never built): Google's next-page link, and "More places". */
export interface CaptureContinuation {
  /** Google's own next-page link (a#pnnext). On a Places page this is the next page of places. */
  nextPageUrl: string | null;
  /** A link to the Places view of this search (udm=local / tbm=lcl, first page), e.g. "More places". */
  morePlacesUrl: string | null;
  /** Google Maps lists only: whether the list was saved to its end ("You've reached the end of the list"). */
  listEnd?: boolean;
}

export type CapturedPage =
  | {
      status: 'parsed';
      listings: CapturedListing[];
      notes: string[];
      diagnostics: CaptureDiagnostics;
      continuation: CaptureContinuation;
      /** The address the browser recorded when saving (MHTML location or "saved from" comment), when present. */
      savedFrom: string | null;
      /** When the browser saved the page (MHTML Date header), when present. */
      savedAt: Date | null;
    }
  | {
      status: 'unavailable';
      reason: string;
      diagnostics: CaptureDiagnostics;
      continuation: CaptureContinuation;
      savedFrom: string | null;
      savedAt: Date | null;
    }
  | { status: 'failed'; reason: string; savedFrom: string | null; savedAt: Date | null };

interface DomNode {
  type: string;
  name?: string;
  data?: string;
  attribs?: Record<string, string>;
  children?: DomNode[];
}

// ---------------- Saved-file formats ----------------

/** Quoted-printable (RFC 2045) to UTF-8: "=XX" is a byte, "=" at a line end is a soft break. Writes bytes directly
 * (saved Google pages are several MB, so per-character allocation is too slow). */
function decodeQuotedPrintable(input: string): string {
  const bytes = new Uint8Array(input.length * 3);
  const encoder = new TextEncoder();
  let n = 0;
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    if (code === 61 /* = */) {
      const next = input.charCodeAt(i + 1);
      if (next === 13 && input.charCodeAt(i + 2) === 10) {
        i += 2;
        continue;
      }
      if (next === 10) {
        i += 1;
        continue;
      }
      const hex = input.slice(i + 1, i + 3);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        bytes[n++] = parseInt(hex, 16);
        i += 2;
        continue;
      }
    }
    if (code < 128) bytes[n++] = code;
    else {
      const point = input.codePointAt(i)!;
      if (point > 0xffff) i += 1;
      for (const b of encoder.encode(String.fromCodePoint(point))) bytes[n++] = b;
    }
  }
  return Buffer.from(bytes.buffer, 0, n).toString('utf8');
}

/** MIME headers with folded lines joined (Chrome folds long header lines, e.g. Content-Type). */
const unfold = (headers: string) => headers.replace(/\r?\n(?=[ \t])/g, '');

/** The HTML part of an MHTML ("Save as single file") archive, with the address and time the browser recorded. */
function fromMhtml(raw: string): { html: string; location: string | null; date: Date | null } | null {
  const headerEnd = raw.slice(0, 20_000).search(/\r?\n\r?\n/);
  if (headerEnd < 0) return null;
  const head = unfold(raw.slice(0, headerEnd));
  if (!/^MIME-Version:/im.test(head) || !/multipart\/related/i.test(head)) return null;
  const boundary = /boundary="?([^";\r\n]+)"?/i.exec(head)?.[1]?.trim();
  if (!boundary) return null;
  const location = /^Snapshot-Content-Location:\s*(\S+)/im.exec(head)?.[1] ?? null;
  const dateRaw = /^Date:\s*(.+?)\s*$/im.exec(head)?.[1];
  for (const part of raw.slice(headerEnd).split(`--${boundary}`)) {
    const body0 = part.replace(/^\r?\n/, '');
    const sep = body0.search(/\r?\n\r?\n/);
    if (sep < 0) continue;
    const headers = unfold(body0.slice(0, sep));
    if (!/Content-Type:\s*text\/html/i.test(headers)) continue;
    let body = body0.slice(sep).replace(/^\r?\n\r?\n/, '');
    if (/Content-Transfer-Encoding:\s*quoted-printable/i.test(headers)) body = decodeQuotedPrintable(body);
    else if (/Content-Transfer-Encoding:\s*base64/i.test(headers))
      body = Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8');
    return {
      html: body,
      location,
      date: dateRaw && !Number.isNaN(Date.parse(dateRaw)) ? new Date(dateRaw) : null,
    };
  }
  return null;
}

// ---------------- Field readers ----------------

const clean = (s: string | undefined | null) => (s ?? '').replace(/\s+/g, ' ').trim();

/** Text of a subtree in document order, with a space between text nodes (spans are otherwise run together). */
function textOf(node: DomNode): string {
  const out: string[] = [];
  const walk = (n: DomNode) => {
    if (n.type === 'text' && n.data) out.push(n.data);
    if (n.type === 'tag' && (n.name === 'script' || n.name === 'style')) return;
    for (const child of n.children ?? []) walk(child);
  };
  walk(node);
  return clean(out.join(' '));
}

/** Text directly inside an element (not in its children). */
const ownText = (node: DomNode) =>
  clean(
    (node.children ?? [])
      .filter((c) => c.type === 'text')
      .map((c) => c.data ?? '')
      .join(' '),
  );

/** "34K" → 34000, "1.2K" → 1200, "1,234" → 1234. Abbreviated counts are as displayed (rounded by Google). */
export function parseReviewCount(raw: string): number | null {
  const s = raw.replace(/\s+/g, '').toUpperCase();
  const abbreviated = /^(\d+(?:[.,]\d+)?)([KM])$/.exec(s);
  if (abbreviated) {
    const n = Number(abbreviated[1]!.replace(',', '.')) * (abbreviated[2] === 'M' ? 1_000_000 : 1_000);
    return Number.isFinite(n) ? Math.round(n) : null;
  }
  if (!/^\d[\d.,]*$/.test(s)) return null;
  const n = Number(s.replace(/[.,]/g, ''));
  return Number.isFinite(n) && n <= 100_000_000 ? n : null;
}

const SPONSORED_LABELS = new Set(['sponsored', 'ad', 'ads', 'sponsorisé', 'gesponsert', 'patrocinado', 'sponsorizzato', 'प्रायोजित']); // prettier-ignore
const RATING_IN_TEXT = /(?:^|\s)([1-5][.,]\d)\s*\(\s*(\d[\d.,]*\s*[KkMm]?)\s*\)/;
/** A "·"-separated segment that is just the rating, with or without its count: "4.9 (618)", "4.9". */
const RATING_SEGMENT = /^[1-5][.,]\d(?:\s*\(\s*\d[\d.,]*\s*[KkMm]?\s*\))?$/;
const PRICE_LEVEL = /^[₹$€£¥]{1,4}$/;
const HOURS_LINE = /^(?:open|opens|closed|closes|open 24 hours|temporarily closed|permanently closed)\b/i;
const DISTANCE = /^\d+(?:[.,]\d+)?\s?(?:km|mi|m|ft)$/i;
/** A service option as a card lists it ("In-store shopping", "Kerbside pickup", "No in-store shopping"). */
const SERVICE_OPTION = /^\p{L}[\p{L}\s'’&/-]{1,40}$/u;
/** Lines about whoever saved the page ("Viewed 2 days ago", "You visited …"), not about the business. */
const VIEWER_HISTORY_LINE = /^(?:viewed|you visited|visited|you've been|you have been)\b/i;
const isPhoneNumber = (s: string) => /^\+?[\d\s()-]+$/.test(s) && s.replace(/\D/g, '').length >= 7;
/** Elements that identify a listing: a place CID, or a Knowledge Graph entity ID on the card ("pv-/g/…"). */
const CARRIER_SELECTOR = '[data-cid], [data-ludocid], [id^="pv-/g/"], [id^="pv-/m/"]';
const KG_CARD_ID = /^pv-(\/[gm]\/[A-Za-z0-9_-]{2,40})$/;

function unwrapGoogleRedirect(href: string): string {
  try {
    const url = new URL(href, 'https://www.google.com');
    if (/(^|\.)google\./.test(url.hostname) && url.pathname === '/url')
      return url.searchParams.get('q') ?? url.searchParams.get('url') ?? href;
    return url.toString();
  } catch {
    return href;
  }
}

const isGoogleHost = (host: string) =>
  /(^|\.)google\.[a-z.]+$/.test(host) || host.endsWith('.googleusercontent.com');

/** Hosts where a "website" is a page on another platform (many businesses list an Instagram page), not the business's
 * own site. Kept as the website but never as its domain, which identifies a business when matching competitors. */
const PLATFORM_HOSTS = ['instagram.com', 'facebook.com', 'fb.com', 'wa.me', 'whatsapp.com', 'linktr.ee', 'youtube.com', 'x.com', 'twitter.com', 'linkedin.com', 'pinterest.com', 'justdial.com', 'indiamart.com', 'g.page', 'goo.gl']; // prettier-ignore
export function businessDomain(website: string | null): string | null {
  if (!website) return null;
  try {
    const host = new URL(website).hostname.replace(/^www\./, '').toLowerCase();
    return isGoogleHost(host) || PLATFORM_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))
      ? null
      : host;
  } catch {
    return null;
  }
}

// ---------------- The page's own listing data ----------------
// A saved results page also carries each listing's data in its scripts: a `var m={…}` JSON model the page builds the
// cards, the map and the "Suggest an edit" dialog from. Read from real saved Places pages (2026-10): per listing, a
// tuple [feature ID "0x…:0x…", CID, -, entity ID "/g/…", Place ID "ChIJ…"]; [name, [rating, -, -, [review count]]];
// "Suggest an edit" fields [value, field ID, -, -, -, label] (an empty field holds a prompt such as "Add website");
// and map pins [-, -, -, lat×1e6, lng×1e6, {"32": [-, CID]}]. Records are matched by shape and Google's IDs, never by
// order; anything that does not match is ignored, so a changed layout only loses these extra fields.

/** A business as the page's data describes it. */
export interface EmbeddedPlace {
  entityId: string;
  cid: string;
  /** Google's Place ID (ChIJ…), when present. */
  placeId: string | null;
  name: string | null;
  rating: number | null;
  /** Exact, where cards show large counts rounded ("34K"). */
  reviewCount: number | null;
  /** The profile's full address (cards often show only its first part). */
  address: string | null;
  /** The profile's website; null when it lists none. Absent when the data had no website field. */
  website?: string | null;
  /** Whether the profile lists a phone number (the number itself is not kept). */
  phoneListed?: boolean;
  latitude: number | null;
  longitude: number | null;
}

const MODEL_START = 'var m={';
const FEATURE_ID = /^0x[0-9a-f]{1,16}:0x([0-9a-f]{1,16})$/i;
/** "Suggest an edit" fields by Google's field ID, and by their English label as a fallback (as seen on real pages). */
const EDIT_FIELD_IDS: Record<number, 'name' | 'address' | 'phone' | 'website'> = { 772642124: 'name', 1188690564: 'address', 108170089: 'phone', 1820148960: 'website' }; // prettier-ignore
const EDIT_FIELD_LABELS: Record<string, 'name' | 'address' | 'phone' | 'website'> = { 'Place name': 'name', 'Place location': 'address', 'Place phone number': 'phone', 'Place website': 'website' }; // prettier-ignore

/** The JSON object or array starting at `start`, or null when it is not closed. */
function balancedJson(text: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (inString) {
      if (c === 92)
        i++; // backslash: skip the escaped character
      else if (c === 34) inString = false;
    } else if (c === 34) inString = true;
    else if (c === 123 || c === 91) depth++;
    else if ((c === 125 || c === 93) && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

function visit(node: unknown, fn: (n: unknown) => void, depth = 0): void {
  if (depth > 40) return;
  fn(node);
  if (Array.isArray(node)) for (const child of node) visit(child, fn, depth + 1);
  else if (node && typeof node === 'object')
    for (const child of Object.values(node)) visit(child, fn, depth + 1);
}

function identityOf(n: unknown): { cid: string; entityId: string; placeId: string | null } | null {
  if (!Array.isArray(n) || typeof n[0] !== 'string' || typeof n[1] !== 'string' || typeof n[3] !== 'string') return null; // prettier-ignore
  const feature = FEATURE_ID.exec(n[0]);
  // The CID is the feature ID's second half (true on real pages), so a look-alike tuple is rejected.
  if (!feature || !/^\d{1,20}$/.test(n[1]) || BigInt(`0x${feature[1]}`) !== BigInt(n[1])) return null;
  if (!/^\/[gm]\/[A-Za-z0-9_-]{2,40}$/.test(n[3])) return null;
  const placeId = typeof n[4] === 'string' && /^ChI[A-Za-z0-9_-]{10,}$/.test(n[4]) ? n[4] : null;
  return { cid: n[1], entityId: n[3], placeId };
}

/** Businesses in the page's own data, by entity ID. Empty when the page carries none in a recognised form. */
export function readEmbeddedPlaces(html: string): Map<string, EmbeddedPlace> {
  const models: unknown[] = [];
  for (let at = html.indexOf(MODEL_START); at >= 0; at = html.indexOf(MODEL_START, at + MODEL_START.length)) {
    const json = balancedJson(html, at + MODEL_START.length - 1);
    if (!json) continue;
    try {
      models.push(JSON.parse(json));
    } catch {
      // not plain JSON: skipped
    }
  }
  const places = new Map<string, EmbeddedPlace>();
  const pins = new Map<string, { lat: number; lng: number } | null>();
  for (const model of models) {
    visit(model, (n) => {
      // Map pins, by CID; a CID with two different pins is dropped.
      if (!Array.isArray(n) || !Number.isInteger(n[3]) || !Number.isInteger(n[4])) return;
      const ext = n[5] as Record<string, unknown> | null | undefined;
      const ids = ext && typeof ext === 'object' && !Array.isArray(ext) ? ext['32'] : null;
      if (!Array.isArray(ids) || typeof ids[1] !== 'string' || !/^\d{1,20}$/.test(ids[1])) return;
      const [lat, lng] = [(n[3] as number) / 1e6, (n[4] as number) / 1e6];
      if (Math.abs(lat) > 90 || Math.abs(lng) > 180 || (lat === 0 && lng === 0)) return;
      const prev = pins.get(ids[1]);
      pins.set(ids[1], prev === undefined || (prev && Math.abs(prev.lat - lat) + Math.abs(prev.lng - lng) < 1e-4) ? { lat, lng } : null); // prettier-ignore
    });
    if (!model || typeof model !== 'object') continue;
    // Each entry of the model is one component; a listing's entry holds its ID tuple, rating and edit fields.
    for (const entry of Object.values(model)) {
      const ids = new Map<string, NonNullable<ReturnType<typeof identityOf>>>();
      let rated: { name: string; rating: number | null; reviewCount: number | null } | null = null;
      const fields: Partial<Record<'name' | 'address' | 'phone' | 'website', string>> = {};
      visit(entry, (n) => {
        const id = identityOf(n);
        if (id) ids.set(id.entityId, id);
        if (!Array.isArray(n)) return;
        if (!rated && typeof n[0] === 'string' && Array.isArray(n[1]) && typeof n[1][0] === 'number') {
          const counts = n[1][3];
          const count = Array.isArray(counts) && Number.isInteger(counts[0]) ? (counts[0] as number) : null;
          const rating = n[1][0] >= 1 && n[1][0] <= 5 ? Math.round(n[1][0] * 10) / 10 : null;
          if (rating !== null && count !== null) rated = { name: clean(n[0]), rating, reviewCount: count };
        }
        if (
          n.length === 6 &&
          typeof n[0] === 'string' &&
          typeof n[1] === 'number' &&
          typeof n[5] === 'string'
        ) {
          const kind = EDIT_FIELD_IDS[n[1]] ?? EDIT_FIELD_LABELS[n[5]];
          if (kind) fields[kind] ??= clean(n[0]);
        }
      });
      for (const id of ids.values()) {
        const place: EmbeddedPlace = places.get(id.entityId) ?? { ...id, name: null, rating: null, reviewCount: null, address: null, latitude: null, longitude: null }; // prettier-ignore
        // Fields only from an entry about this one business.
        if (ids.size === 1) {
          const r = rated as { name: string; rating: number | null; reviewCount: number | null } | null;
          place.name ??= fields.name || r?.name || null;
          if (r && (!fields.name || normalizeBusinessName(r.name) === normalizeBusinessName(fields.name))) {
            place.rating ??= r.rating;
            place.reviewCount ??= r.reviewCount;
          }
          // An address has a digit or a comma; an empty field's prompt ("Add address") has neither.
          if (fields.address && /[\d,]/.test(fields.address)) place.address ??= fields.address.slice(0, 255);
          if (fields.website !== undefined && place.website === undefined) {
            let site: string | null = null;
            try {
              const url = new URL(fields.website);
              if (/^https?:$/.test(url.protocol)) site = url.toString();
            } catch {
              // a prompt such as "Add website": the profile lists none
            }
            place.website = site;
          }
          if (fields.phone !== undefined && place.phoneListed === undefined)
            place.phoneListed = isPhoneNumber(fields.phone);
        }
        places.set(id.entityId, place);
      }
    }
  }
  for (const place of places.values()) {
    const pin = pins.get(place.cid);
    if (pin) [place.latitude, place.longitude] = [pin.lat, pin.lng];
  }
  return places;
}

// ---------------- Google Maps results list ----------------
// A saved Google Maps search keeps its results list (role="feed") with one role="article" card per listing, in the
// order shown. Maps loads more as the list is scrolled, so one page saved at the end of its list holds every result
// (121 on a real page saved 2026-10-30). Read from that page: the card's place link carries the name (aria-label)
// and Google's IDs (!1s feature ID, !3d/!4d coordinates, !16s entity ID, !19s Place ID); the rating is an image
// labelled "4.8 stars 246 Reviews" (exact count); the lines are [rating] [category · address] [hours · phone]
// [service options | quote], with the hours line sometimes only a phone.

const MAPS_RATING = /^([1-5](?:[.,]\d)?)\s+stars?\s+(\d[\d.,]*\s*[KkMm]?)\s+Reviews?$/i;
const MAPS_LIST_END = /you(?:['’]ve| have) reached the end of the list/i;

/** Google's identifiers and coordinates in a Maps place link (…/data=!…!1s0x…:0x…!3d…!4d…!16s/g/…!19sChIJ…). */
function mapsLinkIds(href: string) {
  let s = href;
  try {
    s = decodeURIComponent(href);
  } catch {
    // keep as is
  }
  const feature = /!1s0x[0-9a-f]{1,16}:0x([0-9a-f]{1,16})/i.exec(s);
  const coords = /!3d(-?\d{1,2}(?:\.\d+)?)!4d(-?\d{1,3}(?:\.\d+)?)/.exec(s);
  const [lat, lng] = coords ? [Number(coords[1]), Number(coords[2])] : [NaN, NaN];
  const valid = Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
  return {
    // The CID is the feature ID's second half (as on Google Search pages' own data).
    cid: feature ? BigInt(`0x${feature[1]}`).toString() : null,
    entityId: /!16s(\/[gm]\/[A-Za-z0-9_-]{2,40})/.exec(s)?.[1] ?? null,
    placeId: /!19s(ChI[A-Za-z0-9_-]{10,})/.exec(s)?.[1] ?? null,
    latitude: valid ? lat : null,
    longitude: valid ? lng : null,
  };
}

/** A card's text lines: the smallest blocks holding text in spans, each split on "·". Icons are font glyphs in the
 * private-use range (the wheelchair icon is U+E934 on the real page), so they and empty segments are dropped. */
function mapsCardLines($: cheerio.CheerioAPI, card: DomNode): string[][] {
  const lines: string[][] = [];
  for (const div of $(card as never)
    .find('div')
    .toArray() as unknown as DomNode[]) {
    const kids = (div.children ?? []).filter((c) => c.type === 'tag');
    if (kids.some((k) => k.name === 'div' && textOf(k))) continue;
    if (!kids.some((k) => k.name === 'span' && textOf(k))) continue;
    const segments = textOf(div)
      .replace(/[-]/g, '')
      .split('·')
      .map(clean)
      .filter((s) => /[\p{L}\p{N}]/u.test(s));
    if (segments.length) lines.push(segments);
  }
  return lines;
}

function parseMapsList(
  $: cheerio.CheerioAPI,
  cards: DomNode[],
  base: { savedFrom: string | null; savedAt: Date | null },
): CapturedPage {
  const listings: CapturedListing[] = [];
  const abbreviated = new Set<CapturedListing>();
  const seen = new Set<string>();
  let repeatedCards = 0;
  let skippedWithoutName = 0;
  let rejectedNotListing = 0;
  for (const card of cards) {
    const $card = $(card as never);
    const link = $card.find('a[href*="/maps/place/"]').first();
    if (!link.length) {
      rejectedNotListing += 1;
      continue;
    }
    const title = clean(link.attr('aria-label') || link.text()).slice(0, 255);
    if (!title) {
      skippedWithoutName += 1;
      continue;
    }
    const href = link.attr('href') ?? '';
    const ids = mapsLinkIds(href);
    const sponsored =
      $card.find('[aria-label="Sponsored"], [aria-label="Ad"]').length > 0 ||
      ($card.find('span, div').toArray() as unknown as DomNode[]).some((n) => SPONSORED_LABELS.has(ownText(n).toLowerCase())); // prettier-ignore
    const key = `${ids.entityId ?? ids.cid ?? normalizeBusinessName(title)}:${sponsored}`;
    if (seen.has(key)) {
      repeatedCards += 1;
      continue;
    }
    seen.add(key);

    const lines = mapsCardLines($, card).filter(
      (l) => !(l.length === 1 && (SPONSORED_LABELS.has(l[0]!.toLowerCase()) || l[0] === title)),
    );
    let rating: number | null = null;
    let reviewCount: number | null = null;
    let countText: string | null = null;
    const ratingLabel = ($card.find('[role="img"][aria-label]').toArray() as unknown as DomNode[])
      .map((n) => MAPS_RATING.exec(clean(n.attribs?.['aria-label'])))
      .find(Boolean);
    const ratingAt = lines.findIndex((l) => RATING_IN_TEXT.test(` ${l[0]}`) || /^no reviews$/i.test(l[0]!));
    const textRating = ratingAt >= 0 ? RATING_IN_TEXT.exec(` ${lines[ratingAt]![0]}`) : null;
    if (ratingLabel) [rating, countText] = [Number(ratingLabel[1]!.replace(',', '.')), ratingLabel[2]!];
    else if (textRating) [rating, countText] = [Number(textRating[1]!.replace(',', '.')), textRating[2]!];
    if (countText) reviewCount = parseReviewCount(countText);
    if (rating !== null && (rating < 1 || rating > 5)) rating = null;

    // The category line follows the rating line: category, then the address as the card shortens it.
    const after = lines.slice(ratingAt + 1);
    const categoryLine = after[0] && !HOURS_LINE.test(after[0][0]!) && !isPhoneNumber(after[0][0]!) ? after[0] : null; // prettier-ignore
    const first = categoryLine?.[0];
    const category =
      first && first.length <= 80 && !/\d{3,}/.test(first) && !PRICE_LEVEL.test(first) ? first : null;
    const addressParts = (categoryLine ?? [])
      .slice(category ? 1 : 0)
      .filter((s) => !isPhoneNumber(s) && !PRICE_LEVEL.test(s) && !DISTANCE.test(s));
    const address = addressParts.join(', ').slice(0, 255) || null;
    const profile: Pick<CapturedListing, 'hours' | 'serviceOptions' | 'phoneShown' | 'reviewSnippet'> = {
      hours: null,
      serviceOptions: [],
      phoneShown: after.some((l) => l.some(isPhoneNumber)),
      reviewSnippet: null,
    };
    for (const line of after.slice(categoryLine ? 1 : 0)) {
      const text = line.join(' · ');
      if (HOURS_LINE.test(line[0]!)) {
        const phoneAt = line.findIndex(isPhoneNumber);
        profile.hours ??= (phoneAt < 0 ? line : line.slice(0, phoneAt)).join(' · ').slice(0, 120) || null;
      } else if (/^["“]/.test(text))
        profile.reviewSnippet ??= text.replace(/^["“]\s*|\s*["”]$/g, '').slice(0, 300) || null;
      else if (
        !line.some(isPhoneNumber) &&
        !VIEWER_HISTORY_LINE.test(text) &&
        line.every((s) => SERVICE_OPTION.test(s))
      )
        profile.serviceOptions = [...new Set([...profile.serviceOptions!, ...line])].slice(0, 12);
    }
    let mapsUrl: string | null = null;
    try {
      const url = new URL(href, 'https://www.google.com');
      if (isGoogleHost(url.hostname)) mapsUrl = `${url.origin}${url.pathname}`; // without the session parameters
    } catch {
      // no link
    }

    const listing: CapturedListing = {
      position: listings.length + 1,
      title,
      cid: ids.cid,
      entityId: ids.entityId,
      placeId: ids.placeId,
      rating,
      reviewCount,
      sponsored,
      category,
      address,
      website: null,
      domain: null,
      mapsUrl,
      mapsUrlSource: mapsUrl ? 'page' : null,
      latitude: ids.latitude,
      longitude: ids.longitude,
      ...profile,
    };
    listings.push(listing);
    if (countText && /[KkMm]\s*$/.test(countText)) abbreviated.add(listing);
    if (listings.length >= MAX_CAPTURED_LISTINGS) break;
  }

  const listEnd = MAPS_LIST_END.test(clean($('[role="feed"]').text()));
  const continuation: CaptureContinuation = { nextPageUrl: null, morePlacesUrl: null, listEnd };
  const diagnostics: CaptureDiagnostics = {
    placeIdElements: cards.length - rejectedNotListing,
    nestedSameCard: 0,
    repeatedCards,
    skippedWithoutName,
    rejectedNotListing,
    possibleMissed: [],
    signals: {
      headings: $('[role="heading"]').length,
      ratingValues: $('[role="feed"] [role="img"][aria-label*="star"]').length,
      ludocidLinks: $('a[href*="ludocid="]').length,
      mapsPlaceLinks: $('a[href*="/maps/place/"]').length,
      lrdLinks: $('a[href*="lrd="]').length,
    },
    embedded: { places: 0, matched: 0, nameMismatch: 0, notOnCards: [], coordinates: 0, exactReviewCounts: 0, websites: 0 }, // prettier-ignore
  };
  if (!listings.length)
    return { status: 'unavailable', reason: 'The Google Maps results list on this page has no businesses.', diagnostics, continuation, ...base }; // prettier-ignore
  const n = listings.length;
  const notes = [
    `Google Maps list: ${n} business${n === 1 ? '' : 'es'}${listEnd ? ', saved to the end of the list' : ''}. Positions are the list’s order for this search and map area; Google Maps can order results differently from Google Search.`, // prettier-ignore
    ...(listEnd ? [] : ['The list was not saved at its end (“You’ve reached the end of the list” is not on the page), so Google Maps may have more. Scroll the list to its end and save the page again to add the rest.']), // prettier-ignore
    'Google Maps list cards show a shortened address and no website.',
  ];
  const noRating = listings.filter((l) => l.rating === null).length;
  if (noRating) notes.push(`${noRating} listing${noRating === 1 ? '' : 's'} showed no rating.`);
  if (abbreviated.size)
    notes.push(`${abbreviated.size} review count${abbreviated.size === 1 ? ' was abbreviated by Google (for example “34K”) and is' : 's were abbreviated by Google (for example “34K”) and are'} stored as displayed, so rounded.`); // prettier-ignore
  return { status: 'parsed', listings, notes, diagnostics, continuation, ...base };
}

/**
 * Parses one saved Google results page (Google Search, or a Google Maps search's results list). Listings are taken in
 * document order; nothing is re-sorted. A page Google served instead of results (consent, "unusual traffic") is
 * reported as failed with the reason.
 */
export function parseGoogleResultsHtml(raw: string): CapturedPage {
  const mhtml = fromMhtml(raw);
  const html = mhtml?.html ?? raw;
  const savedFromComment =
    /<!--\s*saved from url=\(\d+\)(\S+?)\s*-->/i.exec(html.slice(0, 2000))?.[1] ?? null;
  const savedFrom = mhtml?.location ?? savedFromComment;
  const savedAt = mhtml?.date ?? null;
  const base = { savedFrom, savedAt };

  const $ = cheerio.load(html);
  $('script, style, noscript, template').remove();

  // Block pages are recognised from the VISIBLE document only. Real results pages embed Google's own scripts that
  // mention "/sorry/index" (they check responses for it), so matching raw HTML would reject every real page.
  const visibleText = clean($('body').text());
  const savedPath = (() => {
    try {
      return savedFrom ? new URL(savedFrom).pathname : '';
    } catch {
      return '';
    }
  })();
  if (
    /Our systems have detected unusual traffic/i.test(visibleText) ||
    $('form#captcha-form, form[action*="/sorry/"]').length > 0 ||
    savedPath.startsWith('/sorry/')
  )
    return { status: 'failed', reason: 'Google showed an “unusual traffic” check instead of results. Complete it in your browser, reload the results, then save the page again.', ...base }; // prettier-ignore
  if (/Before you continue to Google/i.test(visibleText) || $('form[action*="consent.google."]').length > 0)
    return { status: 'failed', reason: 'This is Google’s cookie-consent page, not the results. Accept or reject it in your browser, then save the results page.', ...base }; // prettier-ignore

  // A Google Maps results list: cards in role="feed" with a place link each.
  const mapsCards = $('[role="feed"] [role="article"]').toArray() as unknown as DomNode[];
  if (mapsCards.some((c) => $(c as never).find('a[href*="/maps/place/"]').length))
    return parseMapsList($, mapsCards, base);

  // A listing is identified by Google's own identifiers, never by its CSS classes: a place CID (data-cid /
  // data-ludocid), or a Knowledge Graph entity ID on the card element (id="pv-/g/…" — the real Places page layout).
  const idsOf = (node: DomNode): { cid: string | null; entityId: string | null } | null => {
    const rawCid = node.attribs?.['data-cid'] ?? node.attribs?.['data-ludocid'];
    const cid = rawCid && /^\d{5,25}$/.test(rawCid) ? rawCid : null;
    const entityId = KG_CARD_ID.exec(node.attribs?.id ?? '')?.[1] ?? null;
    return cid || entityId ? { cid, entityId } : null;
  };
  const all = ($(CARRIER_SELECTOR).toArray() as unknown as DomNode[]).filter((el) => idsOf(el));
  const allSet = new Set(all);
  // Identifier elements inside another one are the same card: fold them into the outermost and merge the IDs.
  const carriers = all.filter(
    (el) =>
      !(
        $(el as never)
          .parents()
          .toArray() as unknown as DomNode[]
      ).some((p) => allSet.has(p)),
  );
  const carrierSet = new Set(carriers);

  const listings: CapturedListing[] = [];
  const seen = new Set<string>();
  const scopes = new Set<DomNode>();
  /** Listings whose card showed the review count rounded ("34K"). */
  const abbreviated = new Set<CapturedListing>();
  let repeatedCards = 0;
  let skippedWithoutName = 0;
  let rejectedNotListing = 0;
  for (const carrier of carriers) {
    const ids = [
      carrier,
      ...($(carrier as never)
        .find(CARRIER_SELECTOR)
        .toArray() as unknown as DomNode[]),
    ]
      .map(idsOf)
      .filter((x): x is { cid: string | null; entityId: string | null } => x !== null);
    const cid = ids.find((x) => x.cid)?.cid ?? null;
    const entityId = ids.find((x) => x.entityId)?.entityId ?? null;
    // The listing's own block: climb while the ancestor holds no other card (bounded).
    let scope: DomNode = carrier;
    let level = 0;
    for (const parent of $(carrier as never)
      .parents()
      .toArray() as unknown as DomNode[]) {
      if (++level > MAX_SCOPE_DEPTH || parent.name === 'body') break;
      const others = (
        $(parent as never)
          .find(CARRIER_SELECTOR)
          .toArray() as unknown as DomNode[]
      ).some((x) => carrierSet.has(x) && x !== carrier);
      if (others) break;
      scope = parent;
    }
    const $scope = $(scope as never);
    const $carrier = $(carrier as never);
    scopes.add(scope);

    const headingNode = ($carrier.find('[role="heading"]').toArray()[0] ??
      $scope.find('[role="heading"]').toArray()[0]) as unknown as DomNode | undefined;
    const title = clean(
      [
        headingNode ? textOf(headingNode) : '',
        $carrier.attr('aria-label'),
        $carrier.find('a[aria-label]').first().attr('aria-label'),
      ].find((t) => clean(t).length > 0),
    ).slice(0, 255);
    if (!title) {
      skippedWithoutName += 1; // a listing without a readable name is skipped, never named by us
      continue;
    }
    // The card's detail lines are the heading's sibling elements, in order (category line, address line, hours…).
    const headingParent = headingNode
      ? ($(headingNode as never)
          .parent()
          .toArray()[0] as unknown as DomNode | undefined)
      : undefined;
    const detailLines = (headingParent?.children ?? [])
      .filter((c) => c.type === 'tag' && c !== headingNode)
      .map(textOf)
      .filter((line) => line && !SPONSORED_LABELS.has(line.toLowerCase()));
    // An entity ID alone also marks other knowledge cards; a business listing must show listing details.
    if (!cid && !detailLines.length && !RATING_IN_TEXT.test(` ${textOf(scope)}`)) {
      rejectedNotListing += 1;
      continue;
    }

    const sponsored =
      ($scope.find('span, div').toArray() as unknown as DomNode[]).some((n) =>
        SPONSORED_LABELS.has(ownText(n).toLowerCase()),
      ) || $scope.find('[aria-label="Sponsored"], [aria-label="Ad"]').length > 0;
    // A sponsored and an organic listing of the same business are two listings; a repeated render is not.
    const key = `${entityId ?? cid}:${sponsored}`;
    if (seen.has(key)) {
      repeatedCards += 1;
      continue;
    }
    seen.add(key);

    const scopeText = textOf(scope);
    let rating: number | null = null;
    let reviewCount: number | null = null;
    let reviewCountAbbreviated = false;
    const ariaLabels = ($scope.find('[aria-label]').toArray() as unknown as DomNode[]).map((n) =>
      clean(n.attribs?.['aria-label']),
    );
    const ariaRating = ariaLabels
      .map((label) => /Rated\s+([1-5](?:[.,]\d)?)\s+out of\s+5/i.exec(label))
      .find(Boolean);
    const textRating = RATING_IN_TEXT.exec(scopeText);
    if (ariaRating) rating = Number(ariaRating[1]!.replace(',', '.'));
    else if (textRating) rating = Number(textRating[1]!.replace(',', '.'));
    if (textRating) {
      reviewCount = parseReviewCount(textRating[2]!);
      reviewCountAbbreviated = /[KkMm]\s*$/.test(textRating[2]!);
    }
    // "1,234 reviews", or the real Places page's "Rated 4.9 out of 5, 618 user reviews" (exact unless abbreviated).
    const ariaReviews = ariaLabels
      .map(
        (label) =>
          /^([\d.,]+)\s+reviews?$/i.exec(label) ??
          /out of\s+5,\s*(\d[\d.,]*\s*[KkMm]?)\s+(?:user\s+)?reviews?/i.exec(label),
      )
      .find(Boolean);
    if (ariaReviews) {
      const fromLabel = parseReviewCount(ariaReviews[1]!);
      if (fromLabel !== null)
        [reviewCount, reviewCountAbbreviated] = [fromLabel, /[KkMm]\s*$/.test(ariaReviews[1]!)];
    }
    if (rating !== null && (rating < 1 || rating > 5)) rating = null;

    // Category: from the category line ("4.8 (34K) · ₹₹ · Jewellery store" or "No reviews · Jewellery store").
    // Address: the next line ("13 Krishna Rowhouse, Yogi Chowk Rd · 072029 26000"), phone removed — this line order
    // was verified on a real saved Places page; a line that is really hours or a quoted review is not an address.
    const categoryLineAt = Math.max(
      0,
      detailLines.findIndex((l) => RATING_IN_TEXT.test(` ${l}`) || /^no reviews\b/i.test(l)),
    );
    const categoryFrom = (line: string | undefined) => {
      const segment = (line ?? '')
        .split('·')
        .map(clean)
        .find((s) => s && !RATING_SEGMENT.test(s) && !PRICE_LEVEL.test(s) && !/^no reviews$/i.test(s));
      return segment && segment.length <= 80 && !/\d{3,}/.test(segment) ? segment : null;
    };
    let category = categoryFrom(detailLines[categoryLineAt]);
    if (!category) {
      // Fallback without a heading structure: the smallest element holding the rating followed by "·".
      const ratingLine = ($scope.find('div, span').toArray() as unknown as DomNode[])
        .map(textOf)
        .filter((line) => RATING_IN_TEXT.test(line) && line.indexOf('·') > line.search(/[1-5][.,]\d/))
        .sort((a, b) => a.length - b.length)[0];
      category = categoryFrom(ratingLine);
    }
    const addressFrom = (line: string | undefined) => {
      if (!line || HOURS_LINE.test(line) || /^["“]/.test(line)) return null;
      const parts = line
        .split('·')
        .map(clean)
        .filter((s) => s && !isPhoneNumber(s) && !/years? in business/i.test(s) && !DISTANCE.test(s));
      const value = parts.join(', ');
      return value && value.length <= 255 ? value : null;
    };
    const detailAddress = detailLines.length > categoryLineAt + 1 ? addressFrom(detailLines[categoryLineAt + 1]) : null; // prettier-ignore
    // The lines after the category line: phone (on the address line), hours, service options or a customer quote,
    // as verified on real saved Places pages. Only cards with that line structure get these details.
    const profile: Pick<CapturedListing, 'hours' | 'serviceOptions' | 'phoneShown' | 'reviewSnippet'> = {};
    if (detailLines.length) {
      const after = detailLines.slice(categoryLineAt + 1);
      profile.phoneShown = after.some((line) => line.split('·').map(clean).some(isPhoneNumber));
      profile.hours = null;
      profile.serviceOptions = [];
      profile.reviewSnippet = null;
      for (const [i, line] of after.entries()) {
        if (i === 0 && detailAddress !== null) continue; // the address line
        if (HOURS_LINE.test(line)) profile.hours ??= line.slice(0, 120);
        else if (/^["“]/.test(line))
          profile.reviewSnippet ??= line.replace(/^["“]\s*|\s*["”]$/g, '').slice(0, 300) || null; // prettier-ignore
        else if (!VIEWER_HISTORY_LINE.test(line)) {
          const segments = line.split('·').map(clean).filter(Boolean);
          if (segments.length && segments.every((s) => SERVICE_OPTION.test(s)))
            profile.serviceOptions = [...new Set([...profile.serviceOptions, ...segments])].slice(0, 12);
        }
      }
    }

    const labelled = (n: DomNode) => clean(`${textOf(n)} ${n.attribs?.['aria-label'] ?? ''}`).toLowerCase();
    let website: string | null = null;
    let mapsUrl: string | null = null;
    for (const a of $scope.find('a[href]').toArray() as unknown as DomNode[]) {
      const href = unwrapGoogleRedirect(a.attribs?.href ?? '');
      let url: URL;
      try {
        url = new URL(href, 'https://www.google.com');
      } catch {
        continue;
      }
      if (
        !website &&
        /\bwebsite\b/.test(labelled(a)) &&
        /^https?:$/.test(url.protocol) &&
        !isGoogleHost(url.hostname)
      )
        website = url.toString();
      if (
        !mapsUrl &&
        isGoogleHost(url.hostname) &&
        /\/maps\/place\/|[?&]cid=\d+/.test(`${url.pathname}${url.search}`)
      )
        mapsUrl = url.toString();
    }
    // A Maps link on the page; else Google's documented link from the listing's own CID; else none — a Knowledge
    // Graph entity ID is kept as the identifier instead of building a Maps link the page did not show.
    let mapsUrlSource: CapturedListing['mapsUrlSource'] = mapsUrl ? 'page' : null;
    if (!mapsUrl && cid) {
      mapsUrl = `https://maps.google.com/?cid=${cid}`;
      mapsUrlSource = 'place_id';
    }

    const addressLabel = ariaLabels.map((label) => /^Address:\s*(.+)$/i.exec(label)).find(Boolean);
    // Coordinates only when the markup carries them; never estimated.
    const attrNumber = (name: string) => {
      const raw = $carrier.attr(name) ?? $scope.attr(name);
      return raw !== undefined && raw.trim() !== '' ? Number(raw) : NaN;
    };
    const lat = attrNumber('data-lat');
    const lng = attrNumber('data-lng');
    const hasCoords =
      Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;

    const listing: CapturedListing = {
      position: listings.length + 1,
      title,
      cid,
      entityId,
      placeId: null,
      rating,
      reviewCount,
      sponsored,
      category,
      address: addressLabel ? clean(addressLabel[1]).slice(0, 255) : detailAddress,
      website,
      domain: businessDomain(website),
      mapsUrl,
      mapsUrlSource,
      latitude: hasCoords ? lat : null,
      longitude: hasCoords ? lng : null,
      ...profile,
    };
    listings.push(listing);
    if (reviewCountAbbreviated) abbreviated.add(listing);
    if (listings.length >= MAX_CAPTURED_LISTINGS) break;
  }

  // The page's own data for the same listings, matched by entity ID (else CID) and checked by name: Google's IDs,
  // the exact review count where the card rounded it, the profile's full address and website, and the map pin. What
  // the card itself showed is kept; the data only fills what the card did not show.
  const embeddedPlaces = readEmbeddedPlaces(html);
  const byCid = new Map([...embeddedPlaces.values()].map((p) => [p.cid, p]));
  const embedded: EmbeddedDiagnostics = { places: embeddedPlaces.size, matched: 0, nameMismatch: 0, notOnCards: [], coordinates: 0, exactReviewCounts: 0, websites: 0 }; // prettier-ignore
  const used = new Set<EmbeddedPlace>();
  for (const l of listings) {
    const e =
      (l.entityId ? embeddedPlaces.get(l.entityId) : undefined) ?? (l.cid ? byCid.get(l.cid) : undefined);
    if (!e) continue;
    used.add(e);
    if (e.name && normalizeBusinessName(e.name) !== normalizeBusinessName(l.title)) {
      embedded.nameMismatch += 1;
      continue;
    }
    embedded.matched += 1;
    l.cid ??= e.cid; // the entity ID is left as the card had it: it keys duplicates across pages
    l.placeId ??= e.placeId;
    if (!l.mapsUrl && l.cid)
      [l.mapsUrl, l.mapsUrlSource] = [`https://maps.google.com/?cid=${l.cid}`, 'place_id'];
    if (l.rating === null) l.rating = e.rating;
    if (e.reviewCount !== null) {
      // A rounded count is replaced only by an exact one it could have been rounded from.
      if (l.reviewCount === null) l.reviewCount = e.reviewCount;
      else if (abbreviated.has(l) && Math.abs(e.reviewCount - l.reviewCount) <= l.reviewCount * 0.1) {
        l.reviewCount = e.reviewCount;
        abbreviated.delete(l);
        embedded.exactReviewCounts += 1;
      }
    }
    if (e.address) l.address = e.address;
    if (e.website !== undefined) {
      l.websiteListed = e.website !== null;
      if (!l.website && e.website) {
        l.website = e.website;
        l.domain = businessDomain(e.website);
        embedded.websites += 1;
      }
    }
    if (l.phoneShown === undefined && e.phoneListed !== undefined) l.phoneShown = e.phoneListed;
    if (l.latitude === null && e.latitude !== null && e.longitude !== null) {
      [l.latitude, l.longitude] = [e.latitude, e.longitude];
      embedded.coordinates += 1;
    }
  }
  embedded.notOnCards = [...embeddedPlaces.values()].filter((p) => !used.has(p)).map((p) => p.name ?? p.entityId); // prettier-ignore

  // Possibly missed: a heading next to a rating, outside every card that was read (no place ID on it).
  const insideCard = (node: DomNode) =>
    scopes.has(node) ||
    (
      $(node as never)
        .parents()
        .toArray() as unknown as DomNode[]
    ).some((p) => scopes.has(p));
  const possibleMissed: string[] = [];
  for (const heading of $('[role="heading"]').toArray() as unknown as DomNode[]) {
    if (insideCard(heading)) continue;
    const name = textOf(heading);
    if (!name || name.length > 120) continue;
    // Only the heading's own block counts: stop before <body>/<html> or an ancestor holding another heading,
    // otherwise any heading on the page sits "near" every rating (found on a real saved page).
    const near: DomNode[] = [];
    for (const p of (
      $(heading as never)
        .parents()
        .toArray() as unknown as DomNode[]
    ).slice(0, 3)) {
      if (p.name === 'body' || p.name === 'html' || $(p as never).find('[role="heading"]').length > 1) break;
      near.push(p);
    }
    if (
      near.some(
        (n) =>
          RATING_IN_TEXT.test(` ${textOf(n)}`) ||
          /Rated\s+[1-5]/i.test(
            $(n as never)
              .find('[aria-label]')
              .toArray()
              .map((x) => (x as unknown as DomNode).attribs?.['aria-label'] ?? '')
              .join(' '),
          ),
      )
    )
      // prettier-ignore
      possibleMissed.push(name);
    if (possibleMissed.length >= 25) break;
  }
  // Continuation: only Google's own links on the page. The next-page link is identified by Google's pagination id
  // (#pnnext) — not by "Next" text, which browser extensions inject into pages too (seen on a real saved page).
  const googleSearchUrl = (href: string | undefined): URL | null => {
    if (!href) return null;
    try {
      const url = new URL(href, 'https://www.google.com');
      return isGoogleHost(url.hostname) && url.pathname === '/search' ? url : null;
    } catch {
      return null;
    }
  };
  const isPlacesView = (u: URL) =>
    u.searchParams.get('udm') === 'local' || u.searchParams.get('tbm') === 'lcl';
  // "More places" must be this page's own search: real pages also link the Places view of related searches.
  const titleSearch = /^(.*?)\s+-\s+Google\b/.exec(clean($('title').text()))?.[1];
  const placesLinks = ($('a[href]').toArray() as unknown as DomNode[])
    .map((a) => googleSearchUrl(a.attribs?.href))
    .filter((u): u is URL => u !== null && isPlacesView(u) && Number(u.searchParams.get('start') ?? 0) === 0);
  const continuation: CaptureContinuation = {
    nextPageUrl: googleSearchUrl($('a#pnnext').attr('href'))?.toString() ?? null,
    morePlacesUrl:
      (titleSearch
        ? placesLinks.find(
            (u) => clean(u.searchParams.get('q')).toLowerCase() === clean(titleSearch).toLowerCase(),
          )
        : placesLinks[0]
      )?.toString() ?? null,
  };
  const diagnostics: CaptureDiagnostics = {
    placeIdElements: all.length,
    nestedSameCard: all.length - carriers.length,
    repeatedCards,
    skippedWithoutName,
    rejectedNotListing,
    possibleMissed,
    signals: {
      headings: $('[role="heading"]').length,
      ratingValues: ($('span, div').toArray() as unknown as DomNode[]).filter((n) => /^[1-5][.,]\d$/.test(ownText(n))).length, // prettier-ignore
      ludocidLinks: $('a[href*="ludocid="]').length,
      mapsPlaceLinks: $('a[href*="/maps/place/"]').length,
      lrdLinks: $('a[href*="lrd="]').length,
    },
    embedded,
  };

  if (!listings.length) {
    const title = clean($('title').text());
    const looksLikeGoogle = /google/i.test(title) || /www\.google\./i.test(html.slice(0, 50_000));
    const mapsPage = /\s-\s+Google Maps$/i.test(title) || /^\/maps(\/|$)/.test(savedPath);
    return {
      status: 'unavailable',
      reason: mapsPage
        ? 'This saved Google Maps page shows no results list. Search on Google Maps, scroll the list on the left to its end (“You’ve reached the end of the list”), then save the page.'
        : looksLikeGoogle
          ? 'No local business listings were found on this page. Save the page that shows the businesses (for example after clicking “More places”).'
          : 'This does not look like a saved Google results page.',
      diagnostics,
      continuation,
      ...base,
    };
  }
  const notes: string[] = [];
  // What the file holds: the result cards, checked against the page's own data when the page carries it.
  if (embedded.places) {
    const inFile = listings.length + embedded.notOnCards.length;
    notes.push(
      embedded.notOnCards.length
        ? `The file holds ${inFile} businesses: ${listings.length} result cards were read; ${embedded.notOnCards.length} more appear only in the page’s data (${embedded.notOnCards.slice(0, 5).join(', ')}) and were not added, because the page showed no position for them.` // prettier-ignore
        : `All ${listings.length} businesses in this file were read (the result cards, checked against the page’s own data). A saved results page holds only that page’s results.`, // prettier-ignore
    );
    const filled = [
      embedded.exactReviewCounts
        ? `exact review counts for ${embedded.exactReviewCounts} shown rounded`
        : null,
      embedded.matched ? `Google’s place IDs for ${embedded.matched}` : null,
      embedded.coordinates ? `map coordinates for ${embedded.coordinates}` : null,
      embedded.websites ? `websites for ${embedded.websites}` : null,
    ].filter(Boolean);
    if (filled.length) notes.push(`From the page’s own data: ${filled.join(', ')}.`);
    if (embedded.nameMismatch)
      notes.push(`${embedded.nameMismatch} listing${embedded.nameMismatch === 1 ? '' : 's'} had a different name in the page’s data, so that data was not used for ${embedded.nameMismatch === 1 ? 'it' : 'them'}.`); // prettier-ignore
  }
  const noRating = listings.filter((l) => l.rating === null).length;
  if (noRating) notes.push(`${noRating} listing${noRating === 1 ? '' : 's'} showed no rating.`);
  if (abbreviated.size)
    notes.push(`${abbreviated.size} review count${abbreviated.size === 1 ? ' was abbreviated by Google (for example “34K”) and is' : 's were abbreviated by Google (for example “34K”) and are'} stored as displayed, so rounded.`); // prettier-ignore
  if (possibleMissed.length)
    notes.push(`${possibleMissed.length} block${possibleMissed.length === 1 ? '' : 's'} looked like a listing but carried no place ID and were not read: ${possibleMissed.slice(0, 5).join(', ')}${possibleMissed.length > 5 ? '…' : ''}.`); // prettier-ignore
  return { status: 'parsed', listings, notes, diagnostics, continuation, ...base };
}

/** The search shown in the page title ("best jewellery shop in surat - Google Search"), when recognisable. */
function titleQuery(raw: string): string | null {
  const html = fromMhtml(raw)?.html ?? raw;
  const title = clean(/<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1]);
  const match = /^(.*?)\s+-\s+Google\b/.exec(title);
  return match ? clean(match[1]).toLowerCase() : null;
}

const normQuery = (q: string) => clean(q).toLowerCase();

export interface PositionedListing {
  batch: number;
  listing: CapturedListing;
  /** Position within its page, as shown. */
  sourcePosition: number;
  /** Global position from Google's start= offset; null when the page's offset cannot be established. */
  cumulativePosition: number | null;
}

/**
 * Places each page's listings in the overall order using Google's own start= offset from the page address. Page 1
 * without start= is the first page (offset 0). A later page without start= cannot be placed, so its listings keep
 * page-local positions only. Offsets are used as given — pages are not assumed to hold 10 or 20 results — and gaps
 * or overlaps between pages are reported, not papered over.
 */
export function assignCapturePositions(
  pages: {
    batch: number;
    info: Pick<GoogleSearchUrlInfo, 'start' | 'hasStart'>;
    listings: CapturedListing[];
  }[],
): { positioned: PositionedListing[]; notes: string[] } {
  const notes: string[] = [];
  const offsets = new Map<number, number>();
  for (const p of pages) {
    if (p.info.hasStart || p.batch === 1) offsets.set(p.batch, p.info.start);
    else notes.push(`Page ${p.batch} has no start= in its address, so its positions are page-local (1–${p.listings.length}), not continued from earlier pages.`); // prettier-ignore
  }
  // Compare placed pages in offset order: report a gap (positions not captured) or an overlap (same positions twice).
  const placed = pages
    .filter((p) => offsets.has(p.batch))
    .map((p) => ({
      batch: p.batch,
      from: offsets.get(p.batch)! + 1,
      to: offsets.get(p.batch)! + p.listings.length,
    }))
    .sort((a, b) => a.from - b.from || a.batch - b.batch);
  for (let i = 1; i < placed.length; i++) {
    const prev = placed[i - 1]!;
    const cur = placed[i]!;
    if (cur.from <= prev.to)
      notes.push(`Pages ${prev.batch} and ${cur.batch} overlap (positions ${cur.from}–${Math.min(prev.to, cur.to)} appear in both); both are kept as separate observations.`); // prettier-ignore
    else if (cur.from > prev.to + 1)
      notes.push(`Positions ${prev.to + 1}–${cur.from - 1} were not captured (between page ${prev.batch} and page ${cur.batch}).`); // prettier-ignore
  }
  const positioned = pages.flatMap((p) => {
    const offset = offsets.get(p.batch);
    return p.listings.map((listing) => ({
      batch: p.batch,
      listing,
      sourcePosition: listing.position,
      cumulativePosition: offset === undefined ? null : offset + listing.position,
    }));
  });
  return { positioned, notes };
}

// ---------------- Multi-page collections ----------------
// A GOOGLE_CAPTURE scan is a resumable collection: each saved page is one batch, processed and committed before the
// next one is read (so a later failure never loses earlier pages), until the unique-business target is reached or
// Google offers no further page. OptiReach cannot open Google's next page itself: it shows the next-page link the
// last saved page carried, and the user opens and saves it.

export interface GoogleCapturePageInput {
  url?: string | null;
  html: string;
}

const TERMINAL_STATES: readonly GoogleCaptureState[] = [
  'TARGET_REACHED',
  'SOURCE_EXHAUSTED',
  'PARTIAL',
  'CANCELLED',
  'FAILED',
];
/** Consecutive pages adding no new business before the collection is treated as exhausted (pagination repeating). */
const MAX_PAGES_WITHOUT_NEW = 2;
const isTerminal = (state: string | null | undefined) =>
  TERMINAL_STATES.includes(state as GoogleCaptureState);

/** A stored batch: the DTO plus the keys used to recognise a repeated page (not exposed through the API). */
type StoredBatch = GoogleCaptureBatchDto & { urlKey: string | null; contentKey: string | null };

const normText = (s: string) =>
  clean(s)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/**
 * How the same business is recognised on another page: Google's entity ID, else its CID, else name + address (a
 * cautious fallback — two branches with the same name differ by address). Null when none is available: such listings
 * are never merged, and are counted as `withoutIdentifier`.
 */
export function captureIdentityKey(l: {
  entityId?: string | null;
  cid?: string | null;
  placeId?: string | null;
  title: string;
  address?: string | null;
}): string | null {
  if (l.entityId) return `e:${l.entityId}`;
  if (l.cid) return `c:${l.cid}`;
  if (l.placeId) return `p:${l.placeId}`;
  if (l.address) return `n:${normalizeBusinessName(l.title)}|${normText(l.address)}`;
  return null;
}

/** A stored listing row: an ad and an organic listing of the same business are two rows (both were shown). */
const rowKeyOf = (l: Parameters<typeof captureIdentityKey>[0] & { sponsored?: boolean }) => {
  const id = captureIdentityKey(l);
  return id ? `${id}:${l.sponsored === true}` : null;
};

/** Distinct businesses among stored rows (an ad and an organic row of one business count once). */
export function uniqueBusinessCount(results: LocalResult[]): number {
  const ids = new Set<string>();
  let anonymous = 0;
  for (const r of results) {
    const id = captureIdentityKey(r);
    if (id) ids.add(id);
    else anonymous += 1;
  }
  return ids.size + anonymous;
}

const pageKey = (info: Pick<GoogleSearchUrlInfo, 'query' | 'surface' | 'start'>) =>
  `${normQuery(info.query)}|${info.surface}|${info.start}`;

interface PreparedPage {
  info: GoogleSearchUrlInfo | null;
  /** The address used: entered, else recorded by the browser in the saved file. */
  url: string | null;
  pageQuery: string | null;
  result: CapturedPage;
  capturedAt: Date;
}

/** Validates the addresses and parses the pages; nothing is stored. Invalid entered addresses are 400s. */
function preparePages(pages: GoogleCapturePageInput[], expectedQuery: string | null): PreparedPage[] {
  const prepared = pages.map((page, i): PreparedPage => {
    let entered: GoogleSearchUrlInfo | null = null;
    if (page.url) {
      const parsed = parseGoogleSearchUrl(page.url);
      if (!parsed.ok) throw Errors.badRequest(`Page ${i + 1}: ${parsed.reason}`);
      entered = parsed.info;
    }
    let result = parseGoogleResultsHtml(page.html);
    const recordedParse = result.savedFrom ? parseGoogleSearchUrl(result.savedFrom) : null;
    const recorded = recordedParse?.ok ? recordedParse.info : null;
    const info = entered ?? recorded;
    const pageQuery = titleQuery(page.html);
    const fail = (reason: string): CapturedPage => ({
      status: 'failed',
      reason,
      savedFrom: result.savedFrom,
      savedAt: result.savedAt,
    });
    if (result.status === 'parsed') {
      if (info && pageQuery && pageQuery !== normQuery(info.query))
        result = fail(`The saved page shows “${pageQuery}”, not “${info.query}”. Pair each file with its own address.`); // prettier-ignore
      else if (
        entered &&
        recorded &&
        (normQuery(recorded.query) !== normQuery(entered.query) || recorded.start !== entered.start)
      )
        // prettier-ignore
        result = fail('The browser recorded a different address for this saved page than the one entered. Pair each file with its own address.'); // prettier-ignore
      else if (
        expectedQuery &&
        normQuery(info?.query ?? pageQuery ?? expectedQuery) !== normQuery(expectedQuery)
      )
        result = fail(
          `This page is for “${info?.query ?? pageQuery}”, but the collection is for “${expectedQuery}”.`,
        );
    }
    return {
      info,
      url: info?.url ?? page.url ?? null,
      pageQuery,
      result,
      capturedAt: result.savedAt ?? new Date(),
    };
  });
  // Pages are processed in Google's order when every page's offset is known; otherwise in the order given.
  return prepared.every((p) => p.info)
    ? prepared
        .map((p, i) => ({ p, i }))
        .sort((a, b) => a.p.info!.start - b.p.info!.start || a.i - b.i)
        .map(({ p }) => p)
    : prepared;
}

/** Serialises changes to one collection (two uploads at once cannot overwrite each other's listings). */
export function withScanLock<T>(
  prisma: PrismaClient,
  scanId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
) {
  return prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM local_rank_scans WHERE id = ${scanId} FOR UPDATE`;
      return fn(tx);
    },
    { timeout: 30_000, maxWait: 10_000 },
  );
}

const storedBatches = (json: unknown): StoredBatch[] => (Array.isArray(json) ? (json as StoredBatch[]) : []);
const storedResults = (json: unknown): LocalResult[] => (Array.isArray(json) ? (json as LocalResult[]) : []);

/** Batches as exposed through the API (internal repeat-detection keys removed). */
export function captureBatchesDto(json: unknown): GoogleCaptureBatchDto[] {
  return storedBatches(json).map(({ urlKey: _u, contentKey: _c, ...batch }) => batch);
}

/** Notes about the overall order: gaps (positions not captured) and overlaps between pages with known offsets. */
function pageRangeNotes(batches: GoogleCaptureBatchDto[], automatic = false): string[] {
  const notes: string[] = [];
  const unit = automatic ? 'batch' : 'page';
  const placed = batches
    .filter((b) => b.status === 'parsed' && b.offsetKnown && b.listings > 0)
    .map((b) => ({ batch: b.batch, from: b.start + 1, to: b.start + b.listings }))
    .sort((a, b) => a.from - b.from || a.batch - b.batch);
  for (let i = 1; i < placed.length; i++) {
    const prev = placed[i - 1]!;
    const cur = placed[i]!;
    if (cur.from <= prev.to)
      notes.push(`${unit === 'page' ? 'Pages' : 'Batches'} ${prev.batch} and ${cur.batch} overlap (positions ${cur.from}–${Math.min(prev.to, cur.to)}).`);
    else if (cur.from > prev.to + 1)
      notes.push(`Positions ${prev.to + 1}–${cur.from - 1} were not captured (between ${unit} ${prev.batch} and ${unit} ${cur.batch}).`); // prettier-ignore
  }
  const local = batches.filter((b) => b.status === 'parsed' && !b.offsetKnown).map((b) => b.batch);
  if (local.length)
    notes.push(automatic ? `Batch${local.length === 1 ? '' : 'es'} ${local.join(', ')}: the source gave no overall position, so ${local.length === 1 ? 'its' : 'their'} positions are batch-local, not global.` : `Page${local.length === 1 ? '' : 's'} ${local.join(', ')} had no start= in the address, so ${local.length === 1 ? 'its' : 'their'} positions are page-local, not global.`); // prettier-ignore
  return notes;
}

/** The collection's progress, from the scan and its stored listings. */
export function googleCaptureProgress(
  scan: {
    id: string;
    query: string;
    captureTarget: number | null;
    captureState: string | null;
    captureReason: string | null;
    captureNextUrl: string | null;
    captureBatches: unknown;
    source: string;
    observationType: string | null;
    collectionBatchSize: number | null;
    collectionDelayMs: number | null;
    collectionCursor: string | null;
  },
  results: LocalResult[],
): GoogleCaptureProgressDto {
  const batches = captureBatchesDto(scan.captureBatches);
  const source = (LOCAL_RANK_SOURCES as readonly string[]).includes(scan.source)
    ? (scan.source as LocalRankSource)
    : 'GOOGLE_CAPTURE';
  const automatic = source !== 'GOOGLE_CAPTURE';
  const withoutIdentifier = results.filter((r) => captureIdentityKey(r) === null).length;
  const notes = [...pageRangeNotes(batches, automatic)];
  if (withoutIdentifier)
    notes.push(`${withoutIdentifier} listing${withoutIdentifier === 1 ? ' has' : 's have'} no identifier or address, so ${withoutIdentifier === 1 ? 'it cannot' : 'they cannot'} be checked for duplicates.`); // prettier-ignore
  return {
    scanId: scan.id,
    state: (GOOGLE_CAPTURE_STATES as readonly string[]).includes(scan.captureState ?? '')
      ? (scan.captureState as GoogleCaptureState)
      : 'IN_PROGRESS',
    target: scan.captureTarget ?? GOOGLE_CAPTURE_DEFAULT_TARGET,
    uniqueBusinesses: uniqueBusinessCount(results),
    listingsStored: results.length,
    listingsExtracted: batches.reduce((s, b) => s + b.listings, 0),
    duplicatesSkipped: batches.reduce((s, b) => s + b.duplicates, 0),
    pagesProcessed: batches.length,
    pagesFailed: batches.filter((b) => b.status === 'failed').length,
    pagesRepeated: batches.filter((b) => b.status === 'repeated').length,
    withoutIdentifier,
    nextUrl: isTerminal(scan.captureState) || automatic ? null : scan.captureNextUrl,
    reason: scan.captureReason,
    query: scan.query,
    notes,
    source,
    sourceLabel: LOCAL_RANK_SOURCE_LABELS[source],
    observationType: (LOCAL_OBSERVATION_TYPES as readonly string[]).includes(scan.observationType ?? '')
      ? (scan.observationType as LocalObservationType)
      : observationTypeForSource(source),
    automatic,
    batchSize: scan.collectionBatchSize,
    delayMs: scan.collectionDelayMs,
    hasMore: automatic ? Boolean(scan.collectionCursor) && !isTerminal(scan.captureState) : Boolean(scan.captureNextUrl), // prettier-ignore
  };
}

/** One batch for a collection, from a saved page or an automatic source; listings carry page-local positions. */
export interface BatchInput {
  status: 'parsed' | 'failed' | 'unavailable';
  /** Why the batch could not be read (failed / unavailable). */
  error: string | null;
  listings: CapturedListing[];
  /** The page's address (saved pages) or what the batch covered (automatic sources). */
  url: string | null;
  /** Whether the first listing's place in the overall order is known; start is that 0-based offset. */
  offsetKnown: boolean;
  start: number;
  /** Identity of this page / cursor, to recognise a repeated batch. */
  pageKey: string | null;
  notes: string[];
  capturedAt: Date;
  /** The next page's address to show (saved pages); null for automatic sources. */
  nextUrl: string | null;
  /** The source reports nothing after this batch (no next link / no cursor). */
  noMore: boolean;
  /** How the source said it has no more, when not by a missing next link or cursor (e.g. a Maps list's end). */
  noMoreReason?: string;
  /** The next link / cursor leads back to an earlier or the same position (a pagination loop). */
  pointsBackwards: boolean;
  /** Written with the batch in the same transaction (e.g. the next cursor of an automatic collection). */
  extraScanData?: Prisma.LocalRankScanUpdateInput;
  /** What a batch is called in messages. */
  unit: 'Page' | 'Batch';
}

/**
 * Applies one batch inside the scan lock: appends its new listings (in source order, first observed positions
 * kept), records duplicates on the listing already kept, stores the batch, and decides the collection state. A
 * collection that has ended takes no batch; a pause made meanwhile is kept unless the collection is now complete.
 */
export async function applyBatch(
  tx: Prisma.TransactionClient,
  scanId: string,
  input: BatchInput,
): Promise<{ batch: StoredBatch | null; state: GoogleCaptureState }> {
  const scan = await tx.localRankScan.findUniqueOrThrow({ where: { id: scanId } });
  const current = (scan.captureState as GoogleCaptureState | null) ?? 'IN_PROGRESS';
  if (isTerminal(current)) return { batch: null, state: current };
  const point = await tx.localRankPoint.findUniqueOrThrow({
    where: { scanId_row_col: { scanId, row: 0, col: 0 } },
  });
  const batches = storedBatches(scan.captureBatches);
  let results = storedResults(point.results);
  const target = scan.captureTarget ?? GOOGLE_CAPTURE_DEFAULT_TARGET;
  const batchNo = batches.length + 1;
  const capturedAt = input.capturedAt.toISOString();
  const { unit } = input;
  const units = unit === 'Page' ? 'pages' : 'batches';

  if (input.status !== 'parsed') {
    const batch: StoredBatch = {
      batch: batchNo,
      url: input.url,
      start: input.start,
      offsetKnown: false,
      status: input.status,
      listings: 0,
      newListings: 0,
      duplicates: 0,
      sponsored: 0,
      nextUrl: null,
      capturedAt,
      error: input.error,
      notes: [],
      urlKey: null,
      contentKey: null,
    };
    // A batch that could not be read does not end the collection.
    await tx.localRankScan.update({
      where: { id: scanId },
      data: {
        captureBatches: [...batches, batch] as unknown as Prisma.InputJsonValue,
        captureReason: `${unit} ${batchNo} was not read: ${input.error}`.slice(0, 2000),
        ...input.extraScanData,
      },
    });
    return { batch, state: current };
  }

  const { listings, offsetKnown, start } = input;
  const contentKey = createHash('sha1')
    .update(listings.map((l) => rowKeyOf(l) ?? `x:${normalizeBusinessName(l.title)}`).join('\n'))
    .digest('hex')
    .slice(0, 20);
  const earlier = batches.filter((b) => b.status === 'parsed' || b.status === 'repeated');
  const repeated =
    listings.length > 0 &&
    ((input.pageKey !== null && earlier.some((b) => b.urlKey === input.pageKey)) ||
      earlier.some((b) => b.contentKey === contentKey));

  let newListings = 0;
  let duplicates = 0;
  if (repeated) duplicates = listings.length;
  else {
    const rowIndex = new Map<string, number>();
    results.forEach((r, i) => {
      const key = rowKeyOf(r);
      if (key && !rowIndex.has(key)) rowIndex.set(key, i);
    });
    results = results.map((r) => ({ ...r }));
    const fresh: ProviderLocalResult[] = [];
    for (const l of listings) {
      const cumulativePosition = offsetKnown ? start + l.position : null;
      const key = rowKeyOf(l);
      const at = key ? rowIndex.get(key) : undefined;
      if (at !== undefined) {
        // Already collected: keep the original observation (its first position), record this sighting on it.
        duplicates += 1;
        const kept = results[at]!;
        kept.alsoSeen = [
          ...(kept.alsoSeen ?? []),
          { batch: batchNo, sourcePosition: l.position, cumulativePosition },
        ];
        continue;
      }
      if (key) rowIndex.set(key, results.length + fresh.length);
      fresh.push({
        // Global position when the batch's offset is known; otherwise the batch-local position (no
        // cumulativePosition marks it, so it is never shown as a global rank).
        rank: cumulativePosition ?? l.position,
        title: l.title,
        placeId: l.placeId,
        cid: l.cid,
        domain: l.domain,
        url: l.website,
        mapsUrl: l.mapsUrl,
        entityId: l.entityId,
        category: l.category,
        rating: l.rating,
        reviewCount: l.reviewCount,
        address: l.address,
        phone: null,
        latitude: l.latitude,
        longitude: l.longitude,
        sponsored: l.sponsored,
        batch: batchNo,
        sourcePosition: l.position,
        cumulativePosition,
        hours: l.hours,
        serviceOptions: l.serviceOptions,
        phoneShown: l.phoneShown,
        reviewSnippet: l.reviewSnippet,
        websiteListed: l.websiteListed,
      });
    }
    const matchTarget = await matchTargetFor(tx, scan.queryId);
    results = [...results, ...storeResults(fresh, matchTarget, Number.MAX_SAFE_INTEGER).stored];
    newListings = fresh.length;
  }

  const batch: StoredBatch = {
    batch: batchNo,
    url: input.url,
    start,
    offsetKnown,
    status: repeated ? 'repeated' : 'parsed',
    listings: listings.length,
    newListings,
    duplicates,
    sponsored: listings.filter((l) => l.sponsored).length,
    nextUrl: input.nextUrl,
    capturedAt,
    error: repeated
      ? `This ${unit.toLowerCase()} was already collected (same position or the same listings); nothing was added.`
      : null,
    notes: input.notes,
    urlKey: input.pageKey,
    contentKey,
  };
  const allBatches = [...batches, batch];

  // Decide the collection state from what the source actually returned.
  const unique = uniqueBusinessCount(results);
  let trailingNoNew = 0;
  for (let i = allBatches.length - 1; i >= 0; i--) {
    const b = allBatches[i]!;
    if (b.status === 'failed' || b.status === 'unavailable') continue;
    if (b.status === 'repeated' || b.newListings === 0) trailingNoNew += 1;
    else break;
  }
  let decided: GoogleCaptureState | null = null;
  let reason: string | null = null;
  if (unique >= target) {
    decided = 'TARGET_REACHED';
    reason = `Collected ${unique} unique businesses, reaching the target of ${target}.`;
  } else if (input.pointsBackwards) {
    decided = 'SOURCE_EXHAUSTED';
    reason = unit === 'Page' ? `Page ${batchNo}'s next link leads back to results already captured: Google is repeating its results. Collected ${unique} unique businesses.` : `Batch ${batchNo}'s cursor leads back to results already collected: the source is repeating its results. Collected ${unique} unique businesses.`; // prettier-ignore
  } else if (input.noMore && !repeated) {
    decided = 'SOURCE_EXHAUSTED';
    reason = input.noMoreReason ? `${input.noMoreReason} Collected ${unique} unique businesses.` : unit === 'Page' ? `Page ${batchNo}${offsetKnown ? ` (results from #${start + 1})` : ''} has no next-page link: Google shows no further results for this search. Collected ${unique} unique businesses.` : `Batch ${batchNo}${offsetKnown ? ` (results from #${start + 1})` : ''} came with no further cursor: the source has no more results for this search. Collected ${unique} unique businesses.`; // prettier-ignore
  } else if (trailingNoNew >= MAX_PAGES_WITHOUT_NEW) {
    decided = 'SOURCE_EXHAUSTED';
    reason = `The last ${trailingNoNew} ${units} added no new businesses: the results are repeating. Collected ${unique} unique businesses.`;
  } else if (repeated) reason = batch.error;
  // A pause made while this batch was being collected stays in force unless the collection is now complete.
  const state: GoogleCaptureState = decided ?? (current === 'PAUSED' ? 'PAUSED' : 'IN_PROGRESS');
  // Saved pages: the next page to open is this page's link if not captured yet, else the furthest uncaptured one.
  const capturedKeys = new Set(allBatches.map((b) => b.urlKey).filter(Boolean));
  const frontier = [...allBatches]
    .reverse()
    .map((b) => b.nextUrl)
    .find((u) => {
      if (!u) return false;
      const p = parseGoogleSearchUrl(u);
      return p.ok && !capturedKeys.has(pageKey(p.info));
    });

  const rank = results.find((r) => r.isTarget)?.rank ?? null;
  await tx.localRankPoint.update({
    where: { id: point.id },
    data: {
      status: results.length ? (rank === null ? 'NOT_FOUND' : 'FOUND') : 'PENDING',
      rank,
      results: results as unknown as Prisma.InputJsonValue,
      error: null,
      attempts: { increment: 1 },
      checkedAt: input.capturedAt,
    },
  });
  await tx.localRankScan.update({
    where: { id: scanId },
    data: {
      captureBatches: allBatches as unknown as Prisma.InputJsonValue,
      captureState: state,
      // A pause keeps its own explanation unless this batch ended the collection or has its own news.
      captureReason: reason ?? (state === 'PAUSED' ? scan.captureReason : null),
      captureNextUrl: isTerminal(state) ? null : (frontier ?? null),
      ...input.extraScanData,
    },
  });
  return { batch, state };
}

/** A saved page as a batch: Google's start= offset, its next link, and the page-specific stop rules. */
async function applyPage(
  tx: Prisma.TransactionClient,
  scanId: string,
  page: PreparedPage,
  isLastInRequest: boolean,
): Promise<{ batch: StoredBatch | null; state: GoogleCaptureState }> {
  const scan = await tx.localRankScan.findUniqueOrThrow({ where: { id: scanId } });
  const batchNo = storedBatches(scan.captureBatches).length + 1;
  const base = {
    url: page.url,
    capturedAt: page.capturedAt,
    unit: 'Page' as const,
    nextUrl: null,
    noMore: false,
    pointsBackwards: false,
    pageKey: null,
    notes: [],
  };
  if (page.result.status !== 'parsed')
    return applyBatch(tx, scanId, {
      ...base,
      status: page.result.status,
      error: page.result.reason,
      listings: [],
      offsetKnown: false,
      start: page.info?.start ?? 0,
    });
  const { listings, continuation } = page.result;
  const surface: GoogleSearchSurface | null =
    continuation.listEnd !== undefined
      ? 'maps'
      : (page.info?.surface ??
        (continuation.nextPageUrl && /[?&](udm=local|tbm=lcl)\b/.test(continuation.nextPageUrl)
          ? 'places'
          : null));
  // The page's place in the overall order: Google's start= offset; the first page of a collection is offset 0. A
  // Maps list always runs from its first result.
  const offsetKnown = surface === 'maps' || (page.info ? page.info.hasStart || batchNo === 1 : batchNo === 1);
  const start = offsetKnown && surface !== 'maps' ? (page.info?.start ?? 0) : 0;
  // The continuation this page offers (from the page itself): the next Places page, or "More places".
  const nextInfo = (() => {
    const candidate =
      surface === 'search'
        ? continuation.morePlacesUrl
        : surface === 'places'
          ? continuation.nextPageUrl
          : null;
    if (!candidate) return null;
    const parsed = parseGoogleSearchUrl(candidate);
    if (!parsed.ok || normQuery(parsed.info.query) !== normQuery(scan.query)) return null;
    return parsed.info;
  })();
  return applyBatch(tx, scanId, {
    ...base,
    status: 'parsed',
    error: null,
    listings,
    offsetKnown,
    start,
    // A Maps list saved again further down repeats its start but adds the rest: it is recognised by its content.
    pageKey: offsetKnown && page.info && surface !== 'maps' ? pageKey({ ...page.info, start }) : null,
    notes: [...page.result.notes],
    nextUrl: nextInfo?.url ?? null,
    // Only a Places page's missing next link means Google has no more (the main page's "Next" is web results);
    // judged on the last page of an upload, since the user may already have the following pages. A Maps list ends
    // when it was saved at its end.
    noMore:
      surface === 'maps'
        ? continuation.listEnd === true
        : surface === 'places' && !nextInfo && isLastInRequest,
    ...(surface === 'maps'
      ? { noMoreReason: 'The Google Maps list was saved to its end: Google Maps shows no further results for this search and map area.' } // prettier-ignore
      : {}),
    pointsBackwards:
      nextInfo !== null &&
      offsetKnown &&
      surface === 'places' &&
      nextInfo.surface === 'places' &&
      nextInfo.start <= start,
  });
}

/** Ends a collection: summarises the scan, updates competitors, and records what the collection can and cannot show. */
/** Ends a collection (saved pages or an automatic source): summary, competitors, and what it can and cannot show. */
export async function finalizeCapture(prisma: PrismaClient, scanId: string): Promise<void> {
  const scan = await prisma.localRankScan.findUniqueOrThrow({ where: { id: scanId } });
  const point = await prisma.localRankPoint.findUniqueOrThrow({ where: { scanId_row_col: { scanId, row: 0, col: 0 } } }); // prettier-ignore
  const results = storedResults(point.results);
  const maxRank = results.reduce((m, r) => Math.max(m, r.rank), 0);
  await prisma.localRankScan.update({
    where: { id: scanId },
    data: { depth: Math.max(scan.depth, maxRank, 1) },
  });
  if (!results.length)
    await prisma.localRankPoint.update({
      where: { id: point.id },
      data: {
        status: 'FAILED',
        error: (scan.captureReason ?? 'No listings could be collected.').slice(0, 500),
      },
    });
  // Stopped early by the user reads as partial; reaching the target or the end of the source is a complete result.
  const stoppedEarly = scan.captureState === 'PARTIAL' || scan.captureState === 'CANCELLED';
  await finishScan(prisma, scanId, { stopped: stoppedEarly ? scan.captureReason : null });
  const finished = await prisma.localRankScan.findUniqueOrThrow({ where: { id: scanId } });
  const batches = captureBatchesDto(finished.captureBatches);
  if (finished.source !== 'GOOGLE_CAPTURE') {
    // An automatic collection: which source, how its batches covered the results, and why it ended.
    const label = LOCAL_RANK_SOURCE_LABELS[finished.source as LocalRankSource] ?? finished.source;
    const seconds = Math.round((finished.collectionDelayMs ?? 0) / 100) / 10;
    const autoNotes = [
      ...pageRangeNotes(batches, true),
      ...(finished.captureReason ? [finished.captureReason] : []),
      `Collected automatically from ${label} in ${batches.length} batch${batches.length === 1 ? '' : 'es'} of up to ${finished.collectionBatchSize ?? 20}, at least ${seconds}s apart, in the order the source returned them.`,
    ];
    const prior = Array.isArray(finished.limitations) ? (finished.limitations as string[]) : [];
    await prisma.localRankScan.update({
      where: { id: scanId },
      data: { limitations: [...prior, ...autoNotes] as unknown as Prisma.InputJsonValue },
    });
    return;
  }
  const savedAt = batches.find((b) => b.status === 'parsed')?.capturedAt ?? null;
  const notes = [
    ...pageRangeNotes(batches),
    ...batches.flatMap((b) => b.notes.map((n) => `Page ${b.batch}: ${n}`)),
    ...(finished.captureReason ? [finished.captureReason] : []),
    `Collected across ${batches.length} saved page${batches.length === 1 ? '' : 's'} (first saved ${savedAt ?? 'unknown'}), on your device and account; another person, place or time can see a different order.`, // prettier-ignore
    'Stored at the tracked location’s centre; Google ranked the pages for wherever and however they were viewed.',
  ];
  const base = Array.isArray(finished.limitations) ? (finished.limitations as string[]) : [];
  await prisma.localRankScan.update({
    where: { id: scanId },
    data: { limitations: [...base, ...notes] as unknown as Prisma.InputJsonValue },
  });
}

/** Applies prepared pages one at a time (each committed before the next), then ends the collection if it is done. */
async function appendPrepared(
  prisma: PrismaClient,
  scanId: string,
  prepared: PreparedPage[],
): Promise<{ batches: GoogleCaptureBatchDto[]; skipped: number; state: GoogleCaptureState }> {
  const out: GoogleCaptureBatchDto[] = [];
  let state: GoogleCaptureState = 'IN_PROGRESS';
  let skipped = 0;
  for (const [i, page] of prepared.entries()) {
    if (isTerminal(state)) {
      skipped = prepared.length - i;
      break;
    }
    const applied = await withScanLock(prisma, scanId, (tx) => applyPage(tx, scanId, page, i === prepared.length - 1)); // prettier-ignore
    state = applied.state;
    if (!applied.batch) continue; // the collection had already ended
    const { urlKey: _u, contentKey: _c, ...dto } = applied.batch;
    out.push(dto);
  }
  if (isTerminal(state)) await finalizeCapture(prisma, scanId);
  return { batches: out, skipped, state };
}

async function captureResult(
  prisma: PrismaClient,
  scanId: string,
  run: { batches: GoogleCaptureBatchDto[]; skipped: number },
  prepared: PreparedPage[],
): Promise<GoogleCaptureResultDto> {
  const scan = await prisma.localRankScan.findUniqueOrThrow({ where: { id: scanId } });
  const point = await prisma.localRankPoint.findUnique({
    where: { scanId_row_col: { scanId, row: 0, col: 0 } },
  });
  const parsed = run.batches.filter((b) => b.status === 'parsed').length;
  const collectionStatus: CollectionStatus =
    parsed === run.batches.length && run.batches.length > 0
      ? 'successful'
      : parsed === 0
        ? run.batches.some((b) => b.status === 'failed')
          ? 'failed'
          : 'unavailable'
        : 'partial';
  const first = prepared.find((p) => p.info)?.info ?? null;
  const limitations = [
    ...run.batches.flatMap((b) => b.notes.map((n) => `Page ${b.batch}: ${n}`)),
    ...(run.skipped ? [`${run.skipped} page${run.skipped === 1 ? ' was' : 's were'} not read: the collection had already ended (${scan.captureState}).`] : []), // prettier-ignore
  ];
  return {
    scanId,
    collectionStatus,
    query: scan.query,
    surface: first?.surface ?? 'places',
    location: first?.location ?? null,
    listings: run.batches.reduce((s, b) => s + b.listings, 0),
    batches: run.batches,
    limitations,
    progress: googleCaptureProgress(scan, storedResults(point?.results)),
  };
}

export interface StartGoogleCaptureArgs {
  projectId: string;
  queryId: string;
  userId: string;
  pages: GoogleCapturePageInput[];
  /** Unique businesses to collect (default 1000). */
  target?: number;
}

/**
 * Starts a collection from the first saved page(s). When no page shows any local listing, nothing is stored
 * (unavailable). When every page failed to read, a FAILED collection is kept for the record.
 */
export async function startGoogleCapture(
  prisma: PrismaClient,
  args: StartGoogleCaptureArgs,
): Promise<GoogleCaptureResultDto> {
  if (!args.pages.length || args.pages.length > GOOGLE_CAPTURE_MAX_PAGES)
    throw Errors.badRequest(`Add between 1 and ${GOOGLE_CAPTURE_MAX_PAGES} saved pages.`);
  const query = await prisma.localRankQuery.findFirst({
    where: { id: args.queryId, projectId: args.projectId },
  });
  if (!query) throw Errors.notFound('Tracked query');
  const prepared = preparePages(args.pages, null);
  if (new Set(prepared.map((p) => p.info && normQuery(p.info.query)).filter(Boolean)).size > 1)
    throw Errors.badRequest('All pages must come from the same search (the q= in each address differs).');
  const first = prepared.find((p) => p.info)?.info ?? null;
  const searchQuery = first?.query ?? prepared.find((p) => p.pageQuery)?.pageQuery ?? query.query;

  if (prepared.every((p) => p.result.status === 'unavailable'))
    return {
      scanId: null,
      collectionStatus: 'unavailable',
      query: searchQuery,
      surface: first?.surface ?? 'places',
      location: first?.location ?? null,
      listings: 0,
      batches: prepared.map((p, i) => ({
        batch: i + 1,
        url: p.url,
        start: p.info?.start ?? 0,
        offsetKnown: false,
        status: 'unavailable' as const,
        listings: 0,
        newListings: 0,
        duplicates: 0,
        sponsored: 0,
        nextUrl: null,
        capturedAt: p.capturedAt.toISOString(),
        error: p.result.status === 'unavailable' ? p.result.reason : null,
        notes: [],
      })),
      limitations: [],
      progress: null,
    };

  const scan = await prisma.localRankScan.create({
    data: {
      projectId: args.projectId,
      queryId: query.id,
      source: 'GOOGLE_CAPTURE',
      trigger: 'MANUAL',
      status: 'RUNNING',
      observationType: 'observed_search_position',
      query: searchQuery,
      surface: query.surface,
      language: first?.language ?? query.language,
      device: query.device,
      gridSize: 1,
      spacingKm: query.spacingKm,
      depth: query.depth,
      centerLatitude: query.centerLatitude,
      centerLongitude: query.centerLongitude,
      pointsPlanned: 1,
      createdById: args.userId,
      startedAt: new Date(),
      captureBatches: [],
      captureTarget: args.target ?? GOOGLE_CAPTURE_DEFAULT_TARGET,
      captureState: 'IN_PROGRESS',
    },
  });
  await prisma.localRankPoint.create({
    data: {
      scanId: scan.id,
      row: 0,
      col: 0,
      latitude: query.centerLatitude,
      longitude: query.centerLongitude,
    },
  });
  if (normQuery(searchQuery) !== normQuery(query.query))
    await prisma.localRankScan.update({
      where: { id: scan.id },
      data: { captureReason: `The saved search is “${searchQuery}”, while this tracked query is “${query.query}”; it is stored as the search you saved.` }, // prettier-ignore
    });
  const run = await appendPrepared(prisma, scan.id, prepared);
  // Nothing could be read from any first page: keep a FAILED collection, with the reason, for the record.
  const point = await prisma.localRankPoint.findUniqueOrThrow({ where: { scanId_row_col: { scanId: scan.id, row: 0, col: 0 } } }); // prettier-ignore
  if (!storedResults(point.results).length && !isTerminal(run.state)) {
    const reasons = run.batches.map((b) => b.error).filter(Boolean);
    await prisma.localRankScan.update({
      where: { id: scan.id },
      data: { captureState: 'FAILED', captureReason: (reasons[0] ?? 'No listings could be collected.').slice(0, 2000), captureNextUrl: null }, // prettier-ignore
    });
    await finalizeCapture(prisma, scan.id);
  }
  return captureResult(prisma, scan.id, run, prepared);
}

/** Adds the next saved page(s) to an unfinished collection (resuming it). */
export async function appendGoogleCapturePages(
  prisma: PrismaClient,
  args: { projectId: string; scanId: string; pages: GoogleCapturePageInput[] },
): Promise<GoogleCaptureResultDto> {
  if (!args.pages.length || args.pages.length > GOOGLE_CAPTURE_MAX_PAGES)
    throw Errors.badRequest(`Add between 1 and ${GOOGLE_CAPTURE_MAX_PAGES} saved pages.`);
  const scan = await prisma.localRankScan.findFirst({
    where: { id: args.scanId, projectId: args.projectId },
  });
  if (!scan) throw Errors.notFound('Scan');
  if (scan.source !== 'GOOGLE_CAPTURE' || !scan.captureState)
    throw Errors.badRequest('Pages can be added only to a Google page collection.');
  if (isTerminal(scan.captureState))
    throw Errors.conflict(
      `This collection has ended (${scan.captureState}). Start a new capture to collect again.`,
    );
  const prepared = preparePages(args.pages, scan.query);
  const run = await appendPrepared(prisma, scan.id, prepared);
  return captureResult(prisma, scan.id, run, prepared);
}

/** Stops a collection before its target or the end of the results (PARTIAL), or FAILED when nothing was collected. */
export async function finishGoogleCapture(
  prisma: PrismaClient,
  args: { projectId: string; scanId: string },
): Promise<GoogleCaptureProgressDto> {
  const scan = await prisma.localRankScan.findFirst({
    where: { id: args.scanId, projectId: args.projectId },
  });
  if (!scan) throw Errors.notFound('Scan');
  if (scan.source !== 'GOOGLE_CAPTURE' || !scan.captureState)
    throw Errors.badRequest('Only a Google page collection can be finished here.');
  const point = await prisma.localRankPoint.findUniqueOrThrow({ where: { scanId_row_col: { scanId: scan.id, row: 0, col: 0 } } }); // prettier-ignore
  if (!isTerminal(scan.captureState)) {
    const results = storedResults(point.results);
    const unique = uniqueBusinessCount(results);
    const target = scan.captureTarget ?? GOOGLE_CAPTURE_DEFAULT_TARGET;
    const pages = storedBatches(scan.captureBatches).length;
    await prisma.localRankScan.update({
      where: { id: scan.id },
      data: unique
        ? { captureState: 'PARTIAL', captureReason: `Stopped by you after ${pages} page${pages === 1 ? '' : 's'}, with ${unique} unique businesses of the target ${target}.`, captureNextUrl: null } // prettier-ignore
        : {
            captureState: 'FAILED',
            captureReason: 'Stopped before any listing was collected.',
            captureNextUrl: null,
          },
    });
    await finalizeCapture(prisma, scan.id);
  }
  const updated = await prisma.localRankScan.findUniqueOrThrow({ where: { id: scan.id } });
  const latest = await prisma.localRankPoint.findUniqueOrThrow({ where: { id: point.id } });
  return googleCaptureProgress(updated, storedResults(latest.results));
}
