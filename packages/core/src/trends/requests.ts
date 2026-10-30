// Creating trends reports (manual, imported or scheduled): limits, cache reuse, quota and queueing; provider status;
// scheduled refreshes of saved comparisons; and CSV export of a report.
import {
  TREND_SOURCE_LABELS,
  termWithCity,
  trendSourceType,
  type TrendAnalysisResult,
  type TrendData,
  type TrendDataType,
  type TrendExportPart,
  type TrendLiveSource,
  type TrendProviderStatusDto,
  type TrendSchedule,
  type TrendSource,
  type TrendTimeRange,
} from '@surfaced/shared';
import type { PrismaClient } from '../db';
import { getEnv } from '../env';
import { Errors, errorMessage } from '../errors';
import { createJobRecord, enqueueJobRecord } from '../jobs';
import { csvCell } from '../keywords';
import type { QueueGateway } from '../queue';
import { assertMonthlyQuota, recordUsage, withWorkspaceLock } from '../usage';
import {
  TREND_PROVIDER_ORDER,
  defaultLiveSource,
  getTrendsProvider,
  isLiveSourceUsable,
  isTrendSourceEnabled,
  type TrendsFetch,
} from './providers';
import { copyTrendData, saveTrendData, trendCacheKey } from './store';

/** Reports per project per rolling 24 hours (imports included). */
export const TREND_REPORTS_PER_PROJECT_PER_DAY = 20;

const DAY_MS = 24 * 3600 * 1000;

export interface TrendReportRequest {
  projectId: string;
  workspaceId: string;
  userId: string | null;
  source: TrendSource;
  /** Terms as sent to the provider (with the city already added when a city filter is set). */
  keywords: string[];
  country: string | null;
  region: string | null;
  /** City filter (stored for labels; the terms already mention it). */
  city?: string | null;
  timeRange: TrendTimeRange;
  category: number;
  language: string;
  include: TrendDataType[];
  suggestPlacements: boolean;
  trigger: 'MANUAL' | 'SCHEDULED';
  savedQueryId?: string | null;
  /** Imported data (CSV), saved with the report. */
  data?: TrendData | null;
  imports?: {
    fileName: string;
    kind: string;
    keywords: string[];
    headerNote: string | null;
    rowCount: number;
  }[];
}

/** Live-provider reports a workspace made in the last 24 hours. Cache hits and imports do not count. */
export function liveReportsToday(prisma: PrismaClient, workspaceId: string): Promise<number> {
  return prisma.trendReport.count({
    where: {
      project: { workspaceId },
      source: { notIn: ['CSV_IMPORT', 'FIXTURE'] },
      cachedFromId: null,
      createdAt: { gte: new Date(Date.now() - DAY_MS) },
    },
  });
}

/** A complete, unexpired report with the same cache key, from any project (only its data rows are reused). */
export function findCachedTrendReport(prisma: PrismaClient, cacheKey: string) {
  return prisma.trendReport.findFirst({
    where: {
      cacheKey,
      status: 'SUCCEEDED',
      partial: false,
      cachedFromId: null,
      expiresAt: { gt: new Date() },
    },
    orderBy: { fetchedAt: 'desc' },
    select: { id: true, fetchedAt: true, expiresAt: true, limitations: true },
  });
}

