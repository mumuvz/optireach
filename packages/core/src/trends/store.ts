// Normalized storage of Google Trends data (trend_observations, trend_regional_interest, trend_related_items),
// the cache key and lifetime of fetched data, and provider event records.
import { createHash } from 'node:crypto';
import type {
  TrendData,
  TrendDataType,
  TrendInterest,
  TrendRegionalInterest,
  TrendRegionResolution,
  TrendRelatedQueries,
  TrendRelatedTopics,
  TrendSource,
} from '@surfaced/shared';
import type { Prisma, PrismaClient } from '../db';
import { getEnv } from '../env';
import { TREND_PROVIDER_SETTING_NAMES, type TrendOperation } from './providers';

type Db = PrismaClient | Prisma.TransactionClient;

// ---------------- Cache ----------------

/** Same provider, terms (in any order or case), place, period, category, language and data types. */
export function trendCacheKey(input: {
  source: TrendSource;
  keywords: string[];
  country: string | null;
  region: string | null;
  timeRange: string;
  category: number;
  language: string;
  include: TrendDataType[];
}): string {
  const canonical = JSON.stringify([
    input.source,
    [...input.keywords].map((k) => k.trim().toLowerCase()).sort(),
    input.country ?? '',
    input.region ?? '',
    input.timeRange,
    input.category,
    input.language,
    [...new Set(input.include)].sort(),
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Hours fetched data is reused, from TRENDS_CACHE_TTL_HOURS ("default=12,regions=24,pytrends.interest=6"). For each
 * data type the most specific entry wins (provider.type, provider, type, default); a report uses the shortest.
 */
export function trendCacheHours(
  source: TrendSource,
  include: TrendDataType[],
  setting = getEnv().TRENDS_CACHE_TTL_HOURS,
): number {
  // prettier-ignore
  const map = new Map<string, number>();
  for (const part of setting.split(',')) {
    const [key, value] = part.split('=').map((s) => s.trim().toLowerCase());
    const hours = Number(value);
    if (key && Number.isFinite(hours) && hours >= 0) map.set(key, hours);
  }
  const provider = TREND_PROVIDER_SETTING_NAMES[source];
  const hoursFor = (type: string) =>
    map.get(`${provider}.${type}`) ?? map.get(provider) ?? map.get(type) ?? map.get('default') ?? 12;
  return Math.min(...(include.length ? include : ['interest']).map(hoursFor));
}

// ---------------- Rows ----------------

const CHUNK = 1000;

async function createInChunks<T>(rows: T[], create: (chunk: T[]) => Promise<unknown>) {
  for (let i = 0; i < rows.length; i += CHUNK) await create(rows.slice(i, i + CHUNK));
}

/** "2026-07-23", "2026-10-16T10", "2026-10-16T10:00:00" or "2026-10" as a UTC date. */
export function periodDate(value: string): Date | null {
  let v = value.trim();
  if (/^\d{4}-\d{2}$/.test(v)) v = `${v}-01`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) v = `${v}T00:00:00`;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}$/.test(v)) v = `${v}:00:00`;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v)) v = `${v}:00`;
  const date = new Date(/[zZ]|[+-]\d{2}:\d{2}$/.test(v) ? v : `${v}Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

const clip = (value: string, max: number) => value.slice(0, max);

export async function saveTrendData(db: Db, reportId: string, data: TrendData): Promise<void> {
  const observations: Prisma.TrendObservationCreateManyInput[] = [];
  const interest = data.interest;
  if (interest)
    interest.series.forEach((series) =>
      interest.dates.forEach((date, i) => {
        const periodStart = periodDate(date);
        if (periodStart)
          observations.push({
            reportId,
            keyword: clip(series.keyword, 100),
            periodStart,
            value: series.values[i] ?? null,
            isPartial: interest.partial?.[i] ?? false,
          });
      }),
    );
  const regional: Prisma.TrendRegionalInterestCreateManyInput[] = [];
  const regions = data.regions;
  if (regions)
    for (const region of regions.regions)
      regions.keywords.forEach((keyword, k) =>
        regional.push({
          reportId,
          keyword: clip(keyword, 100),
          geoCode: region.geoCode ? clip(region.geoCode, 20) : null,
          regionName: clip(region.name, 150),
          resolution: regions.resolution,
          comparison: regions.comparison,
          value: region.values[k] ?? null,
        }),
      );
  const related: Prisma.TrendRelatedItemCreateManyInput[] = [];
  const keywordOf = (k: string | null) => (k ? clip(k, 100) : null);
  for (const group of data.related) {
    group.top.forEach((q, rank) => related.push({ reportId, keyword: keywordOf(group.keyword), kind: 'QUERY', list: 'TOP', rank, label: clip(q.query, 255), value: q.value })); // prettier-ignore
    group.rising.forEach((q, rank) => related.push({ reportId, keyword: keywordOf(group.keyword), kind: 'QUERY', list: 'RISING', rank, label: clip(q.query, 255), growth: clip(q.value, 20) })); // prettier-ignore
  }
  for (const group of data.topics ?? []) {
    group.top.forEach((t, rank) => related.push({ reportId, keyword: keywordOf(group.keyword), kind: 'TOPIC', list: 'TOP', rank, label: clip(t.topic, 255), topicType: t.type ? clip(t.type, 80) : null, value: t.value })); // prettier-ignore
    group.rising.forEach((t, rank) => related.push({ reportId, keyword: keywordOf(group.keyword), kind: 'TOPIC', list: 'RISING', rank, label: clip(t.topic, 255), topicType: t.type ? clip(t.type, 80) : null, growth: clip(t.value, 20) })); // prettier-ignore
  }
  await createInChunks(observations, (chunk) => db.trendObservation.createMany({ data: chunk }));
  await createInChunks(regional, (chunk) => db.trendRegionalInterest.createMany({ data: chunk }));
  await createInChunks(related, (chunk) => db.trendRelatedItem.createMany({ data: chunk }));
}

/** Copies fetched data from one report to another (a cache hit). Only data rows are copied, never report details. */
export async function copyTrendData(db: Db, fromReportId: string, toReportId: string): Promise<void> {
  const [observations, regional, related] = await Promise.all([
    db.trendObservation.findMany({ where: { reportId: fromReportId } }),
    db.trendRegionalInterest.findMany({ where: { reportId: fromReportId } }),
    db.trendRelatedItem.findMany({ where: { reportId: fromReportId } }),
  ]);
  const strip = <T extends { id: string; reportId: string }>({ id: _id, reportId: _reportId, ...rest }: T) => ({ ...rest, reportId: toReportId }); // prettier-ignore
  await createInChunks(observations.map(strip), (chunk) => db.trendObservation.createMany({ data: chunk }));
  await createInChunks(regional.map(strip), (chunk) => db.trendRegionalInterest.createMany({ data: chunk }));
  await createInChunks(related.map(strip), (chunk) => db.trendRelatedItem.createMany({ data: chunk }));
}

function formatPeriod(date: Date, hourly: boolean): string {
  return hourly ? date.toISOString().slice(0, 16) : date.toISOString().slice(0, 10);
}

const average = (values: (number | null)[]) => {
  const known = values.filter((v): v is number => v !== null);
  return known.length ? Math.round((known.reduce((a, b) => a + b, 0) / known.length) * 10) / 10 : null;
};

/** Orders names like the report's terms (case-insensitive), unknown ones last. */
function byTerms(terms: string[]) {
  const index = (k: string | null) => {
    const i = k === null ? -1 : terms.findIndex((t) => t.toLowerCase() === k.toLowerCase());
    return i === -1 ? terms.length : i;
  };
  return (a: string | null, b: string | null) => index(a) - index(b);
}

/** The report's data from the normalized tables, or from the legacy JSON column of older reports. */
export async function loadTrendData(
  db: Db,
  report: { id: string; keywords: unknown; data: unknown },
): Promise<TrendData | null> {
  const terms = Array.isArray(report.keywords) ? (report.keywords as string[]) : [];
  const [observations, regional, related] = await Promise.all([
    db.trendObservation.findMany({ where: { reportId: report.id }, orderBy: [{ periodStart: 'asc' }] }),
    db.trendRegionalInterest.findMany({ where: { reportId: report.id } }),
    db.trendRelatedItem.findMany({ where: { reportId: report.id }, orderBy: [{ rank: 'asc' }] }),
  ]);
  if (!observations.length && !regional.length && !related.length)
    return (report.data as TrendData | null) ?? null;

  let interest: TrendInterest | null = null;
  if (observations.length) {
    const hourly = observations.some((o) => o.periodStart.getUTCHours() || o.periodStart.getUTCMinutes());
    const times = [...new Set(observations.map((o) => o.periodStart.getTime()))].sort((a, b) => a - b);
    const keywords = [...new Set(observations.map((o) => o.keyword))].sort(byTerms(terms));
    const at = new Map(times.map((t, i) => [t, i]));
    const values = new Map(keywords.map((k) => [k, times.map(() => null as number | null)]));
    const partial = times.map(() => false);
    for (const o of observations) {
      const i = at.get(o.periodStart.getTime())!;
      values.get(o.keyword)![i] = o.value;
      if (o.isPartial) partial[i] = true;
    }
    interest = {
      dates: times.map((t) => formatPeriod(new Date(t), hourly)),
      series: keywords.map((keyword) => ({ keyword, values: values.get(keyword)!, average: average(values.get(keyword)!) })), // prettier-ignore
      partial,
    };
  }

  let regions: TrendRegionalInterest | null = null;
  if (regional.length) {
    const keywords = [...new Set(regional.map((r) => r.keyword))].sort(byTerms(terms));
    const places = new Map<string, { geoCode: string | null; name: string; values: (number | null)[] }>();
    for (const r of regional) {
      const key = r.geoCode ?? r.regionName;
      if (!places.has(key)) places.set(key, { geoCode: r.geoCode, name: r.regionName, values: keywords.map(() => null) }); // prettier-ignore
      places.get(key)!.values[keywords.indexOf(r.keyword)] = r.value;
    }
    regions = {
      resolution: regional[0]!.resolution as TrendRegionResolution,
      keywords,
      regions: [...places.values()].sort((a, b) => (b.values[0] ?? -1) - (a.values[0] ?? -1) || a.name.localeCompare(b.name)), // prettier-ignore
      comparison: regional[0]!.comparison === 'share' ? 'share' : 'single',
    };
  }

  const groupKeys = (kind: string) =>
    [...new Set(related.filter((r) => r.kind === kind).map((r) => r.keyword))].sort(byTerms(terms));
  const queries: TrendRelatedQueries[] = groupKeys('QUERY').map((keyword) => {
    const rows = related.filter((r) => r.kind === 'QUERY' && r.keyword === keyword);
    return {
      keyword,
      top: rows.filter((r) => r.list === 'TOP').map((r) => ({ query: r.label, value: r.value ?? 0 })),
      rising: rows
        .filter((r) => r.list === 'RISING')
        .map((r) => ({ query: r.label, value: r.growth ?? '—' })),
    };
  });
  const topics: TrendRelatedTopics[] = groupKeys('TOPIC').map((keyword) => {
    const rows = related.filter((r) => r.kind === 'TOPIC' && r.keyword === keyword);
    return {
      keyword,
      top: rows.filter((r) => r.list === 'TOP').map((r) => ({ topic: r.label, type: r.topicType, value: r.value ?? 0 })), // prettier-ignore
      rising: rows.filter((r) => r.list === 'RISING').map((r) => ({ topic: r.label, type: r.topicType, value: r.growth ?? '—' })), // prettier-ignore
    };
  });
  return { interest, related: queries, regions, topics };
}

export async function hasTrendData(db: Db, reportId: string): Promise<boolean> {
  const [o, r, q] = await Promise.all([
    db.trendObservation.count({ where: { reportId } }),
    db.trendRegionalInterest.count({ where: { reportId } }),
    db.trendRelatedItem.count({ where: { reportId } }),
  ]);
  return o + r + q > 0;
}

// ---------------- Provider events ----------------

/** Records provider request outcomes; best effort, never fails the caller. Messages never contain secrets. */
export async function recordTrendProviderEvents(
  db: Db,
  provider: TrendSource,
  operations: TrendOperation[],
  context: { workspaceId?: string | null; projectId?: string | null; reportId?: string | null },
): Promise<void> {
  if (!operations.length) return;
  await db.trendProviderEvent
    .createMany({
      data: operations.map((op) => ({
        provider,
        operation: clip(op.operation, 40),
        outcome: op.outcome,
        message: op.message ? clip(op.message, 500) : null,
        durationMs: Math.round(op.durationMs),
        workspaceId: context.workspaceId ?? null,
        projectId: context.projectId ?? null,
        reportId: context.reportId ?? null,
      })),
    })
    .catch(() => undefined);
}
