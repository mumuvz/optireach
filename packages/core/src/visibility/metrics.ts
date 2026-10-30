// Loads stored observations for a filter and computes the documented metrics (docs/metrics.md).
import {
  computeVisibilityMetrics,
  computeVisibilityTrend,
  describeComposition,
  type CompetitorRef,
  type MetricComposition,
  type ObservationFacts,
  type TrendBucket,
  type VisibilityFilter,
  type VisibilityMetrics,
} from '@surfaced/shared';
import type { Prisma, PrismaClient } from '../db';

/** Hard cap on observations per metrics query (keeps responses bounded). */
export const MAX_METRIC_OBSERVATIONS = 20_000;

export function observationWhere(
  projectId: string,
  filter: Partial<VisibilityFilter>,
): Prisma.AiVisibilityObservationWhereInput {
  const where: Prisma.AiVisibilityObservationWhereInput = { projectId };
  if (filter.provider && filter.provider !== 'all') where.provider = filter.provider;
  if (filter.country) where.country = filter.country;
  if (filter.language) where.language = filter.language;
  if (filter.promptIds?.length) where.promptId = { in: filter.promptIds };
  if (filter.from || filter.to)
    where.observedAt = {
      ...(filter.from ? { gte: filter.from } : {}),
      ...(filter.to ? { lte: filter.to } : {}),
    };
  if (filter.includeDemo === 'false') where.isDemo = false;
  return where;
}

export interface LoadedObservations {
  facts: (ObservationFacts & { isDemo: boolean })[];
  competitors: CompetitorRef[];
  truncated: boolean;
}

export async function loadObservationFacts(
  prisma: PrismaClient,
  projectId: string,
  filter: Partial<VisibilityFilter>,
): Promise<LoadedObservations> {
  const [rows, competitors] = await Promise.all([
    prisma.aiVisibilityObservation.findMany({
      where: observationWhere(projectId, filter),
      orderBy: { observedAt: 'desc' },
      take: MAX_METRIC_OBSERVATIONS + 1,
      select: {
        id: true,
        promptId: true,
        provider: true,
        country: true,
        language: true,
        observedAt: true,
        status: true,
        isDemo: true,
        brandMentioned: true,
        brandCited: true,
        mentions: { select: { entityType: true, competitorId: true } },
        citations: { select: { domain: true, competitorId: true } },
      },
    }),
    prisma.projectCompetitor.findMany({
      where: { projectId },
      select: { id: true, name: true },
      orderBy: { createdAt: 'asc' },
    }),
  ]);
  const truncated = rows.length > MAX_METRIC_OBSERVATIONS;
  const facts = rows.slice(0, MAX_METRIC_OBSERVATIONS).map((r) => ({
    id: r.id,
    promptId: r.promptId,
    provider: r.provider,
    country: r.country,
    language: r.language,
    observedAt: r.observedAt,
    succeeded: r.status === 'SUCCEEDED',
    isDemo: r.isDemo,
    brandMentioned: r.brandMentioned,
    brandCited: r.brandCited,
    competitorsMentioned: [
      ...new Set(
        r.mentions.filter((m) => m.entityType === 'COMPETITOR' && m.competitorId).map((m) => m.competitorId!),
      ),
    ],
    competitorsCited: [...new Set(r.citations.filter((c) => c.competitorId).map((c) => c.competitorId!))],
    citationDomains: r.citations.map((c) => c.domain),
  }));
  return { facts, competitors, truncated };
}

export interface VisibilitySummary {
  metrics: VisibilityMetrics;
  composition: MetricComposition;
  truncated: boolean;
  notes: string[];
}

function compositionNotes(composition: MetricComposition, truncated: boolean): string[] {
  const notes: string[] = [];
  if (composition.mixedProviders) {
    notes.push(
      `Rates pool ${composition.providers.length} providers (${composition.providers.join(', ')}). Providers answer differently; filter to one provider for like-for-like comparisons.`,
    );
  }
  if (composition.mixedLocales)
    notes.push(
      `Observations span several locales (${composition.countries.join(', ')} / ${composition.languages.join(', ')}).`,
    );
  if (composition.includesDemoData) notes.push('Includes demo fixture data, which is not real AI output.');
  if (truncated) notes.push('Only the most recent 20,000 observations are included.');
  return notes;
}

export async function getVisibilitySummary(
  prisma: PrismaClient,
  projectId: string,
  filter: Partial<VisibilityFilter>,
): Promise<VisibilitySummary> {
  const { facts, competitors, truncated } = await loadObservationFacts(prisma, projectId, filter);
  const composition = describeComposition(facts);
  return {
    metrics: computeVisibilityMetrics(facts, competitors),
    composition,
    truncated,
    notes: compositionNotes(composition, truncated),
  };
}

export async function getVisibilityTrend(
  prisma: PrismaClient,
  projectId: string,
  filter: Partial<VisibilityFilter>,
  bucket: TrendBucket,
) {
  const { facts, competitors, truncated } = await loadObservationFacts(prisma, projectId, filter);
  const composition = describeComposition(facts);
  return {
    points: computeVisibilityTrend(facts, competitors, bucket),
    composition,
    notes: compositionNotes(composition, truncated),
  };
}
