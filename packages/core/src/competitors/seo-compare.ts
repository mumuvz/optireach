// SEO comparison: the project's site and up to five competitors are crawled the same way (same page budget,
// starting at the homepage, robots.txt respected) and checked with the same audit rules. Every number comes from
// those crawls; rankings, traffic and backlinks are not estimated. Suggestions are built by fixed rules from the
// differences, and each one states its evidence.
import {
  DEFAULT_CRAWL_SETTINGS,
  SEO_METRICS,
  getAuditRule,
  type AuditCategory,
  type IssueSeverity,
  type SeoComparisonResult,
  type SeoMetricDefinition,
  type SeoMetricRow,
  type SeoSite,
  type SeoSiteRule,
  type SeoSuggestion,
  type SeoSuggestionPriority,
} from '@surfaced/shared';
import { analyzeSite, type AnalysisResult } from '../audit/analyze';
import { dbPageToAnalysis, pageRecordToCreateData, type AnalysisInput } from '../audit/model';
import { crawlSite, type CrawledPageRecord, type SafeFetcher, type SafeFetcherOptions } from '../crawler';
import type { Prisma, PrismaClient } from '../db';
import { getEnv } from '../env';
import { errorMessage } from '../errors';
import { requireWebsite } from '../website';
import { categoryForAuditRule } from '../recommendations/benefit';
import { upsertEvidenceRecommendation } from '../recommendations/evidence';
import { inPool } from './pool';

/** Crawl time per site; a robots.txt Crawl-delay can make a full page budget take far longer. */
const SITE_TIME_BUDGET_MS = 4 * 60_000;

export interface SiteCrawlOutcome {
  status: SeoSite['status'];
  error: string | null;
  input: AnalysisInput | null;
  pagesCrawled: number;
  limitReached: boolean;
  timeLimitReached: boolean;
}

/** Crawls one site for a comparison. Replaceable in tests. */
export type SiteCrawler = (startUrl: string, options: { maxPages: number }) => Promise<SiteCrawlOutcome>;

export function createSiteCrawler(
  options: { fetcherOptions?: SafeFetcherOptions; fetcher?: SafeFetcher; timeBudgetMs?: number } = {},
): SiteCrawler {
  return async (startUrl, { maxPages }) => {
    const records: CrawledPageRecord[] = [];
    const deadline = Date.now() + (options.timeBudgetMs ?? SITE_TIME_BUDGET_MS);
    let timedOut = false;
    try {
      const summary = await crawlSite(
        {
          startUrl,
          maxPages,
          maxDepth: null,
          includeSubdomains: false,
          crawlDelayMs: DEFAULT_CRAWL_SETTINGS.crawlDelayMs,
          concurrency: 2,
          fetcher: options.fetcher,
          fetcherOptions: options.fetcherOptions,
        },
        {
          onPage: async (record) => void records.push(record),
          isCancelled: async () => (Date.now() > deadline ? (timedOut = true) : false),
        },
      );
      const fail = (status: SeoSite['status'], error: string): SiteCrawlOutcome => ({
        status,
        error,
        input: null,
        pagesCrawled: summary.pagesCrawled,
        limitReached: false,
        timeLimitReached: false,
      });
      if (summary.stoppedReason === 'robots_unreachable')
        return fail(
          'UNREACHABLE',
          'robots.txt could not be fetched, so crawlers must treat the site as off-limits.',
        );
      if (!records.length && (summary.robots.disallowAll || summary.blockedByRobotsTotal > 0))
        return fail(
          'BLOCKED_BY_ROBOTS',
          'robots.txt does not allow crawling this site, so it was not checked.',
        );
      if (!records.length) return fail('UNREACHABLE', 'No page of the site could be fetched.');
      const pages = records.map((record, i) =>
        dbPageToAnalysis(
          { id: `p${i}`, ...pageRecordToCreateData('comparison', record) } as unknown as Parameters<
            typeof dbPageToAnalysis
          >[0],
          record.internalLinks,
        ),
      );
      return {
        status: 'OK',
        error: null,
        input: { pages, crawl: summary },
        pagesCrawled: summary.pagesCrawled,
        limitReached: summary.limitReached,
        timeLimitReached: timedOut,
      };
    } catch (error) {
      return {
        status: 'FAILED',
        error: errorMessage(error).slice(0, 300),
        input: null,
        pagesCrawled: records.length,
        limitReached: false,
        timeLimitReached: false,
      };
    }
  };
}

