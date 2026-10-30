// A single, consolidated health view across every data source the product depends on: the Google connections, the
// AI model, the local-rank source and the background-job infrastructure. Each check says what it enables, whether it
// is working, and how to fix it when not — so an operator can see at a glance what is set up and what is missing.
import type { IntegrationDiagnosticsDto, DiagnosticCheck, DiagnosticStatus } from '@surfaced/shared';
import { listLlmProviders } from '../ai/llm';
import type { PrismaClient } from '../db';
import { getEnv } from '../env';
import { liveLocalRankSources } from '../local/rank-providers';
import { googleOAuthConfigured } from './google';

export interface DiagnosticsOptions {
  /** Whether the Redis/queue backend is connected in this process (background jobs need it). */
  redisConnected: boolean;
  now?: Date;
}

const daysSince = (d: Date | null, now: Date): number | null =>
  d ? Math.floor((now.getTime() - d.getTime()) / 86_400_000) : null;

/** Freshness phrasing and status for a connected, synced integration. */
function syncFreshness(
  lastSyncAt: Date | null,
  lastSyncStatus: string | null,
  lastError: string | null,
  now: Date,
): { status: DiagnosticStatus; detail: string; fix: string | null } {
  if (lastSyncStatus === 'FAILED')
    return { status: 'error', detail: `The last sync failed: ${lastError ?? 'unknown error'}.`.slice(0, 240), fix: 'Reconnect the account or retry the sync.' }; // prettier-ignore
  const days = daysSince(lastSyncAt, now);
  if (days === null) return { status: 'warning', detail: 'Connected, but not synced yet.', fix: 'Run a sync to import data.' }; // prettier-ignore
  if (days > 7) return { status: 'warning', detail: `Last synced ${days} days ago.`, fix: 'Sync again for fresh data.' }; // prettier-ignore
  return { status: 'ok', detail: `Last synced ${days === 0 ? 'today' : `${days} day${days === 1 ? '' : 's'} ago`}.`, fix: null }; // prettier-ignore
}

/**
 * Builds the diagnostics for a project. Reads the project's integrations, counts linked locations and recent failed
 * jobs, and combines them with the server-side provider configuration (Google OAuth, AI model, local rank source).
 */
