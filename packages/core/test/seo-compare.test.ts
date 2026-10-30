import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_CRAWL_SETTINGS, type SeoComparisonResult, type SeoSite } from '@surfaced/shared';
import {
  buildSeoSuggestions,
  compareMetrics,
  executeSeoComparison,
  saveSeoSuggestionAsRecommendation,
} from '../src/competitors';
import { randomToken } from '../src/crypto';
import { disconnectPrisma, getPrisma } from '../src/db';

describe('compareMetrics', () => {
  it('marks clear gaps against the competitors’ median, not rounding differences', () => {
    const rows = compareMetrics([
      {
        key: 'you',
        isYou: true,
        metrics: { descriptionPct: 0.5, titlePct: 0.97, https: false, medianResponseMs: 900 },
      },
      {
        key: 'a',
        isYou: false,
        metrics: { descriptionPct: 0.9, titlePct: 1, https: true, medianResponseMs: 300 },
      },
      {
        key: 'b',
        isYou: false,
        metrics: { descriptionPct: 0.8, titlePct: 0.99, https: true, medianResponseMs: 350 },
      },
    ]);
    const row = (key: string) => rows.find((r) => r.key === key)!;
    expect(row('descriptionPct')).toMatchObject({ status: 'behind', best: { siteKey: 'a', value: 0.9 } });
    expect(row('descriptionPct').competitorMedian).toBeCloseTo(0.85);
    expect(row('titlePct').status).toBe('even');
    expect(row('https').status).toBe('behind');
    // Lower is better for response time.
    expect(row('medianResponseMs')).toMatchObject({ status: 'behind', best: { siteKey: 'a', value: 300 } });
    // Checks nobody measured stay unknown.
    expect(row('altPct').status).toBe('unknown');
  });
});

describe('buildSeoSuggestions', () => {
  const site = (key: string, overrides: Partial<SeoSite>): SeoSite => ({
    key,
    name: key,
    domain: `${key}.test`,
    isYou: key === 'you',
    competitorId: key === 'you' ? null : key,
    startUrl: `https://${key}.test/`,
    status: 'OK',
    error: null,
    pagesCrawled: 10,
    pagesAnalyzed: 10,
    limitReached: false,
    timeLimitReached: false,
    score: 80,
    categoryScores: null,
    rules: [],
    schemaTypes: [],
    crawledAt: '2026-10-23T00:00:00.000Z',
    ...overrides,
  });
  const rule = (ruleId: string, pages: number, severity: 'HIGH' | 'MEDIUM' = 'HIGH') => ({
    ruleId,
    title: ruleId,
    category: 'METADATA' as const,
    severity,
    scope: 'page' as const,
    pages,
    rate: pages / 10,
    sampleUrls: ['https://you.test/a'],
  });

  it('lists every problem with how competitors fare, and ranks shared problems lower', () => {
    const sites = [
      site('you', {
        rules: [rule('meta-description-missing', 6), rule('title-too-long', 3)],
        schemaTypes: ['WebSite'],
      }),
      site('rival', {
        rules: [rule('title-too-long', 5)],
        schemaTypes: ['WebSite', 'Product', 'BreadcrumbList'],
      }),
    ];
    const rows = compareMetrics([
      { key: 'you', isYou: true, metrics: { medianWords: 300 } },
      { key: 'rival', isYou: false, metrics: { medianWords: 1200 } },
    ]);
    const suggestions = buildSeoSuggestions(sites, rows, { name: 'You' });
    const byKey = new Map(suggestions.map((s) => [s.key, s]));
    expect(byKey.get('rule:meta-description-missing')).toMatchObject({ priority: 2 });
    expect(byKey.get('rule:meta-description-missing')!.why).toContain(
      '6 of 10 pages checked (60%). Competitors: rival 0%.',
    );
    // The rival has longer titles on more pages, so this does not set you back against it.
    expect(byKey.get('rule:title-too-long')).toMatchObject({ priority: 3 });
    expect(byKey.get('metric:medianWords')!.why).toContain('300 words');
    expect(byKey.get('metric:schemaTypes')!.why).toContain('Product (rival)');
    // Same priority: the problem affecting more pages comes first.
    expect(suggestions.slice(0, 2).map((s) => s.key)).toEqual([
      'rule:meta-description-missing',
      'metric:medianWords',
    ]);
  });

  it('asks you to fix crawling first when your own site could not be read', () => {
    const suggestions = buildSeoSuggestions(
      [site('you', { status: 'UNREACHABLE', error: 'No page could be fetched.' })],
      [],
      {
        name: 'You',
      },
    );
    expect(suggestions).toEqual([expect.objectContaining({ key: 'site-unreadable', priority: 1 })]);
  });
});

function startSite(pages: Record<string, string>, robots = 'User-agent: *\nAllow: /\n') {
  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]!;
    if (path === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(robots);
    } else if (pages[path]) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(pages[path]);
    } else {
      res.writeHead(404, { 'content-type': 'text/html' });
      res.end('<h1>Not found</h1>');
    }
  });
  return new Promise<{ server: Server; origin: string }>((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }),
    ),
  );
}

const html = (title: string, body: string, head = '') =>
  `<!doctype html><html lang="en"><head><title>${title}</title><meta name="viewport" content="width=device-width">${head}</head><body>${body}</body></html>`;
const words = (n: number) =>
  `<p>${'Helpful details about digital invitations for every occasion. '.repeat(n)}</p>`;

