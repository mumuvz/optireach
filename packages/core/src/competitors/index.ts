// Competitor analysis built only from stored evidence: AI visibility observations, citations,
// the project's own crawl, and public pages of competitor sites fetched with the safe crawler.
// No competitor traffic, rankings or private analytics are estimated.
import {
  bucketStart,
  computeVisibilityMetrics,
  type TrendBucket,
  type VisibilityFilter,
} from '@surfaced/shared';
import {
  SafeFetcher,
  assertUrlPolicy,
  discoverSitemaps,
  extractPage,
  fetchRobots,
  isHtmlContentType,
  isInScope,
  normalizeCrawlUrl,
  type SafeFetcherOptions,
} from '../crawler';
import type { Prisma, PrismaClient } from '../db';
import { loadObservationFacts, observationWhere } from '../visibility/metrics';

export interface EntityComparison {
  id: string | null;
  name: string;
  domain: string | null;
  isBrand: boolean;
  mentions: number;
  mentionRate: number | null;
  citedObservations: number;
  citationRate: number | null;
  shareOfVoice: number | null;
  averageRank: number | null;
}

export async function competitorComparison(
  prisma: PrismaClient,
  projectId: string,
  filter: Partial<VisibilityFilter>,
) {
  const project = await prisma.project.findUniqueOrThrow({
    where: { id: projectId },
    select: { name: true, domain: true },
  });
  const competitors = await prisma.projectCompetitor.findMany({
    where: { projectId },
    orderBy: { createdAt: 'asc' },
  });
  const { facts } = await loadObservationFacts(prisma, projectId, filter);
  const metrics = computeVisibilityMetrics(
    facts,
    competitors.map((c) => ({ id: c.id, name: c.name })),
  );

  const ranks = await prisma.brandMention.groupBy({
    by: ['entityType', 'competitorId'],
    where: { observation: { ...observationWhere(projectId, filter), status: 'SUCCEEDED' } },
    _avg: { rank: true },
  });
  const avgRank = (type: 'BRAND' | 'COMPETITOR', id: string | null) => {
    const row = ranks.find((r) => r.entityType === type && (type === 'BRAND' || r.competitorId === id));
    return row?._avg.rank ? Math.round(row._avg.rank * 10) / 10 : null;
  };

  const entities: EntityComparison[] = [
    {
      id: null,
      name: project.name,
      domain: project.domain,
      isBrand: true,
      mentions: metrics.brandMentions,
      mentionRate: metrics.mentionRate,
      citedObservations: metrics.brandCitations,
      citationRate: metrics.citationRate,
      shareOfVoice: metrics.shareOfVoice.brand,
      averageRank: avgRank('BRAND', null),
    },
    ...competitors.map((c) => {
      const rate = metrics.competitors.find((r) => r.id === c.id)!;
      return {
        id: c.id,
        name: c.name,
        domain: c.domain,
        isBrand: false,
        mentions: rate.mentions,
        mentionRate: rate.mentionRate,
        citedObservations: rate.citations,
        citationRate: rate.citationRate,
        shareOfVoice: metrics.shareOfVoice.competitors.find((s) => s.id === c.id)?.share ?? null,
        averageRank: avgRank('COMPETITOR', c.id),
      };
    }),
  ];

  // Sources cited alongside each entity: shared with the brand vs. only alongside the competitor.
  const successful = facts.filter((f) => f.succeeded);
  const domainsWhere = (predicate: (f: (typeof facts)[number]) => boolean) =>
    new Set(successful.filter(predicate).flatMap((f) => f.citationDomains));
  const brandSources = domainsWhere((f) => f.brandMentioned);
  const sources = competitors.map((c) => {
    const compSources = domainsWhere((f) => f.competitorsMentioned.includes(c.id));
    return {
      competitorId: c.id,
      name: c.name,
      shared: [...compSources].filter((d) => brandSources.has(d)).sort(),
      onlyWithCompetitor: [...compSources].filter((d) => !brandSources.has(d)).sort(),
    };
  });

  return { entities, sources, totals: metrics.totals, observationCount: facts.length };
}

