// Keyword opportunity scores: which of the project's keywords to work on first, from the signals that exist for each
// one. Every component says where its value comes from; signals without data are listed as missing and left out of
// the score instead of being guessed. Google Trends interest, Search Console figures and provider metrics are scored
// separately and never converted into one another.
import {
  OPPORTUNITY_ACTION_LABELS,
  OPPORTUNITY_COMPONENTS,
  TREND_SOURCE_LABELS,
  trendDirection,
  type KeywordOpportunitiesDto,
  type KeywordOpportunityDto,
  type OpportunityAction,
  type OpportunityComponent,
  type OpportunityComponentKey,
  type SearchConsoleQueryMetrics,
  type TrendData,
  type TrendSource,
} from '@surfaced/shared';
import type { PrismaClient } from '../db';
import { loadSitePages, termCoverage, type PageWords } from '../trends/matching';
import { searchConsoleQueryMetrics } from '../trends/signals';
import { loadTrendData } from '../trends/store';

const MAX: Record<OpportunityComponentKey, number> = Object.fromEntries(
  OPPORTUNITY_COMPONENTS.map((c) => [c.key, c.maxPoints]),
) as Record<OpportunityComponentKey, number>;
const LABEL: Record<OpportunityComponentKey, string> = Object.fromEntries(
  OPPORTUNITY_COMPONENTS.map((c) => [c.key, c.label]),
) as Record<OpportunityComponentKey, string>;

const fmt = (n: number) => n.toLocaleString('en-US');
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

function component(
  key: OpportunityComponentKey,
  available: boolean,
  points: number,
  value: string | null,
  source: string | null,
  explanation: string,
): OpportunityComponent {
  const maxPoints = MAX[key];
  return { key, label: LABEL[key], available, points: available ? Math.max(0, Math.min(maxPoints, Math.round(points))) : 0, maxPoints, value, source, explanation }; // prettier-ignore
}

/** One trends report's signal for a phrase: as a compared term, a rising or a top related query. */
export interface TrendSignal {
  kind: 'compared' | 'rising_query' | 'top_query';
  direction?: ReturnType<typeof trendDirection>;
  average?: number | null;
  growth?: string;
  popularity?: number;
  source: TrendSource;
  fetchedAt: Date | null;
  place: string;
}

export function trendSignalFor(
  phrase: string,
  data: TrendData,
  meta: Pick<TrendSignal, 'source' | 'fetchedAt' | 'place'>,
): TrendSignal | null {
  // prettier-ignore
  const p = phrase.trim().toLowerCase();
  const series = data.interest?.series.find((s) => s.keyword.trim().toLowerCase() === p);
  if (series)
    return { ...meta, kind: 'compared', direction: trendDirection(series.values, data.interest?.partial), average: series.average }; // prettier-ignore
  for (const group of data.related) {
    const rising = group.rising.find((q) => q.query.trim().toLowerCase() === p);
    if (rising) return { ...meta, kind: 'rising_query', growth: rising.value };
  }
  for (const group of data.related) {
    const top = group.top.find((q) => q.query.trim().toLowerCase() === p);
    if (top) return { ...meta, kind: 'top_query', popularity: top.value };
  }
  return null;
}

