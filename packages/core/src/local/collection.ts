// Automatic batch collection: a keyword and location collected from a configured source, batch after batch, until
// the unique-business target is reached or the source has nothing further. Each batch is committed before the next
// request; the source's own cursor is saved with it, so a collection can be paused, resumed, retried or cancelled
// without losing or repeating work. The pause between requests is a courtesy floor, never permission to ignore a
// source's restrictions: a source that refuses or rate-limits is backed off and, if it persists, the run stops.
//
// The source is whatever provider implements fetchBatch (rank-providers.ts) — replaceable without CRM changes. What
// its order means (a Google observation, or discovery order) is stored with the collection and shown everywhere.
import { randomUUID } from 'node:crypto';
import {
  COLLECTION_DEFAULT_DELAY_MS,
  COLLECTION_MAX_BATCH_SIZE,
  GOOGLE_CAPTURE_DEFAULT_TARGET,
  LOCAL_RANK_SOURCE_LABELS,
  type CollectionAction,
  type GoogleCaptureState,
  type LocalRankSource,
  type LocalSurface,
} from '@surfaced/shared';
import { recordProviderUsage } from '../costs';
import type { PrismaClient } from '../db';
import { Errors, errorMessage } from '../errors';
import { createJobRecord, enqueueJobRecord } from '../jobs';
import type { QueueGateway } from '../queue';
import { applyBatch, finalizeCapture, withScanLock, type CapturedListing } from './google-capture';
import {
  LocalRankProviderError,
  getLocalRankProvider,
  type LocalBatchResult,
  type LocalRankFetch,
} from './rank-providers';
import { matchTargetFor, zoomForSpacing } from './scans';

/** Attempts per batch for a transient problem (rate limit, timeout, error) before the run stops for a retry. */
export const COLLECTION_MAX_RETRIES = 3;
/** Safety limit on batches per run (a run past it stops; Retry continues from where it stopped). */
export const COLLECTION_MAX_BATCHES_PER_RUN = 500;

const newRunId = () => randomUUID().replace(/-/g, '');

export interface StartCollectionArgs {
  projectId: string;
  queryId: string;
  userId: string;
  source: LocalRankSource;
  target?: number;
  batchSize?: number;
  delayMs?: number;
}

/** Queues a run of the collection on the local queue. */
async function queueRun(
  prisma: PrismaClient,
  queues: QueueGateway,
  scan: { id: string; projectId: string; workspaceId: string },
  runId: string,
  userId: string,
) {
  const job = await createJobRecord(prisma, {
    type: 'RANK_CHECK',
    queue: 'local',
    workspaceId: scan.workspaceId,
    projectId: scan.projectId,
    userId,
    entityType: 'LocalRankScan',
    entityId: scan.id,
    payload: { scanId: scan.id, collectionRunId: runId },
    maxAttempts: 3,
  });
  await enqueueJobRecord(prisma, queues, job, 'local', { backgroundJobId: job.id, scanId: scan.id, collectionRunId: runId }, { backoffMs: 30_000 }); // prettier-ignore
  return job.id;
}

