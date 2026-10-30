// Keyword trends: Google Trends data from one configured provider (pytrends, DataForSEO, the official API alpha, a
// CSV export or a labeled development fixture) compared with the words on the project's crawled pages, the project's
// own Search Console figures for the same queries, and AI suggestions of where to use the terms the site misses.
// Trends values are relative interest (100 = peak within one comparison), never search volumes. Providers are never
// mixed, and a provider that fails is reported as failed: no data is ever made up.
import {
  TREND_SOURCE_LABELS,
  countryName,
  trendDirection,
  trendRegionName,
  trendSourceType,
  type TrendAnalysisResult,
  type TrendData,
  type TrendDataType,
  type TrendPlacement,
  type TrendSource,
  type TrendTerm,
  type TrendTimeRange,
} from '@surfaced/shared';
import { z } from 'zod';
import { getLlmProvider, type LlmProvider } from '../ai';
import { contentWords } from '../competitors/gap';
import { recordProviderUsage } from '../costs';
import type { Prisma, PrismaClient } from '../db';
import { errorMessage } from '../errors';
import { upsertEvidenceRecommendation } from '../recommendations/evidence';
import { loadSitePages, termCoverage, type PageWords } from './matching';
import {
  TREND_PROVIDER_SETTING_NAMES,
  TrendProviderError,
  getTrendsProvider,
  isTrendSourceEnabled,
  type DataForSeoCredentials,
  type TrendFetchResult,
  type TrendsFetch,
} from './providers';
import { searchConsoleQueryMetrics, searchConsoleStatus } from './signals';
import { loadTrendData, recordTrendProviderEvents, saveTrendData, trendCacheHours } from './store';

export * from './providers';
export * from './requests';
export { googleTrendsCategories, type GoogleTrendsCategories } from './categories';
export { containsPhrase, loadSitePages, matchTerm, termCoverage, type PageWords } from './matching';
export { searchConsoleQueryMetrics, searchConsoleStatus } from './signals';
export {
  copyTrendData,
  hasTrendData,
  loadTrendData,
  periodDate,
  recordTrendProviderEvents,
  saveTrendData,
  trendCacheHours,
  trendCacheKey,
} from './store';

// ---------------- Comparison with the site ----------------

const MAX_TERMS = 40;
const MAX_PLACEMENT_TERMS = 15;
const CANDIDATE_PAGES = 8;

type BaseTerm = Pick<TrendTerm, 'term' | 'origin' | 'interest' | 'rising' | 'direction'>;

const FILLER = new Set(['a', 'an', 'the', 'for', 'of', 'in', 'on', 'with', 'and', 'to']);

/**
 * Same search: the same words in any order, ignoring filler words and plurals ("invitations for weddings" =
 * "wedding invitation"). Modifiers such as "best", "free" or "how to make" stay: they are different searches.
 */
export function trendTermKey(term: string): string {
  return term
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w && !FILLER.has(w))
    .map((w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w))
    .sort()
    .join(' ');
}

function collectTerms(keywords: string[], data: TrendData): BaseTerm[] {
  const terms = new Map<string, BaseTerm>();
  const add = (
    term: string,
    origin: TrendTerm['origin'],
    interest: number | null,
    rising: string | null,
    direction: TrendTerm['direction'] = null,
  ) => {
    // prettier-ignore
    const key = trendTermKey(term);
    if (!key || terms.has(key)) return;
    terms.set(key, { term: term.trim(), origin, interest, rising, direction });
  };
  const interest = data.interest;
  const series = new Map(interest?.series.map((s) => [s.keyword.toLowerCase(), s]) ?? []);
  const directionOf = (keyword: string) => {
    const s = series.get(keyword.toLowerCase());
    return s ? trendDirection(s.values, interest?.partial) : null;
  };
  for (const keyword of keywords)
    add(keyword, 'keyword', series.get(keyword.toLowerCase())?.average ?? null, null, directionOf(keyword));
  for (const s of interest?.series ?? []) add(s.keyword, 'keyword', s.average, null, directionOf(s.keyword));
  for (const group of data.related) {
    for (const q of group.top.slice(0, 10)) add(q.query, 'top_query', q.value, null);
    for (const q of group.rising.slice(0, 10)) add(q.query, 'rising_query', null, q.value);
  }
  return [...terms.values()].slice(0, MAX_TERMS);
}