// ---------------- Metrics ----------------

type MetricValues = Record<string, number | boolean | null>;

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** The comparison's checks for one crawled site (see SEO_METRICS for definitions). */
export function siteMetrics(input: AnalysisInput, result: AnalysisResult): MetricValues {
  const pages = input.pages;
  const analyzed = pages.filter((p) => p.analyzed);
  const n = analyzed.length;
  const share = (count: number, of = n) => (of ? count / of : null);
  const count = (predicate: (p: (typeof analyzed)[number]) => boolean) => analyzed.filter(predicate).length;
  const issuePages = (ruleId: string) =>
    new Set(result.issues.filter((i) => i.ruleId === ruleId && i.url).map((i) => i.url)).size;
  const titles = analyzed.map((p) => (p.title ?? '').trim().toLowerCase()).filter(Boolean);
  const titleCounts = new Map<string, number>();
  for (const t of titles) titleCounts.set(t, (titleCounts.get(t) ?? 0) + 1);
  const imagesTotal = analyzed.reduce((sum, p) => sum + p.imagesTotal, 0);
  const imagesMissingAlt = analyzed.reduce((sum, p) => sum + p.imagesMissingAlt, 0);
  const root = pages.find((p) => p.source === 'SEED');
  const length = (value: string | null, min: number, max: number) => {
    const l = (value ?? '').trim().length;
    return l >= min && l <= max;
  };
  return {
    healthScore: result.score.score,
    https: input.crawl.rootUrl.startsWith('https:'),
    sitemap: input.crawl.sitemap.found,
    indexablePct: share(count((p) => Boolean(result.indexability.get(p.url)?.indexable))),
    errorPagesPct: share(
      pages.filter(
        (p) =>
          (p.statusCode !== null && p.statusCode >= 400) ||
          (p.statusCode === null && Boolean(p.fetchError) && !['BLOCKED', 'DISALLOWED', 'CANCELLED'].includes(p.fetchErrorCode ?? '')),
      ).length,
      pages.length,
    ),
    brokenLinkPagesPct: share(issuePages('broken-internal-link')),
    redirectLinkPagesPct: share(issuePages('internal-link-to-redirect')),
    titlePct: share(titles.length),
    titleLengthPct: share(count((p) => length(p.title, 15, 60))),
    uniqueTitlePct: titles.length ? titles.filter((t) => titleCounts.get(t) === 1).length / titles.length : null,
    descriptionPct: share(count((p) => Boolean(p.metaDescription?.trim()))),
    descriptionLengthPct: share(count((p) => length(p.metaDescription, 50, 160))),
    canonicalPct: share(count((p) => p.canonicals.length > 0)),
    openGraphPct: share(count((p) => Boolean(p.ogTitle || p.ogDescription))),
    medianWords: median(analyzed.map((p) => p.wordCount)),
    thinPct: share(count((p) => p.wordCount < 200)),
    singleH1Pct: share(count((p) => p.h1Count === 1)),
    questionHeadingsPct: share(count((p) => p.questionHeadings > 0)),
    faqPct: share(count((p) => p.hasFaqContent)),
    duplicateContentPct: share(issuePages('duplicate-content')),
    langPct: share(count((p) => Boolean(p.lang))),
    structuredDataPct: share(count((p) => p.structuredDataTypes.length > 0)),
    structuredDataErrorsPct: share(count((p) => p.jsonLd.some((b) => Boolean(b.error) || b.requiredMissing.length > 0))),
    orgSchema: root?.analyzed ? !result.issues.some((i) => i.ruleId === 'organization-schema-missing') : null,
    altPct: imagesTotal ? 1 - imagesMissingAlt / imagesTotal : null,
    medianResponseMs: median(analyzed.map((p) => p.responseTimeMs).filter((v): v is number => v !== null)),
    compressedPct: share(count((p) => p.compressed)),
    viewportPct: share(count((p) => p.hasViewport)),
    mixedContentPct: share(count((p) => p.insecureResources.length > 0)),
    medianInternalLinks: median(analyzed.map((p) => new Set(p.internalLinks.map((l) => l.url)).size)),
    orphanPct: share(issuePages('orphan-page')),
    deepPct: share(count((p) => p.depth > 4)),
  }; // prettier-ignore
}

