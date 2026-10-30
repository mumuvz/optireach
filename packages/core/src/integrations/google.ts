// Google integrations: one OAuth 2.0 flow (authorization code + PKCE, encrypted token storage, refresh, revocation)
// shared by Search Console, Business Profile, Merchant Center and GA4, each with its own scopes, plus the
// Search Analytics sync. Data is the customer's own first-party data.
import type { IntegrationProvider } from '@surfaced/shared';
import { createPkcePair, decryptSecret, encryptSecret, hashToken, randomToken, sha256Hex } from '../crypto';
import type { PrismaClient } from '../db';
import { getEnv } from '../env';
import { Errors } from '../errors';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const GSC_API = 'https://www.googleapis.com/webmasters/v3';
const IDENTITY_SCOPES = ['openid', 'email'];
export const GSC_SCOPES = ['https://www.googleapis.com/auth/webmasters.readonly', ...IDENTITY_SCOPES];
const STATE_TTL_MS = 10 * 60 * 1000;

export type GoogleProvider = Extract<
  IntegrationProvider,
  'GOOGLE_SEARCH_CONSOLE' | 'GOOGLE_BUSINESS_PROFILE' | 'GOOGLE_MERCHANT_CENTER' | 'GOOGLE_ANALYTICS_4'
>;

/** Scopes, labels and URL slugs per Google integration. Each connection asks only for its own scope. */
export const GOOGLE_PROVIDERS: Record<GoogleProvider, { label: string; slug: string; scopes: string[] }> = {
  GOOGLE_SEARCH_CONSOLE: {
    label: 'Google Search Console',
    slug: 'google-search-console',
    scopes: GSC_SCOPES,
  },
  GOOGLE_BUSINESS_PROFILE: {
    label: 'Google Business Profile',
    slug: 'google-business-profile',
    scopes: ['https://www.googleapis.com/auth/business.manage', ...IDENTITY_SCOPES],
  },
  GOOGLE_MERCHANT_CENTER: {
    label: 'Google Merchant Center',
    slug: 'google-merchant-center',
    scopes: ['https://www.googleapis.com/auth/content', ...IDENTITY_SCOPES],
  },
  GOOGLE_ANALYTICS_4: {
    label: 'Google Analytics 4',
    slug: 'google-analytics-4',
    scopes: ['https://www.googleapis.com/auth/analytics.readonly', ...IDENTITY_SCOPES],
  },
};

export function isGoogleProvider(provider: string): provider is GoogleProvider {
  return provider in GOOGLE_PROVIDERS;
}

export function googleProviderBySlug(slug: string): GoogleProvider | null {
  const entry = Object.entries(GOOGLE_PROVIDERS).find(([, config]) => config.slug === slug);
  return (entry?.[0] as GoogleProvider | undefined) ?? null;
}

export type HttpFetch = typeof fetch;

export class IntegrationAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IntegrationAuthError';
  }
}

/** A Google API call that failed after authentication succeeded. `retryable` drives job retries. */
export class GoogleApiError extends Error {
  constructor(
    readonly httpStatus: number,
    /** Google's status string, e.g. PERMISSION_DENIED, RESOURCE_EXHAUSTED, NOT_FOUND. */
    readonly googleStatus: string | null,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'GoogleApiError';
  }
}

export function googleOAuthConfigured(): boolean {
  const env = getEnv();
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
}

export function googleRedirectUri(): string {
  const env = getEnv();
  return (
    env.GOOGLE_OAUTH_REDIRECT_URI ?? `${env.API_URL.replace(/\/$/, '')}/api/v1/integrations/google/callback`
  );
}