function trendComponent(signal: TrendSignal | null): OpportunityComponent {
  if (!signal)
    return component('trend', false, 0, null, null, 'Not in any Google Trends comparison yet. Add it to a Keyword trends comparison to see its direction.'); // prettier-ignore
  const source = `${TREND_SOURCE_LABELS[signal.source]}, ${signal.place}${signal.fetchedAt ? `, ${signal.fetchedAt.toISOString().slice(0, 10)}` : ''}`; // prettier-ignore
  if (signal.kind === 'rising_query') {
    const growth = signal.growth ?? '';
    const n = Number(growth.replace(/[^\d.]/g, ''));
    const points = /breakout/i.test(growth) ? 20 : Number.isFinite(n) ? 10 + n / 50 : 10;
    return component('trend', true, points, `Rising related search (${growth})`, source, 'Searches for it are growing fast, relative to its own past.'); // prettier-ignore
  }
  if (signal.kind === 'top_query') {
    const v = signal.popularity ?? 0;
    return component('trend', true, (v / 100) * 14, `Top related search (${v}/100)`, source, 'A popular related search; its direction over time is not known from this list.'); // prettier-ignore
  }
  const avg = signal.average ?? 0;
  const map = { rising: [20, 'Interest is rising over the period.'], stable: [avg >= 20 ? 12 : 8, 'Interest is steady over the period.'], falling: [4, 'Interest is falling over the period.'], no_data: [0, 'Google Trends shows no measurable interest for it.'] } as const; // prettier-ignore
  const [points, text] = map[signal.direction ?? 'no_data'];
  return component('trend', true, points, `${signal.direction === 'no_data' ? 'No measurable interest' : `${signal.direction}, average ${avg}/100`}`, source, `${text} Values are relative interest, not search counts.`); // prettier-ignore
}

function searchConsoleComponent(
  metrics: SearchConsoleQueryMetrics | null,
  range: { start: string; end: string } | null,
): OpportunityComponent {
  // prettier-ignore
  if (!range)
    return component('search_console', false, 0, null, null, 'Search Console is not connected (or not synced), so your own impressions and clicks are unknown.'); // prettier-ignore
  const source = `Google Search Console, ${range.start} to ${range.end}`;
  if (!metrics)
    return component('search_console', true, 0, 'No impressions', source, 'Google did not show your site for this exact query in this period.'); // prettier-ignore
  const demand = Math.min(15, (15 * Math.log10(1 + metrics.impressions)) / 4);
  let upside = 0;
  let why = '';
  if (metrics.position > 3 && metrics.position <= 20) {
    upside = 10;
    why = ` Average position ${metrics.position}: within reach of the top results.`;
  } else if (metrics.position <= 3 && metrics.impressions >= 100 && metrics.ctr < 0.02) {
    upside = 6;
    why = ' It ranks well but few people click: the title and description can do better.';
  } else if (metrics.position > 20) {
    upside = 3;
    why = ` Average position ${metrics.position}: the page needs to be much stronger to compete.`;
  }
  return component('search_console', true, demand + upside, `${fmt(metrics.impressions)} impressions, ${fmt(metrics.clicks)} clicks, CTR ${pct(metrics.ctr)}, position ${metrics.position}`, source, `Measured demand on your own site.${why}`); // prettier-ignore
}

export interface OpportunityKeyword {
  id: string;
  phrase: string;
  intent: string | null;
  priority: 'HIGH' | 'MEDIUM' | 'LOW';
  isPrimary: boolean;
  targetUrl: string | null;
  relatedQuestions: string[];
  searchVolume: number | null;
  difficulty: number | null;
  metricsSource: string | null;
}

const QUESTION = /^(how|what|why|when|where|which|who|can|is|are|does|do|should|will)\b/;
const LOCAL = /\b(near me|nearby|local)\b/;
const COMPARATIVE = /\b(best|top|vs|versus|alternatives?|compare|comparison|reviews?)\b/;
const COMMERCIAL =
  /\b(buy|price|prices|pricing|cost|cheap|online|order|maker|templates?|services?|shop|hire|app)\b/;

