// Breadth-first, polite website crawler. Pages discovered through links are crawled first (so
// click depth is meaningful); URLs found only in sitemaps are crawled afterwards with depth -1,
// which lets the audit identify orphan pages.
import type { PageSource } from '@surfaced/shared';
import { assertUrlPolicy } from './ssrf';
import { SafeFetcher, type FetchErrorCode, type RedirectHop, type SafeFetcherOptions } from './fetcher';
import { extractPage, type ExtractedLink, type PageExtract } from './extract';
import { fetchRobots, type RobotsInfo } from './robots';
import { discoverSitemaps, type SitemapDiscovery } from './sitemap';
import { simhash } from './simhash';
import { isHtmlContentType, isInScope, looksLikeHtmlUrl, normalizeCrawlUrl, urlHash } from './url-utils';

export interface CrawlOptions {
  startUrl: string;
  /** null crawls every page reachable through links and sitemaps. */
  maxPages: number | null;
  /** null follows links at any click depth. */
  maxDepth: number | null;
  includeSubdomains: boolean;
  /** Minimum delay between requests to the same host (robots Crawl-delay may raise it, capped). */
  crawlDelayMs: number;
  concurrency: number;
  fetcher?: SafeFetcher;
  fetcherOptions?: SafeFetcherOptions;
  maxSitemapUrls?: number;
  /**
   * Loop protection: at most this many query-string variants of one path are followed (calendars, filters and
   * session ids can otherwise generate endless URLs). Pages without a query string are never limited.
   */
  maxQueryVariantsPerPath?: number;
}

export interface CrawledPageRecord {
  url: string;
  urlHash: string;
  finalUrl: string | null;
  depth: number;
  source: PageSource;
  statusCode: number | null;
  contentType: string | null;
  responseTimeMs: number | null;
  contentLength: number | null;
  redirectChain: RedirectHop[];
  isHtml: boolean;
  compressed: boolean;
  bodyTruncated: boolean;
  xRobotsTag: string | null;
  fetchError: string | null;
  fetchErrorCode: FetchErrorCode | null;
  inSitemap: boolean;
  extract: PageExtract | null;
  internalLinks: ExtractedLink[];
  /** Internal links with generic anchor text (kept even when the URL is linked twice). */
  genericAnchors: ExtractedLink[];
  externalLinksCount: number;
  contentHash: string | null;
}

export interface CrawlSummary {
  startUrl: string;
  rootUrl: string;
  rootHost: string;
  robots: Pick<
    RobotsInfo,
    'url' | 'status' | 'statusCode' | 'sitemaps' | 'crawlDelaySec' | 'disallowAll' | 'error'
  >;
  sitemap: Omit<SitemapDiscovery, 'urls'> & { urlCount: number };
  httpsRedirect: 'ok' | 'not_redirected' | 'unreachable' | 'not_https';
  pagesCrawled: number;
  pagesFailed: number;
  pagesDiscovered: number;
  /** Internal URLs that robots.txt disallows (their linking pages come from the stored link graph); the first 500. */
  blockedByRobots: string[];
  /** How many internal URLs robots.txt disallowed in total. */
  blockedByRobotsTotal: number;
  /** Links not followed by loop protection (repetitive query strings, URLs too long to store). */
  loopUrlsSkipped: number;
  limitReached: boolean;
  cancelled: boolean;
  stoppedReason: string | null;
}

export interface CrawlCallbacks {
  onPage(record: CrawledPageRecord): Promise<void>;
  onProgress?(state: {
    crawled: number;
    failed: number;
    discovered: number;
    maxPages: number | null;
  }): Promise<void>;
  isCancelled?(): Promise<boolean>;
}

interface QueueItem {
  url: string;
  depth: number;
  source: PageSource;
}

class HostThrottle {
  private readonly nextSlot = new Map<string, number>();

  async wait(host: string, delayMs: number, signal: AbortSignal): Promise<void> {
    const now = Date.now();
    const at = Math.max(now, this.nextSlot.get(host) ?? 0);
    this.nextSlot.set(host, at + delayMs);
    if (at > now) await sleep(at - now, signal);
  }
}

