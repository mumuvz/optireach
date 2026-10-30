import { disconnectPrisma } from '@surfaced/core/db';
import { afterAll, describe, expect, it } from 'vitest';
import { createTestApp, registerClient } from './helpers';

const { app } = createTestApp();

afterAll(async () => {
  await disconnectPrisma();
});

async function setupLocal() {
  const owner = await registerClient(app);
  const res = await owner.client.post('/projects', {
    workspaceId: owner.workspaceId,
    name: 'Navkar Jewellers',
    websiteUrl: 'navkar.example.com',
    targetCountries: ['IN'],
    targetLanguages: ['en'],
    businessProfile: { types: ['LOCAL_STOREFRONT'], profilePresence: 'NONE' },
    // Deliberately incomplete: no coordinates, no category, no phone, no hours, not linked to the website.
    locations: [
      { name: 'Navkar Jewellers', kind: 'STOREFRONT', city: 'Surat', country: 'IN', addressLine1: 'Ghod Dod Road', isPrimary: true }, // prettier-ignore
    ],
  });
  expect(res.status).toBe(201);
  return { ...owner, projectId: res.body.data.id as string };
}

describe('local recommendations', () => {
  it('generates evidence-based LOCAL recommendations from profile gaps and keeps them idempotent', async () => {
    const { client, projectId } = await setupLocal();

    const regen = await client.post(`/projects/${projectId}/recommendations/regenerate`);
    expect(regen.status).toBe(200);
    // The incomplete location yields several actions: map position, primary category, phone, hours, website link.
    expect(regen.body.data.local.created).toBeGreaterThanOrEqual(2);

    const list = await client.get(`/projects/${projectId}/recommendations`);
    const items = list.body.data.items as { id: string; title: string; category: string; source: string }[];
    const localRecs = items.filter((r) => r.source === 'LOCAL');
    expect(localRecs.length).toBeGreaterThanOrEqual(2);
    expect(localRecs.every((r) => r.category === 'LOCAL_SEO')).toBe(true);
    expect(localRecs.some((r) => /map position/i.test(r.title))).toBe(true);

    // Idempotent: a second run creates no new LOCAL recommendations and keeps the same set.
    const regen2 = await client.post(`/projects/${projectId}/recommendations/regenerate`);
    expect(regen2.body.data.local.created).toBe(0);
    const after = await client.get(`/projects/${projectId}/recommendations`);
    const localAfter = (after.body.data.items as { source: string }[]).filter((r) => r.source === 'LOCAL');
    expect(localAfter.length).toBe(localRecs.length);
  });

  it('does not generate LOCAL recommendations for a non-local (website-only) project', async () => {
    const owner = await registerClient(app);
    const res = await owner.client.post('/projects', {
      workspaceId: owner.workspaceId,
      name: 'Acme Analytics',
      websiteUrl: 'acme-analytics.example.com',
      targetCountries: ['US'],
      targetLanguages: ['en'],
    });
    const projectId = res.body.data.id as string;
    const regen = await owner.client.post(`/projects/${projectId}/recommendations/regenerate`);
    expect(regen.body.data.local).toMatchObject({ created: 0, updated: 0, autoCompleted: 0 });
  });
});
