// Turns a local business's own evidence — its Business Profile completeness, its local rank scans and its
// reviews — into prioritized, evidence-cited recommendations (source = LOCAL). This is the "growth coordinator"
// of the Local Business Growth module: it reuses the existing recommendation store and the Business Profile audit
// rather than inventing a parallel system, and never promises a ranking or fabricates data.
import type { BusinessProfile } from '@surfaced/shared';
import { sha256Hex } from '../crypto';
import type { PrismaClient } from '../db';
import { toLocationDto } from '../local/locations';
import { auditProfile } from '../local/profile-audit';
import { upsertEvidenceRecommendation } from './evidence';

export interface RecommendationSyncResult {
  created: number;
  updated: number;
  autoCompleted: number;
}

const LOCAL_BUSINESS_TYPES = new Set(['LOCAL_STOREFRONT', 'SERVICE_AREA', 'RETAIL_STORE', 'MULTI_LOCATION']);
const CHECK_PRIORITY = { critical: 1, warning: 2, suggestion: 3 } as const;
/** Profile audit checks that are about internal matching, not customer-facing completeness — skip as actions. */
const SKIP_CHECK_KEYS = new Set(['nap_phone', 'nap_address', 'pending', 'open_status', 'ownership']);
const MAX_PROFILE_CHECKS = 8;
const MAX_RANK_QUERIES = 10;

/**
 * Rebuilds LOCAL-sourced recommendations for a project from its current local evidence. Runs only for local
 * businesses (a local business type or at least one location). Idempotent per fingerprint; dismissed stay
 * dismissed; LOCAL recommendations whose evidence is gone are auto-completed.
 */
