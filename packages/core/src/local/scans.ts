// Local rank scans: one measurement of a tracked query over its geographic grid. Each grid point is fetched from the
// scan's source (a licensed provider, or entered by a person for manual scans), stored with the businesses listed,
// and matched to the tracked business. Points are unique per scan, so a retried job only redoes pending or failed
// points. Failed and unmeasured points are excluded from visibility metrics (coverage says how many were measured).
import {
  gridPoints,
  summarizeGrid,
  type GridPointStatus,
  type LocalCompetitorShowing,
  type LocalRankSource,
  type LocalObservationType,
  type LocalResult,
  type LocalSurface,
  type ManualPointInput,
  type RankFrequency,
  observationTypeForSource,
} from '@surfaced/shared';
import { parseDelimited } from '../commerce/feed';
import { recordProviderUsage } from '../costs';
import type { Prisma, PrismaClient } from '../db';
import { Errors, errorMessage } from '../errors';
import { createJobRecord, enqueueJobRecord } from '../jobs';
import type { QueueGateway } from '../queue';
import { assertMonthlyQuota, recordUsage, withWorkspaceLock } from '../usage';
import {
  LocalRankProviderError,
  getLocalRankProvider,
  type LocalRankFetch,
  type ProviderLocalResult,
} from './rank-providers';

type Db = PrismaClient | Prisma.TransactionClient;

const DAY_MS = 24 * 3600 * 1000;
/** Results stored per point (the depth decides how far the tracked business is looked for). */
const STORED_RESULTS = 20;
const MAX_POINT_ATTEMPTS = 2;
/** New competitor suggestions created from one scan at most. */
const MAX_SUGGESTIONS_PER_SCAN = 15;

export function nextLocalRankRun(frequency: RankFrequency, from: Date): Date | null {
  if (frequency === 'WEEKLY') return new Date(from.getTime() + 7 * DAY_MS);
  if (frequency === 'MONTHLY') return new Date(from.getTime() + 30 * DAY_MS);
  return null;
}

/** Map zoom for a grid: wider spacing needs a wider map view at each point. */
export function zoomForSpacing(spacingKm: number): number {
  if (spacingKm <= 0.5) return 16;
  if (spacingKm <= 1.5) return 15;
  if (spacingKm <= 3) return 14;
  return 13;
}

// ---------------- Matching ----------------

export function normalizeBusinessName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export interface MatchTarget {
  names: string[];
  placeId: string | null;
  domains: string[];
}

/** The tracked business: same place ID, same website domain, or exactly the same name (no fuzzy guessing). */
export function isTargetResult(
  result: Pick<ProviderLocalResult, 'title' | 'placeId' | 'domain'>,
  target: MatchTarget,
): boolean {
  // prettier-ignore
  if (target.placeId && result.placeId && result.placeId === target.placeId) return true;
  const domain = result.domain?.replace(/^www\./, '').toLowerCase();
  if (domain && target.domains.some((d) => domain === d || domain.endsWith(`.${d}`))) return true;
  const title = normalizeBusinessName(result.title);
  return Boolean(title) && target.names.some((n) => normalizeBusinessName(n) === title);
}

function domainOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}

// ---------------- Creating scans ----------------

export interface CreateScanInput {
  projectId: string;
  queryId: string;
  source: LocalRankSource;
  userId: string | null;
  trigger: 'MANUAL' | 'SCHEDULED';
}

/**
 * Creates a scan with one pending point per grid cell. Live sources queue a job and use one local grid point of the
 * monthly quota per point (the development fixture is free); manual scans wait for points to be entered.
 */
