import { disconnectPrisma } from '@surfaced/core/db';
import { resetEnvCache } from '@surfaced/core/env';
import { executeTrendReport, resetTrendHealthCache } from '@surfaced/core/trends';
import type { TrendProviderStatusDto } from '@surfaced/shared';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createTestApp, registerClient } from './helpers';

const { app, queues, prisma } = createTestApp();

afterAll(async () => {
  await disconnectPrisma();
});

const saved = { ...process.env };
function setEnv(vars: Record<string, string>) {
  Object.assign(process.env, vars);
  resetEnvCache();
  resetTrendHealthCache();
}
afterEach(() => {
  for (const key of ['TRENDS_PROVIDERS', 'TRENDS_LIVE_REPORTS_PER_WORKSPACE_PER_DAY', 'PYTRENDS_SERVICE_URL'])
    process.env[key] = saved[key] ?? '';
  resetEnvCache();
  resetTrendHealthCache();
});

async function setup(domain = `acme-invites-${Math.random().toString(36).slice(2, 8)}.example.com`) {
  const owner = await registerClient(app);
  const res = await owner.client.post('/projects', {
    workspaceId: owner.workspaceId,
    name: 'Acme Invites',
    websiteUrl: domain,
    targetCountries: ['IN'],
    targetLanguages: ['en'],
  });
  return { ...owner, projectId: res.body.data.id as string };
}

const interestCsv = [
  'Category: All categories',
  '',
  'Week,wedding invitation: (India),housewarming invitation: (India)',
  '2026-07-20,54,3',
  '2026-07-27,100,5',
].join('\n');
const regionCsv = [
  'Region,wedding invitation: (20/07/2026 - 27/07/2026),housewarming invitation: (20/07/2026 - 27/07/2026)',
  'Kerala,97%,3%',
  'Gujarat,90%,10%',
].join('\n');
const relatedCsv = [
  'TOP',
  'wedding invitation card,100',
  '',
  'RISING',
  'video wedding invitation,Breakout',
].join('\n');

