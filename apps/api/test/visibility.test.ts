import { disconnectPrisma } from '@surfaced/core/db';
import { JobTracker } from '@surfaced/core/jobs';
import type { MemoryQueueGateway, VisibilityJobData } from '@surfaced/core/queue';
import { executeVisibilityRun } from '@surfaced/core/visibility';
import { afterAll, describe, expect, it } from 'vitest';
import { createTestApp, registerClient } from './helpers';

const { app, queues, prisma } = createTestApp();

afterAll(async () => {
  await disconnectPrisma();
});

async function runQueuedVisibility(gateway: MemoryQueueGateway) {
  for (const job of gateway.drain('visibility')) {
    const data = job.data as VisibilityJobData;
    const record = await prisma.backgroundJob.findUniqueOrThrow({ where: { id: data.backgroundJobId } });
    const tracker = new JobTracker(prisma, data.backgroundJobId, 0);
    await tracker.start(1);
    const promptIds = ((record.payload ?? {}) as { promptIds?: string[] }).promptIds ?? null;
    const outcome = await executeVisibilityRun(prisma, data.runId, promptIds, tracker, null);
    await tracker.succeed(outcome as never);
  }
}

async function setup() {
  const owner = await registerClient(app);
  const project = await owner.client.post('/projects', {
    workspaceId: owner.workspaceId,
    name: 'Acme CRM',
    websiteUrl: 'acme-crm.example.com',
    targetCountries: ['US'],
    targetLanguages: ['en'],
    competitors: [
      { name: 'Rival CRM', domain: 'rival-crm.example.net' },
      { name: 'Other CRM', domain: 'other-crm.example.org' },
    ],
  });
  return {
    ...owner,
    projectId: project.body.data.id as string,
    competitors: project.body.data.competitors as { id: string }[],
  };
}

const promptBody = (overrides: Record<string, unknown> = {}) => ({
  text: 'What is the best CRM for small businesses?',
  country: 'US',
  language: 'en',
  providers: ['mock_demo'],
  frequency: 'WEEKLY',
  ...overrides,
});

describe('prompts', () => {
  it('validates providers, frequency and the tracked-prompt limit', async () => {
    const { client, projectId, competitors } = await setup();
    const created = await client.post(
      `/projects/${projectId}/prompts`,
      promptBody({ competitorIds: [competitors[0]!.id] }),
    );
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({
      targetBrand: 'Acme CRM',
      providers: ['mock_demo'],
      status: 'ACTIVE',
      competitorIds: [competitors[0]!.id],
    });
    expect(created.body.data.nextRunAt).not.toBeNull();

    const unconfigured = await client.post(
      `/projects/${projectId}/prompts`,
      promptBody({ providers: ['openai_web_search'] }),
    );
    expect(unconfigured.status).toBe(503);
    expect(unconfigured.body.error.code).toBe('PROVIDER_NOT_CONFIGURED');

    const daily = await client.post(`/projects/${projectId}/prompts`, promptBody({ frequency: 'DAILY' }));
    expect(daily.status).toBe(402);

    const foreignCompetitor = await client.post(
      `/projects/${projectId}/prompts`,
      promptBody({ competitorIds: ['c'.repeat(25)] }),
    );
    expect(foreignCompetitor.status).toBe(400);

    for (let i = 0; i < 4; i++) {
      expect(
        (
          await client.post(
            `/projects/${projectId}/prompts`,
            promptBody({ text: `Best CRM option number ${i + 2}?` }),
          )
        ).status,
      ).toBe(201);
    }
    const sixth = await client.post(
      `/projects/${projectId}/prompts`,
      promptBody({ text: 'One prompt too many?' }),
    );
    expect(sixth.status).toBe(402);
    expect(sixth.body.error.details).toMatchObject({ kind: 'trackedPrompts', limit: 5 });

    const paused = await client.patch(`/prompts/${created.body.data.id}`, { status: 'PAUSED' });
    expect(paused.body.data).toMatchObject({ status: 'PAUSED', nextRunAt: null });
    const list = await client.get(`/projects/${projectId}/prompts?status=PAUSED`);
    expect(list.body.data).toHaveLength(1);
  });

  it('reports provider configuration', async () => {
    const { client } = await setup();
    const res = await client.get('/ai-visibility/providers');
    const byKey = Object.fromEntries(res.body.data.providers.map((p: { key: string }) => [p.key, p]));
    expect(byKey.mock_demo.status).toBe('demo');
    expect(byKey.openai_web_search.status).toBe('not_configured');
    expect(res.body.data.llm).toMatchObject({ provider: 'dev', isDevAdapter: true });
  });
});

