// Safe single-page checks used to verify that something is live: links and mentions on third-party pages, content
// published through a CMS, website changes and product landing pages. Every request goes through the SSRF-safe
// fetcher and obeys robots.txt for Surfaced's user agent on every hop. A page that robots.txt blocks is reported
// as BLOCKED_BY_ROBOTS and is never fetched another way: those cases need a person to confirm them.
import * as cheerio from 'cheerio';
import { SafeFetcher, type FetchResult } from '../crawler/fetcher';
import { fetchRobots, type RobotsInfo } from '../crawler/robots';
import { normalizeCrawlUrl } from '../crawler/url-utils';

export type PageCheckStatus =
  'OK' | 'HTTP_ERROR' | 'BLOCKED_BY_ROBOTS' | 'UNSAFE_URL' | 'FETCH_FAILED' | 'NOT_HTML';

export type LinkMatch = 'EXACT' | 'DOMAIN';

export interface PageLink {
  href: string;
  text: string;
  /** Lower-cased rel tokens, e.g. ["nofollow", "sponsored"]. */
  rel: string[];
  match: LinkMatch;
}

export interface HreflangAlternate {
  hreflang: string;
  href: string;
  source: 'html' | 'header';
}

export interface PageCheckResult {
  url: string;
  checkedAt: string;
  status: PageCheckStatus;
  httpStatus: number | null;
  finalUrl: string | null;
  redirects: number;
  error: string | null;
  title: string | null;
  metaDescription: string | null;
  h1: string | null;
  canonicalUrl: string | null;
  lang: string | null;
  /** noindex in meta robots or X-Robots-Tag. */
  robotsNoindex: boolean;
  /** Links pointing at one of `linkTargets`. */
  links: PageLink[];
  /** Whether each needle occurs in the visible text (case-insensitive, whitespace-normalized). */
  textMatches: Record<string, boolean>;
  /** Parsed JSON-LD nodes (flattened @graph), capped. */
  jsonLd: Record<string, unknown>[];
  jsonLdErrors: string[];
  hreflang: HreflangAlternate[];
  wordCount: number;
}

export interface PageCheckOptions {
  fetcher?: SafeFetcher;
  signal?: AbortSignal;
  /** Domains ("example.com", subdomains included) or absolute URLs whose links are reported. */
  linkTargets?: string[];
  textNeedles?: string[];
  /** Reused across checks in one job so robots.txt is fetched once per origin. */
  robotsCache?: Map<string, RobotsInfo>;
}

const MAX_JSON_LD_NODES = 100;
const MAX_LINKS = 200;

const TRACKING_PARAM = /^(utm_[a-z]+|gclid|fbclid|msclkid|mc_cid|mc_eid|srsltid)$/i;

/** URL form used to compare links: lower-case host, no fragment, no tracking parameters, no trailing slash. */
export function comparableUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    url.hash = '';
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
    for (const key of [...url.searchParams.keys()])
      if (TRACKING_PARAM.test(key)) url.searchParams.delete(key);
    url.searchParams.sort();
    const text = url.toString();
    return text.endsWith('/') && url.pathname !== '/' ? text.slice(0, -1) : text.replace(/\/$/, '');
  } catch {
    return null;
  }
}