export async function createLocalRankScan(
  prisma: PrismaClient,
  queues: QueueGateway,
  input: CreateScanInput,
): Promise<{ scanId: string; jobId: string | null; status: 'QUEUED' }> {
  const query = await prisma.localRankQuery.findFirst({
    where: { id: input.queryId, projectId: input.projectId },
    include: { project: { select: { workspaceId: true } } },
  });
  if (!query) throw Errors.notFound('Tracked query');
  const provider = getLocalRankProvider(input.source);
  const config = provider.configured();
  if (!config.configured) throw Errors.providerNotConfigured(provider.label, { setup: config.detail });
  if (!(provider.surfaces as readonly string[]).includes(query.surface))
    throw Errors.badRequest(`${provider.label} cannot measure ${query.surface.toLowerCase().replace('_', ' ')} results.`); // prettier-ignore
  const active = await prisma.localRankScan.findFirst({
    // A Google page collection stays open while the user saves pages; it does not block other scans of the query.
    where: { queryId: query.id, status: { in: ['QUEUED', 'RUNNING'] }, source: { not: 'GOOGLE_CAPTURE' } },
    select: { id: true, source: true },
  });
  if (active && provider.live) throw Errors.conflict('A scan of this query is already running.');
  if (active && !provider.live && active.source === input.source)
    throw Errors.conflict('A manual scan of this query is still open: enter its points or finish it first.');

  const points = gridPoints(Number(query.centerLatitude), Number(query.centerLongitude), query.gridSize, query.spacingKm); // prettier-ignore
  const workspaceId = query.project.workspaceId;
  // No paid local-rank provider any more: OSM discovery and the operator's own custom service are the operator's
  // own collection, so grid points do not consume the licensed-point quota.
  const charged = false;
  const { scan, job } = await withWorkspaceLock(prisma, workspaceId, async (tx) => {
    if (charged) await assertMonthlyQuota(tx, workspaceId, 'LOCAL_RANK_POINT', points.length);
    const scan = await tx.localRankScan.create({
      data: {
        projectId: input.projectId,
        queryId: query.id,
        source: input.source,
        trigger: input.trigger,
        status: provider.live ? 'QUEUED' : 'RUNNING',
        // The kind of order this source yields (observed search position vs. discovery order, etc.). The custom
        // source may refine this per response when it collects, but never upgrade a discovery list into a ranking.
        observationType: observationTypeForSource(input.source),
        query: query.query,
        surface: query.surface,
        language: query.language,
        device: query.device,
        gridSize: query.gridSize,
        spacingKm: query.spacingKm,
        depth: query.depth,
        centerLatitude: query.centerLatitude,
        centerLongitude: query.centerLongitude,
        pointsPlanned: points.length,
        createdById: input.userId,
        startedAt: provider.live ? null : new Date(),
      },
    });
    await tx.localRankPoint.createMany({
      data: points.map((p) => ({ scanId: scan.id, row: p.row, col: p.col, latitude: p.latitude, longitude: p.longitude })), // prettier-ignore
    });
    if (charged)
      await recordUsage(tx, {
        workspaceId,
        projectId: input.projectId,
        metric: 'LOCAL_RANK_POINT',
        quantity: points.length,
        idempotencyKey: `local-scan:${scan.id}`,
      });
    const job = provider.live
      ? await createJobRecord(tx, {
          type: 'RANK_CHECK',
          queue: 'local',
          workspaceId,
          projectId: input.projectId,
          userId: input.userId,
          entityType: 'LocalRankScan',
          entityId: scan.id,
          payload: { scanId: scan.id },
          maxAttempts: 3,
        })
      : null;
    return { scan, job };
  });
  if (job) {
    try {
      await enqueueJobRecord(prisma, queues, job, 'local', { backgroundJobId: job.id, scanId: scan.id }, { backoffMs: 30_000 }); // prettier-ignore
    } catch (error) {
      await prisma.localRankScan.update({
        where: { id: scan.id },
        data: { status: 'FAILED', errorMessage: errorMessage(error).slice(0, 500), finishedAt: new Date() },
      });
      throw error;
    }
  }
  return { scanId: scan.id, jobId: job?.id ?? null, status: 'QUEUED' };
}

// ---------------- Running scans ----------------

export async function matchTargetFor(db: Db, queryId: string): Promise<MatchTarget & { country: string }> {
  const query = await db.localRankQuery.findUniqueOrThrow({
    where: { id: queryId },
    include: { location: true, project: { select: { name: true, domain: true, brandAliases: true } } },
  });
  const aliases = Array.isArray(query.project.brandAliases) ? (query.project.brandAliases as string[]) : [];
  return {
    names: [...new Set([query.location.name, query.project.name, ...aliases].filter(Boolean))],
    placeId: query.location.placeId,
    domains: [...new Set([domainOf(query.location.websiteUrl), query.project.domain].filter((d): d is string => Boolean(d)))], // prettier-ignore
    country: query.location.country,
  };
}

/** Maps provider results to stored results, matching the tracked business. `limit` caps how many are kept (the
 * tracked business's own entry is always kept). Page captures keep more, so later pages are not dropped. */
