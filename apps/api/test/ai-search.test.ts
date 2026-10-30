import { disconnectPrisma } from '@surfaced/core/db';
import { afterAll, describe, expect, it } from 'vitest';
import { createTestApp, registerClient } from './helpers';

const { app, prisma } = createTestApp();
afterAll(async () => {
  await disconnectPrisma();
});

async function setup() {
  const owner = await registerClient(app);
  const project = await owner.client.post('/projects', {
    workspaceId: owner.workspaceId,
    name: 'Navkar Jewellers',
    websiteUrl: 'https://navkar.example.in',
    targetCountries: ['IN'],
    targetLanguages: ['en'],
  });
  expect(project.status).toBe(201);
  const projectId = project.body.data.id as string;
  const prompt = await owner.client.post(`/projects/${projectId}/prompts`, {
    text: 'Which are the best jewellers in Surat?',
    country: 'IN',
    city: 'Surat',
    language: 'en',
    providers: ['mock_demo'],
    frequency: 'MANUAL',
  });
  expect(prompt.status).toBe(201);
  return { ...owner, projectId, promptId: prompt.body.data.id as string, prompt: prompt.body.data };
}

describe('prompt locality', () => {
  it('stores the city, validates it, and lists the new providers with their status', async () => {
    const { client, projectId, promptId, prompt } = await setup();
    expect(prompt.city).toBe('Surat');
    const bad = await client.post(`/projects/${projectId}/prompts`, { text: 'Which are the best jewellers in Surat?', country: 'IN', city: 'Surat 395007', language: 'en', providers: ['mock_demo'] }); // prettier-ignore
    expect(bad.status).toBe(400);
    expect((await client.patch(`/prompts/${promptId}`, { city: null })).body.data.city).toBeNull();
    const providers = (await client.get('/ai-visibility/providers')).body.data.providers;
    expect(providers.find((p: { key: string }) => p.key === 'gemini_model_knowledge')).toMatchObject({ configured: false, detail: expect.stringMatching(/GEMINI_API_KEY/) }); // prettier-ignore
    expect(providers.find((p: { key: string }) => p.key === 'dataforseo_ai_mode')).toMatchObject({
      configured: false,
    });
    // A provider that is not configured cannot be chosen.
    expect((await client.post(`/projects/${projectId}/prompts`, { text: 'Which are the best jewellers in Surat?', country: 'IN', language: 'en', providers: ['dataforseo_ai_mode'] })).status).toBe(503); // prettier-ignore
  });
});

describe('manual observations', () => {
  it('records what a person saw, keeps sources apart, and shows it on the dashboard as manual', async () => {
    const { client, projectId, promptId, workspaceId } = await setup();
    const res = await client.post(`/projects/${projectId}/ai-visibility/observations/manual`, {
      promptId,
      surface: 'GOOGLE_AI_MODE',
      answerText:
        'For gold jewellery in Surat, Navkar Jewellers is often recommended for its bridal collection.',
      citedUrls: ['https://navkar.example.in/bridal', 'https://www.justdial.com/Surat/Jewellers'],
    });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ provider: 'manual_google_ai_mode', captureMethod: 'MANUAL', city: 'Surat', brandMentioned: true, brandCited: true }); // prettier-ignore
    expect(res.body.data.citations).toHaveLength(2);

    await client.post(`/projects/${projectId}/ai-visibility/observations/manual`, {
      promptId,
      surface: 'GOOGLE_AI_OVERVIEW',
      answerText: 'Popular choices include several jewellers on Ghod Dod Road; prices vary by purity.',
    });
    const manualOnly = await client.get(
      `/projects/${projectId}/ai-visibility/observations?provider=manual_google_ai_mode`,
    );
    expect(manualOnly.body.data).toHaveLength(1);
    expect(manualOnly.body.data[0]).toMatchObject({ captureMethod: 'MANUAL', city: 'Surat' });

    const overview = (await client.get(`/projects/${projectId}/local/overview`)).body.data;
    const aiMode = overview.cards.find((c: { key: string }) => c.key === 'ai_mode');
    expect(aiMode).toMatchObject({ state: 'ok', value: '100% of answers mention you', source: 'Manual observation · Google AI Mode' }); // prettier-ignore
    // AI Mode and AI Overviews stay on separate lines.
    expect(aiMode.lines).toEqual([
      {
        label: 'Manual observation · Google AI Mode',
        value: 'mentioned 100% · cited 100%',
        note: '1 answers · manual observation',
      },
      {
        label: 'Manual observation · Google AI Overviews',
        value: 'mentioned 0% · cited 0%',
        note: '1 answers · manual observation',
      },
    ]);
    expect(overview.cards.find((c: { key: string }) => c.key === 'gemini')).toMatchObject({
      state: 'unsupported',
    });

    // Manual entries are free: no visibility-check quota is used.
    expect(await prisma.usageRecord.count({ where: { workspaceId, metric: 'VISIBILITY_CHECK' } })).toBe(0);

    // Clients can read but not record; other workspaces see nothing.
    const clientUser = await registerClient(app);
    await prisma.workspaceMember.create({
      data: { workspaceId, userId: clientUser.me.user.id, role: 'CLIENT' },
    });
    expect((await clientUser.client.post(`/projects/${projectId}/ai-visibility/observations/manual`, { promptId, surface: 'CHATGPT', answerText: 'An answer that is long enough.' })).status).toBe(403); // prettier-ignore
    const stranger = await registerClient(app);
    expect((await stranger.client.post(`/projects/${projectId}/ai-visibility/observations/manual`, { promptId, surface: 'CHATGPT', answerText: 'An answer that is long enough.' })).status).toBe(404); // prettier-ignore
  });

  it('rejects a prompt from another project', async () => {
    const a = await setup();
    const b = await setup();
    const res = await a.client.post(`/projects/${a.projectId}/ai-visibility/observations/manual`, { promptId: b.promptId, surface: 'CHATGPT', answerText: 'An answer that is long enough.' }); // prettier-ignore
    expect(res.status).toBe(404);
  });
});