/** Creates a single-use, user-bound OAuth state (stored hashed) and returns the consent URL. */
export async function startGoogleOAuth(
  prisma: PrismaClient,
  params: { userId: string; workspaceId: string; projectId: string; provider?: GoogleProvider },
): Promise<{ url: string }> {
  const env = getEnv();
  const provider = params.provider ?? 'GOOGLE_SEARCH_CONSOLE';
  const config = GOOGLE_PROVIDERS[provider];
  if (!googleOAuthConfigured())
    throw Errors.providerNotConfigured(config.label, {
      detail: 'Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.',
    });
  const state = randomToken(32);
  const { verifier, challenge } = createPkcePair();
  await prisma.oAuthState.create({
    data: {
      stateHash: hashToken(state),
      provider,
      userId: params.userId,
      workspaceId: params.workspaceId,
      projectId: params.projectId,
      codeVerifierEnc: encryptSecret(verifier),
      expiresAt: new Date(Date.now() + STATE_TTL_MS),
    },
  });
  const url = new URL(AUTH_URL);
  url.search = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID!,
    redirect_uri: googleRedirectUri(),
    response_type: 'code',
    scope: config.scopes.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString();
  return { url: url.toString() };
}

interface TokenResponse {
  access_token: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
  id_token?: string;
  error?: string;
  error_description?: string;
}

function emailFromIdToken(idToken: string | undefined): string | null {
  if (!idToken) return null;
  try {
    const payload = JSON.parse(Buffer.from(idToken.split('.')[1] ?? '', 'base64url').toString('utf8')) as {
      email?: string;
    };
    return payload.email ?? null;
  } catch {
    return null;
  }
}

async function tokenRequest(httpFetch: HttpFetch, params: Record<string, string>): Promise<TokenResponse> {
  const response = await httpFetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(20_000),
  });
  const json = (await response.json()) as TokenResponse;
  if (!response.ok || json.error)
    throw new IntegrationAuthError(
      json.error_description ?? json.error ?? `Token request failed (HTTP ${response.status})`,
    );
  return json;
}

/**
 * Validates the state (exists, unused, unexpired, same user that started the flow), exchanges the
 * code with PKCE, and stores the tokens encrypted.
 */
export async function completeGoogleOAuth(
  prisma: PrismaClient,
  params: { state: string; code: string; sessionUserId: string },
  httpFetch: HttpFetch = fetch,
): Promise<{ projectId: string; integrationId: string; provider: GoogleProvider }> {
  const env = getEnv();
  const record = await prisma.oAuthState.findUnique({ where: { stateHash: hashToken(params.state) } });
  if (!record || !isGoogleProvider(record.provider) || record.usedAt || record.expiresAt <= new Date()) {
    throw new IntegrationAuthError(
      'This authorization link is invalid or has expired. Start the connection again.',
    );
  }
  if (record.userId !== params.sessionUserId)
    throw new IntegrationAuthError('The connection was started by a different user.');
  const consumed = await prisma.oAuthState.updateMany({
    where: { id: record.id, usedAt: null },
    data: { usedAt: new Date() },
  });
  if (consumed.count !== 1) throw new IntegrationAuthError('This authorization link was already used.');

  const provider = record.provider;
  const requestedScopes = GOOGLE_PROVIDERS[provider].scopes.join(' ');
  const tokens = await tokenRequest(httpFetch, {
    code: params.code,
    client_id: env.GOOGLE_CLIENT_ID ?? '',
    client_secret: env.GOOGLE_CLIENT_SECRET ?? '',
    redirect_uri: googleRedirectUri(),
    grant_type: 'authorization_code',
    code_verifier: decryptSecret(record.codeVerifierEnc),
  });
  const integration = await prisma.integration.upsert({
    where: { projectId_provider: { projectId: record.projectId, provider } },
    update: {
      status: 'CONNECTED',
      externalAccount: emailFromIdToken(tokens.id_token),
      scopes: tokens.scope ?? requestedScopes,
      connectedById: record.userId,
      connectedAt: new Date(),
      lastError: null,
    },
    create: {
      workspaceId: record.workspaceId,
      projectId: record.projectId,
      provider,
      status: 'CONNECTED',
      externalAccount: emailFromIdToken(tokens.id_token),
      scopes: tokens.scope ?? requestedScopes,
      connectedById: record.userId,
      connectedAt: new Date(),
    },
  });
  const tokenData = {
    accessTokenEnc: encryptSecret(tokens.access_token),
    ...(tokens.refresh_token ? { refreshTokenEnc: encryptSecret(tokens.refresh_token) } : {}),
    tokenType: tokens.token_type ?? 'Bearer',
    scope: tokens.scope ?? null,
    expiresAt: tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000) : null,
  };
  await prisma.oAuthToken.upsert({
    where: { integrationId: integration.id },
    update: tokenData,
    create: { integrationId: integration.id, ...tokenData },
  });
  return { projectId: record.projectId, integrationId: integration.id, provider };
}