export function storeResults(
  results: ProviderLocalResult[],
  target: MatchTarget,
  limit = STORED_RESULTS,
): { stored: LocalResult[]; rank: number | null } {
  let rank: number | null = null;
  const stored = results.map((r) => {
    const isTarget = isTargetResult(r, target);
    if (isTarget && rank === null) rank = r.rank;
    return {
      rank: r.rank,
      title: r.title,
      placeId: r.placeId,
      cid: r.cid,
      domain: r.domain,
      category: r.category,
      rating: r.rating,
      reviewCount: r.reviewCount,
      address: r.address,
      latitude: r.latitude,
      longitude: r.longitude,
      isTarget,
      competitorId: null,
      // Carry the source-supplied collection metadata through to storage, when the source provided it.
      ...(typeof r.sponsored === 'boolean' ? { sponsored: r.sponsored } : {}),
      ...(typeof r.batch === 'number' ? { batch: r.batch } : {}),
      ...(typeof r.sourcePosition === 'number' ? { sourcePosition: r.sourcePosition } : {}),
      ...(r.cumulativePosition != null ? { cumulativePosition: r.cumulativePosition } : {}),
      ...(r.url ? { website: r.url } : {}),
      ...(r.mapsUrl ? { mapsUrl: r.mapsUrl } : {}),
      ...(r.entityId ? { entityId: r.entityId } : {}),
      ...(r.hours !== undefined ? { hours: r.hours } : {}),
      ...(r.serviceOptions ? { serviceOptions: r.serviceOptions } : {}),
      ...(typeof r.phoneShown === 'boolean' ? { phoneShown: r.phoneShown } : {}),
      ...(r.reviewSnippet !== undefined ? { reviewSnippet: r.reviewSnippet } : {}),
      ...(typeof r.websiteListed === 'boolean' ? { websiteListed: r.websiteListed } : {}),
    } satisfies LocalResult;
  });
  // Keep the first results and the tracked business's own entry, wherever it is.
  const kept = stored.filter((r, i) => i < limit || r.isTarget);
  return { stored: kept, rank };
}

/** Fetches every pending or failed point of a live scan, then summarizes it and updates local competitors. */
export async function executeLocalRankScan(
  prisma: PrismaClient,
  scanId: string,
  options: { fetchImpl?: LocalRankFetch; backgroundJobId?: string; onProgress?: (done: number, total: number) => Promise<void> } = {}, // prettier-ignore
): Promise<{ measured: number; failed: number }> {
  const scan = await prisma.localRankScan.findUniqueOrThrow({
    where: { id: scanId },
    include: { project: { select: { workspaceId: true } } },
  });
  await prisma.localRankScan.update({
    where: { id: scanId },
    data: { status: 'RUNNING', startedAt: scan.startedAt ?? new Date(), errorMessage: null },
  });
  const target = await matchTargetFor(prisma, scan.queryId);
  const provider = getLocalRankProvider(scan.source as LocalRankSource, target.names[0] ?? null);
  if (!provider.fetchPoint) throw new Error(`${provider.label} does not fetch results automatically.`);
  const todo = await prisma.localRankPoint.findMany({
    where: { scanId, status: { in: ['PENDING', 'FAILED'] }, attempts: { lt: MAX_POINT_ATTEMPTS } },
    orderBy: [{ row: 'asc' }, { col: 'asc' }],
  });
  let costUsd = scan.costUsd ?? 0;
  let requests = 0;
  let stop: LocalRankProviderError | null = null;
  let done = 0;
  // A source may declare how its order was obtained (e.g. the custom service collected a discovery list, not a
  // ranking). We honor the last one reported rather than assuming the per-source default.
  let observationType: LocalObservationType | null = null;
  for (const point of todo) {
    if (stop) break;
    try {
      const result = await provider.fetchPoint(
        {
          query: scan.query,
          latitude: Number(point.latitude),
          longitude: Number(point.longitude),
          surface: scan.surface as LocalSurface,
          language: scan.language,
          device: scan.device === 'desktop' ? 'desktop' : 'mobile',
          depth: scan.depth,
          zoom: zoomForSpacing(scan.spacingKm),
          country: target.country,
        },
        options.fetchImpl,
      );
      requests += 1;
      costUsd += result.costUsd;
      if (result.observationType) observationType = result.observationType;
      const { stored, rank } = storeResults(
        result.results.filter((r) => r.rank <= scan.depth),
        target,
      );
      await prisma.localRankPoint.update({
        where: { id: point.id },
        data: {
          status: rank === null ? 'NOT_FOUND' : 'FOUND',
          rank,
          results: stored as unknown as Prisma.InputJsonValue,
          error: null,
          attempts: { increment: 1 },
          checkedAt: result.checkedAt,
        },
      });
    } catch (error) {
      const message = errorMessage(error).slice(0, 500);
      await prisma.localRankPoint.update({
        where: { id: point.id },
        data: { status: 'FAILED', error: message, attempts: { increment: 1 }, checkedAt: new Date() },
      });
      // Missing setup or a rate limit fails the remaining points the same way; stop asking.
      if (error instanceof LocalRankProviderError && (error.permanent || error.code === 'RATE_LIMITED'))
        stop = error;
    }
    done += 1;
    await options.onProgress?.(done, todo.length);
  }
  if (requests)
    await recordProviderUsage(prisma, {
      workspaceId: scan.project.workspaceId,
      projectId: scan.projectId,
      provider: provider.key.toLowerCase(),
      operation: 'local_grid_point',
      requests,
      backgroundJobId: options.backgroundJobId,
      idempotencyKey: `local-scan:${scanId}:${scan.pointsMeasured}:${requests}`,
    });
  const summary = await finishScan(prisma, scanId, {
    costUsd,
    stopped: stop?.message ?? null,
    observationType,
  });
  return { measured: summary.pointsMeasured, failed: summary.pointsFailed };
}