export function scoreKeyword(
  keyword: OpportunityKeyword,
  signals: {
    trend: TrendSignal | null;
    searchConsole: SearchConsoleQueryMetrics | null;
    searchConsoleRange: { start: string; end: string } | null;
    pages: PageWords[];
  },
): KeywordOpportunityDto {
  const q = keyword.phrase.trim().toLowerCase();
  const coverage = signals.pages.length ? termCoverage(keyword.phrase, signals.pages) : null;
  const components: OpportunityComponent[] = [
    trendComponent(signals.trend),
    searchConsoleComponent(signals.searchConsole, signals.searchConsoleRange),
    keyword.metricsSource && keyword.searchVolume !== null
      ? component('volume', true, 20 * Math.min(1, Math.log10(1 + keyword.searchVolume) / 4), `${fmt(keyword.searchVolume)} searches a month`, keyword.metricsSource, 'Measured monthly search volume from a keyword-data provider.') // prettier-ignore
      : component('volume', false, 0, null, null, 'No keyword-data provider has supplied a search volume; it is not estimated.'), // prettier-ignore
    component('relevance', true, keyword.isPrimary ? 15 : { HIGH: 12, MEDIUM: 8, LOW: 4 }[keyword.priority], `${keyword.isPrimary ? 'Primary keyword, ' : ''}${keyword.priority.toLowerCase()} priority`, 'Your keyword settings', 'How important you marked this keyword for the business.'), // prettier-ignore
    keyword.metricsSource && keyword.difficulty !== null
      ? component('competition', true, 10 * (1 - keyword.difficulty / 100), `Difficulty ${keyword.difficulty}/100`, keyword.metricsSource, 'Lower difficulty scores higher.') // prettier-ignore
      : component('competition', false, 0, null, null, 'No keyword-data provider has supplied a difficulty score; competition is not estimated.'), // prettier-ignore
    coverage
      ? component('coverage', true, { missing: 10, partial: 6, present: 2 }[coverage.status], coverage.status === 'present' ? `Targeted on ${coverage.pages.length} page(s)` : coverage.status === 'partial' ? 'Mentioned, not targeted' : 'Not on your site', 'Your latest audit', coverage.status === 'present' ? 'A page already targets it in its title, main heading or address.' : coverage.status === 'partial' ? 'It appears only in sub-headings or descriptions, or its words appear separately.' : 'No page uses this phrase in its title, headings, address or description.') // prettier-ignore
      : component('coverage', false, 0, null, null, 'No completed audit, so your pages could not be checked.'), // prettier-ignore
  ];
  const available = components.filter((c) => c.available);
  const possible = available.reduce((s, c) => s + c.maxPoints, 0);
  const score = possible ? Math.round((100 * available.reduce((s, c) => s + c.points, 0)) / possible) : null;
  const share = possible / OPPORTUNITY_COMPONENTS.reduce((s, c) => s + c.maxPoints, 0);

  const actions: KeywordOpportunityDto['actions'] = [];
  const add = (type: OpportunityAction, reason: string, targetUrl: string | null = null) => {
    if (actions.length < 3 && !actions.some((a) => a.type === type))
      actions.push({ type, label: OPPORTUNITY_ACTION_LABELS[type], reason, targetUrl });
  };
  const question = QUESTION.test(q) || q.endsWith('?');
  const gsc = signals.searchConsole;
  if (coverage?.status === 'missing') {
    if (LOCAL.test(q))
      add('local_page', 'People want a nearby result: a page for the place, with your address and service area.'); // prettier-ignore
    else if (question || keyword.intent === 'INFORMATIONAL')
      add('new_article', 'No page covers it; an article that answers it directly fits the search.'); // prettier-ignore
    else if (COMMERCIAL.test(q) || keyword.intent === 'COMMERCIAL' || keyword.intent === 'TRANSACTIONAL')
      add('new_landing_page', 'No page targets it; people searching it want to buy or start, so give it a landing page.', keyword.targetUrl); // prettier-ignore
    else add('new_article', 'No page targets it yet.');
  } else if (coverage?.status === 'partial') {
    add('update_page', 'Use the exact phrase in the title or main heading of the page that mentions it.', coverage.pages[0]?.url ?? keyword.targetUrl); // prettier-ignore
  }
  if (gsc && gsc.impressions >= 100 && gsc.ctr < 0.02)
    add('update_page', `Shown ${fmt(gsc.impressions)} times but clicked ${pct(gsc.ctr)}: rewrite the title and meta description.`, coverage?.pages[0]?.url ?? keyword.targetUrl); // prettier-ignore
  else if (gsc && gsc.position > 3 && gsc.position <= 20 && coverage?.status === 'present')
    add('update_page', `Average position ${gsc.position}: strengthen the page with more depth and internal links.`, coverage.pages[0]?.url ?? keyword.targetUrl); // prettier-ignore
  if (question || keyword.relatedQuestions.length) {
    add('faq', 'Answer the question in one or two plain sentences in an FAQ section.');
    add('aeo_topic', 'Answer engines quote short, direct answers; put the answer first.');
  }
  if (COMPARATIVE.test(q))
    add(
      'geo_topic',
      'AI assistants answer comparisons: state clearly who it is for, prices and how you differ.',
    );
  if (!actions.length)
    add('monitor', 'Covered already; keep an eye on its trend and Search Console figures.');

  return {
    keywordId: keyword.id,
    phrase: keyword.phrase,
    score,
    confidence: share >= 0.7 ? 'high' : share >= 0.45 ? 'medium' : 'low',
    components,
    missing: components.filter((c) => !c.available).map((c) => c.label),
    actions,
  };
}