const placementSchema = z.object({
  placements: z.array(
    z.object({
      term: z.string(),
      action: z.enum(['add_to_page', 'new_page']),
      pageUrl: z.string().nullable(),
      section: z.string().nullable(),
      newSection: z.string().nullable(),
      spot: z.enum(['title', 'h1', 'heading', 'body', 'meta_description', 'faq']),
      suggestedText: z.string(),
      reason: z.string(),
    }),
  ),
});

const PLACEMENT_SYSTEM = `You are an SEO editor. For each search term, choose where on the business's website it fits best.
Rules:
- Use only the candidate pages listed for that term. "pageUrl" must be copied exactly from them, or null with action "new_page" when none fits.
- "section" must be copied exactly from that page's headings, or null. Use "newSection" for a new heading when no existing section fits.
- "spot" is where the term goes: title, h1, heading, body, meta_description or faq.
- "suggestedText" is one natural sentence, heading or title (at most 160 characters) that uses the term. Never state facts about the business that are not given (prices, features, awards, numbers). Use [placeholders] for facts the owner must fill in.
- "reason" says in one sentence why this page and spot fit the term.
- Do not stuff keywords: one natural use is enough.
Return one placement per term.`;

export async function analyzeTrends(
  prisma: PrismaClient,
  projectId: string,
  keywords: string[],
  data: TrendData,
  options: {
    llm?: LlmProvider | null;
    usageKey: string;
    backgroundJobId?: string;
    suggestPlacements?: boolean;
  },
): Promise<TrendAnalysisResult> {
  const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
  const notes: string[] = [];
  const { crawl, pages } = await loadSitePages(prisma, projectId);
  if (!crawl)
    notes.push(
      'There is no completed audit yet, so the site could not be checked. Run an audit, then run this again.',
    );
  else
    notes.push(
      'Checked each page’s address, title, main heading, sub-headings and meta description: the places search engines and AI systems weigh most. Words used only in body text are not counted.',
    );

  const base = collectTerms(keywords, data);
  const gsc = await searchConsoleQueryMetrics(
    prisma,
    projectId,
    base.map((t) => t.term),
  );
  const gscStatus = await searchConsoleStatus(prisma, projectId);
  const terms: TrendTerm[] = base.map((t) => ({
    ...t,
    ...(pages.length
      ? termCoverage(t.term, pages)
      : { status: 'missing' as const, matchedWords: [], missingWords: contentWords(t.term), pages: [] }),
    searchConsole: gsc.byQuery.get(t.term.toLowerCase()) ?? null,
  }));
  if (gsc.range)
    notes.push(
      `Search Console figures are your own measured clicks and impressions (${gsc.range.start} to ${gsc.range.end}), shown next to Google Trends interest but never combined with it.`,
    );
  else if (gscStatus.connected)
    notes.push(
      'Search Console is connected but has no query data yet; sync it to see clicks and impressions here.',
    );

  // Where to use the missing terms (AI suggestions, checked against the crawl).
  let placements: TrendPlacement[] = [];
  let placementModel: string | null = null;
  const targets = terms
    .filter((t) => t.status !== 'present')
    .sort((a, b) => (b.interest ?? (b.rising ? 50 : 0)) - (a.interest ?? (a.rising ? 50 : 0)))
    .slice(0, MAX_PLACEMENT_TERMS);
  if (options.suggestPlacements === false) {
    if (targets.length) notes.push('AI placement suggestions were not requested for this report.');
  } else {
    const llm = options.llm === undefined ? getLlmProvider() : options.llm;
    if (targets.length && pages.length && llm && !llm.isDevAdapter) {
      const result = await suggestPlacements(prisma, project, targets, pages, llm, options);
      placements = result.placements;
      placementModel = result.model;
      notes.push(...result.notes);
    } else if (targets.length && pages.length) {
      notes.push(
        'No AI provider is configured, so there are no placement suggestions. Missing terms are still listed.',
      );
    }
  }

  return {
    version: 1,
    terms,
    placements,
    method: {
      pagesChecked: pages.length,
      crawlFinishedAt: crawl?.finishedAt?.toISOString() ?? null,
      placementModel,
      searchConsole: { connected: gscStatus.connected, rangeStart: gsc.range?.start ?? null, rangeEnd: gsc.range?.end ?? null }, // prettier-ignore
    },
    notes,
  };
}

