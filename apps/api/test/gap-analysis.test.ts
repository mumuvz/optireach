import { executeGapAnalysis } from '@surfaced/core/competitors';
import { disconnectPrisma } from '@surfaced/core/db';
import { afterAll, describe, expect, it } from 'vitest';
import { createTestApp, registerClient } from './helpers';

const { app, queues, prisma } = createTestApp();

afterAll(async () => {
  await disconnectPrisma();
});

async function setPlan(workspaceId: string, key: string) {
  const plan = await prisma.subscriptionPlan.findUniqueOrThrow({ where: { key } });
  await prisma.subscription.update({ where: { workspaceId }, data: { planId: plan.id } });
}

/** A project with one real answer naming Canva (and citing canva.com), plus one demo answer. */
async function setup({ realAnswers = true } = {}) {
  const owner = await registerClient(app);
  const res = await owner.client.post('/projects', {
    workspaceId: owner.workspaceId,
    name: 'Shubh Invites',
    websiteUrl: 'shubh-invites.example.com',
    targetCountries: ['IN'],
    targetLanguages: ['en'],
    competitors: [{ name: 'Crafty Art', domain: 'craftyartapp.example.com' }],
  });
  const projectId = res.body.data.id as string;
  const prompt = await prisma.aiPrompt.create({
    data: {
      projectId,
      text: 'Best app for wedding invitations in India',
      country: 'IN',
      language: 'en',
      targetBrand: 'Shubh Invites',
      providers: ['openai_web_search'],
    },
  });
  const run = await prisma.aiVisibilityRun.create({ data: { projectId, status: 'SUCCEEDED' } });
  const observe = (key: string, isDemo: boolean) =>
    prisma.aiVisibilityObservation.create({
      data: {
        runId: run.id,
        promptId: prompt.id,
        projectId,
        provider: 'openai_web_search',
        country: 'IN',
        language: 'en',
        promptText: prompt.text,
        status: 'SUCCEEDED',
        isDemo,
        answerText: 'Most people pick Canva for Indian wedding templates.',
        idempotencyKey: `${run.id}:${key}`,
        citations: {
          create: [
            {
              url: 'https://www.canva.com/wedding/',
              domain: 'canva.com',
              position: 1,
              sourceType: 'INLINE_CITATION',
            },
          ],
        },
      },
    });
  await observe('demo', true);
  if (realAnswers) await observe('real', false);
  return { ...owner, projectId };
}

describe('competitor gap analysis API', () => {
  it('is gated to plans with competitor analysis', async () => {
    const { client, projectId } = await setup();
    const res = await client.get(`/projects/${projectId}/gap-analyses/latest`);
    expect(res.status).toBe(402);
    expect(res.body.error.details).toMatchObject({ feature: 'competitorAnalysis' });
    expect((await client.post(`/projects/${projectId}/gap-analyses`)).status).toBe(402);
  });

  it('needs real AI answers: demo answers are not analyzed', async () => {
    const { client, projectId, workspaceId } = await setup({ realAnswers: false });
    await setPlan(workspaceId, 'GROWTH');
    expect((await client.get(`/projects/${projectId}/gap-analyses/latest`)).body.data).toBeNull();
    const res = await client.post(`/projects/${projectId}/gap-analyses`);
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/no real AI answers/);
  });

  it('queues one analysis at a time, stores the report and saves actions as recommendations', async () => {
    const { client, projectId, workspaceId } = await setup();
    await setPlan(workspaceId, 'GROWTH');
    const started = await client.post(`/projects/${projectId}/gap-analyses`);
    expect(started.status).toBe(202);
    const { analysisId, jobId } = started.body.data as { analysisId: string; jobId: string };
    expect(queues.jobs.find((j) => j.queue === 'competitor' && j.jobId === jobId)?.data).toMatchObject({
      gapAnalysisId: analysisId,
    });
    expect((await client.post(`/projects/${projectId}/gap-analyses`)).status).toBe(409);

    const queued = await client.get(`/projects/${projectId}/gap-analyses/latest`);
    expect(queued.body.data).toMatchObject({ id: analysisId, status: 'QUEUED', jobId, result: null });

    // The worker runs the job; network checks and AI extraction are off in this test.
    await executeGapAnalysis(prisma, analysisId, { llm: null, liveChecks: false });
    const done = await client.get(`/projects/${projectId}/gap-analyses/latest`);
    expect(done.body.data).toMatchObject({ status: 'SUCCEEDED', newAnswersSince: 0 });
    const result = done.body.data.result;
    expect(result).toMatchObject({ answers: 1, demoAnswersExcluded: 1 });
    expect(result.brands.find((b: { name: string }) => b.name === 'Canva')).toMatchObject({
      tracked: false,
      answers: 1,
      domain: 'canva.com',
    });
    expect(result.actions.map((a: { key: string }) => a.key)).toContain('track-brands');

    const save = (actionKey: string) =>
      client.post(`/projects/${projectId}/gap-analyses/${analysisId}/recommendations`, { actionKey });
    const first = await save('track-brands');
    expect(first.status).toBe(200);
    expect(first.body.data).toMatchObject({
      created: true,
      recommendation: { source: 'AI_VISIBILITY', status: 'OPEN' },
    });
    expect((await save('track-brands')).body.data.created).toBe(false);
    expect((await save('no-such-action')).status).toBe(404);
  });

  it('keeps analyses inside their tenant', async () => {
    const { projectId, workspaceId } = await setup();
    await setPlan(workspaceId, 'GROWTH');
    const outsider = await registerClient(app);
    await setPlan(outsider.workspaceId, 'GROWTH');
    expect((await outsider.client.get(`/projects/${projectId}/gap-analyses/latest`)).status).toBe(404);
    expect((await outsider.client.post(`/projects/${projectId}/gap-analyses`)).status).toBe(404);
  });
});
