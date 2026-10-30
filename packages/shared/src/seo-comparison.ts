// SEO comparison: your site and competitors crawled the same way and checked with the same audit rules.
// Only what can be observed on public pages is compared. Rankings, traffic and backlinks need licensed data and
// are not estimated.
import type { AuditCategory, IssueSeverity, RecommendationCategory } from './enums';

export const SEO_METRIC_GROUPS = [
  'OVERALL',
  'CRAWLABILITY',
  'METADATA',
  'CONTENT',
  'STRUCTURED_DATA',
  'IMAGES',
  'PERFORMANCE',
  'LINKS',
] as const;
export type SeoMetricGroup = (typeof SEO_METRIC_GROUPS)[number];
export const SEO_METRIC_GROUP_LABELS: Record<SeoMetricGroup, string> = {
  OVERALL: 'Overall',
  CRAWLABILITY: 'Crawling and indexing',
  METADATA: 'Titles and metadata',
  CONTENT: 'Content',
  STRUCTURED_DATA: 'Structured data',
  IMAGES: 'Images',
  PERFORMANCE: 'Speed and technical',
  LINKS: 'Internal links',
};

export type SeoMetricUnit = 'score' | 'percent' | 'words' | 'count' | 'ms' | 'boolean';

export interface SeoMetricDefinition {
  key: string;
  label: string;
  group: SeoMetricGroup;
  unit: SeoMetricUnit;
  better: 'higher' | 'lower';
  help: string;
}

export const SEO_METRICS: readonly SeoMetricDefinition[] = [
  { key: 'healthScore', label: 'Site health index', group: 'OVERALL', unit: 'score', better: 'higher', help: 'Surfaced’s 0–100 index from the same audit rules on every site. It is not a Google score.' },
  { key: 'https', label: 'Served over HTTPS', group: 'CRAWLABILITY', unit: 'boolean', better: 'higher', help: 'The start page uses HTTPS.' },
  { key: 'sitemap', label: 'XML sitemap found', group: 'CRAWLABILITY', unit: 'boolean', better: 'higher', help: 'A sitemap is declared in robots.txt or found at /sitemap.xml.' },
  { key: 'indexablePct', label: 'Indexable pages', group: 'CRAWLABILITY', unit: 'percent', better: 'higher', help: 'HTML pages that return 200, are not noindex and are not canonicalized elsewhere.' },
  { key: 'errorPagesPct', label: 'Pages returning errors', group: 'CRAWLABILITY', unit: 'percent', better: 'lower', help: 'Crawled URLs that returned 4xx/5xx or could not be fetched.' },
  { key: 'brokenLinkPagesPct', label: 'Pages with broken internal links', group: 'CRAWLABILITY', unit: 'percent', better: 'lower', help: 'Pages linking to internal URLs that return errors.' },
  { key: 'redirectLinkPagesPct', label: 'Pages linking to redirects', group: 'CRAWLABILITY', unit: 'percent', better: 'lower', help: 'Pages whose internal links point at redirecting URLs.' },
  { key: 'titlePct', label: 'Pages with a title', group: 'METADATA', unit: 'percent', better: 'higher', help: 'Pages with a non-empty <title>.' },
  { key: 'titleLengthPct', label: 'Titles of 15–60 characters', group: 'METADATA', unit: 'percent', better: 'higher', help: 'Titles short enough to show in full and long enough to describe the page.' },
  { key: 'uniqueTitlePct', label: 'Unique titles', group: 'METADATA', unit: 'percent', better: 'higher', help: 'Titled pages whose title no other checked page uses.' },
  { key: 'descriptionPct', label: 'Pages with a meta description', group: 'METADATA', unit: 'percent', better: 'higher', help: 'Pages with a meta description.' },
  { key: 'descriptionLengthPct', label: 'Descriptions of 50–160 characters', group: 'METADATA', unit: 'percent', better: 'higher', help: 'Meta descriptions of a length that usually shows in full.' },
  { key: 'canonicalPct', label: 'Pages with a canonical tag', group: 'METADATA', unit: 'percent', better: 'higher', help: 'Pages that declare their preferred URL.' },
  { key: 'openGraphPct', label: 'Pages with Open Graph tags', group: 'METADATA', unit: 'percent', better: 'higher', help: 'og:title or og:description, used when pages are shared.' },
  { key: 'medianWords', label: 'Median words per page', group: 'CONTENT', unit: 'words', better: 'higher', help: 'Visible words on a typical page. More is not automatically better; depth that answers questions is.' },
  { key: 'thinPct', label: 'Thin pages (under 200 words)', group: 'CONTENT', unit: 'percent', better: 'lower', help: 'Pages with little visible text.' },
  { key: 'singleH1Pct', label: 'Pages with exactly one H1', group: 'CONTENT', unit: 'percent', better: 'higher', help: 'One main heading that states what the page is about.' },
  { key: 'questionHeadingsPct', label: 'Pages with question headings', group: 'CONTENT', unit: 'percent', better: 'higher', help: 'Headings phrased as the questions people ask (useful for answer engines).' },
  { key: 'faqPct', label: 'Pages with FAQ content', group: 'CONTENT', unit: 'percent', better: 'higher', help: 'FAQ sections or FAQPage data.' },
  { key: 'duplicateContentPct', label: 'Near-duplicate pages', group: 'CONTENT', unit: 'percent', better: 'lower', help: 'Pages whose visible text is nearly identical to another checked page.' },
  { key: 'langPct', label: 'Pages declaring a language', group: 'CONTENT', unit: 'percent', better: 'higher', help: 'Pages with an <html lang> attribute.' },
  { key: 'structuredDataPct', label: 'Pages with structured data', group: 'STRUCTURED_DATA', unit: 'percent', better: 'higher', help: 'Pages with at least one JSON-LD block.' },
  { key: 'structuredDataErrorsPct', label: 'Pages with structured data errors', group: 'STRUCTURED_DATA', unit: 'percent', better: 'lower', help: 'JSON-LD that cannot be parsed or misses required properties.' },
  { key: 'orgSchema', label: 'Organization data on the start page', group: 'STRUCTURED_DATA', unit: 'boolean', better: 'higher', help: 'Organization or LocalBusiness JSON-LD on the homepage.' },
  { key: 'altPct', label: 'Images with alt text', group: 'IMAGES', unit: 'percent', better: 'higher', help: 'Share of images that have an alt attribute.' },
  { key: 'medianResponseMs', label: 'Median server response time', group: 'PERFORMANCE', unit: 'ms', better: 'lower', help: 'Time until the server answered, measured by the crawler. It is not Core Web Vitals.' },
  { key: 'compressedPct', label: 'Compressed HTML', group: 'PERFORMANCE', unit: 'percent', better: 'higher', help: 'HTML served with gzip or Brotli.' },
  { key: 'viewportPct', label: 'Mobile viewport set', group: 'PERFORMANCE', unit: 'percent', better: 'higher', help: 'Pages with a viewport meta tag.' },
  { key: 'mixedContentPct', label: 'Pages loading insecure resources', group: 'PERFORMANCE', unit: 'percent', better: 'lower', help: 'HTTPS pages that load resources over plain HTTP.' },
  { key: 'medianInternalLinks', label: 'Median internal links per page', group: 'LINKS', unit: 'count', better: 'higher', help: 'Links to other pages of the same site on a typical page.' },
  { key: 'orphanPct', label: 'Orphan pages', group: 'LINKS', unit: 'percent', better: 'lower', help: 'Pages in the sitemap that no checked page links to.' },
  { key: 'deepPct', label: 'Pages more than 4 clicks deep', group: 'LINKS', unit: 'percent', better: 'lower', help: 'Pages far from the start page are found and visited less.' },
]; // prettier-ignore