async function suggestPlacements(
  prisma: PrismaClient,
  project: { id: string; name: string; domain: string | null; industry: string | null; description: string | null; workspaceId: string }, // prettier-ignore
  targets: TrendTerm[],
  pages: PageWords[],
  llm: LlmProvider,
  options: { usageKey: string; backgroundJobId?: string },
): Promise<{ placements: TrendPlacement[]; model: string | null; notes: string[] }> {
  const candidatesFor = (term: string) => {
    const words = contentWords(term);
    return pages
      .map((p) => ({
        page: p,
        score: words.filter((w) => p.fields.title.has(w) || p.fields.h1.has(w) || p.fields.heading.has(w) || p.fields.address.has(w)).length, // prettier-ignore
      }))
      .sort((a, b) => b.score - a.score || a.page.url.length - b.page.url.length)
      .slice(0, CANDIDATE_PAGES)
      .map((c) => c.page);
  };
  const candidates = new Map(targets.map((t) => [t.term, candidatesFor(t.term)]));
  const user = [
    `Business: ${project.name}${project.domain ? ` (${project.domain})` : ''}${project.industry ? `, industry: ${project.industry}` : ''}.`,
    project.description ? `About: ${project.description.slice(0, 500)}` : '',
    ...targets.map((t) =>
      [
        `Term: ${t.term}`,
        'Candidate pages:',
        ...candidates
          .get(t.term)!
          .map((p) => `- ${p.url} | title: ${p.title ?? '(none)'} | h1: ${p.h1 ?? '(none)'} | headings: ${p.headings.slice(0, 12).join(' / ') || '(none)'}`), // prettier-ignore
      ].join('\n'),
    ),
  ]
    .filter(Boolean)
    .join('\n\n');
  try {
    const result = await llm.generateJson({
      schema: placementSchema,
      schemaName: 'keyword_placements',
      system: PLACEMENT_SYSTEM,
      user,
      maxOutputTokens: 5000,
    });
    await recordProviderUsage(prisma, {
      workspaceId: project.workspaceId,
      projectId: project.id,
      provider: result.provider,
      operation: 'trend_placement',
      model: result.model,
      inputTokens: result.usage?.inputTokens ?? null,
      outputTokens: result.usage?.outputTokens ?? null,
      backgroundJobId: options.backgroundJobId,
      idempotencyKey: `${options.usageKey}:placement`,
    });
    const placements = validatePlacements(result.data.placements, targets, candidates);
    const dropped = result.data.placements.length - placements.length;
    return {
      placements,
      model: result.model,
      notes:
        dropped > 0
          ? [
              `${dropped} AI suggestion(s) were dropped because they named a page or section that is not on your site.`,
            ]
          : [],
    };
  } catch (error) {
    return { placements: [], model: null, notes: [`AI placement suggestions failed: ${errorMessage(error).slice(0, 200)}`] }; // prettier-ignore
  }
}

/**
 * Keeps suggestions that name a candidate page and one of its real headings, and whose text uses the term.
 * A suggestion for a page that does not exist is dropped rather than shown.
 */
export function validatePlacements(
  raw: z.infer<typeof placementSchema>['placements'],
  targets: { term: string }[],
  candidates: Map<string, { url: string; title: string | null; headings: string[] }[]>,
): TrendPlacement[] {
  const out: TrendPlacement[] = [];
  const done = new Set<string>();
  for (const p of raw) {
    const target = targets.find((t) => t.term.toLowerCase() === p.term.trim().toLowerCase());
    if (!target || done.has(target.term)) continue;
    const pages = candidates.get(target.term) ?? [];
    const page = p.pageUrl ? pages.find((c) => c.url === p.pageUrl!.trim()) : undefined;
    if (p.action === 'add_to_page' && !page) continue;
    const section = page && p.section ? (page.headings.find((h) => h.toLowerCase() === p.section!.trim().toLowerCase()) ?? null) : null; // prettier-ignore
    const text = p.suggestedText.replace(/\s+/g, ' ').trim().slice(0, 200);
    const words = contentWords(target.term);
    const used = contentWords(text);
    if (!text || words.filter((w) => used.includes(w)).length * 2 < words.length) continue;
    done.add(target.term);
    out.push({
      term: target.term,
      action: page ? 'add_to_page' : 'new_page',
      pageUrl: page?.url ?? null,
      pageTitle: page?.title ?? null,
      section,
      newSection: p.newSection?.trim().slice(0, 120) || null,
      spot: p.spot,
      suggestedText: text,
      reason: p.reason.replace(/\s+/g, ' ').trim().slice(0, 240),
    });
  }
  return out;
}