/** Starts an automatic collection of a tracked query (its keyword and location) from a batch-capable source. */
export async function startLocalCollection(
  prisma: PrismaClient,
  queues: QueueGateway,
  args: StartCollectionArgs,
): Promise<{ scanId: string; jobId: string }> {
  const query = await prisma.localRankQuery.findFirst({
    where: { id: args.queryId, projectId: args.projectId },
    include: { project: { select: { workspaceId: true } } },
  });
  if (!query) throw Errors.notFound('Tracked query');
  const provider = getLocalRankProvider(args.source);
  if (!provider.fetchBatch || !provider.batching)
    throw Errors.badRequest(`${provider.label} cannot collect automatically in batches.`);
  const config = provider.configured();
  if (!config.configured) throw Errors.providerNotConfigured(provider.label, { setup: config.detail });
  if (!(provider.surfaces as readonly string[]).includes(query.surface))
    throw Errors.badRequest(`${provider.label} cannot collect ${query.surface.toLowerCase().replace('_', ' ')} results.`); // prettier-ignore
  const open = await prisma.localRankScan.findFirst({
    where: { queryId: query.id, source: { not: 'GOOGLE_CAPTURE' }, captureState: { in: ['IN_PROGRESS', 'PAUSED', 'FAILED'] }, status: 'RUNNING' }, // prettier-ignore
    select: { id: true },
  });
  if (open)
    throw Errors.conflict('A collection of this query is still open: resume, retry or cancel it first.');

  const batchSize = Math.min(args.batchSize ?? COLLECTION_MAX_BATCH_SIZE, provider.batching.maxBatchSize);
  // The configured pause, but never less than the source itself requires.
  const delayMs = Math.max(args.delayMs ?? COLLECTION_DEFAULT_DELAY_MS, provider.batching.minDelayMs);
  const runId = newRunId();
  const scan = await prisma.localRankScan.create({
    data: {
      projectId: args.projectId,
      queryId: query.id,
      source: args.source,
      trigger: 'MANUAL',
      status: 'RUNNING',
      observationType: provider.batching.observationType,
      query: query.query,
      surface: query.surface,
      language: query.language,
      device: query.device,
      gridSize: 1,
      spacingKm: query.spacingKm,
      depth: query.depth,
      centerLatitude: query.centerLatitude,
      centerLongitude: query.centerLongitude,
      pointsPlanned: 1,
      createdById: args.userId,
      startedAt: new Date(),
      captureBatches: [],
      captureTarget: args.target ?? GOOGLE_CAPTURE_DEFAULT_TARGET,
      captureState: 'IN_PROGRESS',
      collectionBatchSize: batchSize,
      collectionDelayMs: delayMs,
      collectionRunId: runId,
      collectionCursor: null,
    },
  });
  await prisma.localRankPoint.create({
    data: {
      scanId: scan.id,
      row: 0,
      col: 0,
      latitude: query.centerLatitude,
      longitude: query.centerLongitude,
    },
  });
  const jobId = await queueRun(prisma, queues, { id: scan.id, projectId: args.projectId, workspaceId: query.project.workspaceId }, runId, args.userId); // prettier-ignore
  return { scanId: scan.id, jobId };
}

/** A source batch as collection listings: the order the source returned them, positions within the batch. */
function listingsOf(result: LocalBatchResult): CapturedListing[] {
  return result.results.map((r, i) => ({
    position: i + 1,
    title: r.title,
    cid: r.cid,
    entityId: r.entityId ?? null,
    placeId: r.placeId,
    rating: r.rating,
    reviewCount: r.reviewCount,
    sponsored: r.sponsored === true,
    category: r.category,
    address: r.address,
    website: r.url,
    domain: r.domain,
    mapsUrl: r.mapsUrl ?? null,
    mapsUrlSource: r.mapsUrl ? 'page' : null,
    latitude: r.latitude,
    longitude: r.longitude,
  }));
}

export interface RunCollectionOptions {
  /** The run this worker job belongs to; a newer run (resume/retry) or a cancel supersedes it. */
  runId: string;
  fetchImpl?: LocalRankFetch;
  /** Waits between requests (replaceable in tests). */
  sleep?: (ms: number) => Promise<void>;
  onProgress?: (uniqueOrBatches: { batches: number; state: GoogleCaptureState }) => Promise<void>;
  backgroundJobId?: string;
  maxBatches?: number;
}

/**
 * Runs a collection until it ends, is paused or cancelled, or a source problem stops it. Every batch is committed
 * (with the source's next cursor) before the next request, so stopping at any moment loses nothing.
 */