/** Recomputes a scan's summary from its points, marks it finished and updates local competitors. */
export async function finishScan(
  prisma: PrismaClient,
  scanId: string,
  options: { costUsd?: number; stopped?: string | null; observationType?: LocalObservationType | null } = {},
) {
  const points = await prisma.localRankPoint.findMany({ where: { scanId } });
  const summary = summarizeGrid(points.map((p) => ({ status: p.status as GridPointStatus, rank: p.rank })));
  const scan = await prisma.localRankScan.findUniqueOrThrow({ where: { id: scanId } });
  const limitations = scanLimitations(scan.source as LocalRankSource, scan.depth, summary.coverage);
  const allFailed = summary.pointsMeasured === 0 && summary.pointsFailed > 0;
  await prisma.localRankScan.update({
    where: { id: scanId },
    data: {
      status: allFailed ? 'FAILED' : 'SUCCEEDED',
      ...(options.observationType ? { observationType: options.observationType } : {}),
      pointsMeasured: summary.pointsMeasured,
      pointsFailed: summary.pointsFailed,
      top3: summary.top3,
      top10: summary.top10,
      notFound: summary.notFound,
      top3Share: summary.top3Share,
      averageRankFound: summary.averageRankFound,
      costUsd: options.costUsd ?? scan.costUsd,
      limitations,
      errorMessage: allFailed ? (options.stopped ?? points.find((p) => p.error)?.error ?? 'No point could be measured.') : (options.stopped ?? null), // prettier-ignore
      finishedAt: new Date(),
    },
  });
  if (!allFailed) await updateLocalCompetitors(prisma, scanId);
  return summary;
}

export function scanLimitations(source: LocalRankSource, depth: number, coverage: number): string[] {
  const notes = [
    `Ranks are positions among the businesses listed at each point, checked to a depth of ${depth}. "Not found" means not in the first ${depth}, not absent from Google.`, // prettier-ignore
    'Results vary by device, account, time and exact location; a scan is one sample.',
  ];
  if (source === 'CUSTOM')
    notes.push(
      'Your own collection service: results are stored in the exact order it returned them, as observed positions — not reordered here. Their accuracy, ranking order and the compliance of the collection method are the operator’s responsibility.',
      'Sponsored listings are flagged separately from organic results wherever the source marks them. Continuation batches are kept in order; a combined position across batches is shown only when the source declares the batches continuous.',
    );
  if (source === 'GOOGLE_CSE')
    notes.push(
      'Google Programmable Search: real Google ORGANIC (web) results from Google’s official Custom Search API — this is an organic SERP position, NOT a Maps local-pack rank.',
      'Google’s free API localises by country only, not by coordinate, so every grid point shows the same national position (use a 1×1 grid). It returns the first 10 results, and is free up to 100 searches a day.',
    );
  if (source === 'OSM')
    notes.push(
      'OpenStreetMap discovery: real businesses mapped near each point, ordered by DISTANCE from the point — this is discovery, NOT a Google Maps ranking. A low "rank" means closer, not higher on Google.',
      'OpenStreetMap has no ratings or review counts, and coverage depends on what the community has mapped, so some businesses may be missing.',
    );
  if (source === 'MANUAL') notes.push('Manual observation: entered by a person from what they saw, not collected automatically.'); // prettier-ignore
  if (source === 'IMPORT') notes.push('Imported observations: shown as provided in the file.');
  if (source === 'GOOGLE_CAPTURE')
    notes.push(
      'Google results page you saved: listings are in exactly the order that page showed them, read from the saved file. OptiReach did not request the page from Google.',
      'Sponsored listings are flagged as shown on the page. Fields the page does not show (on Google’s Places list, usually the website and Maps link) are left empty, never filled in.',
    );
  if (source === 'FIXTURE')
    notes.push('Development fixture: generated sample results, not real Google data.');
  if (coverage < 100) notes.push(`Only ${coverage}% of the grid points were measured; the others are left out of every figure.`); // prettier-ignore
  return notes;
}