/**
 * First-in-first-out queue with constant-time removal. Array#shift copies the whole array once it is large, which
 * makes an uncapped crawl of a big site quadratic. Takes ownership of the initial array.
 */
class Fifo<T> {
  private items: T[];
  private head = 0;

  constructor(items: T[] = []) {
    this.items = items;
  }

  get size(): number {
    return this.items.length - this.head;
  }

  push(item: T): void {
    this.items.push(item);
  }

  shift(): T | undefined {
    if (this.head >= this.items.length) return undefined;
    const item = this.items[this.head];
    this.head += 1;
    // Drop the consumed prefix now and then, so memory follows what is still queued.
    if (this.head >= 4096 && this.head * 2 >= this.items.length) {
      this.items = this.items.slice(this.head);
      this.head = 0;
    }
    return item;
  }

  some(predicate: (item: T) => boolean): boolean {
    for (let i = this.head; i < this.items.length; i++) if (predicate(this.items[i]!)) return true;
    return false;
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

const MAX_CRAWL_DELAY_MS = 10_000;
/** Sitemap URLs read when the crawl has no page cap (bounds memory on very large sitemaps). */
const UNCAPPED_SITEMAP_URLS = 500_000;
const DEFAULT_QUERY_VARIANTS_PER_PATH = 100;
/** Longest URL stored faithfully (crawled_pages.url is VARCHAR(2048)). */
const MAX_URL_LENGTH = 2048;

export async function crawlSite(options: CrawlOptions, callbacks: CrawlCallbacks): Promise<CrawlSummary> {
  const startUrl = normalizeCrawlUrl(options.startUrl);
  if (!startUrl) throw new Error('Invalid start URL');
  assertUrlPolicy(new URL(startUrl), options.fetcherOptions?.allowlist);

  const ownsFetcher = !options.fetcher;
  const fetcher = options.fetcher ?? new SafeFetcher(options.fetcherOptions);
  const controller = new AbortController();
  const throttle = new HostThrottle();
  const robotsByOrigin = new Map<string, Promise<RobotsInfo>>();
  const getRobots = (origin: string) => {
    let pending = robotsByOrigin.get(origin);
    if (!pending) {
      pending = fetchRobots(fetcher, origin, controller.signal);
      robotsByOrigin.set(origin, pending);
    }
    return pending;
  };
  const robotsAllows = async (url: URL) => (await getRobots(url.origin)).isAllowed(url.toString());

  const summary: CrawlSummary = {
    startUrl,
    rootUrl: startUrl,
    rootHost: new URL(startUrl).hostname,
    robots: {
      url: '',
      status: 'missing',
      statusCode: null,
      sitemaps: [],
      crawlDelaySec: null,
      disallowAll: false,
      error: null,
    },
    sitemap: { files: [], truncated: false, found: false, urlCount: 0 },
    httpsRedirect: 'not_https',
    pagesCrawled: 0,
    pagesFailed: 0,
    pagesDiscovered: 1,
    blockedByRobots: [],
    blockedByRobotsTotal: 0,
    loopUrlsSkipped: 0,
    limitReached: false,
    cancelled: false,
    stoppedReason: null,
  };

  try {
    // Resolve the canonical root (e.g. example.com → https://www.example.com/) without fetching content
    // that robots.txt disallows: every hop is checked by `beforeRequest`.
    const probe = await fetcher.fetch(startUrl, {
      readBody: false,
      signal: controller.signal,
      beforeRequest: robotsAllows,
    });
    const rootUrl =
      probe.error?.code === 'DISALLOWED' ? startUrl : (normalizeCrawlUrl(probe.finalUrl) ?? startUrl);
    const root = new URL(rootUrl);
    summary.rootUrl = rootUrl;
    summary.rootHost = root.hostname;
    const inScope = (url: string) => isInScope(url, root.hostname, options.includeSubdomains);

    const robots = await getRobots(root.origin);
    summary.robots = {
      url: robots.url,
      status: robots.status,
      statusCode: robots.statusCode,
      sitemaps: robots.sitemaps.slice(0, 50),
      crawlDelaySec: robots.crawlDelaySec,
      disallowAll: robots.disallowAll,
      error: robots.error,
    };
    if (robots.status === 'unreachable') {
      summary.stoppedReason = 'robots_unreachable';
      return summary;
    }
    const delayMs = Math.min(
      MAX_CRAWL_DELAY_MS,
      Math.max(options.crawlDelayMs, (robots.crawlDelaySec ?? 0) * 1000),
    );

    if (root.protocol === 'https:') {
      const http = await fetcher.fetch(`http://${root.host}/`, {
        readBody: false,
        signal: controller.signal,
        beforeRequest: robotsAllows,
      });
      summary.httpsRedirect = http.error
        ? 'unreachable'
        : http.finalUrl.startsWith('https:')
          ? 'ok'
          : 'not_redirected';
    }

    const sitemapCandidates = robots.sitemaps.length ? robots.sitemaps : [`${root.origin}/sitemap.xml`];
    const allowedCandidates: string[] = [];
    for (const candidate of sitemapCandidates) {
      try {
        if (robots.sitemaps.length || (await robotsAllows(new URL(candidate))))
          allowedCandidates.push(candidate);
      } catch {
        // ignore malformed sitemap URLs from robots.txt
      }
    }
    const sitemap = await discoverSitemaps(fetcher, allowedCandidates, {
      maxUrls:
        options.maxSitemapUrls ??
        (options.maxPages ? Math.max(options.maxPages * 4, 1000) : UNCAPPED_SITEMAP_URLS),
      inScope,
      signal: controller.signal,
    });
    const { urls: sitemapUrls, ...sitemapMeta } = sitemap;
    summary.sitemap = { ...sitemapMeta, urlCount: sitemapUrls.length };
    const sitemapSet = new Set(sitemapUrls);

    const linkQueue = new Fifo<QueueItem>([{ url: rootUrl, depth: 0, source: 'SEED' }]);
    const sitemapQueue = new Fifo([...sitemapUrls]);
    const seen = new Set<string>([rootUrl]);
    const blocked = new Set<string>();
    let started = 0;
    let active = 0;
    let stop = false;
    const pageLimit = options.maxPages ?? Number.POSITIVE_INFINITY;
    const depthLimit = options.maxDepth ?? Number.POSITIVE_INFINITY;
    const variantLimit = options.maxQueryVariantsPerPath ?? DEFAULT_QUERY_VARIANTS_PER_PATH;
    const queryVariants = new Map<string, number>();
    /** Loop protection for links: false when the URL should not be followed. */
    const followable = (url: string): boolean => {
      if (url.length > MAX_URL_LENGTH) return false;
      const queryStart = url.indexOf('?');
      if (queryStart === -1) return true;
      const path = url.slice(0, queryStart);
      const count = queryVariants.get(path) ?? 0;
      if (count >= variantLimit) return false;
      queryVariants.set(path, count + 1);
      return true;
    };

    const nextItem = (): QueueItem | null => {
      const linked = linkQueue.shift();
      if (linked) return linked;
      while (sitemapQueue.size) {
        const url = sitemapQueue.shift()!;
        if (!seen.has(url)) {
          seen.add(url);
          summary.pagesDiscovered += 1;
          return { url, depth: -1, source: 'SITEMAP' };
        }
      }
      return null;
    };

    /** Returns true when a request was made (counts toward the page budget). */
    const processItem = async (item: QueueItem): Promise<boolean> => {
      const target = new URL(item.url);
      const targetRobots = await getRobots(target.origin);
      if (!targetRobots.isAllowed(item.url)) {
        blocked.add(item.url);
        return false;
      }
      await throttle.wait(target.host, delayMs, controller.signal);
      if (controller.signal.aborted) return false;

      const result = await fetcher.fetch(item.url, {
        signal: controller.signal,
        beforeRequest: robotsAllows,
      });
      if (result.error?.code === 'CANCELLED' || (controller.signal.aborted && result.error)) return false;
      if (result.error?.code === 'DISALLOWED') {
        blocked.add(item.url);
        return false;
      }
      const finalUrl = normalizeCrawlUrl(result.finalUrl);
      const finalInScope = finalUrl ? inScope(finalUrl) : false;
      const isHtml = isHtmlContentType(result.contentType);
      let extract: PageExtract | null = null;
      if (
        result.statusCode !== null &&
        result.statusCode >= 200 &&
        result.statusCode < 300 &&
        isHtml &&
        result.body &&
        finalInScope
      ) {
        extract = extractPage(result.body.toString('utf8'), finalUrl!);
      }

      const internalLinks: ExtractedLink[] = [];
      let externalLinksCount = 0;
      if (extract) {
        const metaNofollow =
          /\bnofollow\b|\bnone\b/.test(extract.metaRobots ?? '') ||
          /\bnofollow\b|\bnone\b/i.test(result.headers['x-robots-tag'] ?? '');
        for (const link of extract.links) {
          if (!inScope(link.url)) {
            externalLinksCount += 1;
            continue;
          }
          internalLinks.push(link);
          if (metaNofollow || seen.has(link.url) || !looksLikeHtmlUrl(link.url)) continue;
          if (item.depth >= 0 && item.depth + 1 > depthLimit) continue;
          if (!followable(link.url)) {
            seen.add(link.url);
            summary.loopUrlsSkipped += 1;
            continue;
          }
          seen.add(link.url);
          summary.pagesDiscovered += 1;
          linkQueue.push({ url: link.url, depth: item.depth >= 0 ? item.depth + 1 : -1, source: 'LINK' });
        }
      }
      if (finalUrl && finalUrl !== item.url && finalInScope) seen.add(finalUrl);

      const failed = result.error !== null || (result.statusCode !== null && result.statusCode >= 400);
      summary.pagesCrawled += 1;
      if (failed) summary.pagesFailed += 1;

      await callbacks.onPage({
        url: item.url,
        urlHash: urlHash(item.url),
        finalUrl: finalUrl && finalUrl !== item.url ? finalUrl : null,
        depth: item.depth,
        source: result.redirectChain.length && item.source === 'LINK' ? 'LINK' : item.source,
        statusCode: result.statusCode,
        contentType: result.contentType,
        responseTimeMs: result.responseTimeMs,
        contentLength: result.body?.length ?? (Number(result.headers['content-length']) || null),
        redirectChain: result.redirectChain,
        isHtml,
        compressed: Boolean(result.contentEncoding && result.contentEncoding !== 'identity'),
        bodyTruncated: result.bodyTruncated,
        xRobotsTag: result.headers['x-robots-tag'] ?? null,
        fetchError: result.error?.message ?? null,
        fetchErrorCode: result.error?.code ?? null,
        inSitemap: sitemapSet.has(item.url) || (finalUrl ? sitemapSet.has(finalUrl) : false),
        extract,
        internalLinks,
        genericAnchors: extract ? extract.genericAnchors.filter((l) => inScope(l.url)) : [],
        externalLinksCount,
        contentHash: extract ? simhash(extract.text) : null,
      });
      await callbacks.onProgress?.({
        crawled: summary.pagesCrawled,
        failed: summary.pagesFailed,
        discovered: summary.pagesDiscovered,
        maxPages: options.maxPages,
      });
      return true;
    };

    const worker = async () => {
      while (!stop) {
        if (callbacks.isCancelled && (await callbacks.isCancelled())) {
          summary.cancelled = true;
          stop = true;
          controller.abort('cancelled');
          break;
        }
        if (started >= pageLimit) {
          summary.limitReached = linkQueue.size > 0 || sitemapQueue.some((u) => !seen.has(u));
          break;
        }
        const item = nextItem();
        if (!item) {
          if (active === 0) break;
          await sleep(25);
          continue;
        }
        started += 1;
        active += 1;
        try {
          // Robots-blocked or cancelled items do not consume the page budget.
          if (!(await processItem(item))) started -= 1;
        } finally {
          active -= 1;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, options.concurrency) }, worker));

    summary.blockedByRobots = [...blocked].slice(0, 500);
    summary.blockedByRobotsTotal = blocked.size;
    if (summary.cancelled) summary.stoppedReason = 'cancelled';
    else if (summary.limitReached) summary.stoppedReason = 'page_limit';
    return summary;
  } finally {
    if (ownsFetcher) await fetcher.close();
  }
}
