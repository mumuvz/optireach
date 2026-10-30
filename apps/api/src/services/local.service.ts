import type { BusinessLocation, LocalRankScan, PrismaClient } from '@surfaced/core/db';
import { getEnv } from '@surfaced/core/env';
import { Errors } from '@surfaced/core/errors';
import {
  CustomHttpLocalRankProvider,
  buildLocalOverview,
  competitorShowings,
  createLocalRankScan,
  deleteProfileData,
  finishScan,
  GoogleCustomSearchLocalRankProvider,
  appendGoogleCapturePages,
  controlLocalCollection,
  getLocalRankProvider,
  startLocalCollection,
  captureBatchesDto,
  finishGoogleCapture,
  googleCaptureProgress,
  importLocalObservations,
  startGoogleCapture,
  liveLocalRankSources,
  locationWriteData,
  OsmLocalRankProvider,
  nextLocalRankRun,
  parseLocalObservationsCsv,
  recordManualPoint,
  toLocationDto,
} from '@surfaced/core/local';
import { csvCell } from '@surfaced/core/keywords';
import { assertCountLimit, countLocationsForLimit, getUsageSummary } from '@surfaced/core/usage';
import {
  LOCAL_RANK_SOURCES,
  LOCAL_RANK_SOURCE_LABELS,
  LOCAL_OBSERVATION_TYPES,
  observationTypeForSource,
  type localRankQueryInputSchema,
  locationInputSchema,
  summarizeGrid,
  googleCaptureAppendSchema,
  localCollectionStartSchema,
  type CollectionAction,
  type LocalBatchSourceDto,
  type LocalCollectionStartInput,
  googleCaptureSchema,
  type CollectionStatus,
  type GoogleCaptureAppendInput,
  type GoogleCaptureInput,
  type GoogleCaptureProgressDto,
  type GoogleCaptureResultDto,
  type GridPointDto,
  type GridPointStatus,
  type LocalCompetitorShowing,
  type LocalObservationType,
  type LocalRankQueryDto,
  type LocalRankScanDto,
  type LocalRankScanSummaryDto,
  type LocalImportInput,
  type LocalImportResultDto,
  type LocalRankSource,
  type LocalResult,
  type LocalSurface,
  type LocationDto,
  type LocationInput,
  localImportSchema,
  type ManualPointInput,
  type RankFrequency,
} from '@surfaced/shared';
import { z } from 'zod';
import { stringArray } from '../lib/http';
import type { AppDeps, AuthUser } from '../types';
import { toCompetitorDto } from './project.service';
import { requireProjectAccess } from './access';

const QUERIES_PER_LOCATION = 50;

/**
 * Sources that can collect automatically in batches, with what their order means. A custom service on this computer
 * is flagged: the bundled demo service there returns sample businesses, not real data.
 */
function batchSources(): LocalBatchSourceDto[] {
  return LOCAL_RANK_SOURCES.flatMap((key): LocalBatchSourceDto[] => {
    const provider = getLocalRankProvider(key);
    if (!provider.batching || !provider.fetchBatch) return [];
    const config = provider.configured();
    let detail = config.detail;
    if (key === 'CUSTOM' && config.configured) {
      const host = (() => {
        try {
          return new URL(getEnv().CUSTOM_SERP_URL ?? '').hostname;
        } catch {
          return '';
        }
      })();
      if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]')
        detail = `${detail} Warning: this address is on this computer — the bundled demo service (scripts/mock-local-scraper.mjs) returns sample businesses, not real data.`; // prettier-ignore
    }
    return [
      {
        key,
        label: provider.label,
        configured: config.configured,
        detail,
        observationType: provider.batching.observationType,
        googleRanking: provider.batching.googleRanking,
        maxBatchSize: provider.batching.maxBatchSize,
        minDelayMs: provider.batching.minDelayMs,
        pagination: provider.batching.pagination,
      },
    ];
  });
}

function sourceOf(value: string): LocalRankSource {
  return (LOCAL_RANK_SOURCES as readonly string[]).includes(value) ? (value as LocalRankSource) : 'MANUAL';
}

/** Successful: every point measured and nothing stopped early. Partial: some points failed or collection stopped
 * early (or, for page captures, a page could not be read). Failed: nothing could be measured. */