// ---------------- Manual observations ----------------

/** Stores what a person saw at one grid point of a manual scan (labeled as manual everywhere). */
export async function recordManualPoint(prisma: PrismaClient, scanId: string, input: ManualPointInput) {
  const scan = await prisma.localRankScan.findUniqueOrThrow({ where: { id: scanId } });
  if (scan.source !== 'MANUAL') throw Errors.badRequest('Points can be entered only in manual scans.');
  if (scan.status !== 'RUNNING') throw Errors.conflict('This manual scan is finished.');
  const point = await prisma.localRankPoint.findUnique({ where: { scanId_row_col: { scanId, row: input.row, col: input.col } } }); // prettier-ignore
  if (!point) throw Errors.notFound('Grid point');
  const target = await matchTargetFor(prisma, scan.queryId);
  const provided: ProviderLocalResult[] = input.results.map((r, i) => ({
    rank: i + 1,
    title: r.title,
    placeId: null,
    cid: null,
    domain: r.domain ?? null,
    url: null,
    category: null,
    rating: r.rating ?? null,
    reviewCount: r.reviewCount ?? null,
    address: null,
    phone: null,
    latitude: null,
    longitude: null,
    // A manual observation is one person reading one list top to bottom: a single, continuous batch.
    batch: 1,
    sourcePosition: i + 1,
    cumulativePosition: i + 1,
  }));
  const { stored, rank: matched } = storeResults(provided, target);
  // The person can mark which entry is their business when the name differs.
  const marked = input.results.findIndex((r) => r.isTarget);
  const rank = marked >= 0 ? marked + 1 : matched;
  const results = stored.map((r) => ({ ...r, isTarget: marked >= 0 ? r.rank === marked + 1 : r.isTarget }));
  await prisma.localRankPoint.update({
    where: { id: point.id },
    data: {
      status: rank === null ? 'NOT_FOUND' : 'FOUND',
      rank,
      results: results as unknown as Prisma.InputJsonValue,
      error: input.note ? `Note: ${input.note}`.slice(0, 500) : null,
      attempts: { increment: 1 },
      checkedAt: input.observedAt ? new Date(input.observedAt) : new Date(),
    },
  });
  return { rank };
}

// ---------------- CSV import ----------------

/** One grid point's observations parsed from a CSV, in the order they should be stored (top first). */
export interface ImportedPoint {
  row: number;
  col: number;
  results: {
    title: string;
    /** Position the file gave, or null to use the order within the point. */
    rank: number | null;
    isTarget: boolean;
    rating: number | null;
    reviewCount: number | null;
    domain: string | null;
  }[];
  observedAt: string | null;
}

export interface ParsedLocalImport {
  points: ImportedPoint[];
  /** Data rows that produced an observation (excludes skipped rows). */
  rowsParsed: number;
  errors: string[];
}

/** The CSV columns the import understands; `row`, `col` and `business` are required, the rest optional. */
export const LOCAL_IMPORT_COLUMNS = ['row', 'col', 'business', 'rank', 'is_tracked_business', 'rating', 'review_count', 'domain', 'observed_at'] as const; // prettier-ignore

const headerKey = (h: string) =>
  h
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
const truthy = (s: string) => ['yes', 'true', '1', 'y'].includes(s.toLowerCase());

