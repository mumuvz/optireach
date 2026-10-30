import { executeAnswerabilityRun } from '@surfaced/core/answerability';
import { disconnectPrisma } from '@surfaced/core/db';
import type { ContentJobData } from '@surfaced/core/queue';
import { DEFAULT_CRAWL_SETTINGS } from '@surfaced/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { createTestApp, registerClient } from './helpers';

const { app, queues, prisma } = createTestApp();

afterAll(async () => {
  await disconnectPrisma();
});

async function setup(withCrawl = true) {
  const owner = await registerClient(app);
  const project = await owner.client.post('/projects', {
    workspaceId: owner.workspaceId,
    name: 'Brew Co',
    websiteUrl: 'brewco.example.com',
    targetCountries: ['US'],
    targetLanguages: ['en'],
  });
  const projectId = project.body.data.id as string;
  if (withCrawl) {
    const crawl = await prisma.crawlJob.create({
      data: {
        projectId,
        startUrl: 'https://brewco.example.com/',
        status: 'SUCCEEDED',
        finishedAt: new Date(),
        settings: DEFAULT_CRAWL_SETTINGS,
      },
    });
    await prisma.crawledPage.create({
      data: {
        crawlJobId: crawl.id,
        url: 'https://brewco.example.com/faq',
        urlHash: 'a'.repeat(64),
        depth: 1,
        source: 'LINK',
        statusCode: 200,
        isHtml: true,
        isIndexable: true,
        title: 'Cold brew FAQ',
        h1: 'Cold brew questions answered',
        headings: [{ level: 2, text: 'What is cold brew coffee?' }],
        wordCount: 900,
        signals: { questionHeadings: 3, hasFaqContent: true },
        structuredData: { types: ['FAQPage'] },
      },
    });
    await prisma.crawledPage.create({
      data: {
        crawlJobId: crawl.id,
        url: 'https://brewco.example.com/shop',
        urlHash: 'b'.repeat(64),
        depth: 1,
        source: 'LINK',
        statusCode: 200,
        isHtml: true,
        isIndexable: true,
        title: 'Shop',
        wordCount: 120,
        signals: { questionHeadings: 0, hasFaqContent: false },
        structuredData: { types: [] },
      },
    });
    await prisma.aiPrompt.create({
      data: {
        projectId,
        text: 'What is cold brew coffee?',
        country: 'US',
        language: 'en',
        targetBrand: 'Brew Co',
        providers: ['mock_demo'],
      },
    });
  }
  return { ...owner, projectId };
}

describe('answerability audit', () => {
  it('lists providers, refuses an unconfigured one, and requires a crawl', async () => {
    const { client, projectId } = await setup(false);
    const providers = (await client.get(`/projects/${projectId}/answerability/providers`)).body.data as {
      key: string;
      configured: boolean;
      isDefault: boolean;
    }[];
    expect(providers.find((p) => p.key === 'dev')).toMatchObject({ configured: true, isDefault: true });

    const refused = await client.post(`/projects/${projectId}/answerability/run`, { provider: 'openai' });
    expect(refused.status).toBe(503);
    expect(refused.body.error.code).toBe('PROVIDER_NOT_CONFIGURED');

    // No crawl exists for this project, so there is nothing to assess.
    const noCrawl = await client.post(`/projects/${projectId}/answerability/run`, {});
    expect(noCrawl.status).toBe(409);
  });

  it('runs an assessment from page structure and persists findings and question coverage', async () => {
    const { client, projectId } = await setup();
    const start = await client.post(`/projects/${projectId}/answerability/run`, {});
    expect(start.status).toBe(202);
    const runId = start.body.data.runId as string;

    const [job] = queues.drain('content');
    const data = job!.data as ContentJobData;
    expect(data.kind).toBe('answerability');

    // Run the job with the development adapter (the deterministic template reads the real page structure). In the
    // worker this runs inside runTracked, which also marks the job record done; here we complete it ourselves.
    await executeAnswerabilityRun(prisma, runId, { backgroundJobId: data.backgroundJobId });
    await prisma.backgroundJob.update({
      where: { id: data.backgroundJobId },
      data: { status: 'SUCCEEDED', finishedAt: new Date() },
    });

    const latest = await client.get(`/projects/${projectId}/answerability/latest`);
    const r = latest.body.data.run;
    expect(r).toMatchObject({ status: 'SUCCEEDED', provider: 'dev', isDevAdapter: true });
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(100);
    expect(['good', 'fair', 'poor']).toContain(r.grade);
    expect(r.pagesConsidered).toBe(2);
    expect(r.questionsConsidered).toBe(1);
    // The template surfaces the real FAQ-schema/question-heading signals and the target question's coverage.
    expect(r.assessment.findings.length).toBeGreaterThan(0);
    const coverage = r.assessment.questionCoverage as { question: string; covered: boolean }[];
    expect(coverage.find((c) => c.question === 'What is cold brew coffee?')?.covered).toBe(true);
    expect(r.limitations.join(' ')).toMatch(/page structure/);

    // A second run is blocked only while one is active; this one already finished, so re-running is allowed.
    expect((await client.post(`/projects/${projectId}/answerability/run`, {})).status).toBe(202);
  });

  it("prevents access to another workspace's answerability data", async () => {
    const b = await setup();
    const start = await b.client.post(`/projects/${b.projectId}/answerability/run`, {});
    const runId = start.body.data.runId as string;
    const a = await registerClient(app);
    for (const path of [
      `/projects/${b.projectId}/answerability/latest`,
      `/projects/${b.projectId}/answerability/runs`,
      `/projects/${b.projectId}/answerability/providers`,
      `/answerability/runs/${runId}`,
    ]) {
      expect((await a.client.get(path)).status, path).toBe(404);
    }
    expect((await a.client.post(`/projects/${b.projectId}/answerability/run`, {})).status).toBe(404);
  });
});