export async function topicGaps(prisma: PrismaClient, projectId: string, filter: Partial<VisibilityFilter>) {
  const observations = await prisma.aiVisibilityObservation.findMany({
    where: { ...observationWhere(projectId, filter), status: 'SUCCEEDED' },
    select: {
      id: true,
      promptId: true,
      promptText: true,
      provider: true,
      brandMentioned: true,
      observedAt: true,
      mentions: { where: { entityType: 'COMPETITOR' }, select: { entityName: true } },
    },
    orderBy: { observedAt: 'desc' },
    take: 5000,
  });
  interface GapEntry {
    promptId: string;
    prompt: string;
    total: number;
    brandMissing: number;
    competitors: Map<string, number>;
    lastObservedAt: Date;
    observationIds: string[];
  }
  const byPrompt = new Map<string, GapEntry>();
  for (const o of observations) {
    const entry: GapEntry = byPrompt.get(o.promptId) ?? {
      promptId: o.promptId,
      prompt: o.promptText,
      total: 0,
      brandMissing: 0,
      competitors: new Map<string, number>(),
      lastObservedAt: o.observedAt,
      observationIds: [],
    };
    entry.total += 1;
    if (!o.brandMentioned && o.mentions.length) {
      entry.brandMissing += 1;
      entry.observationIds.push(o.id);
      for (const m of o.mentions)
        entry.competitors.set(m.entityName, (entry.competitors.get(m.entityName) ?? 0) + 1);
    }
    byPrompt.set(o.promptId, entry);
  }
  return [...byPrompt.values()]
    .filter((e) => e.brandMissing > 0)
    .map((e) => ({
      promptId: e.promptId,
      prompt: e.prompt,
      observations: e.total,
      brandAbsentWhileCompetitorsPresent: e.brandMissing,
      gapRate: e.brandMissing / e.total,
      competitorsMentioned: [...e.competitors.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([name, count]) => ({ name, count })),
      lastObservedAt: e.lastObservedAt.toISOString(),
      sampleObservationIds: e.observationIds.slice(0, 5),
    }))
    .sort((a, b) => b.gapRate - a.gapRate || b.observations - a.observations);
}

export async function competitorTrend(
  prisma: PrismaClient,
  projectId: string,
  filter: Partial<VisibilityFilter>,
  bucket: TrendBucket,
) {
  const competitors = await prisma.projectCompetitor.findMany({
    where: { projectId },
    select: { id: true, name: true },
  });
  const { facts } = await loadObservationFacts(prisma, projectId, filter);
  const buckets = new Map<string, typeof facts>();
  for (const f of facts) {
    const key = bucketStart(new Date(f.observedAt), bucket).toISOString();
    buckets.set(key, [...(buckets.get(key) ?? []), f]);
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, list]) => {
      const m = computeVisibilityMetrics(list, competitors);
      return {
        bucketStart: key,
        observations: m.totals.successful,
        brand: m.mentionRate,
        competitors: Object.fromEntries(m.competitors.map((c) => [c.id, c.mentionRate])),
      };
    });
}

// ---------------- Public metadata snapshots ----------------

export interface SnapshotPage {
  url: string;
  statusCode: number | null;
  title: string | null;
  metaDescription: string | null;
  h1: string | null;
  wordCount: number;
  schemaTypes: string[];
  hasFaqContent: boolean;
  questionHeadings: number;
}

const SNAPSHOT_MAX_PAGES = 10;

/** Fetches a competitor's home page plus a few sitemap URLs (robots.txt respected, SSRF-safe). */
export async function executeCompetitorSnapshot(
  prisma: PrismaClient,
  snapshotId: string,
  fetcherOptions?: SafeFetcherOptions,
) {
  const snapshot = await prisma.competitorSnapshot.findUniqueOrThrow({
    where: { id: snapshotId },
    include: { competitor: true },
  });
  await prisma.competitorSnapshot.update({ where: { id: snapshotId }, data: { status: 'RUNNING' } });
  const fetcher = new SafeFetcher({ ...fetcherOptions, timeoutMs: 15_000 });
  const competitorDomain = snapshot.competitor.domain;
  try {
    if (!competitorDomain) throw new Error('This competitor has no known website to read.');
    const startUrl = `https://${competitorDomain}/`;
    // Fail clearly (and permanently) for targets the SSRF policy forbids, before any request.
    assertUrlPolicy(new URL(startUrl), fetcherOptions?.allowlist);
    const robots = await fetchRobots(fetcher, new URL(startUrl).origin);
    if (robots.status === 'unreachable' || !robots.isAllowed(startUrl)) {
      const reason =
        robots.status === 'unreachable'
          ? `robots.txt could not be fetched (${robots.error ?? 'server error'}); crawlers must then assume the site is disallowed, so no pages were fetched.`
          : 'robots.txt does not allow crawling this site, so no pages were fetched.';
      await prisma.competitorSnapshot.update({
        where: { id: snapshotId },
        data: {
          status: 'SUCCEEDED',
          robotsAllowed: false,
          pages: [],
          fetchedAt: new Date(),
          errorMessage: reason,
        },
      });
      return { pages: 0, robotsAllowed: false };
    }
    const sitemap = await discoverSitemaps(
      fetcher,
      robots.sitemaps.length ? robots.sitemaps : [`${new URL(startUrl).origin}/sitemap.xml`],
      {
        maxUrls: 200,
        maxFiles: 3,
        inScope: (u) => isInScope(u, competitorDomain, false),
      },
    );
    const targets = [startUrl, ...sitemap.urls.filter((u) => robots.isAllowed(u))]
      .map((u) => normalizeCrawlUrl(u))
      .filter((u): u is string => Boolean(u));
    const unique = [...new Set(targets)].slice(0, SNAPSHOT_MAX_PAGES);
    const pages: SnapshotPage[] = [];
    for (const url of unique) {
      const result = await fetcher.fetch(url, { beforeRequest: async (u) => robots.isAllowed(u.toString()) });
      const html =
        result.body && isHtmlContentType(result.contentType) && result.statusCode === 200
          ? result.body.toString('utf8')
          : null;
      const extract = html ? extractPage(html, result.finalUrl) : null;
      pages.push({
        url,
        statusCode: result.statusCode,
        title: extract?.title ?? null,
        metaDescription: extract?.metaDescription ?? null,
        h1: extract?.h1 ?? null,
        wordCount: extract?.wordCount ?? 0,
        schemaTypes: extract?.structuredDataTypes ?? [],
        hasFaqContent: extract?.hasFaqContent ?? false,
        questionHeadings: extract?.questionHeadings ?? 0,
      });
      await new Promise((r) => setTimeout(r, 500)); // politeness between requests
    }
    await prisma.competitorSnapshot.update({
      where: { id: snapshotId },
      data: {
        status: 'SUCCEEDED',
        robotsAllowed: true,
        pages: pages as unknown as Prisma.InputJsonValue,
        fetchedAt: new Date(),
        errorMessage: null,
      },
    });
    return { pages: pages.length, robotsAllowed: true };
  } finally {
    await fetcher.close();
  }
}