/**
 * Parses a CSV of local observations into per-point lists, PRESERVING the order given (by `rank` when the file
 * supplies it, otherwise the order rows appear within each point). Values are read as given; nothing is inferred or
 * reordered by rating or distance. Rows outside the grid or without a business name are skipped and reported.
 */
export function parseLocalObservationsCsv(text: string, gridSize: number): ParsedLocalImport {
  const rows = parseDelimited(text, ',');
  if (rows.length < 2)
    return { points: [], rowsParsed: 0, errors: ['The file has a header but no data rows.'] };
  const header = rows[0]!.map(headerKey);
  const idx = (name: string) => header.indexOf(name);
  const missing = ['row', 'col', 'business'].filter((n) => idx(n) < 0);
  if (missing.length)
    return { points: [], rowsParsed: 0, errors: [`Missing required column(s): ${missing.join(', ')}. The header must include row, col and business.`] }; // prettier-ignore
  const col = {
    row: idx('row'), colNo: idx('col'), business: idx('business'), rank: idx('rank'),
    target: idx('is_tracked_business'), rating: idx('rating'), reviews: idx('review_count'),
    domain: idx('domain'), observed: idx('observed_at'),
  }; // prettier-ignore
  const errors: string[] = [];
  const byPoint = new Map<string, ImportedPoint>();
  let rowsParsed = 0;
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r]!;
    const at = (i: number) => (i >= 0 && i < cells.length ? cells[i]!.trim() : '');
    const line = r + 1;
    const business = at(col.business).slice(0, 255);
    if (!business) {
      errors.push(`Line ${line}: no business name.`);
      continue;
    }
    const rowNo = Number(at(col.row));
    const colNo = Number(at(col.colNo));
    if (
      !Number.isInteger(rowNo) ||
      !Number.isInteger(colNo) ||
      rowNo < 0 ||
      colNo < 0 ||
      rowNo >= gridSize ||
      colNo >= gridSize
    ) {
      // prettier-ignore
      errors.push(`Line ${line}: row/col is outside the ${gridSize}×${gridSize} grid.`);
      continue;
    }
    const intIn = (s: string, min: number, max: number) => {
      const n = Number(s);
      return s !== '' && Number.isInteger(n) && n >= min && n <= max ? n : null;
    };
    const rating = (() => {
      const n = Number(at(col.rating));
      return at(col.rating) !== '' && Number.isFinite(n) && n >= 0 && n <= 5 ? Math.round(n * 10) / 10 : null;
    })();
    const observedRaw = at(col.observed);
    const observedAt = observedRaw && !Number.isNaN(Date.parse(observedRaw)) ? new Date(observedRaw).toISOString() : null; // prettier-ignore
    const key = `${rowNo}:${colNo}`;
    const point = byPoint.get(key) ?? { row: rowNo, col: colNo, results: [], observedAt };
    point.results.push({
      title: business,
      rank: intIn(at(col.rank), 1, 1000),
      isTarget: truthy(at(col.target)),
      rating,
      reviewCount: intIn(at(col.reviews), 0, 10_000_000),
      domain: at(col.domain) ? at(col.domain).replace(/^www\./, '').toLowerCase().slice(0, 253) : null, // prettier-ignore
    });
    if (observedAt && !point.observedAt) point.observedAt = observedAt;
    byPoint.set(key, point);
    rowsParsed += 1;
  }
  // Within a point, keep the file's order unless it supplied ranks, in which case sort by the given rank (stable).
  const points = [...byPoint.values()].map((p) => ({
    ...p,
    results: p.results.some((x) => x.rank != null)
      ? [...p.results].sort(
          (a, b) => (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER),
        )
      : p.results,
  }));
  return { points, rowsParsed, errors };
}

/**
 * Stores parsed observations into an IMPORT scan's points (observed order preserved), then finishes the scan. The
 * scan must already exist with source IMPORT (created through createLocalRankScan). Points not in the file stay
 * unmeasured and are excluded from every figure, exactly like a partial manual scan.
 */
