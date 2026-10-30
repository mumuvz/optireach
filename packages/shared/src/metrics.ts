// AI visibility metric formulas (documented in docs/metrics.md). Every metric is computed from a
// filtered set of stored observations; the caller is responsible for keeping that set comparable
// (same providers, locales, prompt set and period) and for reporting its composition.

export interface ObservationFacts {
  id: string;
  promptId: string;
  provider: string;
  country: string;
  language: string;
  observedAt: string | Date;
  succeeded: boolean;
  brandMentioned: boolean;
  brandCited: boolean;
  /** Competitor ids mentioned at least once in the answer. */
  competitorsMentioned: readonly string[];
  /** Competitor ids whose domain was cited. */
  competitorsCited: readonly string[];
  /** Cited domains (one entry per citation; duplicates allowed). */
  citationDomains: readonly string[];
}

export interface CompetitorRef {
  id: string;
  name: string;
}

export interface EntityRate {
  id: string;
  name: string;
  mentions: number;
  citations: number;
  mentionRate: number | null;
  citationRate: number | null;
}

export interface SourceShare {
  domain: string;
  citations: number;
  /** Share of all citations in the set. */
  share: number;
  /** Number of successful observations that cited this domain at least once. */
  observations: number;
}

export interface VisibilityMetrics {
  totals: { observations: number; successful: number; failed: number };
  /** Successful observations mentioning the brand ÷ successful observations. */
  mentionRate: number | null;
  /** Successful observations citing an owned-domain URL ÷ successful observations. */
  citationRate: number | null;
  brandMentions: number;
  brandCitations: number;
  competitors: EntityRate[];
  /**
   * Share of voice: brand mentions ÷ (brand mentions + all competitor mentions), where a "mention"
   * counts each observation at most once per entity. Null when nobody was mentioned.
   */
  shareOfVoice: { brand: number | null; competitors: { id: string; name: string; share: number | null }[] };
  sources: SourceShare[];
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

export function computeVisibilityMetrics(
  observations: readonly ObservationFacts[],
  competitors: readonly CompetitorRef[],
): VisibilityMetrics {
  const successful = observations.filter((o) => o.succeeded);
  const s = successful.length;

  const brandMentions = successful.filter((o) => o.brandMentioned).length;
  const brandCitations = successful.filter((o) => o.brandCited).length;

  const competitorRates: EntityRate[] = competitors.map((c) => {
    const mentions = successful.filter((o) => o.competitorsMentioned.includes(c.id)).length;
    const citations = successful.filter((o) => o.competitorsCited.includes(c.id)).length;
    return {
      id: c.id,
      name: c.name,
      mentions,
      citations,
      mentionRate: ratio(mentions, s),
      citationRate: ratio(citations, s),
    };
  });

  const totalMentions = brandMentions + competitorRates.reduce((sum, c) => sum + c.mentions, 0);

  const sourceMap = new Map<string, { citations: number; observations: number }>();
  let totalCitations = 0;
  for (const o of successful) {
    const seen = new Set<string>();
    for (const domain of o.citationDomains) {
      totalCitations += 1;
      const entry = sourceMap.get(domain) ?? { citations: 0, observations: 0 };
      entry.citations += 1;
      if (!seen.has(domain)) {
        entry.observations += 1;
        seen.add(domain);
      }
      sourceMap.set(domain, entry);
    }
  }
  const sources: SourceShare[] = [...sourceMap.entries()]
    .map(([domain, v]) => ({
      domain,
      citations: v.citations,
      observations: v.observations,
      share: v.citations / totalCitations,
    }))
    .sort((a, b) => b.citations - a.citations || a.domain.localeCompare(b.domain));

  return {
    totals: { observations: observations.length, successful: s, failed: observations.length - s },
    mentionRate: ratio(brandMentions, s),
    citationRate: ratio(brandCitations, s),
    brandMentions,
    brandCitations,
    competitors: competitorRates,
    shareOfVoice: {
      brand: ratio(brandMentions, totalMentions),
      competitors: competitorRates.map((c) => ({
        id: c.id,
        name: c.name,
        share: ratio(c.mentions, totalMentions),
      })),
    },
    sources,
  };
}

export type TrendBucket = 'day' | 'week' | 'month';

/** Start of the UTC bucket containing `date` (weeks start on Monday). */
export function bucketStart(date: Date, bucket: TrendBucket): Date {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  if (bucket === 'week') {
    const day = d.getUTCDay(); // 0 = Sunday
    d.setUTCDate(d.getUTCDate() - ((day + 6) % 7));
  } else if (bucket === 'month') {
    d.setUTCDate(1);
  }
  return d;
}

export interface TrendPoint {
  bucketStart: string;
  observations: number;
  successful: number;
  mentionRate: number | null;
  citationRate: number | null;
  shareOfVoice: number | null;
}

export function computeVisibilityTrend(
  observations: readonly ObservationFacts[],
  competitors: readonly CompetitorRef[],
  bucket: TrendBucket,
): TrendPoint[] {
  const groups = new Map<string, ObservationFacts[]>();
  for (const o of observations) {
    const key = bucketStart(new Date(o.observedAt), bucket).toISOString();
    const list = groups.get(key) ?? [];
    list.push(o);
    groups.set(key, list);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, list]) => {
      const m = computeVisibilityMetrics(list, competitors);
      return {
        bucketStart: key,
        observations: m.totals.observations,
        successful: m.totals.successful,
        mentionRate: m.mentionRate,
        citationRate: m.citationRate,
        shareOfVoice: m.shareOfVoice.brand,
      };
    });
}

/** Describes the observation set behind a metric so the UI can show what is being compared. */
export interface MetricComposition {
  providers: string[];
  countries: string[];
  languages: string[];
  promptCount: number;
  from: string | null;
  to: string | null;
  mixedProviders: boolean;
  mixedLocales: boolean;
  includesDemoData: boolean;
}

export function describeComposition(
  observations: readonly (Pick<
    ObservationFacts,
    'provider' | 'country' | 'language' | 'promptId' | 'observedAt'
  > & {
    isDemo?: boolean;
  })[],
): MetricComposition {
  const providers = [...new Set(observations.map((o) => o.provider))].sort();
  const countries = [...new Set(observations.map((o) => o.country))].sort();
  const languages = [...new Set(observations.map((o) => o.language))].sort();
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const o of observations) {
    const t = new Date(o.observedAt).getTime();
    if (Number.isNaN(t)) continue;
    if (t < min) min = t;
    if (t > max) max = t;
  }
  const hasTimes = Number.isFinite(min);
  return {
    providers,
    countries,
    languages,
    promptCount: new Set(observations.map((o) => o.promptId)).size,
    from: hasTimes ? new Date(min).toISOString() : null,
    to: hasTimes ? new Date(max).toISOString() : null,
    mixedProviders: providers.length > 1,
    mixedLocales: countries.length > 1 || languages.length > 1,
    includesDemoData: observations.some((o) => o.isDemo === true),
  };
}