/** Returns a usable access token, refreshing it when it is about to expire. */
export async function getValidAccessToken(
  prisma: PrismaClient,
  integrationId: string,
  httpFetch: HttpFetch = fetch,
): Promise<string> {
  const token = await prisma.oAuthToken.findUnique({ where: { integrationId } });
  if (!token) throw new IntegrationAuthError('This integration is not connected.');
  if (!token.expiresAt || token.expiresAt.getTime() > Date.now() + 60_000)
    return decryptSecret(token.accessTokenEnc);
  if (!token.refreshTokenEnc) {
    await prisma.integration.update({
      where: { id: integrationId },
      data: { status: 'NEEDS_REAUTH', lastError: 'Access expired and no refresh token is available.' },
    });
    throw new IntegrationAuthError('Access expired. Reconnect the Google integration.');
  }
  const env = getEnv();
  try {
    const refreshed = await tokenRequest(httpFetch, {
      client_id: env.GOOGLE_CLIENT_ID ?? '',
      client_secret: env.GOOGLE_CLIENT_SECRET ?? '',
      refresh_token: decryptSecret(token.refreshTokenEnc),
      grant_type: 'refresh_token',
    });
    await prisma.oAuthToken.update({
      where: { integrationId },
      data: {
        accessTokenEnc: encryptSecret(refreshed.access_token),
        expiresAt: refreshed.expires_in ? new Date(Date.now() + refreshed.expires_in * 1000) : null,
      },
    });
    return refreshed.access_token;
  } catch (error) {
    await prisma.integration.update({
      where: { id: integrationId },
      data: { status: 'NEEDS_REAUTH', lastError: error instanceof Error ? error.message : 'Refresh failed' },
    });
    throw error;
  }
}

interface GoogleErrorBody {
  error?: { code?: number; message?: string; status?: string };
}

/**
 * Authenticated JSON request to any Google API with consistent error handling:
 *  - 401 marks the integration NEEDS_REAUTH;
 *  - 403 (no access, API not enabled or quota 0 before approval), 404 and 400 are permanent;
 *  - 429 and 5xx are retryable.
 */
export async function googleApiRequest<T>(
  prisma: PrismaClient,
  integrationId: string,
  url: string,
  init: RequestInit,
  httpFetch: HttpFetch = fetch,
  service = 'Google API',
): Promise<T> {
  const accessToken = await getValidAccessToken(prisma, integrationId, httpFetch);
  const response = await httpFetch(url, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(60_000),
  });
  if (response.status === 401) {
    await prisma.integration.update({
      where: { id: integrationId },
      data: { status: 'NEEDS_REAUTH', lastError: 'Google rejected the access token.' },
    });
    throw new IntegrationAuthError(`Google rejected the access token. Reconnect ${service}.`);
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as GoogleErrorBody;
    const googleStatus = body.error?.status ?? null;
    const detail = (body.error?.message ?? '').slice(0, 300);
    const retryable = response.status === 429 || response.status >= 500;
    const message =
      response.status === 403
        ? `${service} denied access (${googleStatus ?? 'HTTP 403'}). Check that the API is enabled and approved for this Google Cloud project and that the connected account has access.${detail ? ` Google: ${detail}` : ''}`
        : response.status === 429
          ? `${service} rate limit or quota reached.${detail ? ` Google: ${detail}` : ''}`
          : `${service} returned HTTP ${response.status}.${detail ? ` Google: ${detail}` : ''}`;
    throw new GoogleApiError(response.status, googleStatus, message, retryable);
  }
  if (response.status === 204) return {} as T;
  return (await response.json()) as T;
}

