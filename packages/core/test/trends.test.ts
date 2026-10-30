import { afterAll, describe, expect, it } from 'vitest';
import { DEFAULT_CRAWL_SETTINGS, type TrendAnalysisResult, type TrendData } from '@surfaced/shared';
import type { LlmJsonRequest, LlmProvider, LlmResult } from '../src/ai';
import { randomToken } from '../src/crypto';
import { disconnectPrisma, getPrisma } from '../src/db';
import { resetEnvCache } from '../src/env';
import { keywordOpportunities, scoreKeyword } from '../src/keywords';
import { MemoryQueueGateway } from '../src/queue';
import {
  PytrendsProvider,
  TrendProviderError,
  containsPhrase,
  copyTrendData,
  executeTrendReport,
  fetchTrendsFromDataForSeo,
  loadTrendData,
  periodDate,
  runScheduledTrendRefreshes,
  saveTrendData,
  saveTrendPlacementAsRecommendation,
  trendCacheHours,
  trendCacheKey,
  trendReportCsv,
  trendTermKey,
  validatePlacements,
  type TrendFetchRequest,
  type TrendsFetch,
} from '../src/trends';

async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const before = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) process.env[k] = v ?? '';
  resetEnvCache();
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(before)) process.env[k] = v ?? '';
    resetEnvCache();
  }
}

type Handler = (body: Record<string, unknown>) => { status?: number; body: unknown } | Promise<never>;

/** A stand-in for the pytrends service: records calls and answers from handlers. Never reaches Google. */
function fakeService(handlers: Record<string, Handler>) {
  const calls: { path: string; body: Record<string, unknown>; token: string | null }[] = [];
  const fetchImpl: TrendsFetch = async (url, init) => {
    const path = new URL(url).pathname;
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    calls.push({ path, body, token: new Headers(init.headers).get('x-service-token') });
    const handler = handlers[path];
    if (!handler) return new Response(JSON.stringify({ error: { code: 'NOT_FOUND' } }), { status: 404 });
    const result = await handler(body);
    return new Response(JSON.stringify(result.body), { status: result.status ?? 200 });
  };
  return { fetchImpl, calls };
}

const PYTRENDS_ENV = { PYTRENDS_SERVICE_URL: 'http://127.0.0.1:4999', PYTRENDS_SERVICE_TOKEN: 'test-token' };

const request: TrendFetchRequest = {
  keywords: ['wedding invitation', 'digital invitation', 'invitation card'],
  country: 'IN',
  region: null,
  timeRange: 'past_90_days',
  category: 293,
  language: 'en',
  include: ['interest', 'regions', 'related_queries', 'related_topics'],
};

const interestBody = {
  points: [
    { date: '2026-07-20', values: { 'wedding invitation': 50, 'digital invitation': 3, 'invitation card': 10 }, isPartial: false },
    { date: '2026-07-27', values: { 'wedding invitation': 100, 'digital invitation': 5, 'invitation card': null }, isPartial: true },
  ],
}; // prettier-ignore
const regionsBody = {
  resolution: 'REGION',
  regions: [
    { name: 'Gujarat', geoCode: 'IN-GJ', values: { 'wedding invitation': 90, 'digital invitation': 4, 'invitation card': 6 } },
    { name: 'Kerala', geoCode: 'IN-KL', values: { 'wedding invitation': 95, 'digital invitation': 2, 'invitation card': 3 } },
  ],
  limitations: ['With several terms, each region shows how its searches split between the terms.'],
}; // prettier-ignore
const relatedBody = (keyword: string) => ({
  keyword,
  queries: { top: [{ label: `${keyword} card`, value: 100 }], rising: [{ label: `${keyword} video`, growth: 'Breakout' }] },
  topics: { top: [{ label: 'Wedding', value: 100, topicType: 'Topic' }], rising: [] },
  limitations: [],
}); // prettier-ignore

