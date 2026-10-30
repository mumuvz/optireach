import { disconnectPrisma } from '@surfaced/core/db';
import { JobTracker } from '@surfaced/core/jobs';
import type { ReportJobData } from '@surfaced/core/queue';
import { executeReportJob } from '@surfaced/core/reports';
import { REPORT_SECTIONS } from '@surfaced/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { createTestApp, registerClient } from './helpers';

const { app, queues, prisma } = createTestApp();

afterAll(async () => {
  await disconnectPrisma();
});

async function setup() {
  const owner = await registerClient(app);
  const res = await owner.client.post('/projects', {
    workspaceId: owner.workspaceId,
    name: 'Northwind <Outdoor>',
    websiteUrl: 'northwind-outdoor.example.com',
    targetCountries: ['US'],
    targetLanguages: ['en'],
    competitors: [{ name: 'Rival Trails', domain: 'rival-trails.example.net' }],
  });
  const projectId = res.body.data.id as string;
  const competitorId = res.body.data.competitors[0].id as string;
  const prompt = await prisma.aiPrompt.create({
    data: {
      projectId,
      text: 'Best waterproof hiking boots?',
      country: 'US',
      language: 'en',
      targetBrand: 'Northwind <Outdoor>',
      providers: ['openai_web_search'],
    },
  });
  const run = await prisma.aiVisibilityRun.create({ data: { projectId, status: 'SUCCEEDED' } });
  for (const [i, mentioned] of [true, false].entries()) {
    await prisma.aiVisibilityObservation.create({
      data: {
        runId: run.id,
        promptId: prompt.id,
        projectId,
        provider: 'openai_web_search',
        country: 'US',
        language: 'en',
        promptText: prompt.text,
        status: 'SUCCEEDED',
        answerText: `Answer ${i} <script>alert(1)</script>`,
        brandMentioned: mentioned,
        idempotencyKey: `${run.id}:${prompt.id}:${i}`,
        mentions: {
          create: [
            {
              entityType: 'COMPETITOR',
              competitorId,
              entityName: 'Rival Trails',
              matchedText: 'Rival Trails',
              matchType: 'NAME',
              position: 0,
              rank: 1,
            },
          ],
        },
        citations: {
          create: [
            {
              url: 'https://gear-reviews.example.com/boots',
              domain: 'gear-reviews.example.com',
              position: 1,
              sourceType: 'INLINE_CITATION',
            },
          ],
        },
      },
    });
  }
  return { ...owner, projectId };
}

async function runReports() {
  for (const job of queues.drain('report')) {
    const data = job.data as ReportJobData;
    const tracker = new JobTracker(prisma, data.backgroundJobId, 0);
    await tracker.start(1);
    await tracker.succeed((await executeReportJob({ prisma, queues }, data.reportId, tracker)) as never);
  }
}

describe('reports', () => {
  it('generates an HTML report from stored data with explicit limitations', async () => {
    const { client, projectId } = await setup();
    const today = new Date();
    const from = new Date(today.getTime() - 7 * 86_400_000).toISOString().slice(0, 10);
    const res = await client.post(`/projects/${projectId}/reports`, {
      title: 'Weekly visibility report',
      dateFrom: from,
      dateTo: new Date(today.getTime() + 86_400_000).toISOString().slice(0, 10),
      sections: [...REPORT_SECTIONS],
    });
    expect(res.status).toBe(202);
    const { reportId } = res.body.data;
    expect((await client.get(`/reports/${reportId}/html`)).status).toBe(409); // not ready yet

    await runReports();
    const meta = await client.get(`/reports/${reportId}`);
    expect(meta.body.data).toMatchObject({ status: 'READY', pdfStatus: 'UNAVAILABLE' });
    expect(meta.body.data.limitations).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/No completed website audit/),
        expect.stringMatching(/no open recommendations/i),
      ]),
    );
    expect(meta.body.data.summary).toMatchObject({ mentionRate: 0.5, observations: 2 });

    const html = await client.get(`/reports/${reportId}/html`);
    expect(html.status).toBe(200);
    expect(html.headers['content-security-policy']).toMatch(/sandbox/);
    expect(html.headers['content-security-policy']).toMatch(/default-src 'none'/);
    expect(html.text).toContain('Northwind &lt;Outdoor&gt;');
    expect(html.text).not.toContain('<script>alert(1)</script>');
    expect(html.text).toContain('50%'); // mention rate 1 of 2
    expect(html.text).toContain('gear-reviews.example.com');
    expect(html.text).toContain('Rival Trails');
    expect(html.text).toContain('No completed audit is available for this period.');
    expect(html.text).toContain('not guarantees of future rankings or AI recommendations');

    const pdf = await client.get(`/reports/${reportId}/pdf`);
    expect(pdf.status).toBe(409);
    expect(pdf.body.error.details).toEqual({ pdfStatus: 'UNAVAILABLE' });

    const list = await client.get(`/projects/${projectId}/reports`);
    expect(list.body.data[0].id).toBe(reportId);
    expect(await prisma.usageRecord.count({ where: { idempotencyKey: `report:${reportId}` } })).toBe(1);

    const other = await registerClient(app);
    for (const path of [
      `/reports/${reportId}`,
      `/reports/${reportId}/html`,
      `/reports/${reportId}/pdf`,
      `/projects/${projectId}/reports`,
    ]) {
      expect((await other.client.get(path)).status, path).toBe(404);
    }
    expect((await other.client.delete(`/reports/${reportId}`)).status).toBe(404);
    expect((await client.delete(`/reports/${reportId}`)).status).toBe(204);
  });

  it('validates the date range and sections', async () => {
    const { client, projectId } = await setup();
    const bad = await client.post(`/projects/${projectId}/reports`, {
      title: 'Bad',
      dateFrom: '2026-10-10',
      dateTo: '2026-10-01',
      sections: ['audit_summary'],
    });
    expect(bad.status).toBe(400);
    const noSections = await client.post(`/projects/${projectId}/reports`, {
      title: 'Bad',
      dateFrom: '2026-10-01',
      dateTo: '2026-10-10',
      sections: [],
    });
    expect(noSections.status).toBe(400);
  });
});