export async function integrationDiagnostics(
  prisma: PrismaClient,
  projectId: string,
  options: DiagnosticsOptions,
): Promise<IntegrationDiagnosticsDto> {
  const env = getEnv();
  const now = options.now ?? new Date();
  const link = `/app/p/${projectId}/integrations`;
  const checks: DiagnosticCheck[] = [];
  const integrations = await prisma.integration.findMany({ where: { projectId } });
  const byProvider = (p: string) => integrations.find((i) => i.provider === p) ?? null;

  // 1. Google OAuth client (shared by every Google integration).
  const oauth = googleOAuthConfigured();
  checks.push({
    key: 'google_oauth',
    title: 'Google sign-in',
    category: 'connections',
    status: oauth ? 'ok' : 'warning',
    detail: oauth ? 'A Google OAuth client is configured.' : 'No Google OAuth client is configured.',
    enables: 'Search Console, Business Profile and Merchant Center.',
    fix: oauth ? null : 'Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and the redirect URI.',
    link: null,
  });

  // 2 & 3. Google connections that are implemented.
  for (const [provider, title, enables] of [
    ['GOOGLE_SEARCH_CONSOLE', 'Search Console', 'Clicks, impressions, CTR and position for a property.'],
    ['GOOGLE_BUSINESS_PROFILE', 'Business Profile', 'Profile audit, performance, reviews, posts and edits.'],
  ] as const) {
    const row = byProvider(provider);
    let check: Omit<DiagnosticCheck, 'key' | 'title' | 'category' | 'enables' | 'link'>;
    if (!row || row.status === 'DISCONNECTED')
      check = { status: 'off', detail: 'Not connected.', fix: oauth ? `Connect ${title}.` : 'Configure the Google OAuth client first.' }; // prettier-ignore
    else if (row.status === 'NEEDS_REAUTH')
      check = { status: 'error', detail: 'Access expired or was revoked.', fix: `Reconnect ${title}.` };
    else if (provider === 'GOOGLE_SEARCH_CONSOLE' && !(row.config as { siteUrl?: string } | null)?.siteUrl)
      check = { status: 'warning', detail: 'Connected, but no property is selected.', fix: 'Choose a property to sync.' }; // prettier-ignore
    else check = syncFreshness(row.lastSyncAt, row.lastSyncStatus, row.lastError, now);
    checks.push({ key: provider.toLowerCase(), title, category: 'connections', enables, link, ...check });
  }

  // Business Profile: also flag connected-but-no-location-linked.
  const gbp = byProvider('GOOGLE_BUSINESS_PROFILE');
  if (gbp && gbp.status !== 'DISCONNECTED' && gbp.status !== 'NEEDS_REAUTH') {
    const linkedLocations = await prisma.businessLocation.count({
      where: { projectId, archivedAt: null, profileLocationName: { not: null } },
    });
    if (linkedLocations === 0) {
      const bp = checks.find((c) => c.key === 'google_business_profile');
      if (bp) {
        bp.status = 'warning';
        bp.detail = 'Connected, but no location is linked to a profile.';
        bp.fix = 'Link a Business Profile location to sync its data.';
      }
    }
  }

  // 4. AI model.
  const providers = listLlmProviders();
  const dflt = providers.find((p) => p.isDefault) ?? null;
  const aiEnables = 'Review summaries, review-reply and post drafts, content ideas.';
  if (env.LLM_PROVIDER === 'none')
    checks.push({ key: 'ai_model', title: 'AI model', category: 'ai', status: 'warning', detail: 'No AI model is configured (LLM_PROVIDER=none). AI features are unavailable.', enables: aiEnables, fix: 'Set LLM_PROVIDER to openai or gemini and add its API key.', link: null }); // prettier-ignore
  else if (dflt?.isDevAdapter)
    checks.push({ key: 'ai_model', title: 'AI model', category: 'ai', status: 'warning', detail: 'Using the development template adapter — output is boilerplate, not a real model.', enables: aiEnables, fix: 'Set OPENAI_API_KEY or GEMINI_API_KEY and select that provider.', link: null }); // prettier-ignore
  else if (dflt?.configured)
    checks.push({ key: 'ai_model', title: 'AI model', category: 'ai', status: 'ok', detail: dflt.detail, enables: aiEnables, fix: null, link: null }); // prettier-ignore
  else
    checks.push({ key: 'ai_model', title: 'AI model', category: 'ai', status: 'error', detail: `${env.LLM_PROVIDER} is selected but its API key is missing.`, enables: aiEnables, fix: `Set the API key for ${env.LLM_PROVIDER}.`, link: null }); // prettier-ignore

  // 5. Local rank source.
  const sources = liveLocalRankSources();
  if (sources.length)
    checks.push({ key: 'local_rank_source', title: 'Local rank source', category: 'local', status: 'ok', detail: `Automatic source${sources.length > 1 ? 's' : ''}: ${sources.join(', ')}.`, enables: 'Automatic Map/local grid scans.', fix: null, link: `/app/p/${projectId}/local/rank` }); // prettier-ignore
  else
    checks.push({ key: 'local_rank_source', title: 'Local rank source', category: 'local', status: 'warning', detail: 'No automatic local rank source; manual entry and CSV import only.', enables: 'Automatic Map/local grid scans.', fix: 'Set SERP_PROVIDER (osm for discovery, or custom for your own collection service).', link: `/app/p/${projectId}/local/rank` }); // prettier-ignore

  // 6. Background jobs / infrastructure.
  if (!options.redisConnected)
    checks.push({ key: 'background_jobs', title: 'Background jobs', category: 'infrastructure', status: 'warning', detail: 'Redis is not connected, so scans, syncs and other background jobs may not run.', enables: 'Scans, syncs, crawls and scheduled work.', fix: 'Set REDIS_URL and start Redis.', link: null }); // prettier-ignore
  else {
    const failed = await prisma.backgroundJob.count({
      where: { projectId, status: 'FAILED', createdAt: { gte: new Date(now.getTime() - 86_400_000) } },
    });
    checks.push({
      key: 'background_jobs',
      title: 'Background jobs',
      category: 'infrastructure',
      status: failed > 0 ? 'warning' : 'ok',
      detail: failed > 0 ? `${failed} background job${failed === 1 ? '' : 's'} failed in the last 24 hours.` : 'Background jobs are running.', // prettier-ignore
      enables: 'Scans, syncs, crawls and scheduled work.',
      fix: failed > 0 ? 'Check the recent jobs for the error and retry.' : null,
      link: null,
    });
  }

  const summary = { ok: 0, warning: 0, error: 0, off: 0 };
  for (const c of checks) summary[c.status] += 1;
  return { checks, summary, generatedAt: now.toISOString() };
}