export type SeoMetricStatus = 'ahead' | 'behind' | 'even' | 'unknown';

export interface SeoSiteRule {
  ruleId: string;
  title: string;
  category: AuditCategory;
  severity: IssueSeverity;
  scope: 'page' | 'site';
  /** Affected pages (1 for site-wide rules). */
  pages: number;
  /** Affected share of analyzed pages; null for site-wide rules. */
  rate: number | null;
  sampleUrls: string[];
}

export interface SeoSite {
  /** "you" or the competitor id. */
  key: string;
  name: string;
  domain: string;
  isYou: boolean;
  competitorId: string | null;
  startUrl: string;
  status: 'OK' | 'BLOCKED_BY_ROBOTS' | 'UNREACHABLE' | 'FAILED';
  error: string | null;
  pagesCrawled: number;
  pagesAnalyzed: number;
  /** More pages were available than the comparison checks per site. */
  limitReached: boolean;
  /** The per-site time budget ended the crawl. */
  timeLimitReached: boolean;
  score: number | null;
  categoryScores: Record<AuditCategory, number> | null;
  rules: SeoSiteRule[];
  schemaTypes: string[];
  crawledAt: string;
}

export interface SeoMetricRow {
  key: string;
  /** Site key → value (null when it could not be measured). */
  values: Record<string, number | boolean | null>;
  /** Median of the competitors' values (share of true for yes/no checks). */
  competitorMedian: number | null;
  best: { siteKey: string; value: number | boolean } | null;
  status: SeoMetricStatus;
}

export type SeoSuggestionPriority = 1 | 2 | 3 | 4;

export interface SeoSuggestion {
  key: string;
  priority: SeoSuggestionPriority;
  category: RecommendationCategory;
  title: string;
  /** Evidence from your pages and the competitors' pages. */
  why: string;
  steps: string[];
  affectedPages: number;
  evidence: { urls: string[]; ruleId: string | null; metricKey: string | null; competitors: string[] };
  link: { label: string; path: string } | null;
}

export interface SeoComparisonResult {
  version: 1;
  maxPagesPerSite: number;
  sites: SeoSite[];
  metrics: SeoMetricRow[];
  summary: { compared: number; behind: number; ahead: number; even: number };
  suggestions: SeoSuggestion[];
  notes: string[];
  /** What this comparison cannot measure, stated plainly. */
  notCompared: string[];
}

export interface SeoComparisonDto {
  id: string;
  projectId: string;
  status: 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  errorMessage: string | null;
  jobId: string | null;
  competitorIds: string[];
  result: SeoComparisonResult | null;
}

export const SEO_COMPARISON_MAX_COMPETITORS = 5;