function collectionStatusOf(scan: {
  status: string;
  pointsFailed: number;
  errorMessage: string | null;
}): CollectionStatus {
  if (scan.status === 'QUEUED' || scan.status === 'RUNNING') return 'in_progress';
  if (scan.status !== 'SUCCEEDED') return 'failed';
  return scan.pointsFailed > 0 || scan.errorMessage ? 'partial' : 'successful';
}

/** The stored observation type when known and valid, else the per-source default (older scans stored none). */
function observationTypeOf(value: string | null, source: LocalRankSource): LocalObservationType {
  return value && (LOCAL_OBSERVATION_TYPES as readonly string[]).includes(value)
    ? (value as LocalObservationType)
    : observationTypeForSource(source);
}

function scanSummary(s: LocalRankScan): LocalRankScanSummaryDto {
  const measured = s.pointsMeasured;
  return {
    id: s.id,
    queryId: s.queryId,
    source: sourceOf(s.source),
    status: s.status,
    trigger: s.trigger === 'SCHEDULED' ? 'SCHEDULED' : 'MANUAL',
    summary: {
      pointsPlanned: s.pointsPlanned,
      pointsMeasured: measured,
      pointsFailed: s.pointsFailed,
      coverage: s.pointsPlanned ? Math.round((measured / s.pointsPlanned) * 1000) / 10 : 0,
      top3: s.top3,
      top10: s.top10,
      notFound: s.notFound,
      top3Share: s.top3Share,
      top10Share: measured ? Math.round((s.top10 / measured) * 1000) / 10 : null,
      averageRankFound: s.averageRankFound,
    },
    costUsd: s.costUsd,
    createdAt: s.createdAt.toISOString(),
    finishedAt: s.finishedAt?.toISOString() ?? null,
  };
}

export const localRankQueryUpdateSchema = z.object({
  frequency: z.enum(['MANUAL', 'WEEKLY', 'MONTHLY']).optional(),
  status: z.enum(['ACTIVE', 'PAUSED']).optional(),
});

export class LocalService {
  constructor(private readonly deps: AppDeps) {}

  private get prisma(): PrismaClient {
    return this.deps.prisma;
  }

  // ---------------- Status ----------------

  async status(user: AuthUser, projectId: string) {
    const { project } = await requireProjectAccess(this.prisma, user, projectId, 'project.read');
    const usage = await getUsageSummary(this.prisma, project.workspaceId);
    const points = usage.metrics.find((m) => m.metric === 'LOCAL_RANK_POINT');
    const osm = new OsmLocalRankProvider().configured();
    const custom = new CustomHttpLocalRankProvider().configured();
    const googleCse = new GoogleCustomSearchLocalRankProvider().configured();
    const live = liveLocalRankSources();
    return {
      sources: [
        { key: 'OSM' as const, label: LOCAL_RANK_SOURCE_LABELS.OSM, live: true, surfaces: ['MAPS'] as LocalSurface[], ...osm, available: osm.configured }, // prettier-ignore
        { key: 'CUSTOM' as const, label: LOCAL_RANK_SOURCE_LABELS.CUSTOM, live: true, surfaces: ['MAPS', 'LOCAL_PACK', 'ORGANIC'] as LocalSurface[], ...custom, available: custom.configured }, // prettier-ignore
        { key: 'GOOGLE_CSE' as const, label: LOCAL_RANK_SOURCE_LABELS.GOOGLE_CSE, live: true, surfaces: ['ORGANIC'] as LocalSurface[], ...googleCse, available: googleCse.configured }, // prettier-ignore
        { key: 'MANUAL' as const, label: LOCAL_RANK_SOURCE_LABELS.MANUAL, live: false, surfaces: ['MAPS', 'LOCAL_PACK', 'ORGANIC'] as LocalSurface[], configured: true, available: true, detail: 'Enter what you see on Google at a grid point. Labeled as a manual observation everywhere.' }, // prettier-ignore
        ...(live.includes('FIXTURE') ? [{ key: 'FIXTURE' as const, label: LOCAL_RANK_SOURCE_LABELS.FIXTURE, live: true, surfaces: ['MAPS', 'LOCAL_PACK', 'ORGANIC'] as LocalSurface[], configured: true, available: true, detail: 'Generated sample results for development. Not real Google data.' }] : []), // prettier-ignore
      ],
      defaultLiveSource: live[0] ?? null,
      batchSources: batchSources(),
      usage: {
        localRankPoints: {
          used: points?.used ?? 0,
          limit: points?.limit ?? null,
          periodKey: usage.periodKey,
        },
      },
      locations: { used: await countLocationsForLimit(this.prisma, project.workspaceId), limit: (await this.limits(project.workspaceId)).businessLocations }, // prettier-ignore
      hasWebsite: Boolean(project.websiteUrl),
      compliance:
        'Google offers no API for Maps or local-pack rankings. Live grid points come only from a licensed provider the operator enables; manual observations are labeled as such and are never shown as automatic measurements.',
    };
  }

