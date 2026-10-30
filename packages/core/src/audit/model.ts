// Analysis input model and conversions between crawler records, database rows and analysis input.
import type { AuditCategory, IssueSeverity, PageSource } from '@surfaced/shared';
import type { CrawledPageRecord, CrawlSummary } from '../crawler/crawler';
import type { JsonLdBlock } from '../crawler/extract';
import type { Prisma } from '../db';
import type { RuleScope } from '@surfaced/shared';

export interface AnalysisLink {
  url: string;
  anchorText: string;
  nofollow: boolean;
}

/** Everything the rule engine needs about one fetched URL. */
export interface AnalysisPage {
  id?: string;
  url: string;
  finalUrl: string | null;
  depth: number;
  source: PageSource;
  statusCode: number | null;
  responseTimeMs: number | null;
  contentLength: number | null;
  redirectChain: { url: string; statusCode: number }[];
  isHtml: boolean;
  compressed: boolean;
  xRobotsTag: string | null;
  fetchError: string | null;
  fetchErrorCode: string | null;
  inSitemap: boolean;
  analyzed: boolean;
  title: string | null;
  titleCount: number;
  metaDescription: string | null;
  metaDescriptionCount: number;
  canonicals: string[];
  metaRobots: string | null;
  lang: string | null;
  headings: { level: number; text: string }[];
  h1Count: number;
  imagesTotal: number;
  imagesMissingAlt: number;
  imagesMissingDimensions: number;
  jsonLd: JsonLdBlock[];
  structuredDataTypes: string[];
  hasViewport: boolean;
  ogTitle: string | null;
  ogDescription: string | null;
  wordCount: number;
  contentHash: string | null;
  blockingScriptsInHead: number;
  insecureResources: string[];
  questionHeadings: number;
  hasFaqContent: boolean;
  internalLinks: AnalysisLink[];
  genericAnchors: AnalysisLink[];
}

export type CrawlContext = Pick<
  CrawlSummary,
  'rootUrl' | 'robots' | 'sitemap' | 'httpsRedirect' | 'blockedByRobots' | 'stoppedReason' | 'limitReached'
> & {
  /** Links skipped by loop protection (absent on crawls stored before it existed). */
  loopUrlsSkipped?: number;
  /** Total robots-blocked URLs; blockedByRobots lists the first 500 (absent on older crawls). */
  blockedByRobotsTotal?: number;
};

export interface AnalysisInput {
  pages: AnalysisPage[];
  crawl: CrawlContext;
}

export interface DetectedIssue {
  ruleId: string;
  category: AuditCategory;
  severity: IssueSeverity;
  scope: RuleScope;
  /** Affected URL for page-scoped issues; null for site-wide issues. */
  url: string | null;
  title: string;
  description: string;
  evidence: Record<string, unknown>;
  suggestedFix: string;
  fingerprint: string;
}

/** JSON stored in crawled_pages.signals. */
export interface PageSignals {
  titleCount: number;
  metaDescriptionCount: number;
  canonicals: string[];
  hasViewport: boolean;
  ogTitle: string | null;
  ogDescription: string | null;
  compressed: boolean;
  imagesMissingDimensions: number;
  blockingScriptsInHead: number;
  insecureResources: string[];
  questionHeadings: number;
  hasFaqContent: boolean;
  fetchErrorCode: string | null;
  jsonLd: JsonLdBlock[];
  genericAnchors: AnalysisLink[];
}