describe('keyword trends API', () => {
  it('reports each data source and refuses live data clearly when none is available', async () => {
    const { client, projectId } = await setup();
    const res = await client.get(`/projects/${projectId}/trends/status`);
    const providers = res.body.data.providers as TrendProviderStatusDto[];
    expect(providers.map((p) => [p.key, p.configured, p.available])).toEqual([
      ['PYTRENDS', false, false],
      ['DATAFORSEO', false, false],
      ['GOOGLE_TRENDS_API', false, false],
      ['CSV_IMPORT', true, true],
    ]);
    expect(providers.find((p) => p.key === 'PYTRENDS')).toMatchObject({ experimental: true, paid: false });
    expect(res.body.data).toMatchObject({
      defaultProvider: null,
      searchConsole: { connected: false },
      keywordPlanner: { configured: false },
      limits: { liveReportsToday: 0, liveReportsPerWorkspacePerDay: 30 },
    });
    const live = await client.post(`/projects/${projectId}/trends`, { keywords: ['wedding invitation'] });
    expect(live.status).toBe(503);
    expect(live.body.error.code).toBe('PROVIDER_NOT_CONFIGURED');
    // The official API alpha is never claimed: it is reported as not configured.
    const official = await client.post(`/projects/${projectId}/trends`, { keywords: ['wedding invitation'], provider: 'GOOGLE_TRENDS_API' }); // prettier-ignore
    expect(official.status).toBe(503);
    // The fixture is off unless the administrator allows it.
    const fixture = await client.post(`/projects/${projectId}/trends`, { keywords: ['wedding invitation'], provider: 'FIXTURE' }); // prettier-ignore
    expect(fixture.status).toBe(400);
    expect(fixture.body.error.message).toMatch(/turned off/);
  });

  it('reports a pytrends service that is configured but not running', async () => {
    setEnv({ PYTRENDS_SERVICE_URL: 'http://127.0.0.1:4598' });
    const { client, projectId } = await setup();
    const res = await client.get(`/projects/${projectId}/trends/status`);
    const pytrends = (res.body.data.providers as TrendProviderStatusDto[]).find((p) => p.key === 'PYTRENDS')!;
    expect(pytrends).toMatchObject({ configured: true, available: false, health: { ok: false, lastError: 'The pytrends service is not reachable.' } }); // prettier-ignore
    const live = await client.post(`/projects/${projectId}/trends`, { keywords: ['wedding invitation'], provider: 'PYTRENDS' }); // prettier-ignore
    expect(live.status).toBe(503);
    expect(live.body.error.message).toMatch(/not available right now/);
  });

  it('previews and imports Google Trends CSV files, compares them with the site and exports them', async () => {
    const { client, projectId } = await setup();
    expect((await client.get(`/projects/${projectId}/trends/latest`)).body.data).toBeNull();
    const files = [
      { name: 'multiTimeline.csv', content: interestCsv },
      { name: 'geoMap.csv', content: regionCsv },
      { name: 'relatedQueries.csv', content: relatedCsv, keyword: 'wedding invitation' },
    ];
    const preview = await client.post(`/projects/${projectId}/trends/import/preview`, { files });
    expect(preview.status).toBe(200);
    expect(preview.body.data.files.map((f: { kind: string }) => f.kind)).toEqual(['interest_over_time', 'interest_by_region', 'related_queries']); // prettier-ignore
    expect(await prisma.trendReport.count({ where: { projectId } })).toBe(0);

    const res = await client.post(`/projects/${projectId}/trends/import`, { country: 'IN', timeRange: 'past_90_days', category: 293, files }); // prettier-ignore
    expect(res.status).toBe(202);
    const { reportId, jobId } = res.body.data as { reportId: string; jobId: string };
    expect(queues.jobs.find((j) => j.jobId === jobId)).toMatchObject({ queue: 'trends', data: { trendReportId: reportId } }); // prettier-ignore
    expect(await prisma.usageRecord.count({ where: { idempotencyKey: `trends:${reportId}`, metric: 'KEYWORD_SUGGESTION' } })).toBe(1); // prettier-ignore
    expect(await prisma.trendCsvImport.count({ where: { reportId } })).toBe(3);
    expect((await client.post(`/projects/${projectId}/trends/import`, { files: [{ name: 'a.csv', content: interestCsv }] })).status).toBe(409); // prettier-ignore

    const queued = (await client.get(`/projects/${projectId}/trends/latest`)).body.data;
    expect(queued).toMatchObject({
      status: 'QUEUED',
      source: 'CSV_IMPORT',
      sourceType: 'CSV',
      freshness: 'imported',
      keywords: ['wedding invitation', 'housewarming invitation'],
      include: ['interest', 'regions', 'related_queries'],
      imports: [{ fileName: 'multiTimeline.csv', kind: 'interest_over_time', rows: 2 }, { fileName: 'geoMap.csv', kind: 'interest_by_region', rows: 2 }, { fileName: 'relatedQueries.csv', kind: 'related_queries', rows: 2 }], // prettier-ignore
      exploreUrl:
        'https://trends.google.com/explore?geo=IN&date=today%203-m&cat=293&q=wedding%2520invitation%2Chousewarming%2520invitation',
    });
    expect(queued.data.related[0]).toEqual({ keyword: 'wedding invitation', top: [{ query: 'wedding invitation card', value: 100 }], rising: [{ query: 'video wedding invitation', value: 'Breakout' }] }); // prettier-ignore
    expect(queued.data.regions).toMatchObject({ comparison: 'share', regions: [{ name: 'Kerala', values: [97, 3] }, { name: 'Gujarat', values: [90, 10] }] }); // prettier-ignore
    expect(queued.limitations.join(' ')).toMatch(/not search counts/);
    expect(queued.limitations.join(' ')).toMatch(/split between the terms/);

    await executeTrendReport(prisma, reportId, { llm: null });
    const done = (await client.get(`/projects/${projectId}/trends/reports/${reportId}`)).body.data;
    expect(done.status).toBe('SUCCEEDED');
    expect(done.analysis.terms.map((t: { term: string }) => t.term)).toEqual(['wedding invitation', 'housewarming invitation', 'wedding invitation card', 'video wedding invitation']); // prettier-ignore
    expect(done.analysis.notes.join(' ')).toMatch(/no completed audit/);
    expect((await client.get(`/projects/${projectId}/trends/reports`)).body.data).toMatchObject([{ id: reportId, cached: false, partial: false }]); // prettier-ignore
    expect((await client.post(`/projects/${projectId}/trends/reports/${reportId}/recommendations`, { term: 'x' })).status).toBe(404); // prettier-ignore

    const csv = await client.get(`/projects/${projectId}/trends/reports/${reportId}/export?part=regions`);
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.text.split('\r\n')[0]).toBe('place,place_code,term,share_of_compared_terms_percent,source,retrieved_at,place,time_range,category'); // prettier-ignore
    expect(csv.text).toMatch(/Kerala,,wedding invitation,97,CSV exported from Google Trends,/);
  });

  it('rejects files that are not Google Trends exports', async () => {
    const { client, projectId } = await setup();
    const res = await client.post(`/projects/${projectId}/trends/import`, { files: [{ name: 'contacts.csv', content: 'name,email\nA,a@example.test' }] }); // prettier-ignore
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/could not be read/);
  });

  it('counts reports against the monthly AI keyword quota and keeps reports inside their tenant', async () => {
    const { client, projectId } = await setup();
    // The Free plan includes 3 AI keyword runs a month.
    for (let i = 0; i < 3; i++) {
      const res = await client.post(`/projects/${projectId}/trends/import`, { files: [{ name: 'a.csv', content: interestCsv }] }); // prettier-ignore
      expect(res.status).toBe(202);
      await executeTrendReport(prisma, res.body.data.reportId as string, { llm: null });
    }
    const over = await client.post(`/projects/${projectId}/trends/import`, { files: [{ name: 'a.csv', content: interestCsv }] }); // prettier-ignore
    expect(over.status).toBe(402);
    // Without AI placement suggestions, no AI keyword run is used.
    const free = await client.post(`/projects/${projectId}/trends/import`, { suggestPlacements: false, files: [{ name: 'a.csv', content: interestCsv }] }); // prettier-ignore
    expect(free.status).toBe(202);

    const outsider = await registerClient(app);
    expect((await outsider.client.get(`/projects/${projectId}/trends/latest`)).status).toBe(404);
    expect((await outsider.client.get(`/projects/${projectId}/trends/reports/${free.body.data.reportId}/export`)).status).toBe(404); // prettier-ignore
    expect((await outsider.client.post(`/projects/${projectId}/trends/import`, { files: [{ name: 'a.csv', content: interestCsv }] })).status).toBe(404); // prettier-ignore
  });

  it('fetches live data, reuses it for identical requests in other workspaces and limits live lookups', async () => {
    setEnv({ TRENDS_PROVIDERS: 'csv,fixture', TRENDS_LIVE_REPORTS_PER_WORKSPACE_PER_DAY: '1' });
    const first = await setup();
    const keywords = [`wedding invitation ${Math.random().toString(36).slice(2, 6)}`];
    const res = await first.client.post(`/projects/${first.projectId}/trends`, { keywords, country: 'IN', region: 'IN-GJ' }); // prettier-ignore
    expect(res.status).toBe(202);
    expect(res.body.data).toMatchObject({ cached: false });
    await executeTrendReport(prisma, res.body.data.reportId, { llm: null });
    const report = (await first.client.get(`/projects/${first.projectId}/trends/reports/${res.body.data.reportId}`)).body.data; // prettier-ignore
    expect(report).toMatchObject({ status: 'SUCCEEDED', source: 'FIXTURE', sourceType: 'FIXTURE', region: 'IN-GJ', freshness: 'fresh', cached: false }); // prettier-ignore
    expect(report.limitations.join(' ')).toMatch(/not real Google Trends data/);
    expect(report.data.interest.series[0].keyword).toBe(keywords[0]);
    expect(report.data.regions.resolution).toBe('CITY');

    // Another workspace asking for the same comparison gets a copy of the data, not the other tenant's report.
    const second = await setup();
    const again = await second.client.post(`/projects/${second.projectId}/trends`, { keywords, country: 'IN', region: 'IN-GJ' }); // prettier-ignore
    expect(again.body.data).toMatchObject({ cached: true });
    await executeTrendReport(prisma, again.body.data.reportId, { llm: null });
    const copy = (await second.client.get(`/projects/${second.projectId}/trends/reports/${again.body.data.reportId}`)).body.data; // prettier-ignore
    expect(copy).toMatchObject({ cached: true, projectId: second.projectId, fetchedAt: report.fetchedAt });
    expect(copy.data.interest).toEqual(report.data.interest);
    expect(JSON.stringify(copy)).not.toContain(report.id);
    expect(JSON.stringify(copy)).not.toContain(first.projectId);

    // The fixture costs nothing, so it is not limited; a real provider is (checked through the limit counter).
    const status = (await second.client.get(`/projects/${second.projectId}/trends/status`)).body.data;
    expect(status).toMatchObject({ defaultProvider: 'FIXTURE', limits: { liveReportsToday: 0, liveReportsPerWorkspacePerDay: 1 } }); // prettier-ignore
    // A region outside the country is refused.
    expect((await second.client.post(`/projects/${second.projectId}/trends`, { keywords, country: 'US', region: 'IN-GJ' })).status).toBe(400); // prettier-ignore
  });

  it('saves report terms to keywords and lists, and plans content with a brief and a task', async () => {
    setEnv({ TRENDS_PROVIDERS: 'csv,fixture' });
    const { client, projectId } = await setup();
    const res = await client.post(`/projects/${projectId}/trends`, { keywords: ['wedding invitation'], country: 'IN', suggestPlacements: false }); // prettier-ignore
    const reportId = res.body.data.reportId as string;
    expect((await client.post(`/projects/${projectId}/trends/reports/${reportId}/keywords`, { terms: ['wedding invitation'] })).status).toBe(409); // prettier-ignore
    await executeTrendReport(prisma, reportId, { llm: null });

    const save = await client.post(`/projects/${projectId}/trends/reports/${reportId}/keywords`, {
      terms: ['wedding invitation', 'how to make wedding invitation', 'not in this report'],
      listName: 'Trends: weddings',
      priority: 'HIGH',
    });
    expect(save.status).toBe(200);
    expect(save.body.data).toMatchObject({ created: 2, skipped: 0, unknown: ['not in this report'] });
    const kept = await prisma.projectKeyword.findMany({ where: { projectId }, include: { list: true }, orderBy: { phrase: 'asc' } }); // prettier-ignore
    expect(kept.map((k) => [k.phrase, k.source, k.priority, k.list?.name])).toEqual([
      ['how to make wedding invitation', 'PROVIDER', 'HIGH', 'Trends: weddings'],
      ['wedding invitation', 'PROVIDER', 'HIGH', 'Trends: weddings'],
    ]);
    expect(kept[0]!.notes).toMatch(/From Google Trends \(Development fixture \(not real Google data\)\), India, past 90 days, retrieved \d{4}-\d{2}-\d{2}\. Rising related search \(Breakout\)\./); // prettier-ignore
    const twice = await client.post(`/projects/${projectId}/trends/reports/${reportId}/keywords`, { terms: ['wedding invitation'] }); // prettier-ignore
    expect(twice.body.data).toMatchObject({ created: 0, skipped: 1 });

    const plan = await client.post(`/projects/${projectId}/trends/reports/${reportId}/briefs`, { term: 'how to make wedding invitation', dueDate: '2026-11-30' }); // prettier-ignore
    expect(plan.status).toBe(201);
    const brief = await prisma.contentBrief.findUniqueOrThrow({ where: { id: plan.body.data.briefId } });
    expect(brief).toMatchObject({ projectId, primaryKeyword: 'how to make wedding invitation', searchIntent: 'INFORMATIONAL', country: 'IN' }); // prettier-ignore
    expect(brief.notes).toMatch(/Rising related search: Breakout/);
    const task = await prisma.task.findUniqueOrThrow({ where: { id: plan.body.data.taskId } });
    expect(task).toMatchObject({
      type: 'CONTENT',
      entityType: 'ContentBrief',
      entityId: brief.id,
      projectId,
    });
    expect(task.dueDate?.toISOString().slice(0, 10)).toBe('2026-11-30');
    expect((await client.post(`/projects/${projectId}/trends/reports/${reportId}/briefs`, { term: 'unrelated' })).status).toBe(404); // prettier-ignore
  });

  it('saves comparisons with refresh schedules and runs them on request', async () => {
    setEnv({ TRENDS_PROVIDERS: 'csv,fixture' });
    const { client, projectId } = await setup();
    const created = await client.post(`/projects/${projectId}/trends/saved`, { name: 'Weddings', keywords: ['wedding invitation'], country: 'IN', schedule: 'WEEKLY' }); // prettier-ignore
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({
      name: 'Weddings',
      schedule: 'WEEKLY',
      timeRange: 'past_90_days',
    });
    expect(Date.parse(created.body.data.nextRunAt)).toBeGreaterThan(Date.now() + 6 * 24 * 3600 * 1000);
    expect((await client.post(`/projects/${projectId}/trends/saved`, { name: 'Weddings', keywords: ['x y'] })).status).toBe(409); // prettier-ignore
    const id = created.body.data.id as string;
    const updated = await client.patch(`/projects/${projectId}/trends/saved/${id}`, { schedule: 'NONE' });
    expect(updated.body.data).toMatchObject({ schedule: 'NONE', nextRunAt: null });
    const run = await client.post(`/projects/${projectId}/trends/saved/${id}/run`);
    expect(run.status).toBe(202);
    expect(await prisma.trendReport.findUniqueOrThrow({ where: { id: run.body.data.reportId } })).toMatchObject({ savedQueryId: id, trigger: 'MANUAL' }); // prettier-ignore
    expect((await client.get(`/projects/${projectId}/trends/saved`)).body.data).toHaveLength(1);

    const outsider = await registerClient(app);
    expect((await outsider.client.delete(`/projects/${projectId}/trends/saved/${id}`)).status).toBe(404);
    expect((await client.delete(`/projects/${projectId}/trends/saved/${id}`)).status).toBe(204);
  });

  it('filters by city with searches that mention it, in the city’s state', async () => {
    setEnv({ TRENDS_PROVIDERS: 'csv,fixture' });
    const { client, projectId } = await setup();
    const res = await client.post(`/projects/${projectId}/trends`, { keywords: ['wedding card', 'haldi card surat'], country: 'IN', city: 'Surat', suggestPlacements: false }); // prettier-ignore
    expect(res.status).toBe(202);
    await executeTrendReport(prisma, res.body.data.reportId, { llm: null });
    const report = (await client.get(`/projects/${projectId}/trends/reports/${res.body.data.reportId}`)).body
      .data;
    expect(report).toMatchObject({ city: 'Surat', region: 'IN-GJ', keywords: ['wedding card surat', 'haldi card surat'] }); // prettier-ignore
    expect(report.data.interest.series.map((s: { keyword: string }) => s.keyword)).toEqual(['wedding card surat', 'haldi card surat']); // prettier-ignore
    expect(report.limitations.join(' ')).toMatch(/searches that mention “Surat”, measured across Gujarat, India, not every search made in Surat/); // prettier-ignore
    expect(report.exploreUrl).toContain('geo=IN-GJ');
    const csv = await client.get(`/projects/${projectId}/trends/reports/${report.id}/export?part=interest`);
    expect(csv.text.split('\n')[1]).toContain('searches mentioning Surat in IN-GJ');
    // A state that does not contain the city is refused.
    const wrong = await client.post(`/projects/${projectId}/trends`, { keywords: ['wedding card'], country: 'IN', region: 'IN-MH', city: 'Surat' }); // prettier-ignore
    expect(wrong.status).toBe(400);

    const saved = await client.post(`/projects/${projectId}/trends/saved`, { name: 'Surat cards', keywords: ['wedding card'], country: 'IN', city: 'Surat' }); // prettier-ignore
    expect(saved.body.data).toMatchObject({ city: 'Surat', region: 'IN-GJ', keywords: ['wedding card'] });
  });

  it('lists the Google Trends categories', async () => {
    const { client, projectId } = await setup();
    const res = await client.get(`/projects/${projectId}/trends/categories`);
    expect(res.body.data.categories.find((c: [number, string, string]) => c[0] === 293)).toEqual([293, 'Weddings', 'Hobbies & Leisure > Special Occasions']); // prettier-ignore
  });
});

describe('keyword opportunities API', () => {
  it('scores the project keywords and stays inside the tenant', async () => {
    const { client, projectId } = await setup();
    await client.post(`/projects/${projectId}/keywords`, { phrase: 'digital wedding invitation', country: 'IN', language: 'en', priority: 'HIGH' }); // prettier-ignore
    const res = await client.get(`/projects/${projectId}/keywords/opportunities`);
    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(1);
    expect(res.body.data.items[0]).toMatchObject({
      phrase: 'digital wedding invitation',
      confidence: 'low',
      score: 80,
    });
    expect(res.body.data.items[0].missing).toContain('Measured search volume');
    expect(res.body.data.signals).toEqual({ trendsReportAt: null, searchConsoleRange: null, measuredMetrics: false, crawlFinishedAt: null }); // prettier-ignore
    const outsider = await registerClient(app);
    expect((await outsider.client.get(`/projects/${projectId}/keywords/opportunities`)).status).toBe(404);
  });
});