  private async limits(workspaceId: string) {
    const { getWorkspacePlan } = await import('@surfaced/core/billing');
    return (await getWorkspacePlan(this.prisma, workspaceId)).limits;
  }

  async overview(user: AuthUser, projectId: string, locationId?: string, days = 28) {
    await requireProjectAccess(this.prisma, user, projectId, 'project.read');
    return buildLocalOverview(this.prisma, projectId, { locationId, days });
  }

  // ---------------- Locations ----------------

  async listLocations(user: AuthUser, projectId: string): Promise<LocationDto[]> {
    await requireProjectAccess(this.prisma, user, projectId, 'project.read');
    const rows = await this.prisma.businessLocation.findMany({
      where: { projectId, archivedAt: null },
      orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
    });
    return rows.map(toLocationDto);
  }

  async createLocation(user: AuthUser, projectId: string, input: LocationInput): Promise<LocationDto> {
    const { project } = await requireProjectAccess(this.prisma, user, projectId, 'local.manage');
    const data = locationInputSchema.parse(input);
    const used = await countLocationsForLimit(this.prisma, project.workspaceId);
    await assertCountLimit(this.prisma, project.workspaceId, 'businessLocations', used);
    const first =
      (await this.prisma.businessLocation.count({ where: { projectId, archivedAt: null } })) === 0;
    const row = await this.prisma.$transaction(async (tx) => {
      if (data.isPrimary)
        await tx.businessLocation.updateMany({ where: { projectId }, data: { isPrimary: false } });
      return tx.businessLocation.create({
        data: { projectId, ...locationWriteData({ ...data, isPrimary: data.isPrimary || first }) },
      });
    });
    return toLocationDto(row);
  }

  private async loadLocation(projectId: string, locationId: string): Promise<BusinessLocation> {
    const row = await this.prisma.businessLocation.findFirst({
      where: { id: locationId, projectId, archivedAt: null },
    });
    if (!row) throw Errors.notFound('Location');
    return row;
  }

  async updateLocation(
    user: AuthUser,
    projectId: string,
    locationId: string,
    input: LocationInput,
  ): Promise<LocationDto> {
    // prettier-ignore
    await requireProjectAccess(this.prisma, user, projectId, 'local.manage');
    await this.loadLocation(projectId, locationId);
    const data = locationInputSchema.parse(input);
    const row = await this.prisma.$transaction(async (tx) => {
      if (data.isPrimary)
        await tx.businessLocation.updateMany({ where: { projectId, id: { not: locationId } }, data: { isPrimary: false } }); // prettier-ignore
      return tx.businessLocation.update({ where: { id: locationId }, data: locationWriteData(data) });
    });
    return toLocationDto(row);
  }

  /**
   * Archives a location (its scans and history are kept; tracked queries stop). A Business Profile link is removed
   * and the Business Profile data stored for it is deleted.
   */
  async archiveLocation(user: AuthUser, projectId: string, locationId: string): Promise<void> {
    await requireProjectAccess(this.prisma, user, projectId, 'local.manage');
    await this.loadLocation(projectId, locationId);
    await this.prisma.$transaction(async (tx) => {
      await tx.businessLocation.update({
        where: { id: locationId },
        data: { archivedAt: new Date(), isPrimary: false, profileLocationName: null, profileAccountName: null, profileLinkedAt: null }, // prettier-ignore
      });
      await tx.localRankQuery.updateMany({
        where: { locationId },
        data: { status: 'PAUSED', nextRunAt: null },
      });
      await deleteProfileData(tx, { projectId, locationId });
    });
  }

  // ---------------- Tracked queries ----------------