const SEVERITY_ORDER: IssueSeverity[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];

function siteRules(input: AnalysisInput, result: AnalysisResult): SeoSiteRule[] {
  const analyzed = input.pages.filter((p) => p.analyzed).length;
  const byRule = new Map<string, { severity: IssueSeverity; urls: Set<string>; site: boolean }>();
  for (const issue of result.issues) {
    const entry = byRule.get(issue.ruleId) ?? {
      severity: issue.severity,
      urls: new Set<string>(),
      site: !issue.url,
    };
    if (SEVERITY_ORDER.indexOf(issue.severity) < SEVERITY_ORDER.indexOf(entry.severity))
      entry.severity = issue.severity;
    if (issue.url) entry.urls.add(issue.url);
    byRule.set(issue.ruleId, entry);
  }
  return [...byRule.entries()]
    .map(([ruleId, entry]) => {
      const rule = getAuditRule(ruleId);
      const pages = entry.site ? 1 : entry.urls.size;
      return {
        ruleId,
        title: rule?.title ?? ruleId,
        category: (rule?.category ?? 'CRAWLABILITY') as AuditCategory,
        severity: entry.severity,
        scope: entry.site ? ('site' as const) : ('page' as const),
        pages,
        rate: entry.site || !analyzed ? null : pages / analyzed,
        sampleUrls: [...entry.urls].slice(0, 5),
      };
    })
    .sort(
      (a, b) =>
        SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) ||
        b.pages - a.pages ||
        a.ruleId.localeCompare(b.ruleId),
    );
}

// ---------------- Comparison ----------------

function tolerance(def: SeoMetricDefinition, reference: number): number {
  switch (def.unit) {
    case 'percent':
      return 0.05;
    case 'score':
      return 5;
    case 'words':
      return Math.max(50, 0.15 * reference);
    case 'count':
      return Math.max(2, 0.15 * reference);
    case 'ms':
      return Math.max(100, 0.2 * reference);
    default:
      return 0;
  }
}

/** Your value against the competitors' median, per check. */
export function compareMetrics(
  sites: { key: string; isYou: boolean; metrics: MetricValues | null }[],
): SeoMetricRow[] {
  const you = sites.find((s) => s.isYou);
  const competitors = sites.filter((s) => !s.isYou && s.metrics);
  return SEO_METRICS.map((def) => {
    const values = Object.fromEntries(sites.map((s) => [s.key, s.metrics?.[def.key] ?? null]));
    const yours = you?.metrics?.[def.key] ?? null;
    const theirs = competitors.map((s) => s.metrics![def.key]).filter((v) => v !== null && v !== undefined);
    let competitorMedian: number | null = null;
    if (theirs.length)
      competitorMedian =
        def.unit === 'boolean'
          ? theirs.filter((v) => v === true).length / theirs.length
          : median(theirs.map((v) => Number(v)));
    const known = sites.filter(
      (s) => s.metrics && s.metrics[def.key] !== null && s.metrics[def.key] !== undefined,
    );
    let best: SeoMetricRow['best'] = null;
    for (const s of known) {
      const v = s.metrics![def.key]!;
      const better =
        best === null ||
        (def.unit === 'boolean'
          ? v === true && best.value !== true
          : def.better === 'higher'
            ? Number(v) > Number(best.value)
            : Number(v) < Number(best.value));
      if (better) best = { siteKey: s.key, value: v };
    }
    let status: SeoMetricRow['status'] = 'unknown';
    if (yours !== null && competitorMedian !== null) {
      if (def.unit === 'boolean') {
        if (yours === true) status = competitorMedian < 0.5 ? 'ahead' : 'even';
        else status = competitorMedian >= 0.5 ? 'behind' : 'even';
      } else {
        const diff = Number(yours) - competitorMedian;
        const t = tolerance(def, competitorMedian);
        const signed = def.better === 'higher' ? diff : -diff;
        status = signed > t ? 'ahead' : signed < -t ? 'behind' : 'even';
      }
    }
    return { key: def.key, values, competitorMedian, best, status };
  });
}

