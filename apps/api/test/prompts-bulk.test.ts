import { disconnectPrisma } from '@surfaced/core/db';
import { afterAll, describe, expect, it } from 'vitest';
import { createTestApp, registerClient } from './helpers';

const { app } = createTestApp();

afterAll(async () => {
  await disconnectPrisma();
});

async function setup() {
  const owner = await registerClient(app);
  const project = await owner.client.post('/projects', {
    workspaceId: owner.workspaceId,
    name: 'Acme CRM',
    websiteUrl: 'acme-crm-bulk.example.com',
    targetCountries: ['US'],
    targetLanguages: ['en'],
    competitors: [{ name: 'Rival CRM', domain: 'rival-crm.example.net' }],
  });
  return { ...owner, projectId: project.body.data.id as string };
}

const settings = { country: 'US', language: 'en', providers: ['mock_demo'], frequency: 'WEEKLY' };

describe('bulk prompts', () => {
  it('adds new questions and reports duplicates, short lines and prompts already tracked', async () => {
    const { client, projectId } = await setup();
    expect(
      (
        await client.post(`/projects/${projectId}/prompts`, {
          ...settings,
          text: 'What is the best CRM for small businesses?',
        })
      ).status,
    ).toBe(201);
    const res = await client.post(`/projects/${projectId}/prompts/bulk`, {
      ...settings,
      texts: [
        'what is the best CRM for small businesses',
        'Which CRM do you recommend for startups?',
        'which crm do you recommend   for startups',
        'CRM',
        'Best CRM in United States',
      ],
    });
    expect(res.status).toBe(201);
    expect(res.body.data.created.map((p: { text: string }) => p.text)).toEqual([
      'Which CRM do you recommend for startups?',
      'Best CRM in United States',
    ]);
    expect(res.body.data.created[0]).toMatchObject({
      country: 'US',
      providers: ['mock_demo'],
      status: 'ACTIVE',
    });
    expect(res.body.data.skipped).toEqual([
      { text: 'what is the best CRM for small businesses', reason: 'already_tracked' },
      { text: 'which crm do you recommend for startups', reason: 'duplicate' },
      { text: 'CRM', reason: 'too_short' },
    ]);
    const list = await client.get(`/projects/${projectId}/prompts`);
    expect(list.body.data).toHaveLength(3);
  });

  it('applies the plan’s prompt limit to the whole batch', async () => {
    const { client, projectId } = await setup();
    // The Free plan tracks 5 prompts.
    const texts = Array.from({ length: 6 }, (_, i) => `Which CRM is best for team number ${i + 1}?`);
    const res = await client.post(`/projects/${projectId}/prompts/bulk`, { ...settings, texts });
    expect(res.status).toBe(402);
    expect(res.body.error).toMatchObject({ code: 'PLAN_LIMIT_REACHED', details: { kind: 'trackedPrompts' } });
    expect((await client.get(`/projects/${projectId}/prompts`)).body.data).toHaveLength(0);
  });

  it('validates the request and keeps projects inside their tenant', async () => {
    const { client, projectId } = await setup();
    const tooMany = Array.from({ length: 101 }, (_, i) => `Question number ${i} about CRM tools`);
    expect(
      (await client.post(`/projects/${projectId}/prompts/bulk`, { ...settings, texts: tooMany })).status,
    ).toBe(400);
    const outsider = await registerClient(app);
    const res = await outsider.client.post(`/projects/${projectId}/prompts/bulk`, {
      ...settings,
      texts: ['Which CRM do you recommend for startups?'],
    });
    expect(res.status).toBe(404);
  });
});
