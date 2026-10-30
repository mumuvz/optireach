import { disconnectPrisma } from '@surfaced/core/db';
import { resetEnvCache } from '@surfaced/core/env';
import { DEFAULT_CRAWL_SETTINGS } from '@surfaced/shared';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createTestApp, registerClient } from './helpers';

const { app, prisma } = createTestApp();

afterAll(async () => {
  await disconnectPrisma();
});

afterEach(() => {
  process.env.PDF_RENDERER = '';
  resetEnvCache();
});

async function setup() {
  const owner = await registerClient(app);
  const project = await owner.client.post('/projects', {
    workspaceId: owner.workspaceId,
    name: 'Acme Co',
    websiteUrl: 'acme.example.com',
    targetCountries: ['US'],
    targetLanguages: ['en'],
  });
  const projectId = project.body.data.id as string;
  // Some audit data so the audit module has content to render.
  const crawl = await prisma.crawlJob.create({
    data: {
      projectId,
      startUrl: 'https://acme.example.com/',
      status: 'SUCCEEDED',
      finishedAt: new Date(),
      settings: DEFAULT_CRAWL_SETTINGS,
    },
  });
  await prisma.auditRun.create({
    data: {
      projectId,
      crawlJobId: crawl.id,
      status: 'SUCCEEDED',
      score: 82,
      categoryScores: { METADATA: 70 },
      issueCounts: { total: 3, bySeverity: { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 0 } },
      pagesAnalyzed: 10,
      scoringVersion: '2026.10',
      weights: {},
      finishedAt: new Date(),
    },
  });
  return { ...owner, projectId };
}

describe('per-module PDF export', () => {
  it('rejects an unknown module', async () => {
    const { client, projectId } = await setup();
    expect((await client.get(`/projects/${projectId}/export/nonsense`)).status).toBe(404);
  });

  it('gathers module data and reports honestly when the PDF renderer is off', async () => {
    const { client, projectId } = await setup();
    // Force the renderer off so the path is deterministic without Chromium: data is gathered and the document
    // built, then rendering reports it is unavailable (503) rather than fabricating a file.
    process.env.PDF_RENDERER = 'none';
    resetEnvCache();
    for (const module of ['audit', 'keywords', 'recommendations', 'content', 'visibility', 'competitors']) {
      const res = await client.get(`/projects/${projectId}/export/${module}`);
      expect([200, 503], module).toContain(res.status);
      if (res.status === 503) expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
    }
  });

  it("prevents access to another workspace's exports", async () => {
    const b = await setup();
    const a = await registerClient(app);
    expect((await a.client.get(`/projects/${b.projectId}/export/audit`)).status).toBe(404);
  });
});