export async function runLocalCollection(
  prisma: PrismaClient,
  scanId: string,
  options: RunCollectionOptions,
): Promise<{ state: GoogleCaptureState; batches: number }> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const maxBatches = options.maxBatches ?? COLLECTION_MAX_BATCHES_PER_RUN;
  const initial = await prisma.localRankScan.findUniqueOrThrow({
    where: { id: scanId },
    include: { project: { select: { workspaceId: true } } },
  });
  // One provider instance per run (a source may keep per-run state, e.g. OpenStreetMap's fetched rings).
  const provider = getLocalRankProvider(initial.source as LocalRankSource);
  const label = LOCAL_RANK_SOURCE_LABELS[initial.source as LocalRankSource] ?? initial.source;
  const stop = (state: GoogleCaptureState, reason: string) =>
    prisma.localRankScan.updateMany({
      where: { id: scanId, collectionRunId: options.runId },
      data: { captureState: state, captureReason: reason.slice(0, 2000) },
    });
  const country = (await matchTargetFor(prisma, initial.queryId)).country;
  let batches = 0;
  let requests = 0;
  let costUsd = 0;
  let attempt = 0;
  let state: GoogleCaptureState;

  for (;;) {
    const scan = await prisma.localRankScan.findUniqueOrThrow({ where: { id: scanId } });
    state = (scan.captureState as GoogleCaptureState | null) ?? 'IN_PROGRESS';
    if (scan.collectionRunId !== options.runId || state !== 'IN_PROGRESS') break; // superseded, paused or ended
    if (!provider.fetchBatch || !provider.batching) {
      await stop('FAILED', `${label} cannot collect automatically in batches.`);
      break;
    }
    const config = provider.configured();
    if (!config.configured) {
      await stop('FAILED', `${label} is not available: ${config.detail}`);
      break;
    }
    if (batches >= maxBatches) {
      await stop('FAILED', `Stopped after ${maxBatches} batches in one run (safety limit). Retry continues from where it stopped.`); // prettier-ignore
      break;
    }
    const cursor = scan.collectionCursor;
    let result: LocalBatchResult;
    try {
      result = await provider.fetchBatch(
        {
          query: scan.query,
          latitude: Number(scan.centerLatitude),
          longitude: Number(scan.centerLongitude),
          surface: scan.surface as LocalSurface,
          language: scan.language,
          device: scan.device === 'desktop' ? 'desktop' : 'mobile',
          depth: scan.depth,
          zoom: zoomForSpacing(scan.spacingKm),
          country,
          limit: scan.collectionBatchSize ?? COLLECTION_MAX_BATCH_SIZE,
          cursor,
        },
        options.fetchImpl,
      );
      requests += 1;
      attempt = 0;
    } catch (error) {
      const message = errorMessage(error);
      const permanent = error instanceof LocalRankProviderError && error.permanent;
      if (!permanent && attempt < COLLECTION_MAX_RETRIES) {
        attempt += 1;
        // Back off — longer each time, and never sooner than the source asked (Retry-After).
        const retryAfter = error instanceof LocalRankProviderError ? (error.retryAfterMs ?? 0) : 0;
        const wait = Math.max(
          (scan.collectionDelayMs ?? COLLECTION_DEFAULT_DELAY_MS) * 2 ** attempt,
          retryAfter,
        );
        await prisma.localRankScan.updateMany({
          where: { id: scanId, collectionRunId: options.runId },
          data: { captureReason: `Waiting ${Math.round(wait / 1000)}s before trying again (attempt ${attempt} of ${COLLECTION_MAX_RETRIES}): ${message}`.slice(0, 2000) }, // prettier-ignore
        });
        await sleep(wait);
        continue;
      }
      // A refusal, or the same problem after every retry: stop here. Everything collected is kept, and Retry
      // continues from this same cursor.
      await stop('FAILED', `Stopped: ${message} Everything collected so far is kept; Retry continues from batch ${(Array.isArray(scan.captureBatches) ? scan.captureBatches.length : 0) + 1}.`); // prettier-ignore
      break;
    }
    costUsd += result.costUsd;
    const pageKey = `cursor:${cursor ?? 'start'}`;
    const nextKey = result.nextCursor ? `cursor:${result.nextCursor}` : null;
    const usedKeys = new Set(
      (Array.isArray(scan.captureBatches) ? (scan.captureBatches as { urlKey?: string | null }[]) : [])
        .map((b) => b.urlKey)
        .filter(Boolean),
    );
    const applied = await withScanLock(prisma, scanId, async (tx) => {
      // Re-check inside the lock: a pause or cancel made during the request still wins.
      const now = await tx.localRankScan.findUniqueOrThrow({ where: { id: scanId }, select: { collectionRunId: true } }); // prettier-ignore
      if (now.collectionRunId !== options.runId) return null;
      return applyBatch(tx, scanId, {
        status: 'parsed',
        error: null,
        listings: listingsOf(result),
        url: null,
        offsetKnown: result.offset !== null,
        start: result.offset ?? 0,
        pageKey,
        notes: result.note ? [result.note] : [],
        capturedAt: result.checkedAt,
        nextUrl: null,
        noMore: result.nextCursor === null,
        // The source's next cursor is one already used: following it would loop.
        pointsBackwards: nextKey !== null && (nextKey === pageKey || usedKeys.has(nextKey)),
        extraScanData: { collectionCursor: result.nextCursor },
        unit: 'Batch',
      });
    });
    if (!applied || !applied.batch) break; // superseded or ended while the request was in flight
    batches += 1;
    state = applied.state;
    await options.onProgress?.({ batches, state });
    if (state !== 'IN_PROGRESS') break;
    await sleep(
      Math.max(scan.collectionDelayMs ?? COLLECTION_DEFAULT_DELAY_MS, provider.batching.minDelayMs),
    );
  }

  if (requests)
    await recordProviderUsage(prisma, {
      workspaceId: initial.project.workspaceId,
      projectId: initial.projectId,
      provider: initial.source.toLowerCase(),
      operation: 'local_collection_batch',
      requests,
      backgroundJobId: options.backgroundJobId,
      idempotencyKey: `local-collection:${scanId}:${options.runId}:${requests}`,
    });
  const final = await prisma.localRankScan.findUniqueOrThrow({ where: { id: scanId } });
  if (costUsd)
    await prisma.localRankScan.update({
      where: { id: scanId },
      data: { costUsd: (final.costUsd ?? 0) + costUsd },
    });
  state = (final.captureState as GoogleCaptureState | null) ?? state;
  if (
    (state === 'TARGET_REACHED' || state === 'SOURCE_EXHAUSTED') &&
    final.status === 'RUNNING' &&
    final.collectionRunId === options.runId
  )
    // prettier-ignore
    await finalizeCapture(prisma, scanId);
  return { state, batches };
}