/** Scores the project's active keywords (up to `limit`), highest first. */
export async function keywordOpportunities(
  prisma: PrismaClient,
  projectId: string,
  options: { limit?: number } = {},
): Promise<KeywordOpportunitiesDto> {
  const keywords = await prisma.projectKeyword.findMany({
    where: { projectId, status: { not: 'DISCARDED' } },
    orderBy: [{ isPrimary: 'desc' }, { createdAt: 'desc' }],
    take: options.limit ?? 300,
  });
  const reports = await prisma.trendReport.findMany({
    where: { projectId, status: 'SUCCEEDED' },
    orderBy: { createdAt: 'desc' },
    take: 10,
    select: {
      id: true,
      keywords: true,
      data: true,
      source: true,
      fetchedAt: true,
      country: true,
      region: true,
    },
  });
  const loaded: { data: TrendData; meta: Pick<TrendSignal, 'source' | 'fetchedAt' | 'place'> }[] = [];
  for (const report of reports) {
    const data = await loadTrendData(prisma, report);
    if (data)
      loaded.push({
        data,
        meta: { source: report.source as TrendSource, fetchedAt: report.fetchedAt, place: report.region ?? report.country ?? 'Worldwide' }, // prettier-ignore
      });
  }
  const gsc = await searchConsoleQueryMetrics(
    prisma,
    projectId,
    keywords.map((k) => k.phrase),
  );
  const { crawl, pages } = await loadSitePages(prisma, projectId);
  const items = keywords.map((k) => {
    // The newest report that mentions the phrase supplies its trend signal (one report, never a mix).
    let trend: TrendSignal | null = null;
    for (const r of loaded) {
      trend = trendSignalFor(k.phrase, r.data, r.meta);
      if (trend) break;
    }
    return scoreKeyword(
      {
        id: k.id,
        phrase: k.phrase,
        intent: k.intent,
        priority: k.priority,
        isPrimary: k.isPrimary,
        targetUrl: k.targetUrl,
        relatedQuestions: Array.isArray(k.relatedQuestions) ? (k.relatedQuestions as string[]) : [],
        searchVolume: k.metricsSource ? k.searchVolume : null,
        difficulty: k.metricsSource ? k.difficulty : null,
        metricsSource: k.metricsSource,
      },
      { trend, searchConsole: gsc.byQuery.get(k.phrase.trim().toLowerCase()) ?? null, searchConsoleRange: gsc.range, pages }, // prettier-ignore
    );
  });
  items.sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || a.phrase.localeCompare(b.phrase));
  const notes = [
    'Scores use only the signals each keyword has; missing signals are listed and left out, never estimated.',
    'Google Trends interest is relative (not search counts) and is scored separately from Search Console and provider figures.',
  ];
  return {
    items,
    signals: {
      trendsReportAt: reports[0]?.fetchedAt?.toISOString() ?? null,
      searchConsoleRange: gsc.range,
      measuredMetrics: keywords.some((k) => k.metricsSource),
      crawlFinishedAt: crawl?.finishedAt?.toISOString() ?? null,
    },
    notes,
  };
}