// ---------------- Job ----------------

/** What every report from a source should say about its values, in addition to what went missing. */
export function trendSourceLimitations(
  source: TrendSource,
  data: TrendData | null,
  place: { country: string | null; region: string | null; city?: string | null } = {
    country: null,
    region: null,
  },
): string[] {
  const notes = [
    source === 'GOOGLE_TRENDS_API'
      ? 'Values are Google’s scaled interest from the official API, not search counts.'
      : 'Values are relative interest from 0 to 100, scaled within this comparison only: they are not search counts, and they cannot be compared with another comparison’s numbers.',
  ];
  if (source === 'PYTRENDS')
    notes.push('Retrieved with pytrends, an unofficial library that reads Google Trends’ website endpoints; Google may change or block them at any time.'); // prettier-ignore
  if (source === 'CSV_IMPORT')
    notes.push('Imported from files: they are shown as uploaded, so check they are unchanged Google Trends downloads.'); // prettier-ignore
  if (source === 'FIXTURE')
    notes.push('Development fixture: generated sample data, not real Google Trends data.');
  if (place.city)
    notes.push(`City filter: these are searches that mention “${place.city}”, measured across ${describeTrendPlace(place.country, place.region)}, not every search made in ${place.city}. Google Trends cannot narrow a comparison to one city.`); // prettier-ignore
  if (data?.regions?.comparison === 'share')
    notes.push('Interest by region with several terms shows how each place’s searches split between the terms (they add up to 100): compare terms within a place, not places with each other.'); // prettier-ignore
  return notes;
}

export function describeTrendPlace(
  country: string | null,
  region: string | null,
  city?: string | null,
): string {
  if (city) return `searches mentioning ${city} in ${describeTrendPlace(country, region)}`;
  if (region) return `${trendRegionName(region)}, ${countryName(region.slice(0, 2))}`;
  return country ? countryName(country) : 'Worldwide';
}

