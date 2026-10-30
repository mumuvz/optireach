// Google Search Console figures for given queries: the project's own measured clicks and impressions. They are kept
// apart from Google Trends interest (a relative index) and never combined into one number with it.
import type { SearchConsoleQueryMetrics } from '@surfaced/shared';
import type { Prisma, PrismaClient } from '../db';

type Db = PrismaClient | Prisma.TransactionClient;

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

export async function searchConsoleStatus(db: Db, projectId: string) {
  const integration = await db.integration.findFirst({
    where: { projectId, provider: 'GOOGLE_SEARCH_CONSOLE' },
    orderBy: { updatedAt: 'desc' },
    select: { status: true, lastSyncAt: true },
  });
  return {
    connected: integration?.status === 'CONNECTED',
    lastSyncedAt: integration?.lastSyncAt?.toISOString() ?? null,
  };
}

/** Totals per query (lower-cased) over the latest synced query range. */
export async function searchConsoleQueryMetrics(
  db: Db,
  projectId: string,
  queries: string[],
): Promise<{
  range: { start: string; end: string } | null;
  byQuery: Map<string, SearchConsoleQueryMetrics>;
}> {
  const byQuery = new Map<string, SearchConsoleQueryMetrics>();
  const latest = await db.searchConsoleMetric.findFirst({
    where: { projectId, dimension: 'QUERY' },
    orderBy: { rangeEnd: 'desc' },
    select: { rangeStart: true, rangeEnd: true },
  });
  if (!latest) return { range: null, byQuery };
  const range = { start: isoDay(latest.rangeStart), end: isoDay(latest.rangeEnd) };
  const wanted = [...new Set(queries.map((q) => q.trim().toLowerCase()).filter(Boolean))].slice(0, 1000);
  if (!wanted.length) return { range, byQuery };
  const rows = await db.searchConsoleMetric.findMany({
    where: { projectId, dimension: 'QUERY', rangeStart: latest.rangeStart, rangeEnd: latest.rangeEnd, key: { in: wanted } }, // prettier-ignore
    select: { key: true, clicks: true, impressions: true, position: true },
  });
  const sums = new Map<string, { clicks: number; impressions: number; positionWeight: number }>();
  for (const row of rows) {
    const key = row.key.trim().toLowerCase();
    const sum = sums.get(key) ?? { clicks: 0, impressions: 0, positionWeight: 0 };
    sum.clicks += row.clicks;
    sum.impressions += row.impressions;
    sum.positionWeight += row.position * Math.max(1, row.impressions);
    sums.set(key, sum);
  }
  for (const [key, sum] of sums)
    byQuery.set(key, {
      clicks: sum.clicks,
      impressions: sum.impressions,
      ctr: sum.impressions ? sum.clicks / sum.impressions : 0,
      position: Math.round((sum.positionWeight / Math.max(1, sum.impressions)) * 10) / 10,
      rangeStart: range.start,
      rangeEnd: range.end,
    });
  return { range, byQuery };
}