// ---------------- Suggestions ----------------

const PRIORITY_BY_SEVERITY: Record<IssueSeverity, SeoSuggestionPriority> = {
  CRITICAL: 1,
  HIGH: 2,
  MEDIUM: 3,
  LOW: 4,
};

/** Structured data types worth comparing (types that describe content or the business). */
const USEFUL_SCHEMA_TYPES = new Set([
  'Organization', 'LocalBusiness', 'WebSite', 'Product', 'Offer', 'AggregateRating', 'Review', 'FAQPage',
  'BreadcrumbList', 'Article', 'BlogPosting', 'NewsArticle', 'HowTo', 'VideoObject', 'ItemList', 'SoftwareApplication',
  'Event', 'Service', 'ImageObject', 'CollectionPage', 'Store',
]); // prettier-ignore

function pct(value: number | null): string {
  return value === null ? '—' : `${Math.round(value * 100)}%`;
}

function list(items: string[], max = 5): string {
  const shown = items.slice(0, max);
  const rest = items.length - shown.length;
  if (rest > 0) return `${shown.join(', ')} and ${rest} more`;
  return shown.length <= 1 ? (shown[0] ?? '') : `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}`;
}

/** The prioritized list of what to improve, from your issues and the checks where you are behind. */
export function buildSeoSuggestions(
  sites: SeoSite[],
  rows: SeoMetricRow[],
  project: { name: string },
): SeoSuggestion[] {
  const you = sites.find((s) => s.isYou);
  if (!you) return [];
  if (you.status !== 'OK')
    return [
      {
        key: 'site-unreadable',
        priority: 1,
        category: 'TECHNICAL_SEO',
        title: 'Make your site readable for crawlers',
        why: `${project.name}’s site could not be checked: ${you.error ?? you.status}. Search engines and AI crawlers face the same problem.`,
        steps: [
          'Open your homepage and robots.txt from outside your network and fix the error.',
          'Allow crawlers to read your public pages in robots.txt.',
          'Run this comparison again.',
        ],
        affectedPages: 0,
        evidence: { urls: [you.startUrl], ruleId: null, metricKey: null, competitors: [] },
        link: null,
      },
    ];
  const competitors = sites.filter((s) => !s.isYou && s.status === 'OK');
  const names = competitors.map((c) => c.name);
  const suggestions: SeoSuggestion[] = [];

  // 1. Every audit rule your pages fail, with how the competitors fare on the same rule.
  for (const rule of you.rules) {
    const def = getAuditRule(rule.ruleId);
    const theirs = competitors.map((c) => {
      const r = c.rules.find((x) => x.ruleId === rule.ruleId);
      return { name: c.name, value: rule.scope === 'site' ? (r ? 1 : 0) : (r?.rate ?? 0) };
    });
    const yourValue = rule.scope === 'site' ? 1 : (rule.rate ?? 0);
    const competitorMedian = median(theirs.map((t) => t.value));
    let priority = PRIORITY_BY_SEVERITY[rule.severity];
    // Problems the competitors share at the same rate do not set you back against them.
    if (competitorMedian !== null && competitorMedian >= yourValue)
      priority = Math.min(4, priority + 1) as SeoSuggestionPriority;
    const comparison = theirs.length
      ? rule.scope === 'site'
        ? ` Competitors with the same problem: ${
            theirs
              .filter((t) => t.value)
              .map((t) => t.name)
              .join(', ') || 'none'
          }.`
        : ` Competitors: ${theirs.map((t) => `${t.name} ${pct(t.value)}`).join(', ')}.`
      : '';
    suggestions.push({
      key: `rule:${rule.ruleId}`,
      priority,
      category: categoryForAuditRule(rule.ruleId, rule.category),
      title: rule.scope === 'site' ? rule.title : `${rule.title} (${rule.pages} page${rule.pages === 1 ? '' : 's'})`,
      why: `${rule.scope === 'site' ? 'Your site has this problem.' : `${rule.pages} of ${you.pagesAnalyzed} pages checked (${pct(rule.rate)}).`}${comparison}${def ? ` ${def.impact}` : ''}`,
      steps: [
        def?.fix ?? 'See the issue details in the audit.',
        ...(rule.sampleUrls.length && rule.scope === 'page' ? [`Start with: ${list(rule.sampleUrls, 3)}.`] : []),
        'Run an audit to confirm the fix, then run this comparison again.',
      ],
      affectedPages: rule.pages,
      evidence: { urls: rule.sampleUrls, ruleId: rule.ruleId, metricKey: null, competitors: names },
      link: { label: 'Open issues', path: 'issues' },
    }); // prettier-ignore
  }

  // 2. Checks where you are behind that no single rule covers.
  const row = (key: string) => rows.find((r) => r.key === key);
  const behind = (key: string) => row(key)?.status === 'behind';
  const valuesText = (key: string, format: (v: number) => string) =>
    competitors
      .map((c) => {
        const v = row(key)?.values[c.key];
        return typeof v === 'number' ? `${c.name} ${format(v)}` : null;
      })
      .filter(Boolean)
      .join(', ');
  const yours = (key: string) => row(key)?.values[you.key];
  const words = (v: number) => `${Math.round(v)} words`;
  if (behind('medianWords'))
    suggestions.push({
      key: 'metric:medianWords',
      priority: 2,
      category: 'CONTENT',
      title: 'Give your key pages more depth',
      why: `A typical page of yours has ${words(Number(yours('medianWords')))}; the competitors’ median is ${words(row('medianWords')!.competitorMedian!)} (${valuesText('medianWords', words)}).`,
      steps: [
        'Expand your most important pages (home, product or feature, category and guide pages) with what people need to decide: what it is, who it is for, examples, prices, how it works and common questions.',
        'Write for readers. Do not pad pages with repeated keywords; length without substance does not help.',
        'Merge or noindex thin pages that cannot be made useful.',
      ],
      affectedPages: 0,
      evidence: { urls: [], ruleId: null, metricKey: 'medianWords', competitors: names },
      link: { label: 'Content Studio', path: 'content' },
    });
  if (behind('questionHeadingsPct') || behind('faqPct'))
    suggestions.push({
      key: 'metric:questions',
      priority: 3,
      category: 'AEO',
      title: 'Answer customers’ questions on your pages',
      why: `${pct(Number(yours('questionHeadingsPct')))} of your pages have question headings and ${pct(Number(yours('faqPct')))} have FAQ content; the competitors’ medians are ${pct(row('questionHeadingsPct')!.competitorMedian)} and ${pct(row('faqPct')!.competitorMedian)}.`,
      steps: [
        'Collect the questions customers really ask (support, sales calls, Search Console queries).',
        'Answer each one under a heading phrased as the question, with the answer in the first sentence.',
        'Mark up genuine FAQ sections with FAQPage structured data where it fits.',
      ],
      affectedPages: 0,
      evidence: { urls: [], ruleId: null, metricKey: 'questionHeadingsPct', competitors: names },
      link: { label: 'Content Studio', path: 'content' },
    });
  if (behind('medianInternalLinks'))
    suggestions.push({
      key: 'metric:medianInternalLinks',
      priority: 3,
      category: 'INTERNAL_LINKING',
      title: 'Link your pages to each other more',
      why: `A typical page of yours links to ${Math.round(Number(yours('medianInternalLinks')))} other pages; the competitors’ median is ${Math.round(row('medianInternalLinks')!.competitorMedian!)} (${valuesText('medianInternalLinks', (v) => `${Math.round(v)}`)}).`,
      steps: [
        'Link related pages from the body text with descriptive anchor text.',
        'Add “related” sections on product, category and article pages.',
        'Make sure every important page is reachable within a few clicks from the homepage.',
      ],
      affectedPages: 0,
      evidence: { urls: [], ruleId: null, metricKey: 'medianInternalLinks', competitors: names },
      link: null,
    });
  if (behind('medianResponseMs'))
    suggestions.push({
      key: 'metric:medianResponseMs',
      priority: 3,
      category: 'PERFORMANCE',
      title: 'Make your server answer faster',
      why: `Your pages took a median ${Math.round(Number(yours('medianResponseMs')))} ms to start answering; the competitors’ median is ${Math.round(row('medianResponseMs')!.competitorMedian!)} ms. Measured by the crawler; this is not Core Web Vitals.`,
      steps: [
        'Cache rendered pages (server or CDN) so they are not rebuilt on every request.',
        'Check slow database queries or third-party calls made while rendering.',
        'Use a hosting region close to your visitors.',
      ],
      affectedPages: 0,
      evidence: { urls: [], ruleId: null, metricKey: 'medianResponseMs', competitors: names },
      link: null,
    });

  // 3. Structured data types the competitors use and you do not.
  const yourTypes = new Set(you.schemaTypes);
  const missingTypes = new Map<string, string[]>();
  for (const c of competitors)
    for (const type of c.schemaTypes)
      if (USEFUL_SCHEMA_TYPES.has(type) && !yourTypes.has(type))
        missingTypes.set(type, [...(missingTypes.get(type) ?? []), c.name]);
  if (missingTypes.size)
    suggestions.push({
      key: 'metric:schemaTypes',
      priority: 3,
      category: 'STRUCTURED_DATA',
      title: 'Add the structured data types your competitors use',
      why: `Competitors use structured data types that your checked pages do not: ${list([...missingTypes.entries()].map(([type, by]) => `${type} (${by.join(', ')})`), 8)}.`,
      steps: [
        'Add only types that describe what is really on the page (for example Product with real prices, BreadcrumbList for navigation, FAQPage for genuine FAQs).',
        'Test each page with the Schema Markup Validator or Google’s Rich Results Test.',
        'Structured data helps machines read pages; Google decides whether to show rich results.',
      ],
      affectedPages: 0,
      evidence: { urls: [], ruleId: null, metricKey: 'structuredDataPct', competitors: [...new Set([...missingTypes.values()].flat())] },
      link: null,
    }); // prettier-ignore

  return suggestions.sort(
    (a, b) => a.priority - b.priority || b.affectedPages - a.affectedPages || a.key.localeCompare(b.key),
  );
}

