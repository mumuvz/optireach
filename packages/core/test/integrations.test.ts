import { DEFAULT_CRAWL_SETTINGS } from '@surfaced/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { createPkcePair, encryptSecret, hashToken, randomToken } from '../src/crypto';
import { disconnectPrisma, getPrisma } from '../src/db';
import {
  completeGoogleOAuth,
  disconnectGoogle,
  getValidAccessToken,
  searchConsoleMetrics,
  syncSearchConsole,
  type HttpFetch,
} from '../src/integrations';

const prisma = getPrisma();
afterAll(async () => {
  await disconnectPrisma();
});

const idToken = (email: string) => `x.${Buffer.from(JSON.stringify({ email })).toString('base64url')}.y`;

function fakeFetch(handler: (url: string, init: RequestInit) => { status?: number; body: unknown }) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    const { status = 200, body } = handler(url, init ?? {});
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as HttpFetch;
  return { fn, calls };
}

async function setup() {
  const user = await prisma.user.create({
    data: { email: `gsc-${randomToken(6)}@example.test`, name: 'GSC User', passwordHash: 'x' },
  });
  const other = await prisma.user.create({
    data: { email: `gsc-other-${randomToken(6)}@example.test`, name: 'Other', passwordHash: 'x' },
  });
  const workspace = await prisma.workspace.create({
    data: { name: 'GSC WS', slug: `gsc-${randomToken(6).toLowerCase()}` },
  });
  const project = await prisma.project.create({
    data: {
      workspaceId: workspace.id,
      name: 'Site',
      websiteUrl: 'https://site.example.com/',
      domain: `site-${randomToken(4).toLowerCase()}.example.com`,
      targetCountries: ['US'],
      targetLanguages: ['en'],
      crawlSettings: DEFAULT_CRAWL_SETTINGS,
    },
  });
  const state = randomToken(32);
  await prisma.oAuthState.create({
    data: {
      stateHash: hashToken(state),
      provider: 'GOOGLE_SEARCH_CONSOLE',
      userId: user.id,
      workspaceId: workspace.id,
      projectId: project.id,
      codeVerifierEnc: encryptSecret(createPkcePair().verifier),
      expiresAt: new Date(Date.now() + 600_000),
    },
  });
  return { user, other, workspace, project, state };
}

describe('Google OAuth state validation', () => {
  it('rejects unknown, foreign-user and replayed states', async () => {
    const { user, other, state } = await setup();
    const token = fakeFetch(() => ({
      body: {
        access_token: 'ya29.access',
        refresh_token: '1//refresh',
        expires_in: 3600,
        scope: 'webmasters.readonly',
        id_token: idToken('owner@example.test'),
      },
    }));
    await expect(
      completeGoogleOAuth(
        prisma,
        { state: 'unknown-state-value-123', code: 'c', sessionUserId: user.id },
        token.fn,
      ),
    ).rejects.toThrow(/invalid or has expired/);
    await expect(
      completeGoogleOAuth(prisma, { state, code: 'c', sessionUserId: other.id }, token.fn),
    ).rejects.toThrow(/different user/);
    const result = await completeGoogleOAuth(
      prisma,
      { state, code: 'auth-code', sessionUserId: user.id },
      token.fn,
    );
    await expect(
      completeGoogleOAuth(prisma, { state, code: 'auth-code', sessionUserId: user.id }, token.fn),
    ).rejects.toThrow(/invalid or has expired|already used/);

    // PKCE verifier and code are sent to the token endpoint.
    const body = new URLSearchParams(String(token.calls[0]!.init.body));
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43,}$/);

    const integration = await prisma.integration.findUniqueOrThrow({
      where: { id: result.integrationId },
      include: { token: true },
    });
    expect(integration).toMatchObject({ status: 'CONNECTED', externalAccount: 'owner@example.test' });
    expect(integration.token?.accessTokenEnc).not.toContain('ya29');
    expect(integration.token?.refreshTokenEnc).not.toContain('refresh');
  });

  it('rejects expired states', async () => {
    const { user, state } = await setup();
    await prisma.oAuthState.update({
      where: { stateHash: hashToken(state) },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const token = fakeFetch(() => ({ body: {} }));
    await expect(
      completeGoogleOAuth(prisma, { state, code: 'c', sessionUserId: user.id }, token.fn),
    ).rejects.toThrow(/expired/);
    expect(token.calls).toHaveLength(0);
  });
});

describe('tokens, sync and disconnect', () => {
  it('refreshes expiring tokens, marks failed refreshes for re-auth, syncs metrics and revokes on disconnect', async () => {
    const { user, project, state } = await setup();
    const google = fakeFetch((url) => {
      if (url.includes('oauth2.googleapis.com/token'))
        return {
          body: {
            access_token: 'ya29.fresh',
            expires_in: 3600,
            id_token: idToken('owner@example.test'),
            refresh_token: '1//refresh',
          },
        };
      if (url.includes('/searchAnalytics/query')) {
        return {
          body: {
            rows: [
              { keys: ['2026-10-01'], clicks: 10, impressions: 100, ctr: 0.1, position: 4.2 },
              { keys: ['2026-10-02'], clicks: 30, impressions: 300, ctr: 0.1, position: 3.8 },
            ],
          },
        };
      }
      if (url.includes('oauth2.googleapis.com/revoke')) return { body: {} };
      return { status: 404, body: {} };
    });
    const { integrationId } = await completeGoogleOAuth(
      prisma,
      { state, code: 'code', sessionUserId: user.id },
      google.fn,
    );

    await prisma.oAuthToken.update({
      where: { integrationId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect(await getValidAccessToken(prisma, integrationId, google.fn)).toBe('ya29.fresh');

    await prisma.integration.update({
      where: { id: integrationId },
      data: { config: { siteUrl: 'sc-domain:site.example.com' } },
    });
    const synced = await syncSearchConsole(prisma, integrationId, { days: 7 }, google.fn);
    expect(synced).toMatchObject({ days: 2 });
    const queryCall = google.calls.find((c) => c.url.includes('searchAnalytics'))!;
    expect(queryCall.url).toContain(encodeURIComponent('sc-domain:site.example.com'));
    const metrics = await searchConsoleMetrics(
      prisma,
      project.id,
      new Date('2026-09-01'),
      new Date('2026-12-31'),
    );
    expect(metrics.totals).toMatchObject({ clicks: 40, impressions: 400 });
    expect(metrics.totals.ctr).toBeCloseTo(0.1);
    expect(metrics.totals.position).toBeCloseTo((4.2 * 100 + 3.8 * 300) / 400);

    const failing = fakeFetch(() => ({
      status: 400,
      body: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' },
    }));
    await prisma.oAuthToken.update({
      where: { integrationId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await expect(getValidAccessToken(prisma, integrationId, failing.fn)).rejects.toThrow(
      /expired or revoked/,
    );
    expect((await prisma.integration.findUniqueOrThrow({ where: { id: integrationId } })).status).toBe(
      'NEEDS_REAUTH',
    );

    await disconnectGoogle(prisma, integrationId, google.fn);
    expect(google.calls.some((c) => c.url.includes('/revoke'))).toBe(true);
    expect(await prisma.oAuthToken.count({ where: { integrationId } })).toBe(0);
    expect((await prisma.integration.findUniqueOrThrow({ where: { id: integrationId } })).status).toBe(
      'DISCONNECTED',
    );
  });
});