export async function createTrendReport(
  prisma: PrismaClient,
  queues: QueueGateway,
  request: TrendReportRequest,
): Promise<{ reportId: string; jobId: string; status: 'QUEUED'; cached: boolean }> {
  const env = getEnv();
  const live = trendSourceType(request.source) !== 'CSV';
  const running = await prisma.trendReport.findFirst({
    where: { projectId: request.projectId, status: { in: ['QUEUED', 'RUNNING'] } },
    select: { id: true },
  });
  if (running) throw Errors.conflict('A trends report for this project is already being prepared.');
  const today = await prisma.trendReport.count({
    where: { projectId: request.projectId, createdAt: { gte: new Date(Date.now() - DAY_MS) } },
  });
  if (today >= TREND_REPORTS_PER_PROJECT_PER_DAY)
    throw Errors.rateLimited(`A project can create ${TREND_REPORTS_PER_PROJECT_PER_DAY} trends reports a day. Try again later.`); // prettier-ignore

  const cacheKey = live ? trendCacheKey(request) : null;
  const cached = cacheKey ? await findCachedTrendReport(prisma, cacheKey) : null;
  if (live && !cached && request.source !== 'FIXTURE') {
    const used = await liveReportsToday(prisma, request.workspaceId);
    if (used >= env.TRENDS_LIVE_REPORTS_PER_WORKSPACE_PER_DAY)
      throw Errors.rateLimited(`This workspace has used its ${env.TRENDS_LIVE_REPORTS_PER_WORKSPACE_PER_DAY} live trends lookups for today. Try again tomorrow, or import a CSV from Google Trends.`); // prettier-ignore
  }

  // Only manual reports with AI placement suggestions use an AI keyword run.
  const charge = request.trigger === 'MANUAL' && request.suggestPlacements;
  const { report, job } = await withWorkspaceLock(prisma, request.workspaceId, async (tx) => {
    if (charge) await assertMonthlyQuota(tx, request.workspaceId, 'KEYWORD_SUGGESTION');
    const report = await tx.trendReport.create({
      data: {
        projectId: request.projectId,
        source: request.source,
        trigger: request.trigger,
        createdById: request.userId,
        savedQueryId: request.savedQueryId ?? null,
        keywords: request.keywords,
        country: request.country,
        region: request.region,
        city: request.city ?? null,
        language: request.language,
        timeRange: request.timeRange,
        category: request.category,
        include: request.include,
        suggestPlacements: request.suggestPlacements,
        cacheKey,
        cachedFromId: cached?.id ?? null,
        fetchedAt: cached?.fetchedAt ?? (request.data ? new Date() : null),
        expiresAt: cached?.expiresAt ?? null,
        limitations: (cached?.limitations as string[] | null) ?? undefined,
      },
    });
    if (cached) await copyTrendData(tx, cached.id, report.id);
    if (request.data) await saveTrendData(tx, report.id, request.data);
    if (request.imports?.length)
      await tx.trendCsvImport.createMany({
        data: request.imports.map((file) => ({
          projectId: request.projectId,
          reportId: report.id,
          createdById: request.userId,
          fileName: file.fileName.slice(0, 200),
          kind: file.kind,
          keywords: file.keywords,
          country: request.country,
          region: request.region,
          timeRange: request.timeRange,
          headerNote: file.headerNote?.slice(0, 120) ?? null,
          rowCount: file.rowCount,
        })),
      });
    if (charge)
      await recordUsage(tx, {
        workspaceId: request.workspaceId,
        projectId: request.projectId,
        metric: 'KEYWORD_SUGGESTION',
        quantity: 1,
        idempotencyKey: `trends:${report.id}`,
      });
    const job = await createJobRecord(tx, {
      type: 'TREND_REPORT',
      queue: 'trends',
      workspaceId: request.workspaceId,
      projectId: request.projectId,
      userId: request.userId,
      entityType: 'TrendReport',
      entityId: report.id,
      payload: { trendReportId: report.id },
      maxAttempts: 2,
    });
    return { report, job };
  });
  try {
    await enqueueJobRecord(prisma, queues, job, 'trends', { backgroundJobId: job.id, trendReportId: report.id }, { backoffMs: 60_000 }); // prettier-ignore
  } catch (error) {
    // Never leave a report "queued" forever: it would block every later report for the project.
    await prisma.trendReport.update({
      where: { id: report.id },
      data: { status: 'FAILED', errorMessage: errorMessage(error).slice(0, 500), finishedAt: new Date() },
    });
    throw error;
  }
  return { reportId: report.id, jobId: job.id, status: 'QUEUED', cached: Boolean(cached) };
}

// ---------------- Provider status ----------------

const healthCache = new Map<
  TrendSource,
  { at: number; value: NonNullable<TrendProviderStatusDto['health']> }
>();
const HEALTH_TTL_MS = 10_000;