export async function importLocalObservations(
  prisma: PrismaClient,
  scanId: string,
  points: ImportedPoint[],
): Promise<void> {
  const scan = await prisma.localRankScan.findUniqueOrThrow({ where: { id: scanId } });
  if (scan.source !== 'IMPORT') throw Errors.badRequest('Points can be imported only into an import scan.');
  const target = await matchTargetFor(prisma, scan.queryId);
  for (const p of points) {
    const point = await prisma.localRankPoint.findUnique({
      where: { scanId_row_col: { scanId, row: p.row, col: p.col } },
    });
    if (!point) continue;
    const provided: ProviderLocalResult[] = p.results.map((r, i) => ({
      rank: r.rank ?? i + 1,
      title: r.title,
      placeId: null,
      cid: null,
      domain: r.domain,
      url: null,
      category: null,
      rating: r.rating,
      reviewCount: r.reviewCount,
      address: null,
      phone: null,
      latitude: null,
      longitude: null,
      // An imported observation is one list as it was seen: a single, continuous batch.
      batch: 1,
      sourcePosition: r.rank ?? i + 1,
      cumulativePosition: r.rank ?? i + 1,
    }));
    const { stored, rank: matched } = storeResults(provided, target);
    // The file can mark which entry is the tracked business when the name differs from the profile.
    const markedIdx = p.results.findIndex((r) => r.isTarget);
    const markedRank = markedIdx >= 0 ? provided[markedIdx]!.rank : null;
    const rank = markedRank ?? matched;
    const results = stored.map((r) => ({
      ...r,
      isTarget: markedRank !== null ? r.rank === markedRank : r.isTarget,
    }));
    await prisma.localRankPoint.update({
      where: { id: point.id },
      data: {
        status: rank === null ? 'NOT_FOUND' : 'FOUND',
        rank,
        results: results as unknown as Prisma.InputJsonValue,
        error: null,
        attempts: { increment: 1 },
        checkedAt: p.observedAt ? new Date(p.observedAt) : new Date(),
      },
    });
  }
  await finishScan(prisma, scanId);
}

// ---------------- Competitors ----------------

interface Showing extends LocalCompetitorShowing {
  ranks: number[];
  latitude: number | null;
  longitude: number | null;
  address: string | null;
  key: string;
}

function resultKey(r: Pick<LocalResult, 'placeId' | 'domain' | 'title' | 'entityId'>): string {
  if (r.placeId) return `p:${r.placeId}`;
  // Google's entity ID identifies the business exactly (page captures), so two branches with the same name differ.
  if (r.entityId) return `e:${r.entityId}`;
  return r.domain ? `d:${r.domain}` : `n:${normalizeBusinessName(r.title)}`;
}

/** Every business listed in a scan, with how often and how high it appeared (measured points only). */
export function competitorShowings(points: { status: string; results: unknown }[]): LocalCompetitorShowing[] {
  const map = new Map<string, Showing>();
  for (const point of points) {
    if (point.status !== 'FOUND' && point.status !== 'NOT_FOUND') continue;
    const results = (Array.isArray(point.results) ? point.results : []) as LocalResult[];
    const seen = new Set<string>();
    for (const r of results) {
      const key = resultKey(r);
      if (seen.has(key)) continue;
      seen.add(key);
      const s = map.get(key) ?? {
        key,
        competitorId: r.competitorId,
        name: r.title,
        placeId: r.placeId,
        domain: r.domain,
        category: r.category,
        appearances: 0,
        top3: 0,
        averageRank: null,
        bestRank: null,
        rating: r.rating,
        reviewCount: r.reviewCount,
        isTarget: r.isTarget,
        status: null,
        ranks: [],
        latitude: r.latitude,
        longitude: r.longitude,
        address: r.address,
      };
      s.appearances += 1;
      if (r.rank <= 3) s.top3 += 1;
      s.ranks.push(r.rank);
      s.isTarget ||= r.isTarget;
      if (r.rating !== null) s.rating = r.rating;
      if (r.reviewCount !== null) s.reviewCount = r.reviewCount;
      map.set(key, s);
    }
  }
  return [...map.values()]
    .map(({ ranks, key: _key, latitude: _lat, longitude: _lng, address: _address, ...s }) => ({
      ...s,
      averageRank: ranks.length
        ? Math.round((ranks.reduce((a, b) => a + b, 0) / ranks.length) * 10) / 10
        : null,
      bestRank: ranks.length ? Math.min(...ranks) : null,
    }))
    .sort(
      (a, b) =>
        b.top3 - a.top3 || b.appearances - a.appearances || (a.averageRank ?? 99) - (b.averageRank ?? 99),
    );
}

/**
 * Suggests businesses that keep appearing near the tracked business as local competitors, and refreshes the
 * publicly displayed rating and review count of known ones. Suggestions need confirmation before other features use
 * them; dismissed ones stay dismissed.
 */