/** Converts a crawler record into Prisma create data for crawled_pages. */
export function pageRecordToCreateData(
  crawlJobId: string,
  record: CrawledPageRecord,
): Prisma.CrawledPageCreateManyInput {
  const e = record.extract;
  const signals: PageSignals = {
    titleCount: e?.titleCount ?? 0,
    metaDescriptionCount: e?.metaDescriptionCount ?? 0,
    canonicals: e?.canonicals ?? [],
    hasViewport: e?.hasViewport ?? false,
    ogTitle: e?.ogTitle ?? null,
    ogDescription: e?.ogDescription ?? null,
    compressed: record.compressed,
    imagesMissingDimensions: e ? e.images.filter((i) => !i.hasDimensions).length : 0,
    blockingScriptsInHead: e?.blockingScriptsInHead ?? 0,
    insecureResources: e?.insecureResources ?? [],
    questionHeadings: e?.questionHeadings ?? 0,
    hasFaqContent: e?.hasFaqContent ?? false,
    fetchErrorCode: record.fetchErrorCode,
    jsonLd: e?.jsonLd ?? [],
    genericAnchors: record.genericAnchors,
  };
  return {
    crawlJobId,
    url: record.url.slice(0, 2048),
    urlHash: record.urlHash,
    finalUrl: record.finalUrl?.slice(0, 2048) ?? null,
    depth: record.depth,
    source: record.source,
    statusCode: record.statusCode,
    contentType: record.contentType?.slice(0, 160) ?? null,
    responseTimeMs: record.responseTimeMs,
    contentLength: record.contentLength,
    redirectChain: record.redirectChain.length
      ? (record.redirectChain as unknown as Prisma.InputJsonValue)
      : undefined,
    isHtml: record.isHtml,
    title: e?.title?.slice(0, 1024) ?? null,
    metaDescription: e?.metaDescription ?? null,
    canonicalUrl: e?.canonicals[0]?.slice(0, 2048) ?? null,
    metaRobots: e?.metaRobots?.slice(0, 255) ?? null,
    xRobotsTag: record.xRobotsTag?.slice(0, 255) ?? null,
    lang: e?.lang?.slice(0, 35) ?? null,
    h1: e?.h1?.slice(0, 1024) ?? null,
    h1Count: e?.h1Count ?? 0,
    headings: e ? e.headings : undefined,
    wordCount: e?.wordCount ?? null,
    imagesTotal: e?.images.length ?? null,
    imagesMissingAlt: e ? e.images.filter((i) => !i.hasAlt).length : null,
    internalLinksOut: e ? record.internalLinks.length : null,
    externalLinksOut: e ? record.externalLinksCount : null,
    structuredData: e
      ? {
          types: e.structuredDataTypes,
          blocks: e.jsonLd.length,
          errors: e.jsonLd.filter((b) => b.error).map((b) => ({ index: b.index, message: b.error })),
        }
      : undefined,
    signals: signals as unknown as Prisma.InputJsonValue,
    contentHash: record.contentHash,
    inSitemap: record.inSitemap,
    fetchError: record.fetchError?.slice(0, 500) ?? null,
  };
}

interface DbPageRow {
  id: string;
  url: string;
  finalUrl: string | null;
  depth: number;
  source: PageSource;
  statusCode: number | null;
  responseTimeMs: number | null;
  contentLength: number | null;
  redirectChain: Prisma.JsonValue;
  isHtml: boolean;
  title: string | null;
  metaDescription: string | null;
  metaRobots: string | null;
  xRobotsTag: string | null;
  lang: string | null;
  h1Count: number;
  headings: Prisma.JsonValue;
  wordCount: number | null;
  imagesTotal: number | null;
  imagesMissingAlt: number | null;
  structuredData: Prisma.JsonValue;
  signals: Prisma.JsonValue;
  contentHash: string | null;
  inSitemap: boolean;
  fetchError: string | null;
}

/** Rebuilds analysis input from stored rows (used by the audit job and re-scoring). */
export function dbPageToAnalysis(row: DbPageRow, links: AnalysisLink[]): AnalysisPage {
  const signals = (row.signals ?? {}) as Partial<PageSignals>;
  const structured = (row.structuredData ?? {}) as { types?: string[] };
  const analyzed =
    row.statusCode !== null &&
    row.statusCode >= 200 &&
    row.statusCode < 300 &&
    row.isHtml &&
    row.wordCount !== null;
  return {
    id: row.id,
    url: row.url,
    finalUrl: row.finalUrl,
    depth: row.depth,
    source: row.source,
    statusCode: row.statusCode,
    responseTimeMs: row.responseTimeMs,
    contentLength: row.contentLength,
    redirectChain: Array.isArray(row.redirectChain)
      ? (row.redirectChain as { url: string; statusCode: number }[])
      : [],
    isHtml: row.isHtml,
    compressed: signals.compressed ?? false,
    xRobotsTag: row.xRobotsTag,
    fetchError: row.fetchError,
    fetchErrorCode: signals.fetchErrorCode ?? null,
    inSitemap: row.inSitemap,
    analyzed,
    title: row.title,
    titleCount: signals.titleCount ?? (row.title ? 1 : 0),
    metaDescription: row.metaDescription,
    metaDescriptionCount: signals.metaDescriptionCount ?? (row.metaDescription ? 1 : 0),
    canonicals: signals.canonicals ?? [],
    metaRobots: row.metaRobots,
    lang: row.lang,
    headings: Array.isArray(row.headings) ? (row.headings as { level: number; text: string }[]) : [],
    h1Count: row.h1Count,
    imagesTotal: row.imagesTotal ?? 0,
    imagesMissingAlt: row.imagesMissingAlt ?? 0,
    imagesMissingDimensions: signals.imagesMissingDimensions ?? 0,
    jsonLd: signals.jsonLd ?? [],
    structuredDataTypes: structured.types ?? [],
    hasViewport: signals.hasViewport ?? true,
    ogTitle: signals.ogTitle ?? null,
    ogDescription: signals.ogDescription ?? null,
    wordCount: row.wordCount ?? 0,
    contentHash: row.contentHash,
    blockingScriptsInHead: signals.blockingScriptsInHead ?? 0,
    insecureResources: signals.insecureResources ?? [],
    questionHeadings: signals.questionHeadings ?? 0,
    hasFaqContent: signals.hasFaqContent ?? false,
    internalLinks: links,
    genericAnchors: signals.genericAnchors ?? [],
  };
}