/** Status of every provider the server allows, with the last success and failure of each. */
export async function trendProviderStatuses(
  prisma: PrismaClient,
  options: { fetchImpl?: TrendsFetch; checkHealth?: boolean } = {},
): Promise<TrendProviderStatusDto[]> {
  const out: TrendProviderStatusDto[] = [];
  for (const key of TREND_PROVIDER_ORDER) {
    if (!isTrendSourceEnabled(key)) continue;
    const provider = getTrendsProvider(key);
    const { configured, detail } = provider.configured();
    const implemented = provider.meta.kind === 'import' || typeof provider.fetch === 'function';
    let health: TrendProviderStatusDto['health'] = null;
    if (configured && provider.health && options.checkHealth !== false) {
      const hit = healthCache.get(key);
      if (hit && Date.now() - hit.at < HEALTH_TTL_MS && !options.fetchImpl) health = hit.value;
      else {
        health = await provider.health(options.fetchImpl);
        healthCache.set(key, { at: Date.now(), value: health });
      }
    }
    const [success, failure] = await Promise.all([
      prisma.trendProviderEvent.findFirst({
        where: { provider: key, outcome: { in: ['SUCCESS', 'CACHE_HIT'] } },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      }),
      prisma.trendProviderEvent.findFirst({
        where: { provider: key, outcome: { notIn: ['SUCCESS', 'CACHE_HIT', 'NO_DATA'] } },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true, outcome: true, message: true },
      }),
    ]);
    out.push({
      key,
      label: provider.meta.label,
      kind: provider.meta.kind,
      enabled: true,
      configured,
      available: configured && implemented && (health ? health.ok : true),
      experimental: provider.meta.experimental,
      paid: provider.meta.paid,
      detail,
      capabilities: provider.meta.capabilities,
      health,
      lastSuccessAt: success?.createdAt.toISOString() ?? null,
      lastFailure: failure
        ? { at: failure.createdAt.toISOString(), outcome: failure.outcome, message: failure.message }
        : null,
    });
  }
  return out;
}

/** Test hook: forget cached health checks. */
export function resetTrendHealthCache(): void {
  healthCache.clear();
}

// ---------------- Scheduled refreshes ----------------

export function nextTrendRun(schedule: TrendSchedule, from: Date): Date | null {
  if (schedule === 'WEEKLY') return new Date(from.getTime() + 7 * DAY_MS);
  if (schedule === 'MONTHLY') return new Date(from.getTime() + 30 * DAY_MS);
  return null;
}

/**
 * Starts reports for saved comparisons that are due. Scheduled reports refresh the data and the comparison with the
 * site, without AI placement suggestions (so they use no AI quota). Each comparison is claimed once per tick.
 */
export async function runScheduledTrendRefreshes(deps: {
  prisma: PrismaClient;
  queues: QueueGateway;
  now?: () => Date;
}): Promise<{ started: number; skipped: { savedQueryId: string; reason: string }[] }> {
  const { prisma, queues } = deps;
  const now = deps.now?.() ?? new Date();
  const due = await prisma.trendSavedQuery.findMany({
    where: { schedule: { in: ['WEEKLY', 'MONTHLY'] }, nextRunAt: { lte: now } },
    include: { project: { select: { workspaceId: true, targetLanguages: true } } },
    orderBy: { nextRunAt: 'asc' },
    take: 200,
  });
  let started = 0;
  const skipped: { savedQueryId: string; reason: string }[] = [];
  for (const query of due) {
    const claimed = await prisma.trendSavedQuery.updateMany({
      where: { id: query.id, nextRunAt: query.nextRunAt },
      data: { nextRunAt: nextTrendRun(query.schedule as TrendSchedule, now) },
    });
    if (claimed.count === 0) continue;
    const source = (query.provider as TrendLiveSource | null) ?? defaultLiveSource();
    if (!source || !isLiveSourceUsable(source)) {
      skipped.push({ savedQueryId: query.id, reason: source ? `${TREND_SOURCE_LABELS[source]} is not available on this server.` : 'No live trends provider is available.' }); // prettier-ignore
      continue;
    }
    const languages = Array.isArray(query.project.targetLanguages) ? (query.project.targetLanguages as string[]) : []; // prettier-ignore
    try {
      await createTrendReport(prisma, queues, {
        projectId: query.projectId,
        workspaceId: query.project.workspaceId,
        userId: query.createdById,
        source,
        keywords: (Array.isArray(query.keywords) ? (query.keywords as string[]) : []).map((k) => termWithCity(k, query.city)), // prettier-ignore
        country: query.country,
        region: query.region,
        city: query.city,
        timeRange: query.timeRange as TrendTimeRange,
        category: query.category,
        language: languages[0] ?? 'en',
        include: ['interest', 'regions', 'related_queries', 'related_topics'],
        suggestPlacements: false,
        trigger: 'SCHEDULED',
        savedQueryId: query.id,
      });
      started++;
    } catch (error) {
      skipped.push({ savedQueryId: query.id, reason: errorMessage(error) });
    }
  }
  return { started, skipped };
}

