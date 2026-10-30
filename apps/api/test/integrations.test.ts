import { disconnectPrisma } from '@surfaced/core/db';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { API, createTestApp, registerClient } from './helpers';

const { app } = createTestApp();

afterAll(async () => {
  await disconnectPrisma();
});

describe('integrations', () => {
  it('reports implemented vs planned integrations honestly and refuses unconfigured OAuth', async () => {
    const { client, workspaceId } = await registerClient(app);
    const project = await client.post('/projects', {
      workspaceId,
      name: 'Site',
      websiteUrl: 'gsc-site.example.com',
      targetCountries: ['US'],
      targetLanguages: ['en'],
    });
    const catalog = await client.get(`/projects/${project.body.data.id}/integrations`);
    const byProvider = Object.fromEntries(
      catalog.body.data.map((c: { provider: string }) => [c.provider, c]),
    );
    expect(byProvider.GOOGLE_SEARCH_CONSOLE).toMatchObject({
      availability: 'implemented',
      configured: false,
      integration: null,
    });
    expect(byProvider.GOOGLE_ANALYTICS_4.availability).toBe('planned');
    expect(byProvider.WORDPRESS.availability).toBe('planned');

    const connect = await client.post(
      `/projects/${project.body.data.id}/integrations/google-search-console/connect`,
    );
    expect(connect.status).toBe(503);
    expect(connect.body.error.code).toBe('PROVIDER_NOT_CONFIGURED');

    const metrics = await client.get(`/projects/${project.body.data.id}/search-console`);
    expect(metrics.body.data).toMatchObject({
      daily: [],
      topQueries: [],
      totals: { clicks: 0, impressions: 0, ctr: null },
    });

    const other = await registerClient(app);
    expect((await other.client.get(`/projects/${project.body.data.id}/integrations`)).status).toBe(404);
  });

  it('reports consolidated diagnostics across connections, AI, local search and jobs', async () => {
    const { client, workspaceId } = await registerClient(app);
    const project = await client.post('/projects', {
      workspaceId,
      name: 'Diag Co',
      websiteUrl: 'diag.example.com',
      targetCountries: ['US'],
      targetLanguages: ['en'],
    });
    const projectId = project.body.data.id as string;
    const res = await client.get(`/projects/${projectId}/integrations/diagnostics`);
    expect(res.status).toBe(200);
    const byKey = Object.fromEntries(res.body.data.checks.map((c: { key: string }) => [c.key, c])) as Record<
      string,
      { status: string; detail: string; category: string; enables: string | null }
    >;
    // Every capability is represented, each with a status.
    for (const key of [
      'google_oauth',
      'google_search_console',
      'google_business_profile',
      'ai_model',
      'local_rank_source',
      'background_jobs',
    ])
      // prettier-ignore
      expect(byKey[key]).toBeTruthy();
    // No OAuth client configured in tests → Search Console is "off"; summary counts add up to the checks.
    expect(byKey.google_search_console?.status).toBe('off');
    expect(byKey.ai_model?.category).toBe('ai');
    const { summary, checks } = res.body.data;
    expect(summary.ok + summary.warning + summary.error + summary.off).toBe(checks.length);
    // Tenant isolation.
    const other = await registerClient(app);
    expect((await other.client.get(`/projects/${projectId}/integrations/diagnostics`)).status).toBe(404);
  });

  it('redirects OAuth callback errors back to the app without leaking details', async () => {
    const noSession = await request(app).get(`${API}/integrations/google/callback?code=abc&state=def`);
    expect(noSession.status).toBe(302);
    expect(noSession.headers.location).toMatch(
      /\/app\/integrations\?integrationError=Your%20session%20expired/,
    );
    const denied = await request(app).get(`${API}/integrations/google/callback?error=access_denied`);
    expect(denied.headers.location).toMatch(/integrationError=Access%20was%20not%20granted/);
  });
});