  async listQueries(user: AuthUser, projectId: string, locationId?: string): Promise<LocalRankQueryDto[]> {
    await requireProjectAccess(this.prisma, user, projectId, 'project.read');
    const rows = await this.prisma.localRankQuery.findMany({
      where: { projectId, ...(locationId ? { locationId } : {}) },
      orderBy: { createdAt: 'asc' },
      include: { scans: { orderBy: { createdAt: 'desc' }, take: 1 } },
    });
    return rows.map((q) => ({
      id: q.id,
      locationId: q.locationId,
      query: q.query,
      surface: q.surface as LocalSurface,
      language: q.language,
      device: q.device === 'desktop' ? 'desktop' : 'mobile',
      gridSize: q.gridSize,
      spacingKm: q.spacingKm,
      depth: q.depth,
      centerLatitude: Number(q.centerLatitude),
      centerLongitude: Number(q.centerLongitude),
      frequency: q.frequency as RankFrequency,
      nextRunAt: q.nextRunAt?.toISOString() ?? null,
      status: q.status === 'PAUSED' ? 'PAUSED' : 'ACTIVE',
      latestScan: q.scans[0] ? scanSummary(q.scans[0]) : null,
      createdAt: q.createdAt.toISOString(),
    }));
  }

  async createQuery(user: AuthUser, projectId: string, input: z.output<typeof localRankQueryInputSchema>) {
    await requireProjectAccess(this.prisma, user, projectId, 'local.manage');
    const location = await this.loadLocation(projectId, input.locationId);
    const lat = input.centerLatitude ?? (location.latitude === null ? null : Number(location.latitude));
    const lng = input.centerLongitude ?? (location.longitude === null ? null : Number(location.longitude));
    if (lat === null || lng === null)
      throw Errors.badRequest('Add the location’s latitude and longitude (or a grid centre) before tracking a query on a grid.'); // prettier-ignore
    if (
      (await this.prisma.localRankQuery.count({ where: { locationId: location.id } })) >= QUERIES_PER_LOCATION
    )
      throw Errors.badRequest(`A location can track ${QUERIES_PER_LOCATION} queries.`);
    try {
      const row = await this.prisma.localRankQuery.create({
        data: {
          projectId,
          locationId: location.id,
          query: input.query,
          surface: input.surface,
          language: input.language,
          device: input.device,
          gridSize: input.gridSize,
          spacingKm: input.spacingKm,
          depth: input.depth,
          centerLatitude: lat,
          centerLongitude: lng,
          frequency: input.frequency,
          nextRunAt: nextLocalRankRun(input.frequency, new Date()),
          createdById: user.id,
        },
      });
      return (await this.listQueries(user, projectId)).find((q) => q.id === row.id)!;
    } catch (error) {
      if ((error as { code?: string }).code === 'P2002')
        throw Errors.conflict('This query is already tracked for this location, surface and device.');
      throw error;
    }
  }

  async updateQuery(
    user: AuthUser,
    projectId: string,
    queryId: string,
    input: z.output<typeof localRankQueryUpdateSchema>,
  ) {
    // prettier-ignore
    await requireProjectAccess(this.prisma, user, projectId, 'local.manage');
    const query = await this.prisma.localRankQuery.findFirst({ where: { id: queryId, projectId } });
    if (!query) throw Errors.notFound('Tracked query');
    const frequency = (input.frequency ?? query.frequency) as RankFrequency;
    const status = input.status ?? query.status;
    await this.prisma.localRankQuery.update({
      where: { id: queryId },
      data: {
        frequency,
        status,
        nextRunAt: status === 'ACTIVE' ? (input.frequency && input.frequency !== query.frequency ? nextLocalRankRun(frequency, new Date()) : query.nextRunAt ?? nextLocalRankRun(frequency, new Date())) : null, // prettier-ignore
      },
    });
    return (await this.listQueries(user, projectId)).find((q) => q.id === queryId)!;
  }

  async deleteQuery(user: AuthUser, projectId: string, queryId: string): Promise<void> {
    await requireProjectAccess(this.prisma, user, projectId, 'local.manage');
    const result = await this.prisma.localRankQuery.deleteMany({ where: { id: queryId, projectId } });
    if (!result.count) throw Errors.notFound('Tracked query');
  }

  // ---------------- Scans ----------------