// ---------------- Export ----------------

function csv(rows: unknown[][]): string {
  return `${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

/**
 * One part of a report as CSV. Every row says where the data came from and when, and what the values are, so an
 * exported file cannot be mistaken for search volumes or mixed with another provider's data.
 */
export function trendReportCsv(
  report: {
    source: TrendSource;
    fetchedAt: Date | null;
    country: string | null;
    region: string | null;
    city?: string | null;
    timeRange: string;
    category: number;
  },
  data: TrendData | null,
  analysis: TrendAnalysisResult | null,
  part: TrendExportPart,
): string {
  const meta = [
    TREND_SOURCE_LABELS[report.source],
    report.fetchedAt?.toISOString() ?? '',
    report.city
      ? `searches mentioning ${report.city} in ${report.region ?? report.country}`
      : (report.region ?? report.country ?? 'Worldwide'),
    report.timeRange,
    report.category,
  ];
  const metaHeader = ['source', 'retrieved_at', 'place', 'time_range', 'category'];
  if (part === 'interest') {
    const interest = data?.interest;
    const rows: unknown[][] = [['period', 'term', 'relative_interest_0_100', 'is_partial', ...metaHeader]];
    if (interest)
      interest.series.forEach(
        (s) =>
        interest.dates.forEach((date, i) => rows.push([date, s.keyword, s.values[i] ?? '', interest.partial?.[i] ? 'yes' : 'no', ...meta])), // prettier-ignore
      );
    return csv(rows);
  }
  if (part === 'regions') {
    const regions = data?.regions;
    const rows: unknown[][] = [['place', 'place_code', 'term', regions?.comparison === 'share' ? 'share_of_compared_terms_percent' : 'relative_interest_0_100', ...metaHeader]]; // prettier-ignore
    if (regions)
      for (const r of regions.regions)
        regions.keywords.forEach((k, i) =>
          rows.push([r.name, r.geoCode ?? '', k, r.values[i] ?? '', ...meta]),
        );
    return csv(rows);
  }
  if (part === 'related') {
    const rows: unknown[][] = [['term', 'kind', 'list', 'rank', 'label', 'topic_type', 'relative_popularity_0_100', 'growth', ...metaHeader]]; // prettier-ignore
    for (const g of data?.related ?? []) {
      g.top.forEach((q, i) =>
        rows.push([g.keyword ?? '', 'query', 'top', i + 1, q.query, '', q.value, '', ...meta]),
      );
      g.rising.forEach((q, i) => rows.push([g.keyword ?? '', 'query', 'rising', i + 1, q.query, '', '', q.value, ...meta])); // prettier-ignore
    }
    for (const g of data?.topics ?? []) {
      g.top.forEach((t, i) => rows.push([g.keyword ?? '', 'topic', 'top', i + 1, t.topic, t.type ?? '', t.value, '', ...meta])); // prettier-ignore
      g.rising.forEach((t, i) => rows.push([g.keyword ?? '', 'topic', 'rising', i + 1, t.topic, t.type ?? '', '', t.value, ...meta])); // prettier-ignore
    }
    return csv(rows);
  }
  const rows: unknown[][] = [['term', 'origin', 'interest_or_popularity', 'rising', 'direction', 'site_status', 'pages', 'search_console_impressions', 'search_console_clicks', 'search_console_position', ...metaHeader]]; // prettier-ignore
  for (const t of analysis?.terms ?? [])
    rows.push([t.term, t.origin, t.interest ?? '', t.rising ?? '', t.direction ?? '', t.status, t.pages.map((p) => p.url).join(' '), t.searchConsole?.impressions ?? '', t.searchConsole?.clicks ?? '', t.searchConsole?.position ?? '', ...meta]); // prettier-ignore
  return csv(rows);
}
