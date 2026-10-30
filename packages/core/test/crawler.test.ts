import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  SafeFetcher,
  crawlSite,
  extractPage,
  hammingDistance,
  normalizeCrawlUrl,
  parseSitemapXml,
  simhash,
  type CrawledPageRecord,
} from '../src/crawler';
import { startFixtureSite, type FixtureSite } from './fixtures/fixture-site';

const ALLOW_LOCAL = ['127.0.0.1:*'];
let site: FixtureSite;

beforeAll(async () => {
  site = await startFixtureSite();
});
afterAll(async () => {
  await site.close();
});

function baseOptions(overrides: Partial<Parameters<typeof crawlSite>[0]> = {}) {
  return {
    startUrl: `${site.origin}/`,
    maxPages: 50,
    maxDepth: 5,
    includeSubdomains: false,
    crawlDelayMs: 0,
    concurrency: 2,
    fetcherOptions: { allowlist: ALLOW_LOCAL, timeoutMs: 5000 },
    ...overrides,
  };
}

describe('crawlSite', () => {
  it('crawls the site, respects robots.txt and records page-level data', async () => {
    const pages: CrawledPageRecord[] = [];
    const summary = await crawlSite(baseOptions(), { onPage: async (p) => void pages.push(p) });
    const byPath = new Map(pages.map((p) => [new URL(p.url).pathname, p]));

    expect(summary.robots).toMatchObject({ status: 'ok', disallowAll: false });
    expect(summary.sitemap).toMatchObject({ found: true, urlCount: 4 });
    expect(site.requests).not.toContain('/private/secret');
    expect(summary.blockedByRobots).toEqual([`${site.origin}/private/secret`]);
    expect(summary.blockedByRobotsTotal).toBe(1);

    const home = byPath.get('/')!;
    expect(home).toMatchObject({ depth: 0, source: 'SEED', statusCode: 200, isHtml: true, inSitemap: true });
    expect(home.extract?.title).toBe('Fixture Outdoor Gear | Home');
    expect(home.extract?.canonicals).toEqual([`${site.origin}/`]);
    expect(home.extract?.structuredDataTypes).toEqual(['Organization']);
    expect(home.extract?.questionHeadings).toBe(2);
    expect(home.extract?.images.filter((i) => !i.hasAlt)).toHaveLength(1);
    expect(home.externalLinksCount).toBe(1);
    expect(home.internalLinks.map((l) => new URL(l.url).pathname)).toEqual(
      expect.arrayContaining(['/about', '/products', '/broken', '/redirect-old', '/private/secret']),
    );
    expect(home.contentHash).toMatch(/^[0-9a-f]{16}$/);

    expect(byPath.get('/broken')).toMatchObject({ statusCode: 404, depth: 1 });
    const redirected = byPath.get('/redirect-old')!;
    expect(redirected.redirectChain.map((h) => h.statusCode)).toEqual([301, 301]);
    expect(redirected.finalUrl).toBe(`${site.origin}/about`);

    // Orphan page is only reachable through the sitemap.
    expect(byPath.get('/orphan')).toMatchObject({ source: 'SITEMAP', depth: -1, inSitemap: true });
    // gzip-encoded responses are decoded and flagged as compressed.
    expect(byPath.get('/products')).toMatchObject({ compressed: true });
    expect(byPath.get('/products')?.extract?.title).toBe('Same Title');
    expect(byPath.get('/products/item-1')?.extract?.jsonLd[0]?.error).toBeTruthy();
    expect(summary.pagesFailed).toBe(1);
    expect(summary.limitReached).toBe(false);
  });

  it('stops at the page limit', async () => {
    const pages: CrawledPageRecord[] = [];
    const summary = await crawlSite(baseOptions({ maxPages: 2, concurrency: 1 }), {
      onPage: async (p) => void pages.push(p),
    });
    expect(pages).toHaveLength(2);
    expect(summary).toMatchObject({ limitReached: true, stoppedReason: 'page_limit' });
  });

  it('supports cancellation between pages', async () => {
    const pages: CrawledPageRecord[] = [];
    let checks = 0;
    const summary = await crawlSite(baseOptions({ concurrency: 1 }), {
      onPage: async (p) => void pages.push(p),
      isCancelled: async () => ++checks > 2,
    });
    expect(summary.cancelled).toBe(true);
    expect(summary.stoppedReason).toBe('cancelled');
    expect(pages.length).toBeLessThanOrEqual(2);
  });

  it('refuses private targets unless explicitly allowlisted (SSRF)', async () => {
    await expect(
      crawlSite(baseOptions({ fetcherOptions: { allowlist: [] } }), { onPage: async () => {} }),
    ).rejects.toMatchObject({
      name: 'UnsafeTargetError',
    });
  });

  it('treats an unreachable robots.txt as disallow-all (RFC 9309)', async () => {
    const broken = await startFixtureSite({ robotsStatus: 503 });
    try {
      const pages: CrawledPageRecord[] = [];
      const summary = await crawlSite(baseOptions({ startUrl: `${broken.origin}/` }), {
        onPage: async (p) => void pages.push(p),
      });
      expect(summary.robots.status).toBe('unreachable');
      expect(summary.stoppedReason).toBe('robots_unreachable');
      expect(pages).toHaveLength(0);
      expect(broken.requests.filter((r) => r !== '/robots.txt')).toEqual([]);
    } finally {
      await broken.close();
    }
  });
});