  async startScan(user: AuthUser, projectId: string, queryId: string, source: LocalRankSource) {
    await requireProjectAccess(this.prisma, user, projectId, 'local.manage');
    if (source === 'IMPORT') throw Errors.badRequest('Use the import endpoint for CSV observations.');
    if (source === 'GOOGLE_CAPTURE')
      throw Errors.badRequest('Use “Capture from Google page” to add a results page you saved.');
    return createLocalRankScan(this.prisma, this.deps.queues, { projectId, queryId, source, userId: user.id, trigger: 'MANUAL' }); // prettier-ignore
  }

  async listScans(user: AuthUser, projectId: string, queryId: string): Promise<LocalRankScanSummaryDto[]> {
    await requireProjectAccess(this.prisma, user, projectId, 'project.read');
    const rows = await this.prisma.localRankScan.findMany({
      where: { projectId, queryId },
      orderBy: { createdAt: 'desc' },
      take: 60,
    });
    return rows.map(scanSummary);
  }

  private async loadScan(projectId: string, scanId: string) {
    const scan = await this.prisma.localRankScan.findFirst({
      where: { id: scanId, projectId },
      include: { points: { orderBy: [{ row: 'asc' }, { col: 'asc' }] } },
    });
    if (!scan) throw Errors.notFound('Scan');
    return scan;
  }

