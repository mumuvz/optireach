// Keyword opportunity scores: an explainable ranking of the project's keywords from the signals that are actually
// available (Google Trends direction, Search Console impressions and CTR, provider search volume and difficulty,
// the keyword's priority and the site's coverage). Missing signals are listed, never estimated.

export const OPPORTUNITY_COMPONENTS = [
  { key: 'trend', label: 'Search trend', maxPoints: 20 },
  { key: 'search_console', label: 'Search Console demand', maxPoints: 25 },
  { key: 'volume', label: 'Measured search volume', maxPoints: 20 },
  { key: 'relevance', label: 'Relevance to the business', maxPoints: 15 },
  { key: 'competition', label: 'Competition', maxPoints: 10 },
  { key: 'coverage', label: 'Content gap on your site', maxPoints: 10 },
] as const;
export type OpportunityComponentKey = (typeof OPPORTUNITY_COMPONENTS)[number]['key'];

export const OPPORTUNITY_ACTIONS = [
  'new_landing_page',
  'new_article',
  'update_page',
  'faq',
  'local_page',
  'aeo_topic',
  'geo_topic',
  'monitor',
] as const;
export type OpportunityAction = (typeof OPPORTUNITY_ACTIONS)[number];

export const OPPORTUNITY_ACTION_LABELS: Record<OpportunityAction, string> = {
  new_landing_page: 'Create a landing page',
  new_article: 'Write an article',
  update_page: 'Update an existing page',
  faq: 'Add an FAQ answer',
  local_page: 'Create a local page',
  aeo_topic: 'Answer it for answer engines (AEO)',
  geo_topic: 'Cover it for AI assistants (GEO)',
  monitor: 'Keep monitoring',
};

export interface OpportunityComponent {
  key: OpportunityComponentKey;
  label: string;
  /** False when the signal is not available for this keyword; its points are then left out of the score. */
  available: boolean;
  points: number;
  maxPoints: number;
  /** The measured value shown to the user, e.g. "1,240 impressions, CTR 0.8%". */
  value: string | null;
  /** Where the value comes from, e.g. "Google Search Console, 28 days to 2026-10-20". */
  source: string | null;
  explanation: string;
}

export interface KeywordOpportunityDto {
  keywordId: string;
  phrase: string;
  /** 0–100 over the signals that are available; null when none are. */
  score: number | null;
  /** Share of the possible points that had data: high ≥ 70%, medium ≥ 45%. */
  confidence: 'high' | 'medium' | 'low';
  components: OpportunityComponent[];
  /** Labels of the signals that had no data. */
  missing: string[];
  actions: { type: OpportunityAction; label: string; reason: string; targetUrl: string | null }[];
}

export interface KeywordOpportunitiesDto {
  items: KeywordOpportunityDto[];
  /** Which signals the project has at all. */
  signals: {
    trendsReportAt: string | null;
    searchConsoleRange: { start: string; end: string } | null;
    measuredMetrics: boolean;
    crawlFinishedAt: string | null;
  };
  notes: string[];
}