export const NOT_COMPARED = [
  'Keyword rankings and search traffic: Search Console shows them for your own site only, and competitor positions need a licensed rank-tracking provider. Nothing is estimated.',
  'Backlinks and domain authority: these need a licensed backlink index, so they are not compared.',
  'Core Web Vitals: real-user speed data needs the PageSpeed Insights or CrUX API. The response time shown is measured by the crawler.',
  'Content quality and accuracy: the checks measure structure and coverage, not whether the content is good.',
];

// ---------------- Job ----------------

export interface SeoComparisonOptions {
  fetcherOptions?: SafeFetcherOptions;
  /** Replaces the network crawl (tests). */
  crawler?: SiteCrawler;
  maxPagesPerSite?: number;
  /** Start URL of a competitor (tests); defaults to https://<domain>/. */
  competitorStartUrl?: (competitor: { id: string; domain: string }) => string;
  onProgress?: (percent: number, message: string) => Promise<void>;
}

export async function executeSeoComparison(
  prisma: PrismaClient,
  comparisonId: string,
  options: SeoComparisonOptions = {},
): Promise<{ sites: number; suggestions: number }> {
  const comparison = await prisma.seoComparison.findUniqueOrThrow({
    where: { id: comparisonId },
    include: { project: { include: { competitors: true } } },
  });
  await prisma.seoComparison.update({
    where: { id: comparisonId },
    data: { status: 'RUNNING', startedAt: comparison.startedAt ?? new Date(), errorMessage: null },
  });
  const project = requireWebsite(comparison.project, 'SEO comparison');
  const ids = Array.isArray(comparison.competitorIds) ? (comparison.competitorIds as string[]) : [];
  // Only competitors with a website can be crawled.
  const competitors = ids
    .map((id) => project.competitors.find((c) => c.id === id))
    .filter((c): c is NonNullable<typeof c> & { domain: string } => Boolean(c?.domain));
  const targets = [
    { key: 'you', name: project.name, domain: project.domain, isYou: true, competitorId: null, startUrl: project.websiteUrl },
    ...competitors.map((c) => ({
      key: c.id,
      name: c.name,
      domain: c.domain,
      isYou: false,
      competitorId: c.id,
      startUrl: options.competitorStartUrl?.(c) ?? `https://${c.domain}/`,
    })),
  ]; // prettier-ignore
  const maxPages = options.maxPagesPerSite ?? getEnv().COMPETITOR_CRAWL_MAX_PAGES;
  const crawler = options.crawler ?? createSiteCrawler({ fetcherOptions: options.fetcherOptions });
  const progress = options.onProgress ?? (async () => {});
  await progress(5, `Checking ${targets.length} sites, up to ${maxPages} pages each`);
  let done = 0;
  const checked = await inPool(targets, 3, async (target) => {
    const outcome = await crawler(target.startUrl, { maxPages });
    done += 1;
    await progress(
      5 + Math.round((85 * done) / targets.length),
      `Checked ${done} of ${targets.length} sites`,
    );
    const base = {
      ...target,
      status: outcome.status,
      error: outcome.error,
      pagesCrawled: outcome.pagesCrawled,
      limitReached: outcome.limitReached,
      timeLimitReached: outcome.timeLimitReached,
      crawledAt: new Date().toISOString(),
    };
    if (!outcome.input)
      return {
        site: {
          ...base,
          pagesAnalyzed: 0,
          score: null,
          categoryScores: null,
          rules: [],
          schemaTypes: [],
        } as SeoSite,
        metrics: null,
      };
    const result = analyzeSite(outcome.input);
    const analyzed = outcome.input.pages.filter((p) => p.analyzed);
    const site: SeoSite = {
      ...base,
      pagesAnalyzed: analyzed.length,
      score: result.score.score,
      categoryScores: result.score.categoryScores,
      rules: siteRules(outcome.input, result),
      schemaTypes: [...new Set(analyzed.flatMap((p) => p.structuredDataTypes))].sort(),
    };
    return { site, metrics: siteMetrics(outcome.input, result) };
  });
  const sites = checked.map((c) => c.site);
  const metrics = compareMetrics(
    checked.map((c) => ({ key: c.site.key, isYou: c.site.isYou, metrics: c.metrics })),
  );
  const suggestions = buildSeoSuggestions(sites, metrics, { name: project.name });
  const counted = metrics.filter((m) => m.status !== 'unknown');
  const notes = [
    `Every site was checked the same way: up to ${maxPages} pages starting at its homepage (linked pages first, then sitemap URLs), robots.txt respected, the same audit rules. Percentages compare like with like; your full audit covers every page of your site.`,
  ];
  for (const s of sites) {
    if (s.status !== 'OK') notes.push(`${s.name} could not be checked: ${s.error ?? s.status}`);
    else if (s.timeLimitReached)
      notes.push(`${s.name}: the time limit ended the crawl after ${s.pagesCrawled} pages (its robots.txt may ask for a slow crawl rate).`);
  } // prettier-ignore
  if (!competitors.length)
    notes.push('No competitors were included. Track competitors to compare against them.');
  const result: SeoComparisonResult = {
    version: 1,
    maxPagesPerSite: maxPages,
    sites,
    metrics,
    summary: {
      compared: counted.length,
      behind: counted.filter((m) => m.status === 'behind').length,
      ahead: counted.filter((m) => m.status === 'ahead').length,
      even: counted.filter((m) => m.status === 'even').length,
    },
    suggestions,
    notes,
    notCompared: NOT_COMPARED,
  };
  await prisma.seoComparison.update({
    where: { id: comparisonId },
    data: { status: 'SUCCEEDED', result: result as unknown as Prisma.InputJsonValue, finishedAt: new Date() },
  });
  return { sites: sites.length, suggestions: suggestions.length };
}

/** Saves one suggestion of a comparison as a recommendation (idempotent per suggestion). */
export function saveSeoSuggestionAsRecommendation(
  prisma: PrismaClient,
  projectId: string,
  comparisonId: string,
  suggestion: SeoSuggestion,
): Promise<{ id: string; created: boolean }> {
  return upsertEvidenceRecommendation(prisma, projectId, {
    fingerprintKey: `seo|${suggestion.key}`,
    source: 'COMPETITOR',
    title: suggestion.title,
    category: suggestion.category,
    priority: suggestion.priority,
    relatedUrl: suggestion.evidence.urls[0] ?? null,
    evidence: {
      seoComparisonId: comparisonId,
      suggestionKey: suggestion.key,
      why: suggestion.why,
      ...suggestion.evidence,
    },
    steps: suggestion.steps,
  });
}