export async function updateLocalCompetitors(prisma: PrismaClient, scanId: string): Promise<number> {
  const scan = await prisma.localRankScan.findUniqueOrThrow({
    where: { id: scanId },
    include: { rankQuery: { select: { locationId: true } }, points: true },
  });
  if (scan.source === 'FIXTURE' || scan.source === 'MANUAL' || scan.source === 'GOOGLE_CSE') {
    // Manual/generated observations, and organic web results (which are pages, not local businesses), do not create
    // local competitor records automatically.
    return 0;
  }
  const measured = scan.points.filter((p) => p.status === 'FOUND' || p.status === 'NOT_FOUND').length;
  const showings = competitorShowings(scan.points).filter((s) => !s.isTarget);
  const existing = await prisma.projectCompetitor.findMany({ where: { projectId: scan.projectId } });
  let created = 0;
  const now = new Date();
  for (const s of showings) {
    const match =
      (s.placeId && existing.find((c) => c.placeId === s.placeId)) ||
      (s.domain && existing.find((c) => c.domain === s.domain)) ||
      existing.find((c) => normalizeBusinessName(c.name) === normalizeBusinessName(s.name));
    if (match) {
      await prisma.projectCompetitor.update({
        where: { id: match.id },
        data: {
          placeId: match.placeId ?? s.placeId,
          category: match.category ?? s.category,
          rating: s.rating ?? match.rating,
          reviewCount: s.reviewCount ?? match.reviewCount,
          lastSeenAt: now,
          firstSeenAt: match.firstSeenAt ?? now,
        },
      });
      continue;
    }
    // Only businesses seen at several points, or in the top 3 somewhere, become suggestions.
    const strong = s.top3 > 0 || s.appearances >= Math.max(2, Math.ceil(measured / 4));
    if (!strong || created >= MAX_SUGGESTIONS_PER_SCAN) continue;
    try {
      await prisma.projectCompetitor.create({
        data: {
          projectId: scan.projectId,
          name: s.name.slice(0, 120),
          domain: s.domain,
          kind: 'LOCAL',
          status: 'SUGGESTED',
          source: 'DISCOVERED',
          locationId: scan.rankQuery.locationId,
          placeId: s.placeId,
          category: s.category,
          rating: s.rating,
          reviewCount: s.reviewCount,
          firstSeenAt: now,
          lastSeenAt: now,
          aliases: [],
        },
      });
      created += 1;
    } catch (error) {
      // Another scan created it at the same time (unique place or domain): keep the existing record.
      if ((error as { code?: string }).code !== 'P2002') throw error;
    }
  }
  return created;
}

// ---------------- Scheduled scans ----------------

/** Starts scans for tracked queries that are due (weekly or monthly), each claimed once per due time. */
export async function runScheduledLocalRankScans(deps: {
  prisma: PrismaClient;
  queues: QueueGateway;
  now?: () => Date;
}): Promise<{ started: number; skipped: { queryId: string; reason: string }[] }> {
  const { prisma, queues } = deps;
  const now = deps.now?.() ?? new Date();
  const { liveLocalRankSources } = await import('./rank-providers');
  const source = liveLocalRankSources()[0] ?? null;
  const due = await prisma.localRankQuery.findMany({
    where: { status: 'ACTIVE', frequency: { in: ['WEEKLY', 'MONTHLY'] }, nextRunAt: { lte: now } },
    orderBy: { nextRunAt: 'asc' },
    take: 100,
  });
  let started = 0;
  const skipped: { queryId: string; reason: string }[] = [];
  for (const query of due) {
    const claimed = await prisma.localRankQuery.updateMany({
      where: { id: query.id, nextRunAt: query.nextRunAt },
      data: { nextRunAt: nextLocalRankRun(query.frequency as RankFrequency, now) },
    });
    if (claimed.count === 0) continue;
    if (!source) {
      skipped.push({ queryId: query.id, reason: 'No live local rank provider is configured.' });
      continue;
    }
    try {
      await createLocalRankScan(prisma, queues, { projectId: query.projectId, queryId: query.id, source, userId: query.createdById, trigger: 'SCHEDULED' }); // prettier-ignore
      started++;
    } catch (error) {
      skipped.push({ queryId: query.id, reason: errorMessage(error) });
    }
  }
  return { started, skipped };
}