describe('trends helpers', () => {
  it('matches phrases with at most one word in between', () => {
    expect(containsPhrase(['digital', 'wedding', 'invitation'], ['digital', 'invitation'])).toBe(true);
    expect(containsPhrase(['digital', 'beautiful', 'wedding', 'invitation'], ['digital', 'invitation'])).toBe(
      false,
    );
    expect(containsPhrase(['invitation', 'digital'], ['digital', 'invitation'])).toBe(false);
  });

  it('drops AI suggestions that name pages or sections not on the site', () => {
    const candidates = new Map([
      [
        'video invitation maker',
        [{ url: 'https://s.test/', title: 'Home', headings: ['Video Invitations'] }],
      ],
      ['haldi card', [{ url: 'https://s.test/haldi', title: 'Haldi', headings: ['Designs'] }]],
    ]);
    const kept = validatePlacements(
      [
        { term: 'video invitation maker', action: 'add_to_page', pageUrl: 'https://s.test/', section: 'video invitations', newSection: null, spot: 'heading', suggestedText: 'Video invitation maker for every celebration', reason: 'Home has a video section.' },
        { term: 'haldi card', action: 'add_to_page', pageUrl: 'https://s.test/made-up', section: null, newSection: null, spot: 'body', suggestedText: 'Haldi card designs', reason: 'x' },
      ],
      [{ term: 'video invitation maker' }, { term: 'haldi card' }],
      candidates,
    ); // prettier-ignore
    expect(kept).toEqual([
      expect.objectContaining({
        term: 'video invitation maker',
        pageUrl: 'https://s.test/',
        section: 'Video Invitations',
      }),
    ]);
  });

  it('treats word order, filler words and plurals as the same search, but not modifiers', () => {
    expect(trendTermKey('invitations for weddings')).toBe(trendTermKey('wedding invitation'));
    expect(trendTermKey('how to make wedding invitation')).not.toBe(trendTermKey('wedding invitation'));
    expect(trendTermKey('free wedding invitation')).not.toBe(trendTermKey('wedding invitation'));
    expect(trendTermKey('dress')).toBe('dress');
  });

  it('shares cached data only for the same provider, terms, place, period, category and data types', () => {
    const base = { source: 'PYTRENDS' as const, keywords: ['Wedding Invitation', 'digital invitation'], country: 'IN', region: null, timeRange: 'past_90_days', category: 293, language: 'en', include: ['interest' as const, 'regions' as const] }; // prettier-ignore
    const key = trendCacheKey(base);
    expect(trendCacheKey({ ...base, keywords: ['digital invitation', 'wedding invitation'] })).toBe(key);
    expect(trendCacheKey({ ...base, include: ['regions', 'interest'] })).toBe(key);
    expect(trendCacheKey({ ...base, source: 'DATAFORSEO' })).not.toBe(key);
    expect(trendCacheKey({ ...base, region: 'IN-GJ' })).not.toBe(key);
    expect(trendCacheKey({ ...base, timeRange: 'past_12_months' })).not.toBe(key);
  });

  it('reads cache lifetimes by provider and data type, the most specific entry winning', () => {
    const setting = 'default=12,regions=24,pytrends=6,pytrends.related_queries=48';
    expect(trendCacheHours('PYTRENDS', ['interest'], setting)).toBe(6);
    expect(trendCacheHours('PYTRENDS', ['related_queries'], setting)).toBe(48);
    expect(trendCacheHours('PYTRENDS', ['interest', 'related_queries'], setting)).toBe(6);
    expect(trendCacheHours('DATAFORSEO', ['regions'], setting)).toBe(24);
    expect(trendCacheHours('DATAFORSEO', ['interest', 'regions'], setting)).toBe(12);
    expect(trendCacheHours('DATAFORSEO', ['interest'], 'nonsense')).toBe(12);
  });

  it('reads Google Trends period formats as UTC dates', () => {
    expect(periodDate('2026-07-23')?.toISOString()).toBe('2026-07-23T00:00:00.000Z');
    expect(periodDate('2026-10-16T10')?.toISOString()).toBe('2026-10-16T10:00:00.000Z');
    expect(periodDate('2026-10-16T10:00:00')?.toISOString()).toBe('2026-10-16T10:00:00.000Z');
    expect(periodDate('2026-10')?.toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(periodDate('last week')).toBeNull();
  });
});

describe('DataForSEO provider', () => {
  it('maps a DataForSEO response to interest over time and related queries', async () => {
    const calls: { body: unknown; auth: string | null }[] = [];
    const fake: TrendsFetch = async (_url, init) => {
      const body = JSON.parse(String(init.body)) as { item_types: string[]; keywords: string[] }[];
      calls.push({ body: body[0], auth: new Headers(init.headers).get('authorization') });
      const task =
        body[0]!.item_types[0] === 'google_trends_graph'
          ? { items: [{ type: 'google_trends_graph', keywords: ['wedding invitation', 'birthday invitation'], data: [{ date_from: '2026-07-20', values: [54, 20] }, { date_from: '2026-07-27', missing_data: true, values: [0, 0] }, { date_from: '2026-08-03', values: [100, 30] }] }] }
          : { items: [{ type: 'google_trends_queries_list', data: { top: [{ query: `${body[0]!.keywords[0]} card`, value: 100 }], rising: [{ query: 'video invite', value: 5000 }, { query: 'e invite', value: 250 }] } }] }; // prettier-ignore
      return new Response(JSON.stringify({ status_code: 20000, status_message: 'Ok.', tasks: [{ status_code: 20000, status_message: 'Ok.', cost: 0.009, result: [task] }] }), { status: 200 }); // prettier-ignore
    };
    const { data, requests, costUsd, partial } = await fetchTrendsFromDataForSeo(
      { keywords: ['wedding invitation', 'birthday invitation'], country: 'IN', timeRange: 'past_90_days', category: 293 },
      fake,
      { login: 'user', password: 'secret' },
    ); // prettier-ignore
    expect(requests).toBe(3);
    expect(partial).toBe(false);
    expect(costUsd).toBeCloseTo(0.027);
    expect(calls[0]).toMatchObject({
      auth: `Basic ${Buffer.from('user:secret').toString('base64')}`,
      body: {
        location_name: 'India',
        time_range: 'past_90_days',
        category_code: 293,
        item_types: ['google_trends_graph'],
      },
    });
    expect(data.interest).toEqual({
      dates: ['2026-07-20', '2026-07-27', '2026-08-03'],
      series: [
        { keyword: 'wedding invitation', values: [54, null, 100], average: 77 },
        { keyword: 'birthday invitation', values: [20, null, 30], average: 25 },
      ],
    });
    expect(data.related[0]).toEqual({
      keyword: 'wedding invitation',
      top: [{ query: 'wedding invitation card', value: 100 }],
      rising: [
        { query: 'video invite', value: 'Breakout' },
        { query: 'e invite', value: '+250%' },
      ],
    });
  });

  it('reports provider errors instead of returning empty data', async () => {
    const failing: TrendsFetch = async () =>
      new Response(JSON.stringify({ status_code: 40100, status_message: 'You are not authorized.' }), {
        status: 200,
      });
    await expect(
      fetchTrendsFromDataForSeo({ keywords: ['x y'], country: null, timeRange: 'past_7_days', category: 0 }, failing, { login: 'a', password: 'b' }), // prettier-ignore
    ).rejects.toThrow(/not authorized/);
    await expect(
      fetchTrendsFromDataForSeo({ keywords: ['x y'], country: null, timeRange: 'past_7_days', category: 0 }, failing, null), // prettier-ignore
    ).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
  });
});

describe('pytrends provider (fake service)', () => {
  it('is not configured without a service address', async () => {
    await withEnv({ PYTRENDS_SERVICE_URL: undefined }, async () => {
      const provider = new PytrendsProvider();
      expect(provider.configured().configured).toBe(false);
      await expect(provider.fetch(request)).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
    });
  });

  it('maps interest over time, regions, related queries and topics, sending the service token', async () => {
    await withEnv(PYTRENDS_ENV, async () => {
      const { fetchImpl, calls } = fakeService({
        '/interest-over-time': () => ({ body: interestBody }),
        '/interest-by-region': () => ({ body: regionsBody }),
        '/related': (body) => ({ body: relatedBody(String(body.keyword)) }),
      });
      const result = await new PytrendsProvider().fetch(request, { fetchImpl });
      expect(calls.map((c) => c.path)).toEqual(['/interest-over-time', '/interest-by-region', '/related', '/related', '/related']); // prettier-ignore
      expect(calls.every((c) => c.token === 'test-token')).toBe(true);
      expect(calls[0]!.body).toMatchObject({ geo: 'IN', timeframe: 'today 3-m', category: 293, hl: 'en-US' });
      expect(calls[1]!.body).toMatchObject({ resolution: 'REGION' });
      expect(calls[2]!.body).toMatchObject({ keyword: 'wedding invitation', kinds: ['queries', 'topics'] });
      expect(result.partial).toBe(false);
      expect(result.data.interest).toEqual({
        dates: ['2026-07-20', '2026-07-27'],
        series: [
          { keyword: 'wedding invitation', values: [50, 100], average: 75 },
          { keyword: 'digital invitation', values: [3, 5], average: 4 },
          { keyword: 'invitation card', values: [10, null], average: 10 },
        ],
        partial: [false, true],
      });
      expect(result.data.regions).toMatchObject({ comparison: 'share', regions: [{ geoCode: 'IN-GJ', values: [90, 4, 6] }, { name: 'Kerala' }] }); // prettier-ignore
      expect(result.data.related[1]).toEqual({ keyword: 'digital invitation', top: [{ query: 'digital invitation card', value: 100 }], rising: [{ query: 'digital invitation video', value: 'Breakout' }] }); // prettier-ignore
      expect(result.data.topics?.[0]).toEqual({ keyword: 'wedding invitation', top: [{ topic: 'Wedding', type: 'Topic', value: 100 }], rising: [] }); // prettier-ignore
      expect(result.operations.every((o) => o.outcome === 'SUCCESS')).toBe(true);
    });
  });

  it('keeps what it got when Google rate-limits a later request, and stops asking', async () => {
    await withEnv(PYTRENDS_ENV, async () => {
      let related = 0;
      const { fetchImpl, calls } = fakeService({
        '/interest-over-time': () => ({ body: interestBody }),
        '/interest-by-region': () => ({ body: regionsBody }),
        '/related': (body) =>
          ++related === 2
            ? { status: 429, body: { error: { code: 'RATE_LIMITED', message: 'Google Trends answered 429.', retryAfterSeconds: 900 } } } // prettier-ignore
            : { body: relatedBody(String(body.keyword)) },
      });
      const result = await new PytrendsProvider().fetch(request, { fetchImpl });
      // The third term is not requested once Google has rate-limited the second.
      expect(calls.filter((c) => c.path === '/related')).toHaveLength(2);
      expect(result.partial).toBe(true);
      expect(result.data.related.map((r) => r.keyword)).toEqual(['wedding invitation']);
      expect(result.limitations.join(' ')).toMatch(/rate-limiting requests from this server; try again in about 15 minutes/); // prettier-ignore
      expect(result.limitations.join(' ')).toMatch(/not fetched for “invitation card”/);
      expect(result.operations.map((o) => o.outcome)).toContain('RATE_LIMITED');
    });
  });

  it('fails clearly when interest over time cannot be fetched (rate limit, timeout, service down)', async () => {
    await withEnv(PYTRENDS_ENV, async () => {
      const limited = fakeService({
        '/interest-over-time': () => ({ status: 429, body: { error: { code: 'RATE_LIMITED', message: 'x', retryAfterSeconds: 120 } } }), // prettier-ignore
      });
      const error = await new PytrendsProvider().fetch(request, { fetchImpl: limited.fetchImpl }).catch((e: unknown) => e); // prettier-ignore
      expect(error).toBeInstanceOf(TrendProviderError);
      expect(error).toMatchObject({ code: 'RATE_LIMITED', retryAfterSeconds: 120, permanent: true });

      const slow: TrendsFetch = async () => {
        throw new DOMException('The operation timed out.', 'TimeoutError');
      };
      await expect(new PytrendsProvider().fetch(request, { fetchImpl: slow })).rejects.toMatchObject({ code: 'TIMEOUT', permanent: false }); // prettier-ignore

      const down: TrendsFetch = async () => {
        throw new TypeError('fetch failed');
      };
      await expect(new PytrendsProvider().fetch(request, { fetchImpl: down })).rejects.toMatchObject({ code: 'UNAVAILABLE' }); // prettier-ignore

      const wrongToken = fakeService({ '/interest-over-time': () => ({ status: 401, body: { error: { code: 'UNAUTHORIZED', message: 'x' } } }) }); // prettier-ignore
      await expect(new PytrendsProvider().fetch(request, { fetchImpl: wrongToken.fetchImpl })).rejects.toMatchObject({ code: 'NOT_CONFIGURED' }); // prettier-ignore
    });
  });

  it('reports health, including a cool-down after rate limiting', async () => {
    await withEnv(PYTRENDS_ENV, async () => {
      const ok: TrendsFetch = async () => new Response(JSON.stringify({ ok: true, robotsAllowed: true, coolingDownSeconds: 0, lastError: null })); // prettier-ignore
      expect(await new PytrendsProvider().health(ok)).toMatchObject({ ok: true, coolingDownSeconds: 0 });
      const cooling: TrendsFetch = async () => new Response(JSON.stringify({ ok: true, robotsAllowed: true, coolingDownSeconds: 600, lastError: 'RATE_LIMITED' })); // prettier-ignore
      expect(await new PytrendsProvider().health(cooling)).toMatchObject({
        ok: false,
        coolingDownSeconds: 600,
      });
      const blocked: TrendsFetch = async () => new Response(JSON.stringify({ ok: true, robotsAllowed: false, coolingDownSeconds: 0 })); // prettier-ignore
      expect(await new PytrendsProvider().health(blocked)).toMatchObject({ ok: false, lastError: expect.stringMatching(/robots\.txt/) }); // prettier-ignore
      const down: TrendsFetch = async () => {
        throw new TypeError('fetch failed');
      };
      expect(await new PytrendsProvider().health(down)).toMatchObject({ ok: false, lastError: 'The pytrends service is not reachable.' }); // prettier-ignore
    });
  });
});

describe('keyword opportunity scoring', () => {
  const keyword = {
    id: 'k1',
    phrase: 'wedding invitation maker',
    intent: null,
    priority: 'HIGH' as const,
    isPrimary: false,
    targetUrl: null,
    relatedQuestions: [],
    searchVolume: null,
    difficulty: null,
    metricsSource: null,
  };

  it('scores only the signals that exist and lists the missing ones', () => {
    const result = scoreKeyword(keyword, {
      trend: null,
      searchConsole: null,
      searchConsoleRange: null,
      pages: [],
    });
    // Only relevance (12 of 15) is available: no trend, Search Console, volume, competition or audit.
    expect(result.score).toBe(80);
    expect(result.confidence).toBe('low');
    expect(result.missing).toEqual(['Search trend', 'Search Console demand', 'Measured search volume', 'Competition', 'Content gap on your site']); // prettier-ignore
    expect(result.components.find((c) => c.key === 'volume')).toMatchObject({ available: false, points: 0, value: null }); // prettier-ignore
  });

  it('uses measured signals when they exist and suggests what to do', () => {
    const result = scoreKeyword(
      { ...keyword, searchVolume: 1000, difficulty: 30, metricsSource: 'Licensed provider' },
      {
        trend: { kind: 'rising_query', growth: 'Breakout', source: 'PYTRENDS', fetchedAt: new Date('2026-10-23T00:00:00Z'), place: 'IN' }, // prettier-ignore
        searchConsole: { clicks: 4, impressions: 900, ctr: 4 / 900, position: 2.1, rangeStart: '2026-09-20', rangeEnd: '2026-10-18' }, // prettier-ignore
        searchConsoleRange: { start: '2026-09-20', end: '2026-10-18' },
        pages: [],
      },
    );
    expect(result.confidence).toBe('high');
    expect(result.components.find((c) => c.key === 'trend')).toMatchObject({ available: true, points: 20, source: expect.stringMatching(/pytrends/) }); // prettier-ignore
    expect(result.components.find((c) => c.key === 'search_console')?.value).toMatch(/900 impressions/);
    expect(result.components.find((c) => c.key === 'competition')).toMatchObject({
      available: true,
      points: 7,
    });
    // Shown 900 times but rarely clicked: improve the title and description.
    expect(result.actions.map((a) => a.type)).toContain('update_page');
  });

  it('recommends new content for gaps, FAQs for questions and GEO coverage for comparisons', () => {
    const page = { url: 'https://s.test/', title: 'Home', h1: 'Home', headings: [], fields: { address: new Set<string>(), title: new Set(['home']), h1: new Set(['home']), heading: new Set<string>(), description: new Set<string>() }, phrases: [] }; // prettier-ignore
    const none = { trend: null, searchConsole: null, searchConsoleRange: null, pages: [page] };
    expect(scoreKeyword(keyword, none).actions[0]?.type).toBe('new_landing_page');
    expect(scoreKeyword({ ...keyword, phrase: 'how to word a wedding invitation' }, none).actions.map((a) => a.type)).toEqual(['new_article', 'faq', 'aeo_topic']); // prettier-ignore
    expect(scoreKeyword({ ...keyword, phrase: 'best wedding invitation apps' }, none).actions.map((a) => a.type)).toContain('geo_topic'); // prettier-ignore
    expect(scoreKeyword({ ...keyword, phrase: 'invitation printers near me' }, none).actions[0]?.type).toBe('local_page'); // prettier-ignore
  });
});

/** Suggests the homepage section for one term, and a page that does not exist for another. */
class FakePlacer implements LlmProvider {
  readonly key = 'openai' as const;
  readonly label = 'Fake';
  readonly isDevAdapter = false;
  async generateJson<T>(request: LlmJsonRequest<T>): Promise<LlmResult<T>> {
    const origin = /- (https?:\/\/[^/\s]+)\//.exec(request.user)![1]!;
    return {
      data: request.schema.parse({
        placements: [
          { term: 'video invitation maker', action: 'add_to_page', pageUrl: `${origin}/`, section: 'Video Invitations', newSection: null, spot: 'heading', suggestedText: 'Video invitation maker for [your event]', reason: 'The homepage has a video section.' },
          { term: 'housewarming invitation', action: 'add_to_page', pageUrl: `${origin}/does-not-exist`, section: null, newSection: null, spot: 'title', suggestedText: 'Housewarming invitation cards', reason: 'x' },
        ],
      }),
      provider: 'openai',
      model: 'fake-model',
      isDevAdapter: false,
      usage: { inputTokens: 10, outputTokens: 5 },
    }; // prettier-ignore
  }
}

describe('trends reports (MySQL)', () => {
  const prisma = getPrisma();
  afterAll(async () => {
    await disconnectPrisma();
  });

  async function makeProject(domainPrefix = 'trends') {
    const workspace = await prisma.workspace.create({
      data: { name: 'Trends WS', slug: `trends-${randomToken(6).toLowerCase()}` },
    });
    const origin = `https://${domainPrefix}-${randomToken(4).toLowerCase()}.test`;
    const project = await prisma.project.create({
      data: {
        workspaceId: workspace.id, name: 'Invites', websiteUrl: `${origin}/`, domain: new URL(origin).hostname,
        targetCountries: ['IN'], targetLanguages: ['en'], crawlSettings: DEFAULT_CRAWL_SETTINGS,
      },
    }); // prettier-ignore
    return { workspace, project, origin };
  }

  it('finds which searches the site targets and where to add the others', async () => {
    const { project, origin } = await makeProject();
    const crawl = await prisma.crawlJob.create({
      data: { projectId: project.id, startUrl: `${origin}/`, status: 'SUCCEEDED', finishedAt: new Date(), settings: DEFAULT_CRAWL_SETTINGS }, // prettier-ignore
    });
    const page = (path: string, title: string, h1: string, headings: string[]) =>
      prisma.crawledPage.create({
        data: {
          crawlJobId: crawl.id, url: `${origin}${path}`, urlHash: randomToken(32).slice(0, 64), depth: 1, source: 'LINK',
          statusCode: 200, isHtml: true, title, h1, headings: headings.map((text) => ({ level: 2, text })),
        },
      }); // prettier-ignore
    await page('/', 'Digital Wedding Invitations Online', 'Craft elegant digital invitations', ['Video Invitations', 'Birthday ideas']); // prettier-ignore
    await page('/blog/party-ideas', 'Party ideas', 'Party ideas', ['Housewarming invitation tips']);
    const data: TrendData = {
      interest: {
        dates: ['2026-07-20'],
        series: [
          { keyword: 'wedding invitation', values: [80], average: 80 },
          { keyword: 'housewarming invitation', values: [20], average: 20 },
        ],
      },
      related: [{ keyword: null, top: [{ query: 'video invitation maker', value: 60 }], rising: [{ query: 'birthday invitation', value: '+120%' }] }],
    }; // prettier-ignore
    // A report created before normalization keeps its data in the JSON column and still works.
    const report = await prisma.trendReport.create({
      data: {
        projectId: project.id, source: 'CSV_IMPORT', keywords: ['wedding invitation', 'housewarming invitation'],
        country: 'IN', timeRange: 'past_90_days', data: data as never, fetchedAt: new Date(),
      },
    }); // prettier-ignore

    const outcome = await executeTrendReport(prisma, report.id, { llm: new FakePlacer() });
    expect(outcome).toEqual({ terms: 4, placements: 1, partial: false });
    const stored = await prisma.trendReport.findUniqueOrThrow({ where: { id: report.id } });
    expect(stored.status).toBe('SUCCEEDED');
    const analysis = stored.analysis as unknown as TrendAnalysisResult;
    const term = (t: string) => analysis.terms.find((x) => x.term === t)!;
    expect(term('wedding invitation')).toMatchObject({ status: 'present', interest: 80, origin: 'keyword' });
    expect(term('wedding invitation').pages[0]).toMatchObject({ url: `${origin}/`, fields: ['title'] });
    expect(term('housewarming invitation')).toMatchObject({ status: 'partial' });
    expect(term('birthday invitation')).toMatchObject({ status: 'partial', rising: '+120%', pages: [] });
    expect(term('video invitation maker')).toMatchObject({ status: 'partial', origin: 'top_query' });
    expect(analysis.placements).toEqual([
      expect.objectContaining({ term: 'video invitation maker', pageUrl: `${origin}/`, section: 'Video Invitations', spot: 'heading' }), // prettier-ignore
    ]);
    expect(analysis.notes.join(' ')).toMatch(
      /dropped because they named a page or section that is not on your site/,
    );

    const saved = await saveTrendPlacementAsRecommendation(prisma, project.id, report.id, analysis.placements[0]!, term('video invitation maker')); // prettier-ignore
    const again = await saveTrendPlacementAsRecommendation(prisma, project.id, report.id, analysis.placements[0]!, term('video invitation maker')); // prettier-ignore
    expect(saved.created).toBe(true);
    expect(again).toEqual({ id: saved.id, created: false });
    const rec = await prisma.recommendation.findUniqueOrThrow({ where: { id: saved.id } });
    expect(rec).toMatchObject({ source: 'SEARCH_TRENDS', category: 'CONTENT', relatedUrl: `${origin}/` });
  });

  it('stores fetched data in normalized rows and reads it back unchanged', async () => {
    const { project } = await makeProject();
    const report = await prisma.trendReport.create({
      data: { projectId: project.id, source: 'PYTRENDS', keywords: ['wedding invitation', 'digital invitation'], country: 'IN', timeRange: 'past_7_days' }, // prettier-ignore
    });
    const data: TrendData = {
      interest: {
        dates: ['2026-10-16T09:00', '2026-10-16T10:00'],
        series: [
          { keyword: 'wedding invitation', values: [40, 100], average: 70 },
          { keyword: 'digital invitation', values: [null, 2], average: 2 },
        ],
        partial: [false, true],
      },
      related: [{ keyword: 'wedding invitation', top: [{ query: 'wedding card', value: 100 }], rising: [{ query: 'wedding video', value: 'Breakout' }] }], // prettier-ignore
      regions: { resolution: 'REGION', keywords: ['wedding invitation', 'digital invitation'], comparison: 'share', regions: [{ geoCode: 'IN-KL', name: 'Kerala', values: [97, 3] }, { geoCode: 'IN-GJ', name: 'Gujarat', values: [90, 10] }] }, // prettier-ignore
      topics: [{ keyword: 'wedding invitation', top: [{ topic: 'Wedding', type: 'Topic', value: 100 }], rising: [{ topic: 'Canva', type: 'Software company', value: '+300%' }] }], // prettier-ignore
    };
    await saveTrendData(prisma, report.id, data);
    expect(await loadTrendData(prisma, report)).toEqual(data);
    expect(await prisma.trendObservation.count({ where: { reportId: report.id } })).toBe(4);

    const copy = await prisma.trendReport.create({
      data: { projectId: project.id, source: 'PYTRENDS', keywords: ['digital invitation', 'wedding invitation'], country: 'IN', timeRange: 'past_7_days' }, // prettier-ignore
    });
    await copyTrendData(prisma, report.id, copy.id);
    const copied = await loadTrendData(prisma, copy);
    // Series follow the copy's own term order.
    expect(copied?.interest?.series.map((s) => s.keyword)).toEqual([
      'digital invitation',
      'wedding invitation',
    ]);
    expect(copied?.regions).toEqual({ ...data.regions, keywords: ['digital invitation', 'wedding invitation'], regions: [{ geoCode: 'IN-GJ', name: 'Gujarat', values: [10, 90] }, { geoCode: 'IN-KL', name: 'Kerala', values: [3, 97] }] }); // prettier-ignore

    const csv = trendReportCsv({ source: 'PYTRENDS', fetchedAt: new Date('2026-10-16T11:00:00Z'), country: 'IN', region: null, timeRange: 'past_7_days', category: 0 }, data, null, 'interest'); // prettier-ignore
    const lines = csv.trim().split('\r\n');
    expect(lines[0]).toBe(
      'period,term,relative_interest_0_100,is_partial,source,retrieved_at,place,time_range,category',
    );
    expect(lines[1]).toBe('2026-10-16T09:00,wedding invitation,40,no,"Google Trends via pytrends (unofficial, experimental)",2026-10-16T11:00:00.000Z,IN,past_7_days,0'); // prettier-ignore
    const regionsCsv = trendReportCsv({ source: 'PYTRENDS', fetchedAt: null, country: 'IN', region: null, timeRange: 'past_7_days', category: 0 }, data, null, 'regions'); // prettier-ignore
    expect(regionsCsv.split('\r\n')[0]).toMatch(/^place,place_code,term,share_of_compared_terms_percent,/);
  });

  it('fetches from pytrends, records each request and keeps the data for reuse', async () => {
    await withEnv(PYTRENDS_ENV, async () => {
      const { project } = await makeProject();
      const report = await prisma.trendReport.create({
        data: { projectId: project.id, source: 'PYTRENDS', keywords: request.keywords, country: 'IN', timeRange: 'past_90_days', category: 293, include: request.include }, // prettier-ignore
      });
      const { fetchImpl } = fakeService({
        '/interest-over-time': () => ({ body: interestBody }),
        '/interest-by-region': () => ({ body: regionsBody }),
        '/related': (body) => ({ body: relatedBody(String(body.keyword)) }),
      });
      const outcome = await executeTrendReport(prisma, report.id, { fetchImpl, llm: null });
      expect(outcome.partial).toBe(false);
      const stored = await prisma.trendReport.findUniqueOrThrow({ where: { id: report.id } });
      expect(stored.data).toBeNull();
      expect(stored.fetchedAt).not.toBeNull();
      expect(stored.expiresAt!.getTime() - stored.fetchedAt!.getTime()).toBe(12 * 3600 * 1000);
      expect((await loadTrendData(prisma, stored))?.related).toHaveLength(3);
      const events = await prisma.trendProviderEvent.findMany({ where: { reportId: report.id } });
      expect(events.map((e) => e.outcome)).toEqual(['SUCCESS', 'SUCCESS', 'SUCCESS', 'SUCCESS', 'SUCCESS']);
      expect(await prisma.providerUsageEvent.count({ where: { projectId: project.id, provider: 'pytrends', requests: 5 } })).toBe(1); // prettier-ignore
      // Search Console has no data for this project: the terms say so, and nothing is filled in.
      const analysis = stored.analysis as unknown as TrendAnalysisResult;
      expect(analysis.terms.every((t) => t.searchConsole === null)).toBe(true);
      expect(analysis.method.searchConsole).toEqual({ connected: false, rangeStart: null, rangeEnd: null });
    });
  });

  it('records a rate-limited fetch as a provider event and fails without data', async () => {
    await withEnv(PYTRENDS_ENV, async () => {
      const { project } = await makeProject();
      const report = await prisma.trendReport.create({
        data: { projectId: project.id, source: 'PYTRENDS', keywords: ['wedding invitation'], country: 'IN', timeRange: 'past_90_days' }, // prettier-ignore
      });
      const { fetchImpl } = fakeService({
        '/interest-over-time': () => ({ status: 429, body: { error: { code: 'RATE_LIMITED', message: 'x', retryAfterSeconds: 900 } } }), // prettier-ignore
      });
      await expect(executeTrendReport(prisma, report.id, { fetchImpl, llm: null })).rejects.toMatchObject({ code: 'RATE_LIMITED' }); // prettier-ignore
      expect(await prisma.trendObservation.count({ where: { reportId: report.id } })).toBe(0);
      const event = await prisma.trendProviderEvent.findFirstOrThrow({ where: { reportId: report.id } });
      expect(event).toMatchObject({
        provider: 'PYTRENDS',
        outcome: 'RATE_LIMITED',
        workspaceId: project.workspaceId,
      });
      expect(event.message).toMatch(/rate-limiting/);
    });
  });

  it('fetches live data first for DataForSEO reports', async () => {
    const { project } = await makeProject('live');
    const report = await prisma.trendReport.create({
      data: { projectId: project.id, source: 'DATAFORSEO', keywords: ['digital invitation'], country: 'IN', timeRange: 'past_30_days' }, // prettier-ignore
    });
    const fake: TrendsFetch = async (_url, init) => {
      const kind = (JSON.parse(String(init.body)) as { item_types: string[] }[])[0]!.item_types[0];
      const items = kind === 'google_trends_graph'
        ? [{ type: 'google_trends_graph', keywords: ['digital invitation'], data: [{ date_from: '2026-09-01', values: [70] }] }]
        : [{ type: 'google_trends_queries_list', data: { top: [], rising: [] } }]; // prettier-ignore
      return new Response(JSON.stringify({ status_code: 20000, status_message: 'Ok.', tasks: [{ status_code: 20000, status_message: 'Ok.', cost: 0.009, result: [{ items }] }] })); // prettier-ignore
    };
    await executeTrendReport(prisma, report.id, { fetchImpl: fake, credentials: { login: 'a', password: 'b' }, llm: null }); // prettier-ignore
    const stored = await prisma.trendReport.findUniqueOrThrow({ where: { id: report.id } });
    expect(stored).toMatchObject({ status: 'SUCCEEDED' });
    expect(stored.fetchedAt).not.toBeNull();
    expect((await loadTrendData(prisma, stored))?.interest?.series[0]).toMatchObject({ keyword: 'digital invitation', average: 70 }); // prettier-ignore
    const analysis = stored.analysis as unknown as TrendAnalysisResult;
    expect(analysis.terms[0]).toMatchObject({ term: 'digital invitation', status: 'missing' });
    expect(analysis.notes.join(' ')).toMatch(/no completed audit/);
    expect(await prisma.providerUsageEvent.count({ where: { projectId: project.id, provider: 'dataforseo', requests: 2 } })).toBe(1); // prettier-ignore
  });

  it('refreshes saved comparisons on schedule, once per due date, without AI suggestions', async () => {
    await withEnv({ TRENDS_PROVIDERS: 'csv,fixture' }, async () => {
      const { project } = await makeProject();
      const saved = await prisma.trendSavedQuery.create({
        data: { projectId: project.id, name: 'Wedding terms', keywords: ['wedding invitation'], country: 'IN', timeRange: 'past_90_days', provider: 'FIXTURE', schedule: 'WEEKLY', nextRunAt: new Date(Date.now() - 1000) }, // prettier-ignore
      });
      const queues = new MemoryQueueGateway();
      const first = await runScheduledTrendRefreshes({ prisma, queues });
      expect(first.started).toBeGreaterThanOrEqual(1);
      const report = await prisma.trendReport.findFirstOrThrow({ where: { savedQueryId: saved.id } });
      expect(report).toMatchObject({ trigger: 'SCHEDULED', suggestPlacements: false, source: 'FIXTURE' });
      expect(queues.jobs.find((j) => j.queue === 'trends')?.data).toMatchObject({ trendReportId: report.id });
      const next = await prisma.trendSavedQuery.findUniqueOrThrow({ where: { id: saved.id } });
      expect(next.nextRunAt!.getTime()).toBeGreaterThan(Date.now() + 6 * 24 * 3600 * 1000);
      await runScheduledTrendRefreshes({ prisma, queues });
      expect(await prisma.trendReport.count({ where: { savedQueryId: saved.id } })).toBe(1);
      // No AI keyword run is used by scheduled refreshes.
      expect(await prisma.usageRecord.count({ where: { idempotencyKey: `trends:${report.id}` } })).toBe(0);
      await executeTrendReport(prisma, report.id, { llm: null });
      expect((await prisma.trendSavedQuery.findUniqueOrThrow({ where: { id: saved.id } })).lastReportId).toBe(report.id); // prettier-ignore
    });
  });

  it('scores keywords from the newest trends report that mentions them and from Search Console', async () => {
    const { project } = await makeProject();
    await prisma.projectKeyword.createMany({
      data: [
        { projectId: project.id, phrase: 'video invitation maker', normalizedPhrase: 'video invitation maker', country: 'IN', language: 'en', priority: 'HIGH' }, // prettier-ignore
        { projectId: project.id, phrase: 'haldi invitation', normalizedPhrase: 'haldi invitation', country: 'IN', language: 'en' }, // prettier-ignore
      ],
    });
    const report = await prisma.trendReport.create({
      data: { projectId: project.id, source: 'CSV_IMPORT', status: 'SUCCEEDED', keywords: ['wedding invitation'], country: 'IN', timeRange: 'past_90_days', fetchedAt: new Date() }, // prettier-ignore
    });
    await saveTrendData(prisma, report.id, {
      interest: {
        dates: ['2026-07-20'],
        series: [{ keyword: 'wedding invitation', values: [80], average: 80 }],
      },
      related: [{ keyword: 'wedding invitation', top: [], rising: [{ query: 'video invitation maker', value: 'Breakout' }] }], // prettier-ignore
    });
    const integration = await prisma.integration.create({
      data: { workspaceId: project.workspaceId, projectId: project.id, provider: 'GOOGLE_SEARCH_CONSOLE', status: 'CONNECTED', externalAccount: 'sc-domain:x' }, // prettier-ignore
    });
    await prisma.searchConsoleMetric.create({
      data: { projectId: project.id, integrationId: integration.id, dimension: 'QUERY', rangeStart: new Date('2026-09-20'), rangeEnd: new Date('2026-10-18'), key: 'video invitation maker', keyHash: randomToken(32).slice(0, 64), clicks: 12, impressions: 640, ctr: 12 / 640, position: 8.4 }, // prettier-ignore
    });
    const result = await keywordOpportunities(prisma, project.id);
    const video = result.items.find((i) => i.phrase === 'video invitation maker')!;
    const haldi = result.items.find((i) => i.phrase === 'haldi invitation')!;
    expect(video.components.find((c) => c.key === 'trend')).toMatchObject({ available: true, value: 'Rising related search (Breakout)' }); // prettier-ignore
    expect(video.components.find((c) => c.key === 'search_console')).toMatchObject({ available: true, source: 'Google Search Console, 2026-09-20 to 2026-10-18' }); // prettier-ignore
    // Search Console is synced, so "no impressions" is a measured zero for the other keyword; its trend is unknown.
    expect(haldi.components.find((c) => c.key === 'search_console')).toMatchObject({ available: true, points: 0, value: 'No impressions' }); // prettier-ignore
    expect(haldi.missing).toContain('Search trend');
    expect(result.signals.searchConsoleRange).toEqual({ start: '2026-09-20', end: '2026-10-18' });
    expect(result.items[0]!.phrase).toBe('video invitation maker');
  });
});