export interface MetadataProfile {
  name: string;
  domain: string | null;
  isBrand: boolean;
  source: 'crawl' | 'snapshot' | 'none';
  pages: number;
  fetchedAt: string | null;
  withMetaDescription: number | null;
  averageTitleLength: number | null;
  averageWordCount: number | null;
  withFaqContent: number | null;
  withQuestionHeadings: number | null;
  schemaTypes: string[];
}

function profileFromPages(
  pages: {
    title: string | null;
    metaDescription: string | null;
    wordCount: number;
    hasFaqContent: boolean;
    questionHeadings: number;
    schemaTypes: string[];
  }[],
) {
  const html = pages.filter((p) => p.title !== null || p.wordCount > 0);
  if (!html.length) return null;
  const avg = (values: number[]) => Math.round(values.reduce((a, b) => a + b, 0) / values.length);
  return {
    pages: html.length,
    withMetaDescription: html.filter((p) => p.metaDescription).length / html.length,
    averageTitleLength: avg(html.map((p) => (p.title ?? '').length)),
    averageWordCount: avg(html.map((p) => p.wordCount)),
    withFaqContent: html.filter((p) => p.hasFaqContent).length / html.length,
    withQuestionHeadings: html.filter((p) => p.questionHeadings > 0).length / html.length,
    schemaTypes: [...new Set(html.flatMap((p) => p.schemaTypes))].sort(),
  };
}

/** Compares public on-page metadata of the project's crawled pages with each competitor's latest snapshot. */
export async function metadataComparison(
  prisma: PrismaClient,
  projectId: string,
): Promise<MetadataProfile[]> {
  const project = await prisma.project.findUniqueOrThrow({
    where: { id: projectId },
    include: { competitors: { where: { status: 'CONFIRMED' } } },
  });
  const crawl = await prisma.crawlJob.findFirst({
    where: { projectId, status: 'SUCCEEDED' },
    orderBy: { finishedAt: 'desc' },
  });
  const ownPages = crawl
    ? await prisma.crawledPage.findMany({
        where: { crawlJobId: crawl.id, isHtml: true, statusCode: 200 },
        select: { title: true, metaDescription: true, wordCount: true, signals: true, structuredData: true },
        take: 2000,
      })
    : [];
  const own = profileFromPages(
    ownPages.map((p) => ({
      title: p.title,
      metaDescription: p.metaDescription,
      wordCount: p.wordCount ?? 0,
      hasFaqContent: Boolean((p.signals as { hasFaqContent?: boolean } | null)?.hasFaqContent),
      questionHeadings: (p.signals as { questionHeadings?: number } | null)?.questionHeadings ?? 0,
      schemaTypes: (p.structuredData as { types?: string[] } | null)?.types ?? [],
    })),
  );
  const empty = {
    pages: 0,
    withMetaDescription: null,
    averageTitleLength: null,
    averageWordCount: null,
    withFaqContent: null,
    withQuestionHeadings: null,
    schemaTypes: [] as string[],
  };
  const profiles: MetadataProfile[] = [
    {
      name: project.name,
      domain: project.domain,
      isBrand: true,
      source: own ? 'crawl' : 'none',
      fetchedAt: crawl?.finishedAt?.toISOString() ?? null,
      ...(own ?? empty),
    },
  ];
  for (const competitor of project.competitors) {
    const snapshot = await prisma.competitorSnapshot.findFirst({
      where: { competitorId: competitor.id, status: 'SUCCEEDED' },
      orderBy: { createdAt: 'desc' },
    });
    const pages = (snapshot?.pages ?? []) as unknown as SnapshotPage[];
    const profile = profileFromPages(pages);
    profiles.push({
      name: competitor.name,
      domain: competitor.domain,
      isBrand: false,
      source: profile ? 'snapshot' : 'none',
      fetchedAt: snapshot?.fetchedAt?.toISOString() ?? null,
      ...(profile ?? empty),
    });
  }
  return profiles;
}

export * from './gap';
export * from './seo-compare';