/** Pause, resume, retry or cancel an automatic collection. Collected listings are always kept. */
export async function controlLocalCollection(
  prisma: PrismaClient,
  queues: QueueGateway,
  args: { projectId: string; scanId: string; action: CollectionAction; userId: string },
): Promise<void> {
  const scan = await prisma.localRankScan.findFirst({
    where: { id: args.scanId, projectId: args.projectId },
    include: { project: { select: { workspaceId: true } } },
  });
  if (!scan) throw Errors.notFound('Scan');
  if (scan.source === 'GOOGLE_CAPTURE' || !scan.captureState)
    throw Errors.badRequest('Only an automatic collection can be paused, resumed, retried or cancelled.');
  const state = scan.captureState as GoogleCaptureState;
  const pages = Array.isArray(scan.captureBatches) ? scan.captureBatches.length : 0;
  const ref = { id: scan.id, projectId: scan.projectId, workspaceId: scan.project.workspaceId };
  if (args.action === 'pause') {
    if (state !== 'IN_PROGRESS') throw Errors.conflict('Only a running collection can be paused.');
    await prisma.localRankScan.update({
      where: { id: scan.id },
      data: { captureState: 'PAUSED', captureReason: `Paused by you after ${pages} batch${pages === 1 ? '' : 'es'}. Resume continues from the next batch.` }, // prettier-ignore
    });
    return;
  }
  if (args.action === 'resume' || args.action === 'retry') {
    const from = args.action === 'resume' ? 'PAUSED' : 'FAILED';
    if (state !== from)
      throw Errors.conflict(args.action === 'resume' ? 'Only a paused collection can be resumed.' : 'Only a collection stopped by an error can be retried.'); // prettier-ignore
    const runId = newRunId();
    await prisma.localRankScan.update({
      where: { id: scan.id },
      data: { captureState: 'IN_PROGRESS', captureReason: null, collectionRunId: runId, status: 'RUNNING', finishedAt: null }, // prettier-ignore
    });
    await queueRun(prisma, queues, ref, runId, args.userId);
    return;
  }
  // cancel
  if (state !== 'IN_PROGRESS' && state !== 'PAUSED' && state !== 'FAILED')
    throw Errors.conflict('This collection has already ended.');
  await prisma.localRankScan.update({
    where: { id: scan.id },
    data: { captureState: 'CANCELLED', captureReason: `Cancelled by you after ${pages} batch${pages === 1 ? '' : 'es'}. Everything collected is kept.`, collectionRunId: null }, // prettier-ignore
  });
  await finalizeCapture(prisma, scan.id);
}