  async getScan(user: AuthUser, projectId: string, scanId: string): Promise<LocalRankScanDto> {
    await requireProjectAccess(this.prisma, user, projectId, 'project.read');
    const scan = await this.loadScan(projectId, scanId);
    const job = await this.prisma.backgroundJob.findFirst({
      where: { entityType: 'LocalRankScan', entityId: scan.id },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    const points: GridPointDto[] = scan.points.map((p) => ({
      row: p.row,
      col: p.col,
      latitude: Number(p.latitude),
      longitude: Number(p.longitude),
      status: p.status as GridPointStatus,
      rank: p.rank,
      error: p.error,
      results: (Array.isArray(p.results) ? p.results : []) as unknown as LocalResult[],
    }));
    const base = scanSummary(scan);
    // A running manual scan is summarized live from the points entered so far.
    const summary = scan.status === 'RUNNING' ? summarizeGrid(points) : base.summary;
    return {
      ...base,
      summary,
      query: scan.query,
      surface: scan.surface as LocalSurface,
      language: scan.language,
      device: scan.device === 'desktop' ? 'desktop' : 'mobile',
      gridSize: scan.gridSize,
      spacingKm: scan.spacingKm,
      depth: scan.depth,
      centerLatitude: Number(scan.centerLatitude),
      centerLongitude: Number(scan.centerLongitude),
      points,
      observationType: observationTypeOf(scan.observationType, sourceOf(scan.source)),
      collectionStatus: collectionStatusOf(scan),
      captureBatches: Array.isArray(scan.captureBatches) ? captureBatchesDto(scan.captureBatches) : null,
      captureProgress: scan.captureState ? googleCaptureProgress(scan, points[0]?.results ?? []) : null,
      limitations: stringArray(scan.limitations),
      errorMessage: scan.errorMessage,
      jobId: job?.id ?? null,
    };
  }

  async enterManualPoint(user: AuthUser, projectId: string, scanId: string, input: ManualPointInput) {
    await requireProjectAccess(this.prisma, user, projectId, 'local.manage');
    await this.loadScan(projectId, scanId);
    return recordManualPoint(this.prisma, scanId, input);
  }

  /** Closes a manual scan; points not entered stay unmeasured and are left out of every figure. */
  async finishManualScan(user: AuthUser, projectId: string, scanId: string) {
    await requireProjectAccess(this.prisma, user, projectId, 'local.manage');
    const scan = await this.loadScan(projectId, scanId);
    if (scan.source !== 'MANUAL') throw Errors.badRequest('Only manual scans are finished by hand.');
    if (scan.status !== 'RUNNING') throw Errors.conflict('This scan is already finished.');
    if (!scan.points.some((p) => p.status === 'FOUND' || p.status === 'NOT_FOUND'))
      throw Errors.badRequest('Enter at least one point before finishing the scan.');
    await finishScan(this.prisma, scanId);
    return this.getScan(user, projectId, scanId);
  }

  /**
   * Imports local observations from a CSV into a new IMPORT scan of the query. The file's order is preserved; rows
   * outside the grid or without a business name are skipped and reported. The grid geometry comes from the query.
   */
  async importObservations(
    user: AuthUser,
    projectId: string,
    queryId: string,
    input: LocalImportInput,
  ): Promise<LocalImportResultDto> {
    await requireProjectAccess(this.prisma, user, projectId, 'local.manage');
    const { csv } = localImportSchema.parse(input);
    const query = await this.prisma.localRankQuery.findFirst({ where: { id: queryId, projectId } });
    if (!query) throw Errors.notFound('Tracked query');
    const parsed = parseLocalObservationsCsv(csv, query.gridSize);
    if (!parsed.points.length)
      throw Errors.badRequest(
        parsed.errors[0] ??
          'No observations could be read from the file. Include row, col and business columns.',
        { errors: parsed.errors.slice(0, 20) },
      );
    const { scanId } = await createLocalRankScan(this.prisma, this.deps.queues, {
      projectId,
      queryId,
      source: 'IMPORT',
      userId: user.id,
      trigger: 'MANUAL',
    });
    await importLocalObservations(this.prisma, scanId, parsed.points);
    const pointsImported = parsed.points.length;
    return { scanId, pointsImported, rowsParsed: parsed.rowsParsed, errors: parsed.errors.slice(0, 20) };
  }

  /**
   * Starts a multi-page collection from Google results pages the user saved in their own browser. OptiReach reads
   * the saved files only; it never requests google.com itself. Later pages are added with appendGoogleCapture.
   */
  async captureGooglePage(
    user: AuthUser,
    projectId: string,
    queryId: string,
    input: GoogleCaptureInput,
  ): Promise<GoogleCaptureResultDto> {
    await requireProjectAccess(this.prisma, user, projectId, 'local.manage');
    const { pages, target } = googleCaptureSchema.parse(input);
    return startGoogleCapture(this.prisma, { projectId, queryId, userId: user.id, pages, target });
  }

  /** Adds the next saved page(s) to an unfinished collection; parsing, de-duplication and storage are automatic. */
  async appendGoogleCapture(
    user: AuthUser,
    projectId: string,
    scanId: string,
    input: GoogleCaptureAppendInput,
  ): Promise<GoogleCaptureResultDto> {
    await requireProjectAccess(this.prisma, user, projectId, 'local.manage');
    const { pages } = googleCaptureAppendSchema.parse(input);
    return appendGoogleCapturePages(this.prisma, { projectId, scanId, pages });
  }

  /** Stops a collection before its target (PARTIAL), keeping everything collected so far. */
  /** Starts an automatic collection of a tracked query from a configured, batch-capable source. */
  async startCollection(
    user: AuthUser,
    projectId: string,
    queryId: string,
    input: LocalCollectionStartInput,
  ) {
    await requireProjectAccess(this.prisma, user, projectId, 'local.manage');
    const settings = localCollectionStartSchema.parse(input);
    return startLocalCollection(this.prisma, this.deps.queues, { projectId, queryId, userId: user.id, ...settings }); // prettier-ignore
  }

  /** Pause, resume, retry or cancel an automatic collection. */
  async controlCollection(user: AuthUser, projectId: string, scanId: string, action: CollectionAction) {
    await requireProjectAccess(this.prisma, user, projectId, 'local.manage');
    await controlLocalCollection(this.prisma, this.deps.queues, {
      projectId,
      scanId,
      action,
      userId: user.id,
    });
    return this.getScan(user, projectId, scanId);
  }

  async finishGoogleCapture(
    user: AuthUser,
    projectId: string,
    scanId: string,
  ): Promise<GoogleCaptureProgressDto> {
    await requireProjectAccess(this.prisma, user, projectId, 'local.manage');
    return finishGoogleCapture(this.prisma, { projectId, scanId });
  }

  async exportScan(user: AuthUser, projectId: string, scanId: string) {
    const { project } = await requireProjectAccess(this.prisma, user, projectId, 'project.read');
    const scan = await this.getScan(user, projectId, scanId);
    const rows: unknown[][] = [['row', 'col', 'latitude', 'longitude', 'point_status', 'tracked_business_rank', 'result_rank', 'business', 'place_id', 'domain', 'category', 'rating', 'review_count', 'is_tracked_business', 'query', 'surface', 'source', 'checked_scan_at']]; // prettier-ignore
    for (const p of scan.points) {
      const base = [p.row, p.col, p.latitude, p.longitude, p.status, p.rank ?? ''];
      const meta = [
        scan.query,
        scan.surface,
        LOCAL_RANK_SOURCE_LABELS[scan.source],
        scan.finishedAt ?? scan.createdAt,
      ];
      if (!p.results.length) rows.push([...base, '', '', '', '', '', '', '', '', ...meta]);
      for (const r of p.results)
        rows.push([...base, r.rank, r.title, r.placeId ?? '', r.domain ?? '', r.category ?? '', r.rating ?? '', r.reviewCount ?? '', r.isTarget ? 'yes' : 'no', ...meta]); // prettier-ignore
    }
    const csv = `${rows.map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;
    const slug = scan.query
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .slice(0, 40);
    return { filename: `${project.domain ?? project.name.replace(/\s+/g, '-').toLowerCase()}-grid-${slug}-${scan.createdAt.slice(0, 10)}.csv`, csv }; // prettier-ignore
  }

  // ---------------- Competitors ----------------

  /** Businesses listed in the latest scan of a query, with appearances, top-3 counts and public ratings. */
  async comparison(
    user: AuthUser,
    projectId: string,
    queryId: string,
  ): Promise<{
    scanId: string | null;
    measured: number;
    showings: LocalCompetitorShowing[];
    reviewGrowth: Record<string, number | null>;
  }> {
    // prettier-ignore
    await requireProjectAccess(this.prisma, user, projectId, 'project.read');
    const scans = await this.prisma.localRankScan.findMany({
      where: { projectId, queryId, status: 'SUCCEEDED' },
      orderBy: { createdAt: 'desc' },
      take: 2,
      include: { points: true },
    });
    const latest = scans[0];
    if (!latest) return { scanId: null, measured: 0, showings: [], reviewGrowth: {} };
    const competitors = await this.prisma.projectCompetitor.findMany({ where: { projectId } });
    const showings = competitorShowings(latest.points).map((s) => {
      const c = competitors.find(
        (x) => (s.placeId && x.placeId === s.placeId) || (s.domain && x.domain === s.domain),
      );
      return {
        ...s,
        competitorId: c?.id ?? null,
        status: (c?.status as LocalCompetitorShowing['status']) ?? null,
      };
    });
    // Review growth: change in the publicly displayed review count since the previous scan (when both exist).
    const previous = scans[1] ? competitorShowings(scans[1].points) : [];
    const reviewGrowth: Record<string, number | null> = {};
    for (const s of showings) {
      const before = previous.find((p) => (s.placeId && p.placeId === s.placeId) || p.name === s.name);
      reviewGrowth[s.placeId ?? s.name] = before?.reviewCount != null && s.reviewCount != null ? s.reviewCount - before.reviewCount : null; // prettier-ignore
    }
    return { scanId: latest.id, measured: latest.pointsMeasured, showings, reviewGrowth };
  }

  async listLocalCompetitors(user: AuthUser, projectId: string) {
    await requireProjectAccess(this.prisma, user, projectId, 'project.read');
    const rows = await this.prisma.projectCompetitor.findMany({
      where: { projectId, kind: 'LOCAL' },
      orderBy: [{ status: 'asc' }, { lastSeenAt: 'desc' }],
    });
    return rows.map(toCompetitorDto);
  }

  async setCompetitorStatus(
    user: AuthUser,
    projectId: string,
    competitorId: string,
    status: 'CONFIRMED' | 'DISMISSED',
  ) {
    // prettier-ignore
    const { project } = await requireProjectAccess(this.prisma, user, projectId, 'competitor.manage');
    const row = await this.prisma.projectCompetitor.findFirst({ where: { id: competitorId, projectId } });
    if (!row) throw Errors.notFound('Competitor');
    if (status === 'CONFIRMED' && row.status !== 'CONFIRMED') {
      const count = await this.prisma.projectCompetitor.count({ where: { projectId, status: 'CONFIRMED' } });
      await assertCountLimit(this.prisma, project.workspaceId, 'competitorsPerProject', count);
    }
    const updated = await this.prisma.projectCompetitor.update({
      where: { id: competitorId },
      data: { status },
    });
    return toCompetitorDto(updated);
  }
}