export async function syncLocalRecommendations(
  prisma: PrismaClient,
  projectId: string,
): Promise<RecommendationSyncResult> {
  const result: RecommendationSyncResult = { created: 0, updated: 0, autoCompleted: 0 };
  const project = await prisma.project.findUniqueOrThrow({
    where: { id: projectId },
    select: { id: true, name: true, websiteUrl: true, domain: true, businessProfile: true },
  });
  const locations = await prisma.businessLocation.findMany({
    where: { projectId, archivedAt: null },
    orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
  });
  const bp = (project.businessProfile ?? null) as (BusinessProfile & { types?: string[] }) | null;
  const isLocal = locations.length > 0 || (bp?.types ?? []).some((t) => LOCAL_BUSINESS_TYPES.has(t));
  if (!isLocal) return result;

  const active = new Set<string>();
  const add = async (input: Parameters<typeof upsertEvidenceRecommendation>[2]) => {
    active.add(sha256Hex(input.fingerprintKey));
    const { created } = await upsertEvidenceRecommendation(prisma, projectId, input);
    if (created) result.created += 1;
    else result.updated += 1;
  };
  const website = project.websiteUrl
    ? { url: project.websiteUrl, domain: project.domain ?? project.websiteUrl }
    : null;

  // ---- No location yet: the most basic local gap.
  if (locations.length === 0) {
    await add({
      fingerprintKey: 'local|location-missing',
      source: 'LOCAL',
      title: 'Add your business location',
      category: 'LOCAL_SEO',
      priority: 1,
      relatedUrl: null,
      evidence: { reason: 'The project is a local business but has no saved location.' },
      steps: [
        'Add the business name, address (or service areas) and map position under Locations.',
        'Then connect or create its Google Business Profile so it can appear on Maps.',
      ],
    });
  }

  const now = new Date();
  const primary = locations[0];
  if (primary) {
    const dto = toLocationDto(primary);

    // ---- Map position (needed for local rank grids).
    if (primary.latitude === null || primary.longitude === null) {
      await add({
        fingerprintKey: `local|map-position|${primary.id}`,
        source: 'LOCAL',
        title: `Add the map position of ${dto.name}`,
        category: 'LOCAL_SEO',
        priority: 2,
        relatedUrl: null,
        evidence: { locationId: primary.id, reason: 'The location has no latitude/longitude.' },
        steps: [
          'Open the location and set its position from a Google Maps link or by searching the address.',
          'Local rank tracking needs the coordinates to measure visibility around the business.',
        ],
      });
    }

    // ---- Business Profile completeness (reuses the profile audit on the details entered here).
    const reviews = await reviewCounts(prisma, projectId, primary.id);
    const audit = auditProfile({
      now,
      location: dto,
      profile: null,
      website,
      businessProfile: bp ? { secondaryCategories: bp.secondaryCategories ?? [] } : null,
      reviews,
    });
    const fails = audit.checks
      .filter((c) => c.status === 'fail' && !SKIP_CHECK_KEYS.has(c.key))
      .slice(0, MAX_PROFILE_CHECKS);
    for (const c of fails) {
      await add({
        fingerprintKey: `local|profile|${primary.id}|${c.key}`,
        source: 'LOCAL',
        title: c.title,
        category: 'LOCAL_SEO',
        priority: CHECK_PRIORITY[c.severity],
        relatedUrl: c.reference ?? null,
        evidence: { locationId: primary.id, check: c.key, found: c.evidence },
        steps: [c.recommendation, c.verification].filter((s): s is string => Boolean(s)),
      });
    }
  }

  // ---- Local rank: queries where the business is weak or absent in the latest scan.
  const queries = await prisma.localRankQuery.findMany({
    where: { projectId, status: 'ACTIVE' },
    orderBy: { createdAt: 'asc' },
    take: MAX_RANK_QUERIES,
    include: {
      scans: { where: { status: 'SUCCEEDED' }, orderBy: { createdAt: 'desc' }, take: 1 },
    },
  });
  for (const q of queries) {
    const scan = q.scans[0];
    if (!scan || scan.pointsMeasured === 0) continue;
    const share = scan.top3Share;
    if (share !== null && share >= 0.5) continue; // already strong in the top 3
    const pct = share === null ? 'none' : `${Math.round(share)}%`;
    await add({
      fingerprintKey: `local|rank|${q.id}`,
      source: 'LOCAL',
      title: `Improve local ranking for “${q.query}”`,
      category: 'LOCAL_SEO',
      priority: share === null || share === 0 ? 2 : 3,
      relatedUrl: null,
      evidence: {
        queryId: q.id,
        query: q.query,
        surface: q.surface,
        top3Share: share,
        pointsMeasured: scan.pointsMeasured,
        scanId: scan.id,
      },
      steps: [
        `In the latest scan the business was in the top 3 at ${pct} of measured points for this search.`,
        'Complete the Business Profile (categories, services, photos, hours), earn and answer reviews, and build locally relevant pages and citations for this query.',
        'Re-run the scan after changes to see whether measured visibility improves.',
      ],
    });
  }

  // ---- Auto-complete LOCAL recommendations whose evidence is gone.
  const stale = await prisma.recommendation.findMany({
    where: {
      projectId,
      source: 'LOCAL',
      status: { in: ['OPEN', 'PLANNED', 'IN_PROGRESS', 'AWAITING_APPROVAL', 'BLOCKED'] },
    },
    select: { id: true, fingerprint: true },
  });
  for (const rec of stale) {
    if (active.has(rec.fingerprint)) continue;
    await prisma.recommendation.update({
      where: { id: rec.id },
      data: { status: 'COMPLETED', completedAt: now },
    });
    result.autoCompleted += 1;
  }
  return result;
}

/** Recent reviews for a location: totals and how many lack a reply, for the profile audit's review check. */
async function reviewCounts(
  prisma: PrismaClient,
  projectId: string,
  locationId: string,
): Promise<{ total: number; unanswered: number; oldestUnansweredAt: Date | null } | null> {
  const rows = await prisma.businessReview.findMany({
    where: { projectId, locationId },
    orderBy: { createTime: 'desc' },
    take: 200,
    select: { replyComment: true, createTime: true },
  });
  if (rows.length === 0) return null;
  const unanswered = rows.filter((r) => !r.replyComment);
  const oldest = unanswered.reduce<Date | null>(
    (min, r) => (min === null || r.createTime < min ? r.createTime : min),
    null,
  );
  return { total: rows.length, unanswered: unanswered.length, oldestUnansweredAt: oldest };
}