export async function executeTrendReport(
  prisma: PrismaClient,
  reportId: string,
  options: {
    fetchImpl?: TrendsFetch;
    credentials?: DataForSeoCredentials | null;
    llm?: LlmProvider | null;
    backgroundJobId?: string;
  } = {},
): Promise<{ terms: number; placements: number; partial: boolean }> {
  const report = await prisma.trendReport.findUniqueOrThrow({
    where: { id: reportId },
    include: { project: true },
  });
  await prisma.trendReport.update({
    where: { id: reportId },
    data: { status: 'RUNNING', startedAt: report.startedAt ?? new Date(), errorMessage: null },
  });
  const keywords = Array.isArray(report.keywords) ? (report.keywords as string[]) : [];
  const source = report.source as TrendSource;
  const include = (Array.isArray(report.include) ? report.include : ['interest', 'related_queries']) as TrendDataType[]; // prettier-ignore
  let data = await loadTrendData(prisma, report);
  let partial = report.partial;
  const usageKey = `trends:${reportId}:${Date.now()}`;
  const events = { workspaceId: report.project.workspaceId, projectId: report.projectId, reportId };
  if (!data && trendSourceType(source) !== 'CSV') {
    const provider = getTrendsProvider(source);
    if (!isTrendSourceEnabled(source))
      throw new TrendProviderError(source, 'NOT_CONFIGURED', `${TREND_SOURCE_LABELS[source]} is turned off on this server.`); // prettier-ignore
    // Each provider refuses itself when it is not configured; one without fetch() is not implemented.
    if (!provider.fetch) throw new TrendProviderError(source, 'UNAVAILABLE', provider.configured().detail);
    let result: TrendFetchResult;
    try {
      result = await provider.fetch(
        {
          keywords,
          country: report.country,
          region: report.region,
          timeRange: report.timeRange as TrendTimeRange,
          category: report.category,
          language: report.language,
          include,
        },
        { fetchImpl: options.fetchImpl, credentials: options.credentials },
      );
    } catch (error) {
      if (error instanceof TrendProviderError)
        await recordTrendProviderEvents(prisma, source, error.operations.length ? error.operations : [{ operation: 'fetch', outcome: error.code, message: error.message, durationMs: 0 }], events); // prettier-ignore
      throw error;
    }
    await recordTrendProviderEvents(prisma, source, result.operations, events);
    const fetchedAt = new Date();
    const hours = trendCacheHours(source, include);
    await prisma.$transaction(
      async (tx) => {
        await saveTrendData(tx, reportId, result.data);
        await tx.trendReport.update({
          where: { id: reportId },
          data: {
            fetchedAt,
            expiresAt: new Date(fetchedAt.getTime() + hours * 3600 * 1000),
            partial: result.partial,
            limitations: result.limitations,
          },
        });
      },
      { timeout: 60_000 },
    );
    if (result.requests)
      await recordProviderUsage(prisma, {
        workspaceId: report.project.workspaceId,
        projectId: report.projectId,
        provider: TREND_PROVIDER_SETTING_NAMES[source],
        operation: 'trends_explore',
        requests: result.requests,
        backgroundJobId: options.backgroundJobId,
        idempotencyKey: `${usageKey}:fetch`,
      });
    data = result.data;
    partial = result.partial;
  }
  if (!data) throw new Error('This report has no trends data.');
  const analysis = await analyzeTrends(prisma, report.projectId, keywords, data, {
    llm: options.llm,
    usageKey,
    backgroundJobId: options.backgroundJobId,
    suggestPlacements: report.suggestPlacements,
  });
  await prisma.trendReport.update({
    where: { id: reportId },
    data: {
      status: 'SUCCEEDED',
      analysis: analysis as unknown as Prisma.InputJsonValue,
      finishedAt: new Date(),
    },
  });
  if (report.savedQueryId)
    await prisma.trendSavedQuery.updateMany({
      where: { id: report.savedQueryId },
      data: { lastReportId: reportId },
    });
  return { terms: analysis.terms.length, placements: analysis.placements.length, partial };
}

/** Saves one placement suggestion as a recommendation (idempotent per term). */
export function saveTrendPlacementAsRecommendation(
  prisma: PrismaClient,
  projectId: string,
  reportId: string,
  placement: TrendPlacement,
  term: TrendTerm | undefined,
): Promise<{ id: string; created: boolean }> {
  const where = placement.pageUrl
    ? `${placement.pageUrl}${placement.section ? ` (section “${placement.section}”)` : ''}`
    : 'a new page';
  return upsertEvidenceRecommendation(prisma, projectId, {
    fingerprintKey: `trends|${placement.term.toLowerCase()}`,
    source: 'SEARCH_TRENDS',
    title: `Use the search term “${placement.term}” on ${placement.pageUrl ? 'your site' : 'a new page'}`,
    category: 'CONTENT',
    priority: term?.origin === 'rising_query' || (term?.interest ?? 0) >= 50 ? 2 : 3,
    relatedUrl: placement.pageUrl,
    evidence: { trendReportId: reportId, term: placement.term, interest: term?.interest ?? null, rising: term?.rising ?? null, reason: placement.reason }, // prettier-ignore
    steps: [
      `Add it to ${where} as ${placement.spot.replace('_', ' ')}${placement.newSection ? ` under a new heading “${placement.newSection}”` : ''}.`, // prettier-ignore
      `Suggested wording (AI-written; check every claim): ${placement.suggestedText}`,
      'Use the term once, naturally; do not repeat it to stuff keywords.',
      'Run an audit afterwards so the next trends report sees the change.',
    ],
  });
}

export { googleTrendsExploreUrl } from '@surfaced/shared';