function gscRequest<T>(
  prisma: PrismaClient,
  integrationId: string,
  path: string,
  init: RequestInit,
  httpFetch: HttpFetch,
): Promise<T> {
  return googleApiRequest<T>(prisma, integrationId, `${GSC_API}${path}`, init, httpFetch, 'Search Console');
}

export async function listGscSites(
  prisma: PrismaClient,
  integrationId: string,
  httpFetch: HttpFetch = fetch,
) {
  const data = await gscRequest<{ siteEntry?: { siteUrl: string; permissionLevel: string }[] }>(
    prisma,
    integrationId,
    '/sites',
    { method: 'GET' },
    httpFetch,
  );
  return (data.siteEntry ?? []).filter((s) => s.permissionLevel !== 'siteUnverifiedUser');
}

export async function disconnectGoogle(
  prisma: PrismaClient,
  integrationId: string,
  httpFetch: HttpFetch = fetch,
): Promise<void> {
  const token = await prisma.oAuthToken.findUnique({ where: { integrationId } });
  if (token) {
    const toRevoke = token.refreshTokenEnc
      ? decryptSecret(token.refreshTokenEnc)
      : decryptSecret(token.accessTokenEnc);
    await httpFetch(`${REVOKE_URL}?token=${encodeURIComponent(toRevoke)}`, {
      method: 'POST',
      signal: AbortSignal.timeout(10_000),
    }).catch(() => undefined);
    await prisma.oAuthToken.delete({ where: { integrationId } });
  }
  await prisma.integration.update({
    where: { id: integrationId },
    data: { status: 'DISCONNECTED', config: undefined, externalAccount: null, lastError: null },
  });
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

interface AnalyticsRow {
  keys?: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

/** Syncs daily totals (last `days`) and top queries/pages (last 28 days) for the selected property. */
export async function syncSearchConsole(
  prisma: PrismaClient,
  integrationId: string,
  { days = 90 }: { days?: number } = {},
  httpFetch: HttpFetch = fetch,
) {
  const integration = await prisma.integration.findUniqueOrThrow({ where: { id: integrationId } });
  const siteUrl = (integration.config as { siteUrl?: string } | null)?.siteUrl;
  if (!siteUrl) throw Errors.badRequest('Choose a Search Console property before syncing.');
  const end = new Date(Date.now() - 2 * 86_400_000); // Search Console data lags ~2 days
  const start = new Date(end.getTime() - (days - 1) * 86_400_000);
  const start28 = new Date(end.getTime() - 27 * 86_400_000);
  const query = (body: Record<string, unknown>) =>
    gscRequest<{ rows?: AnalyticsRow[] }>(
      prisma,
      integrationId,
      `/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
      { method: 'POST', body: JSON.stringify(body) },
      httpFetch,
    );

  const [daily, queries, pages] = await Promise.all([
    query({ startDate: isoDay(start), endDate: isoDay(end), dimensions: ['date'], rowLimit: 25_000 }),
    query({ startDate: isoDay(start28), endDate: isoDay(end), dimensions: ['query'], rowLimit: 1000 }),
    query({ startDate: isoDay(start28), endDate: isoDay(end), dimensions: ['page'], rowLimit: 1000 }),
  ]);

  const toRow = (
    dimension: 'DATE' | 'QUERY' | 'PAGE',
    rangeStart: Date,
    rangeEnd: Date,
    row: AnalyticsRow,
  ) => {
    const key = row.keys?.[0] ?? '';
    return {
      projectId: integration.projectId,
      integrationId,
      dimension,
      rangeStart,
      rangeEnd,
      key: key.slice(0, 2048),
      keyHash: sha256Hex(key),
      clicks: Math.round(row.clicks),
      impressions: Math.round(row.impressions),
      ctr: row.ctr,
      position: row.position,
    };
  };
  const dailyRows = (daily.rows ?? []).map((r) => {
    const day = new Date(`${r.keys?.[0]}T00:00:00Z`);
    return toRow('DATE', day, day, r);
  });
  const rangeStart = new Date(`${isoDay(start28)}T00:00:00Z`);
  const rangeEnd = new Date(`${isoDay(end)}T00:00:00Z`);
  await prisma.$transaction([
    prisma.searchConsoleMetric.deleteMany({
      where: {
        integrationId,
        dimension: 'DATE',
        rangeStart: { gte: new Date(`${isoDay(start)}T00:00:00Z`) },
      },
    }),
    prisma.searchConsoleMetric.createMany({ data: dailyRows, skipDuplicates: true }),
    prisma.searchConsoleMetric.deleteMany({
      where: { integrationId, dimension: { in: ['QUERY', 'PAGE'] }, rangeStart, rangeEnd },
    }),
    prisma.searchConsoleMetric.createMany({
      data: [
        ...(queries.rows ?? []).map((r) => toRow('QUERY', rangeStart, rangeEnd, r)),
        ...(pages.rows ?? []).map((r) => toRow('PAGE', rangeStart, rangeEnd, r)),
      ],
      skipDuplicates: true,
    }),
  ]);
  await prisma.integration.update({
    where: { id: integrationId },
    data: { lastSyncAt: new Date(), lastSyncStatus: 'SUCCEEDED', lastError: null, status: 'CONNECTED' },
  });
  return { days: dailyRows.length, queries: queries.rows?.length ?? 0, pages: pages.rows?.length ?? 0 };
}

/** Stored Search Console metrics for dashboards and reports. */
export async function searchConsoleMetrics(prisma: PrismaClient, projectId: string, from: Date, to: Date) {
  const [daily, latestQuery] = await Promise.all([
    prisma.searchConsoleMetric.findMany({
      where: { projectId, dimension: 'DATE', rangeStart: { gte: from, lte: to } },
      orderBy: { rangeStart: 'asc' },
    }),
    prisma.searchConsoleMetric.findFirst({
      where: { projectId, dimension: 'QUERY' },
      orderBy: { rangeEnd: 'desc' },
      select: { rangeStart: true, rangeEnd: true },
    }),
  ]);
  const top = latestQuery
    ? await prisma.searchConsoleMetric.findMany({
        where: {
          projectId,
          dimension: { in: ['QUERY', 'PAGE'] },
          rangeStart: latestQuery.rangeStart,
          rangeEnd: latestQuery.rangeEnd,
        },
        orderBy: { clicks: 'desc' },
        take: 200,
      })
    : [];
  const totals = daily.reduce(
    (acc, d) => ({ clicks: acc.clicks + d.clicks, impressions: acc.impressions + d.impressions }),
    { clicks: 0, impressions: 0 },
  );
  const weightedPosition = daily.reduce((sum, d) => sum + d.position * d.impressions, 0);
  return {
    daily: daily.map((d) => ({
      date: isoDay(d.rangeStart),
      clicks: d.clicks,
      impressions: d.impressions,
      ctr: d.ctr,
      position: d.position,
    })),
    totals: {
      ...totals,
      ctr: totals.impressions ? totals.clicks / totals.impressions : null,
      position: totals.impressions ? weightedPosition / totals.impressions : null,
    },
    topRange: latestQuery ? { from: isoDay(latestQuery.rangeStart), to: isoDay(latestQuery.rangeEnd) } : null,
    topQueries: top
      .filter((t) => t.dimension === 'QUERY')
      .slice(0, 50)
      .map((t) => ({
        query: t.key,
        clicks: t.clicks,
        impressions: t.impressions,
        ctr: t.ctr,
        position: t.position,
      })),
    topPages: top
      .filter((t) => t.dimension === 'PAGE')
      .slice(0, 50)
      .map((t) => ({
        page: t.key,
        clicks: t.clicks,
        impressions: t.impressions,
        ctr: t.ctr,
        position: t.position,
      })),
  };
}