describe('visibility runs and metrics', () => {
  it('runs demo checks, then serves metrics, composition, observations and citations', async () => {
    const { client, projectId } = await setup();
    const p1 = await client.post(`/projects/${projectId}/prompts`, promptBody());
    await client.post(
      `/projects/${projectId}/prompts`,
      promptBody({ text: 'Which CRM has the best support for startups?' }),
    );

    const start = await client.post(`/projects/${projectId}/ai-visibility/runs`, {});
    expect(start.status).toBe(202);
    expect(start.body.data.plannedChecks).toBe(2);
    expect((await client.post(`/projects/${projectId}/ai-visibility/runs`, {})).status).toBe(409);
    await runQueuedVisibility(queues);

    const run = await client.get(`/ai-visibility/runs/${start.body.data.runId}`);
    expect(run.body.data).toMatchObject({
      status: 'SUCCEEDED',
      successCount: 2,
      failureCount: 0,
      isDemo: true,
    });

    const summary = await client.get(`/projects/${projectId}/ai-visibility/summary?provider=mock_demo`);
    expect(summary.body.data.metrics.totals).toEqual({ observations: 2, successful: 2, failed: 0 });
    expect(summary.body.data.composition).toMatchObject({
      providers: ['mock_demo'],
      includesDemoData: true,
      promptCount: 2,
    });
    expect(summary.body.data.notes.join(' ')).toMatch(/demo fixture data/);
    const rate = summary.body.data.metrics.mentionRate;
    expect(rate === null || (rate >= 0 && rate <= 1)).toBe(true);

    const observations = await client.get(
      `/projects/${projectId}/ai-visibility/observations?promptIds=${p1.body.data.id}`,
    );
    expect(observations.body.data).toHaveLength(1);
    const detail = await client.get(`/ai-visibility/observations/${observations.body.data[0].id}`);
    expect(detail.body.data.answerText).toContain('Demo data — not a real AI response');
    expect(detail.body.data.citations.length).toBeGreaterThan(0);

    const citations = await client.get(`/projects/${projectId}/ai-visibility/citations`);
    expect(citations.body.data[0]).toHaveProperty('sampleUrls');
    const trend = await client.get(`/projects/${projectId}/ai-visibility/trend?bucket=day`);
    expect(trend.body.data.points).toHaveLength(1);

    const runs = await client.get(`/projects/${projectId}/ai-visibility/runs`);
    expect(runs.body.data[0].id).toBe(start.body.data.runId);
  });

  it("prevents access to another workspace's prompts, runs and observations", async () => {
    const b = await setup();
    const prompt = await b.client.post(`/projects/${b.projectId}/prompts`, promptBody());
    const start = await b.client.post(`/projects/${b.projectId}/ai-visibility/runs`, {});
    await runQueuedVisibility(queues);
    const obs = await b.client.get(`/projects/${b.projectId}/ai-visibility/observations`);

    const a = await registerClient(app);
    for (const path of [
      `/prompts/${prompt.body.data.id}`,
      `/ai-visibility/runs/${start.body.data.runId}`,
      `/ai-visibility/observations/${obs.body.data[0].id}`,
      `/projects/${b.projectId}/prompts`,
      `/projects/${b.projectId}/ai-visibility/summary`,
      `/projects/${b.projectId}/ai-visibility/observations`,
    ]) {
      expect((await a.client.get(path)).status, path).toBe(404);
    }
    expect((await a.client.post(`/prompts/${prompt.body.data.id}/run`)).status).toBe(404);
    expect((await a.client.patch(`/prompts/${prompt.body.data.id}`, { status: 'PAUSED' })).status).toBe(404);
    expect((await a.client.post(`/projects/${b.projectId}/prompts`, promptBody())).status).toBe(404);
  });
});