describe('executeSeoComparison (MySQL + local sites)', () => {
  const prisma = getPrisma();
  const sites: { server: Server; origin: string }[] = [];

  beforeAll(async () => {
    // Your site: no meta descriptions, thin pages.
    sites.push(
      await startSite({
        '/': html(
          'Invites',
          '<h1>Invites</h1><a href="/wedding">Wedding</a><a href="/haldi">Haldi</a>' + words(5),
        ),
        '/wedding': html('Wedding invitations online', '<h1>Wedding</h1><a href="/">Home</a>' + words(10)),
        '/haldi': html('Haldi invitations online', '<h1>Haldi</h1><a href="/">Home</a>' + words(10)),
      }),
    );
    // Rival: descriptions, deeper pages, structured data.
    const meta =
      '<meta name="description" content="Design and share beautiful digital invitations online in minutes.">';
    const org =
      '<script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"Rival","url":"https://rival.test/"}</script>';
    sites.push(
      await startSite({
        '/': html(
          'Rival digital invitations',
          '<h1>Rival</h1><a href="/wedding">Wedding</a><a href="/haldi">Haldi</a>' + words(60),
          meta + org,
        ),
        '/wedding': html(
          'Rival wedding invitations',
          '<h1>Wedding</h1><a href="/">Home</a>' + words(60),
          meta,
        ),
        '/haldi': html('Rival haldi invitations', '<h1>Haldi</h1><a href="/">Home</a>' + words(60), meta),
      }),
    );
    // A competitor that does not allow crawling.
    sites.push(await startSite({ '/': html('Blocked', '<h1>Blocked</h1>') }, 'User-agent: *\nDisallow: /\n'));
  });
  afterAll(async () => {
    await Promise.all(sites.map((s) => new Promise<void>((resolve) => s.server.close(() => resolve()))));
    await disconnectPrisma();
  });

  it('crawls every site the same way, compares them and lists what to improve', async () => {
    const workspace = await prisma.workspace.create({
      data: { name: 'SEO WS', slug: `seo-${randomToken(6).toLowerCase()}` },
    });
    const project = await prisma.project.create({
      data: {
        workspaceId: workspace.id,
        name: 'Invites',
        websiteUrl: `${sites[0]!.origin}/`,
        domain: `invites-${randomToken(4).toLowerCase()}.test`,
        targetCountries: ['IN'],
        targetLanguages: ['en'],
        crawlSettings: DEFAULT_CRAWL_SETTINGS,
        competitors: {
          create: [
            { name: 'Rival', domain: 'rival.test' },
            { name: 'Closed', domain: 'closed.test' },
          ],
        },
      },
      include: { competitors: { orderBy: { name: 'desc' } } },
    });
    const [rival, closed] = project.competitors;
    const comparison = await prisma.seoComparison.create({
      data: { projectId: project.id, competitorIds: [rival!.id, closed!.id] },
    });
    const origins: Record<string, string> = {
      'rival.test': sites[1]!.origin,
      'closed.test': sites[2]!.origin,
    };
    const outcome = await executeSeoComparison(prisma, comparison.id, {
      fetcherOptions: { allowlist: ['127.0.0.1:*'], timeoutMs: 5000 },
      maxPagesPerSite: 10,
      competitorStartUrl: (c) => `${origins[c.domain]}/`,
    });
    expect(outcome.sites).toBe(3);

    const stored = await prisma.seoComparison.findUniqueOrThrow({ where: { id: comparison.id } });
    expect(stored.status).toBe('SUCCEEDED');
    const r = stored.result as unknown as SeoComparisonResult;
    expect(r.maxPagesPerSite).toBe(10);
    const [you, rivalSite, closedSite] = r.sites;
    expect(you).toMatchObject({ key: 'you', isYou: true, status: 'OK', pagesAnalyzed: 3 });
    expect(rivalSite).toMatchObject({ key: rival!.id, status: 'OK', pagesAnalyzed: 3 });
    expect(rivalSite!.schemaTypes).toContain('Organization');
    expect(closedSite).toMatchObject({ status: 'BLOCKED_BY_ROBOTS' });
    expect(r.notes.join(' ')).toMatch(/Closed could not be checked/);

    const row = (key: string) => r.metrics.find((m) => m.key === key)!;
    expect(row('descriptionPct')).toMatchObject({ status: 'behind', values: { you: 0, [rival!.id]: 1 } });
    expect(row('descriptionPct').values[closed!.id]).toBeNull();
    expect(row('medianWords').status).toBe('behind');
    expect(r.summary.behind).toBeGreaterThan(0);

    const keys = r.suggestions.map((s) => s.key);
    expect(keys).toEqual(
      expect.arrayContaining(['rule:meta-description-missing', 'metric:medianWords', 'metric:schemaTypes']),
    );
    const description = r.suggestions.find((s) => s.key === 'rule:meta-description-missing')!;
    expect(description.why).toContain('3 of 3 pages checked (100%). Competitors: Rival 0%.');
    expect(r.notCompared.join(' ')).toMatch(/Backlinks/);

    const first = await saveSeoSuggestionAsRecommendation(prisma, project.id, comparison.id, description);
    const again = await saveSeoSuggestionAsRecommendation(prisma, project.id, comparison.id, description);
    expect(first.created).toBe(true);
    expect(again).toEqual({ id: first.id, created: false });
    const rec = await prisma.recommendation.findUniqueOrThrow({ where: { id: first.id } });
    expect(rec).toMatchObject({ source: 'COMPETITOR' });
  });
});
