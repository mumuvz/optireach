import type { LlmJsonRequest, LlmProvider, LlmResult } from '@surfaced/core/ai';
import { disconnectPrisma } from '@surfaced/core/db';
import { JobTracker } from '@surfaced/core/jobs';
import { executeKeywordSuggestions } from '@surfaced/core/keywords';
import type { ContentJobData } from '@surfaced/core/queue';
import { DEFAULT_CRAWL_SETTINGS } from '@surfaced/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { createTestApp, registerClient } from './helpers';

const { app, queues, prisma } = createTestApp();

afterAll(async () => {
  await disconnectPrisma();
});

async function setup() {
  const owner = await registerClient(app);
  const project = await owner.client.post('/projects', {
    workspaceId: owner.workspaceId,
    name: 'Brew Co',
    websiteUrl: 'brewco.example.com',
    targetCountries: ['GB'],
    targetLanguages: ['en'],
  });
  return { ...owner, projectId: project.body.data.id as string };
}

describe('keyword management', () => {
  it('creates, filters, updates and deletes keywords without inventing metrics', async () => {
    const { client, projectId } = await setup();
    const created = await client.post(`/projects/${projectId}/keywords`, {
      phrase: 'Cold brew coffee',
      intent: 'INFORMATIONAL',
      country: 'GB',
      language: 'en',
      priority: 'HIGH',
      relatedQuestions: ['How long does cold brew last?'],
    });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ phrase: 'Cold brew coffee', metrics: null, source: 'MANUAL' });
    const dup = await client.post(`/projects/${projectId}/keywords`, {
      phrase: '  cold   BREW coffee ',
      country: 'GB',
      language: 'en',
    });
    expect(dup.status).toBe(409);
    await client.post(`/projects/${projectId}/keywords`, {
      phrase: 'buy coffee beans',
      intent: 'TRANSACTIONAL',
      country: 'GB',
      language: 'en',
    });

    const filtered = await client.get(`/projects/${projectId}/keywords?intent=TRANSACTIONAL`);
    expect(filtered.body.data.map((k: { phrase: string }) => k.phrase)).toEqual(['buy coffee beans']);
    const updated = await client.patch(`/keywords/${created.body.data.id}`, {
      status: 'PLANNED',
      targetUrl: 'https://brewco.example.com/cold-brew',
    });
    expect(updated.body.data).toMatchObject({
      status: 'PLANNED',
      targetUrl: 'https://brewco.example.com/cold-brew',
    });
    expect((await client.delete(`/keywords/${created.body.data.id}`)).status).toBe(204);

    const status = await client.get('/keywords/provider-status');
    expect(status.body.data.keywordData.configured).toBe(false);
    expect(status.body.data.keywordData.detail).toMatch(/never estimated/);
    // Every LLM provider is listed so the client can offer the configured ones and compare them. In tests only
    // the development adapter is configured, and it is the default.
    const providers = status.body.data.llmProviders as {
      key: string;
      configured: boolean;
      isDefault: boolean;
    }[];
    expect(providers.map((p) => p.key)).toEqual(['openai', 'gemini', 'dev']);
    expect(providers.find((p) => p.key === 'dev')).toMatchObject({ configured: true, isDefault: true });
    expect(providers.find((p) => p.key === 'openai')).toMatchObject({ configured: false, isDefault: false });
  });

  it('runs keyword ideas on the chosen provider and refuses one that is not configured', async () => {
    const { client, projectId } = await setup();
    // OpenAI has no key in tests, so choosing it fails immediately instead of enqueuing a dead job.
    const refused = await client.post(`/projects/${projectId}/keywords/suggest`, {
      country: 'GB',
      language: 'en',
      count: 5,
      provider: 'openai',
    });
    expect(refused.status).toBe(503);
    expect(refused.body.error.code).toBe('PROVIDER_NOT_CONFIGURED');

    // Choosing the configured (development) provider enqueues the job and records the choice for the worker.
    const ok = await client.post(`/projects/${projectId}/keywords/suggest`, {
      country: 'GB',
      language: 'en',
      count: 5,
      provider: 'dev',
    });
    expect(ok.status).toBe(202);
    const [job] = queues.drain('content');
    const record = await prisma.backgroundJob.findUniqueOrThrow({
      where: { id: (job!.data as ContentJobData).backgroundJobId },
    });
    expect((record.payload as { provider?: string }).provider).toBe('dev');
  });

  it('imports CSV with per-line errors, creates clusters, and skips duplicates on re-import', async () => {
    const { client, projectId } = await setup();
    const csv = [
      'Keyword,Intent,Priority,Cluster,Related Questions',
      'espresso machine,commercial,high,Equipment,Which espresso machine is best? | Is it worth it?',
      'french press guide,informational,,Brewing,',
      ',informational,low,Brewing,',
      'pour over coffee,not-an-intent,medium,Brewing,',
    ].join('\n');
    const res = await client.post(`/projects/${projectId}/keywords/import`, {
      csv,
      defaultCountry: 'GB',
      defaultLanguage: 'en',
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ totalRows: 4, created: 3, skipped: 0 });
    expect(res.body.data.errors).toEqual([{ line: 4, message: expect.stringContaining('phrase') }]);
    const groups = await client.get(`/projects/${projectId}/keyword-groups`);
    expect(groups.body.data.clusters.map((c: { name: string }) => c.name).sort()).toEqual([
      'Brewing',
      'Equipment',
    ]);
    const espresso = (await client.get(`/projects/${projectId}/keywords?q=espresso`)).body.data[0];
    expect(espresso).toMatchObject({
      intent: 'COMMERCIAL',
      priority: 'HIGH',
      source: 'CSV_IMPORT',
      cluster: { name: 'Equipment' },
    });
    expect(espresso.relatedQuestions).toEqual(['Which espresso machine is best?', 'Is it worth it?']);

    const again = await client.post(`/projects/${projectId}/keywords/import`, {
      csv,
      defaultCountry: 'GB',
      defaultLanguage: 'en',
    });
    expect(again.body.data).toMatchObject({ created: 0, skipped: 3 });

    const missingHeader = await client.post(`/projects/${projectId}/keywords/import`, {
      csv: 'foo,bar\n1,2',
      defaultCountry: 'GB',
      defaultLanguage: 'en',
    });
    expect(missingHeader.body.data.errors[0].message).toMatch(/keyword/);
  });

  it('exports CSV with spreadsheet formula injection neutralized', async () => {
    const { client, projectId } = await setup();
    await client.post(`/projects/${projectId}/keywords`, {
      phrase: '=HYPERLINK("http://evil")',
      country: 'GB',
      language: 'en',
      notes: 'contains, comma',
    });
    const res = await client.get(`/projects/${projectId}/keywords/export`);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(
      /attachment; filename="brewco\.example\.com-keywords\.csv"/,
    );
    const lines = res.text.trim().split('\r\n');
    expect(lines[0]).toMatch(/^keyword,intent,priority/);
    expect(lines[1]).toContain(`"'=HYPERLINK(""http://evil"")"`);
    expect(lines[1]).toContain('"contains, comma"');
  });

  it('generates ideas for the whole business from its pages and keywords when no topic is given', async () => {
    const { client, projectId } = await setup();
    await client.patch(`/projects/${projectId}`, { primaryKeywords: ['cold brew coffee'] });
    const crawl = await prisma.crawlJob.create({
      data: { projectId, startUrl: 'https://brewco.example.com/', status: 'SUCCEEDED', finishedAt: new Date(), settings: DEFAULT_CRAWL_SETTINGS },
    });
    await prisma.crawledPage.create({
      data: {
        crawlJobId: crawl.id, url: 'https://brewco.example.com/kits', urlHash: 'k'.repeat(64), depth: 1, source: 'LINK',
        statusCode: 200, isHtml: true, isIndexable: true, title: 'Cold brew kits', h1: 'Cold brew starter kits',
      },
    });
    const start = await client.post(`/projects/${projectId}/keywords/suggest`, { country: 'GB', language: 'en', count: 5 });
    expect(start.status).toBe(202);
    const [job] = queues.drain('content');
    const data = job!.data as ContentJobData;
    const record = await prisma.backgroundJob.findUniqueOrThrow({ where: { id: data.backgroundJobId } });
    expect((record.payload as { seed?: string }).seed).toBeUndefined();
    let prompt = '';
    const llm: LlmProvider = {
      key: 'openai',
      label: 'Fake',
      isDevAdapter: false,
      async generateJson<T>(request: LlmJsonRequest<T>): Promise<LlmResult<T>> {
        prompt = request.user;
        const keywords = ['cold brew starter kit', 'best cold brew kit uk'].map((phrase) => ({
          phrase, intent: 'COMMERCIAL', relatedQuestions: [`Is a ${phrase} worth it?`], rationale: 'Matches the kits page.',
        }));
        return { data: request.schema.parse({ keywords }), provider: 'openai', model: 'fake', isDevAdapter: false, usage: null };
      },
    };
    const result = await executeKeywordSuggestions(prisma, data.backgroundJobId, record.payload as never, llm);
    expect(result.suggestions.map((s) => s.phrase)).toEqual(['cold brew starter kit', 'best cold brew kit uk']);
    // The prompt is grounded in what the business shows: its primary keywords and its crawled pages.
    expect(prompt).toContain('Primary keywords: cold brew coffee');
    expect(prompt).toContain('Pages on the website: Cold brew starter kits');
    expect(prompt).toContain('Focus: the main products and services shown above.');
  }); // prettier-ignore

  it('generates labeled AI keyword ideas and adds accepted ones', async () => {
    const { client, projectId } = await setup();
    const start = await client.post(`/projects/${projectId}/keywords/suggest`, {
      seed: 'cold brew',
      country: 'GB',
      language: 'en',
      count: 5,
    });
    expect(start.status).toBe(202);
    const [job] = queues.drain('content');
    const data = job!.data as ContentJobData;
    const record = await prisma.backgroundJob.findUniqueOrThrow({ where: { id: data.backgroundJobId } });
    const tracker = new JobTracker(prisma, data.backgroundJobId, 0);
    await tracker.start(1);
    const result = await executeKeywordSuggestions(prisma, data.backgroundJobId, record.payload as never);
    await tracker.succeed(result as never);

    const jobStatus = await client.get(`/jobs/${data.backgroundJobId}`);
    expect(jobStatus.body.data.status).toBe('SUCCEEDED');
    expect(jobStatus.body.data.result.label).toMatch(/not AI-generated and not measured/);
    const suggestions = jobStatus.body.data.result.suggestions as {
      phrase: string;
      intent: string;
      relatedQuestions: string[];
    }[];
    expect(suggestions).toHaveLength(5);

    const bulk = await client.post(`/projects/${projectId}/keywords/bulk`, {
      source: 'AI_SUGGESTION',
      keywords: suggestions.slice(0, 2).map((s) => ({
        phrase: s.phrase,
        intent: s.intent,
        country: 'GB',
        language: 'en',
        relatedQuestions: s.relatedQuestions,
      })),
    });
    expect(bulk.body.data).toEqual({ created: 2, skipped: 0 });
    const list = await client.get(`/projects/${projectId}/keywords`);
    expect(
      list.body.data.every(
        (k: { source: string; metrics: unknown }) => k.source === 'AI_SUGGESTION' && k.metrics === null,
      ),
    ).toBe(true);
  });

  it("prevents access to another workspace's keywords", async () => {
    const b = await setup();
    const keyword = await b.client.post(`/projects/${b.projectId}/keywords`, {
      phrase: 'secret keyword',
      country: 'GB',
      language: 'en',
    });
    const a = await registerClient(app);
    expect((await a.client.get(`/projects/${b.projectId}/keywords`)).status).toBe(404);
    expect((await a.client.get(`/projects/${b.projectId}/keywords/export`)).status).toBe(404);
    expect((await a.client.patch(`/keywords/${keyword.body.data.id}`, { status: 'PLANNED' })).status).toBe(
      404,
    );
    expect((await a.client.delete(`/keywords/${keyword.body.data.id}`)).status).toBe(404);
    expect(
      (
        await a.client.post(`/projects/${b.projectId}/keywords/import`, {
          csv: 'keyword\nx',
          defaultCountry: 'GB',
          defaultLanguage: 'en',
        })
      ).status,
    ).toBe(404);
  });
});