function hostOf(raw: string): string | null {
  try {
    return new URL(raw).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

/** Matches a link against a target: an absolute URL (exact page) or a bare domain (any page on it). */
export function matchLinkTarget(href: string, target: string): LinkMatch | null {
  const linkHost = hostOf(href);
  if (!linkHost) return null;
  if (/^https?:\/\//i.test(target)) {
    const a = comparableUrl(href);
    const b = comparableUrl(target);
    if (a && b && a === b) return 'EXACT';
    const targetHost = hostOf(target);
    return targetHost && (linkHost === targetHost || linkHost.endsWith(`.${targetHost}`)) ? 'DOMAIN' : null;
  }
  const domain = target.toLowerCase().replace(/^www\./, '');
  return linkHost === domain || linkHost.endsWith(`.${domain}`) ? 'DOMAIN' : null;
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

function flattenJsonLd(data: unknown, out: Record<string, unknown>[]): void {
  if (out.length >= MAX_JSON_LD_NODES || data === null || typeof data !== 'object') return;
  if (Array.isArray(data)) {
    for (const item of data) flattenJsonLd(item, out);
    return;
  }
  const node = data as Record<string, unknown>;
  if (Array.isArray(node['@graph'])) {
    for (const item of node['@graph'] as unknown[]) flattenJsonLd(item, out);
    return;
  }
  if (node['@type'] !== undefined) out.push(node);
}

/** Parses `Link` response headers for rel="alternate" hreflang entries. */
export function parseHreflangHeader(header: string | undefined, baseUrl: string): HreflangAlternate[] {
  if (!header) return [];
  const result: HreflangAlternate[] = [];
  for (const part of header.split(/,(?=\s*<)/)) {
    const target = /<([^>]+)>/.exec(part)?.[1];
    if (!target || !/rel\s*=\s*"?alternate"?/i.test(part)) continue;
    const lang = /hreflang\s*=\s*"?([^";\s]+)"?/i.exec(part)?.[1];
    if (!lang) continue;
    const href = normalizeCrawlUrl(target, baseUrl);
    if (href) result.push({ hreflang: lang, href, source: 'header' });
  }
  return result;
}

function emptyResult(url: string, status: PageCheckStatus, error: string | null, fetched?: FetchResult) {
  return {
    url,
    checkedAt: new Date().toISOString(),
    status,
    httpStatus: fetched?.statusCode ?? null,
    finalUrl: fetched?.finalUrl ?? null,
    redirects: fetched?.redirectChain.length ?? 0,
    error,
    title: null,
    metaDescription: null,
    h1: null,
    canonicalUrl: null,
    lang: null,
    robotsNoindex: false,
    links: [],
    textMatches: {},
    jsonLd: [],
    jsonLdErrors: [],
    hreflang: [],
    wordCount: 0,
  } satisfies PageCheckResult;
}

/** Extracts the verification signals from an HTML document. Exported for tests and for already-fetched pages. */
export function analyzeHtml(
  html: string,
  pageUrl: string,
  options: { linkTargets?: string[]; textNeedles?: string[]; linkHeader?: string; xRobotsTag?: string } = {},
): Omit<PageCheckResult, 'url' | 'checkedAt' | 'status' | 'httpStatus' | 'finalUrl' | 'redirects' | 'error'> {
  const $ = cheerio.load(html);
  // A line break separates words ("Elegant<br>Digital" reads as two words, not "ElegantDigital").
  $('br').replaceWith(' ');
  const baseHref = $('base[href]').first().attr('href');
  const base = (baseHref && normalizeCrawlUrl(baseHref, pageUrl)) || pageUrl;
  const clean = (value: string | undefined | null) => (value ?? '').replace(/\s+/g, ' ').trim();

  const links: PageLink[] = [];
  const targets = options.linkTargets ?? [];
  if (targets.length) {
    $('a[href]').each((_i, el) => {
      if (links.length >= MAX_LINKS) return false;
      const href = normalizeCrawlUrl(($(el).attr('href') ?? '').trim(), base);
      if (!href) return undefined;
      let match: LinkMatch | null = null;
      for (const target of targets) {
        const result = matchLinkTarget(href, target);
        if (result === 'EXACT') {
          match = 'EXACT';
          break;
        }
        if (result === 'DOMAIN') match = 'DOMAIN';
      }
      if (!match) return undefined;
      const rel = clean($(el).attr('rel')).toLowerCase().split(' ').filter(Boolean);
      const text = clean($(el).text()) || clean($(el).find('img[alt]').first().attr('alt'));
      links.push({ href, text: text.slice(0, 255), rel, match });
      return undefined;
    });
  }

  const jsonLd: Record<string, unknown>[] = [];
  const jsonLdErrors: string[] = [];
  $('script[type="application/ld+json" i]').each((index, el) => {
    try {
      flattenJsonLd(JSON.parse($(el).text().trim()), jsonLd);
    } catch (error) {
      jsonLdErrors.push(
        `Block ${index + 1}: ${error instanceof Error ? error.message.slice(0, 160) : 'invalid JSON'}`,
      );
    }
  });

  const hreflang: HreflangAlternate[] = [];
  $('link[rel~="alternate" i][hreflang]').each((_i, el) => {
    const href = normalizeCrawlUrl($(el).attr('href') ?? '', base);
    const lang = clean($(el).attr('hreflang'));
    if (href && lang) hreflang.push({ hreflang: lang, href, source: 'html' });
  });
  hreflang.push(...parseHreflangHeader(options.linkHeader, pageUrl));

  const metaRobots = clean($('meta[name="robots" i]').first().attr('content')).toLowerCase();
  const canonicalHref = $('link[rel~="canonical" i]').first().attr('href');
  const title = clean($('head title, title').first().text()) || null;
  const metaDescription = clean($('meta[name="description" i]').first().attr('content')) || null;
  const h1 = clean($('h1').first().text()) || null;
  const lang = clean($('html').attr('lang')) || null;

  $('script, style, noscript, template, svg').remove();
  const text = normalizeText($('body').text() || $.root().text());
  const textMatches: Record<string, boolean> = {};
  for (const needle of options.textNeedles ?? []) {
    const wanted = normalizeText(needle);
    if (wanted) textMatches[needle] = text.includes(wanted);
  }

  return {
    title,
    metaDescription,
    h1,
    canonicalUrl: canonicalHref ? normalizeCrawlUrl(canonicalHref, base) : null,
    lang,
    robotsNoindex: /\bnoindex\b/.test(metaRobots) || /\bnoindex\b/i.test(options.xRobotsTag ?? ''),
    links,
    textMatches,
    jsonLd,
    jsonLdErrors,
    hreflang,
    wordCount: text ? text.split(' ').length : 0,
  };
}

/** Fetches one page safely and returns what is live on it. Never throws for network or policy failures. */
export async function checkPage(url: string, options: PageCheckOptions = {}): Promise<PageCheckResult> {
  let parsed: URL;
  try {
    parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('protocol');
  } catch {
    return emptyResult(url, 'UNSAFE_URL', 'Enter a full http(s) URL.');
  }
  const fetcher = options.fetcher ?? new SafeFetcher();
  const robotsCache = options.robotsCache ?? new Map<string, RobotsInfo>();
  const robotsFor = async (target: URL) => {
    let robots = robotsCache.get(target.origin);
    if (!robots) {
      robots = await fetchRobots(fetcher, target.origin, options.signal);
      robotsCache.set(target.origin, robots);
    }
    return robots;
  };
  try {
    const fetched = await fetcher.fetch(parsed.toString(), {
      signal: options.signal,
      beforeRequest: async (hop) => (await robotsFor(hop)).isAllowed(hop.toString()),
    });
    if (fetched.error) {
      if (fetched.error.code === 'DISALLOWED')
        return emptyResult(
          url,
          'BLOCKED_BY_ROBOTS',
          "The site's robots.txt does not allow automated checks of this page. Confirm it manually.",
          fetched,
        );
      if (fetched.error.code === 'BLOCKED')
        return emptyResult(url, 'UNSAFE_URL', 'This address is not a public website.', fetched);
      return emptyResult(url, 'FETCH_FAILED', fetched.error.message, fetched);
    }
    if (fetched.statusCode === null || fetched.statusCode >= 400)
      return emptyResult(url, 'HTTP_ERROR', `The page returned HTTP ${fetched.statusCode}.`, fetched);
    if (!/html|xml/i.test(fetched.contentType ?? 'text/html'))
      return emptyResult(
        url,
        'NOT_HTML',
        `The URL returned ${fetched.contentType}, not a web page.`,
        fetched,
      );
    const html = fetched.body?.toString('utf8') ?? '';
    return {
      url,
      checkedAt: new Date().toISOString(),
      status: 'OK',
      httpStatus: fetched.statusCode,
      finalUrl: fetched.finalUrl,
      redirects: fetched.redirectChain.length,
      error: fetched.bodyTruncated
        ? 'The page was larger than the size limit; only the first part was checked.'
        : null,
      ...analyzeHtml(html, fetched.finalUrl, {
        linkTargets: options.linkTargets,
        textNeedles: options.textNeedles,
        linkHeader: fetched.headers.link,
        xRobotsTag: fetched.headers['x-robots-tag'],
      }),
    };
  } finally {
    if (!options.fetcher) await fetcher.close();
  }
}