/** A site with a 30-level chain of links, an endless calendar and one link longer than 2,048 characters. */
async function startEndlessSite() {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    requests.push(`${url.pathname}${url.search}`);
    const html = (body: string) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        `<!doctype html><html lang="en"><head><title>${url.pathname}</title></head><body>${body}</body></html>`,
      );
    };
    if (url.pathname === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('User-agent: *\nAllow: /\n');
    } else if (url.pathname === '/') {
      html(
        `<a href="/level/1">Start</a> <a href="/calendar?month=0">Calendar</a> <a href="/long/${'a'.repeat(2100)}">Long</a>`,
      );
    } else if (url.pathname.startsWith('/level/')) {
      const n = Number(url.pathname.slice('/level/'.length));
      html(n < 30 ? `<a href="/level/${n + 1}">Next</a>` : '<p>End of the chain</p>');
    } else if (url.pathname === '/calendar') {
      html(`<a href="/calendar?month=${Number(url.searchParams.get('month')) + 1}">Next month</a>`);
    } else {
      res.writeHead(404, { 'content-type': 'text/html' });
      res.end('<h1>Not found</h1>');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe('crawling without a page or depth cap', () => {
  let endless: Awaited<ReturnType<typeof startEndlessSite>>;
  beforeAll(async () => {
    endless = await startEndlessSite();
  });
  afterAll(async () => {
    await endless.close();
  });

  it('crawls every reachable page at any depth, with loop protection', async () => {
    const pages: CrawledPageRecord[] = [];
    const summary = await crawlSite(
      baseOptions({
        startUrl: `${endless.origin}/`,
        maxPages: null,
        maxDepth: null,
        maxQueryVariantsPerPath: 5,
      }),
      { onPage: async (p) => void pages.push(p) },
    );
    expect(pages.filter((p) => p.url.includes('/level/'))).toHaveLength(30);
    expect(pages.filter((p) => p.url.includes('/calendar'))).toHaveLength(5);
    expect(pages).toHaveLength(36);
    expect(Math.max(...pages.map((p) => p.depth))).toBe(30);
    // The sixth calendar variant and the over-long URL are skipped, not fetched.
    expect(summary).toMatchObject({ limitReached: false, stoppedReason: null, loopUrlsSkipped: 2 });
    expect(endless.requests).not.toContain('/calendar?month=5');
    expect(endless.requests.some((r) => r.startsWith('/long/'))).toBe(false);
  });

  it('still applies a depth cap when one is set', async () => {
    const pages: CrawledPageRecord[] = [];
    await crawlSite(baseOptions({ startUrl: `${endless.origin}/`, maxPages: null, maxDepth: 3 }), {
      onPage: async (p) => void pages.push(p),
    });
    expect(Math.max(...pages.map((p) => p.depth))).toBe(3);
    expect(pages.some((p) => p.url.endsWith('/level/4'))).toBe(false);
  });
});

describe('SafeFetcher limits', () => {
  it('times out slow responses', async () => {
    const fetcher = new SafeFetcher({ allowlist: ALLOW_LOCAL, timeoutMs: 500 });
    const result = await fetcher.fetch(`${site.origin}/slow`);
    expect(result.error?.code).toBe('TIMEOUT');
    await fetcher.close();
  });

  it('caps the response body size', async () => {
    const fetcher = new SafeFetcher({ allowlist: ALLOW_LOCAL, maxBodyBytes: 70_000 });
    const result = await fetcher.fetch(`${site.origin}/big`);
    expect(result.bodyTruncated).toBe(true);
    expect(result.body?.length).toBe(70_000);
    await fetcher.close();
  });

  it('blocks private targets, including when reached through a redirect', async () => {
    const direct = new SafeFetcher({ allowlist: [] });
    expect((await direct.fetch('http://169.254.169.254/latest/meta-data/')).error?.code).toBe('BLOCKED');
    await direct.close();

    const fetcher = new SafeFetcher({ allowlist: ALLOW_LOCAL });
    const viaRedirect = await fetcher.fetch(`${site.origin}/to-metadata`);
    expect(viaRedirect.error?.code).toBe('BLOCKED');
    expect(viaRedirect.redirectChain).toEqual([{ url: `${site.origin}/to-metadata`, statusCode: 302 }]);
    expect(viaRedirect.finalUrl).toBe('http://169.254.169.254/latest/meta-data/');
    await fetcher.close();
  });
});

describe('extraction helpers', () => {
  it('extracts metadata, links (with base href) and structured data issues', () => {
    const html = `<html lang="de"><head><base href="https://ex.test/docs/"><title> Hello </title>
      <meta name="description" content="Desc"><meta name="robots" content="NOINDEX, follow">
      <script src="/a.js"></script><script src="/b.js" defer></script>
      <script type="application/ld+json">{"@context":"https://schema.org","@type":"Article"}</script></head>
      <body><h2>Why use it?</h2><h2>How does it work</h2><a href="page2" rel="nofollow">Next</a>
      <a href="javascript:void(0)">JS</a><img src="http://cdn.ex.test/x.png"></body></html>`;
    const result = extractPage(html, 'https://ex.test/docs/page1');
    expect(result.title).toBe('Hello');
    expect(result.lang).toBe('de');
    expect(result.metaRobots).toBe('noindex, follow');
    expect(result.links).toEqual([{ url: 'https://ex.test/docs/page2', anchorText: 'Next', nofollow: true }]);
    expect(result.blockingScriptsInHead).toBe(1);
    expect(result.insecureResources).toEqual(['http://cdn.ex.test/x.png']);
    expect(result.jsonLd[0]?.requiredMissing).toEqual([{ type: 'Article', props: ['headline'] }]);
    expect(result.questionHeadings).toBe(2);
    expect(result.hasFaqContent).toBe(true);
  });

  it('parses sitemap documents and normalizes crawl URLs', () => {
    expect(
      parseSitemapXml(
        '<urlset><url><loc>https://a.test/x</loc></url><url><loc>https://a.test/y</loc></url></urlset>',
      ),
    ).toEqual({
      type: 'urlset',
      locs: ['https://a.test/x', 'https://a.test/y'],
    });
    expect(
      parseSitemapXml('<sitemapindex><sitemap><loc>https://a.test/s1.xml</loc></sitemap></sitemapindex>')
        .type,
    ).toBe('index');
    expect(gzipSync('x').length).toBeGreaterThan(0);
    expect(normalizeCrawlUrl('HTTPS://Ex.Test:443/a?utm_source=x&id=2#frag')).toBe('https://ex.test/a?id=2');
    expect(normalizeCrawlUrl('/rel', 'https://ex.test/base/')).toBe('https://ex.test/rel');
    expect(normalizeCrawlUrl('ftp://ex.test/')).toBeNull();
  });

  it('fingerprints near-duplicate text with SimHash', () => {
    const base =
      'Waterproof hiking boots with breathable lining and grippy soles for wet trails and rocky paths. '.repeat(
        6,
      );
    const a = simhash(base)!;
    const b = simhash(`${base} Free shipping on orders over fifty dollars.`)!;
    const c = simhash(
      'Completely different text about baking sourdough bread at home with a starter and long fermentation. '.repeat(
        6,
      ),
    )!;
    expect(hammingDistance(a, b)).toBeLessThan(hammingDistance(a, c));
    expect(simhash('too short')).toBeNull();
  });
});
