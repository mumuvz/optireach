import { DEFAULT_SCORING_CONFIG, getAuditRule, type IssueSeverity } from '@surfaced/shared';
import type { CrawledPage, Prisma, PrismaClient } from '../db';
import { urlHash } from '../crawler/url-utils';
import type { AnalysisResult } from './analyze';
import {
  dbPageToAnalysis,
  type AnalysisInput,
  type AnalysisLink,
  type AnalysisPage,
  type CrawlContext,
  type DetectedIssue,
} from './model';

const CHUNK = 200;

function chunks<T>(items: T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const PAGE_BATCH = 2000;
const LINK_BATCH = 20_000;

/**
 * Loads a stored crawl (pages + internal link graph) as analysis input. Crawls have no page cap, so rows are read
 * in batches and link objects are shared: every link to the same URL (with the same nofollow flag) is one
 * read-only object, so memory grows with the number of distinct URLs rather than with every link on every page.
 * Anchor text is not needed by the rules (generic anchors are kept per page in its signals).
 */
export async function loadAnalysisInput(prisma: PrismaClient, crawlJobId: string): Promise<AnalysisInput> {
  const crawl = await prisma.crawlJob.findUniqueOrThrow({ where: { id: crawlJobId } });
  if (!crawl.summary || !crawl.robotsInfo || !crawl.sitemapInfo)
    throw new Error('Crawl results are incomplete; the crawl did not finish');

  const shared = new Map<string, AnalysisLink>();
  const linksByPage = new Map<string, AnalysisLink[]>();
  let linkCursor: { fromPageId: string; toUrlHash: string } | null = null;
  for (;;) {
    const batch: { fromPageId: string; toUrlHash: string; toUrl: string; nofollow: boolean }[] =
      await prisma.crawledLink.findMany({
        where: { crawlJobId },
        select: { fromPageId: true, toUrlHash: true, toUrl: true, nofollow: true },
        // Primary-key order, the same order the rows were read in before batching.
        orderBy: [{ fromPageId: 'asc' }, { toUrlHash: 'asc' }],
        take: LINK_BATCH,
        ...(linkCursor
          ? { skip: 1, cursor: { crawlJobId_fromPageId_toUrlHash: { crawlJobId, ...linkCursor } } }
          : {}),
      });
    for (const l of batch) {
      const key = `${l.nofollow ? '1' : '0'}${l.toUrl}`;
      let link = shared.get(key);
      if (!link) {
        link = { url: l.toUrl, anchorText: '', nofollow: l.nofollow };
        shared.set(key, link);
      }
      const list = linksByPage.get(l.fromPageId);
      if (list) list.push(link);
      else linksByPage.set(l.fromPageId, [link]);
    }
    if (batch.length < LINK_BATCH) break;
    const last = batch[batch.length - 1]!;
    linkCursor = { fromPageId: last.fromPageId, toUrlHash: last.toUrlHash };
  }

  const pages: AnalysisPage[] = [];
  let pageCursor: string | null = null;
  for (;;) {
    const batch: CrawledPage[] = await prisma.crawledPage.findMany({
      where: { crawlJobId },
      orderBy: { id: 'asc' },
      take: PAGE_BATCH,
      ...(pageCursor ? { skip: 1, cursor: { id: pageCursor } } : {}),
    });
    for (const row of batch) pages.push(dbPageToAnalysis(row, linksByPage.get(row.id) ?? []));
    if (batch.length < PAGE_BATCH) break;
    pageCursor = batch[batch.length - 1]!.id;
  }

  const summary = crawl.summary as unknown as Pick<
    CrawlContext,
    | 'rootUrl'
    | 'httpsRedirect'
    | 'blockedByRobots'
    | 'blockedByRobotsTotal'
    | 'stoppedReason'
    | 'limitReached'
    | 'loopUrlsSkipped'
  >;
  return {
    pages,
    crawl: {
      ...summary,
      robots: crawl.robotsInfo as unknown as CrawlContext['robots'],
      sitemap: crawl.sitemapInfo as unknown as CrawlContext['sitemap'],
    },
  };
}

/** Splits a crawl summary into the three JSON columns stored on crawl_jobs. */
export function crawlSummaryColumns(summary: CrawlContext): {
  robotsInfo: Prisma.InputJsonValue;
  sitemapInfo: Prisma.InputJsonValue;
  summary: Prisma.InputJsonValue;
} {
  const { robots, sitemap, ...rest } = summary;
  return {
    robotsInfo: robots as unknown as Prisma.InputJsonValue,
    sitemapInfo: sitemap as unknown as Prisma.InputJsonValue,
    summary: rest as unknown as Prisma.InputJsonValue,
  };
}

export interface PersistOutcome {
  newIssues: number;
  reopenedIssues: number;
  resolvedIssues: number;
}

/** Writes analysis results for a project audit run. Idempotent for retries of the same run. */
export async function persistProjectAudit(
  prisma: PrismaClient,
  params: { projectId: string; auditRunId: string; result: AnalysisResult; input: AnalysisInput },
): Promise<PersistOutcome> {
  const { projectId, auditRunId, result, input } = params;
  const now = new Date();
  const pageIdByUrl = new Map(input.pages.filter((p) => p.id).map((p) => [p.url, p.id!]));
  const crawledHashes = new Set(input.pages.map((p) => urlHash(p.url)));

  // 1. Upsert issues by fingerprint.
  const detected = new Map(result.issues.map((i) => [i.fingerprint, i]));
  const existing = new Map<string, { id: string; status: string }>();
  for (const batch of chunks([...detected.keys()])) {
    const rows = await prisma.auditIssue.findMany({
      where: { projectId, fingerprint: { in: batch } },
      select: { id: true, fingerprint: true, status: true },
    });
    for (const r of rows) existing.set(r.fingerprint, { id: r.id, status: r.status });
  }

  const toCreate = [...detected.values()].filter((i) => !existing.has(i.fingerprint));
  for (const batch of chunks(toCreate)) {
    await prisma.auditIssue.createMany({
      data: batch.map((i) => issueCreateData(projectId, auditRunId, i, now)),
      skipDuplicates: true,
    });
  }
  let reopened = 0;
  for (const batch of chunks([...existing.entries()], 100)) {
    await prisma.$transaction(
      batch.map(([fp, row]) => {
        const issue = detected.get(fp)!;
        const reopen = row.status === 'RESOLVED';
        if (reopen) reopened += 1;
        return prisma.auditIssue.update({
          where: { id: row.id },
          data: {
            severity: issue.severity,
            title: issue.title,
            description: issue.description,
            evidence: issue.evidence as Prisma.InputJsonValue,
            suggestedFix: issue.suggestedFix,
            lastDetectedAt: now,
            lastAuditRunId: auditRunId,
            ...(reopen ? { status: 'OPEN' as const, resolvedAt: null } : {}),
          },
        });
      }),
    );
  }

  // 2. Occurrences for this run (composite key makes retries safe).
  const ids = new Map<string, string>();
  for (const batch of chunks([...detected.keys()])) {
    const rows = await prisma.auditIssue.findMany({
      where: { projectId, fingerprint: { in: batch } },
      select: { id: true, fingerprint: true },
    });
    for (const r of rows) ids.set(r.fingerprint, r.id);
  }
  const occurrences = [...detected.values()].map((i) => ({
    auditRunId,
    issueId: ids.get(i.fingerprint)!,
    crawledPageId: i.url ? (pageIdByUrl.get(i.url) ?? null) : null,
    severity: i.severity,
  }));
  for (const batch of chunks(occurrences.filter((o) => o.issueId))) {
    await prisma.auditIssueOccurrence.createMany({ data: batch, skipDuplicates: true });
  }

  // 3. Resolve open issues that were not detected again — only for pages re-crawled in this run
  //    (and site-wide issues), so a partial crawl never "fixes" pages it did not visit.
  const stillOpen = await prisma.auditIssue.findMany({
    where: { projectId, status: 'OPEN', NOT: { lastAuditRunId: auditRunId } },
    select: { id: true, urlHash: true, fingerprint: true },
  });
  const resolveIds = stillOpen
    .filter((i) => !detected.has(i.fingerprint) && (i.urlHash === null || crawledHashes.has(i.urlHash)))
    .map((i) => i.id);
  for (const batch of chunks(resolveIds)) {
    await prisma.auditIssue.updateMany({
      where: { id: { in: batch } },
      data: { status: 'RESOLVED', resolvedAt: now },
    });
  }

  // 4. Page-level derived fields.
  await updatePageSignals(prisma, input, result);

  // 5. Run summary.
  await prisma.auditRun.update({
    where: { id: auditRunId },
    data: {
      status: 'SUCCEEDED',
      score: result.score.score,
      categoryScores: result.score.categoryScores,
      issueCounts: {
        ...result.issueCounts,
        limitations: result.limitations,
      } as unknown as Prisma.InputJsonValue,
      pagesAnalyzed: result.pagesAnalyzed,
      finishedAt: now,
    },
  });
  return { newIssues: toCreate.length, reopenedIssues: reopened, resolvedIssues: resolveIds.length };
}

function issueCreateData(
  projectId: string,
  auditRunId: string,
  issue: DetectedIssue,
  now: Date,
): Prisma.AuditIssueCreateManyInput {
  return {
    projectId,
    ruleId: issue.ruleId,
    category: issue.category,
    severity: issue.severity,
    fingerprint: issue.fingerprint,
    url: issue.url?.slice(0, 2048) ?? null,
    urlHash: issue.url ? urlHash(issue.url) : null,
    title: issue.title.slice(0, 255),
    description: issue.description,
    evidence: issue.evidence as Prisma.InputJsonValue,
    suggestedFix: issue.suggestedFix,
    firstDetectedAt: now,
    lastDetectedAt: now,
    firstAuditRunId: auditRunId,
    lastAuditRunId: auditRunId,
  };
}

async function updatePageSignals(
  prisma: PrismaClient,
  input: AnalysisInput,
  result: AnalysisResult,
): Promise<void> {
  const updates = input.pages
    .filter((p) => p.id)
    .map((p) => {
      const idx = result.indexability.get(p.url);
      return {
        id: p.id!,
        inlinksCount: result.inlinks.get(p.url) ?? 0,
        isIndexable: idx?.indexable ?? false,
        reason: idx?.reason ?? null,
      };
    });
  for (const batch of chunks(updates, 100)) {
    await prisma.$transaction(
      batch.map((u) =>
        prisma.crawledPage.update({
          where: { id: u.id },
          data: { inlinksCount: u.inlinksCount, isIndexable: u.isIndexable, indexabilityReason: u.reason },
        }),
      ),
    );
  }
}

export interface PublicAuditSummary {
  score: number;
  categoryScores: Record<string, number>;
  issueCounts: AnalysisResult['issueCounts'];
  pagesAnalyzed: number;
  topIssues: {
    ruleId: string;
    title: string;
    category: string;
    severity: IssueSeverity;
    affected: number;
    fix: string;
    sampleUrls: string[];
  }[];
  limitations: string[];
  scoring: { version: string; note: string };
}

/** Compact, shareable summary for anonymous free audits (no per-issue rows are stored). */
export function summarizeForPublicAudit(result: AnalysisResult): PublicAuditSummary {
  const byRule = new Map<string, DetectedIssue[]>();
  for (const issue of result.issues) byRule.set(issue.ruleId, [...(byRule.get(issue.ruleId) ?? []), issue]);
  const rank: Record<IssueSeverity, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
  const topIssues = [...byRule.entries()]
    .map(([ruleId, list]) => ({
      ruleId,
      title: list[0]!.title,
      category: list[0]!.category,
      severity: list[0]!.severity,
      affected: list.length,
      fix: getAuditRule(ruleId)?.fix ?? list[0]!.suggestedFix,
      sampleUrls: list
        .map((i) => i.url)
        .filter((u): u is string => Boolean(u))
        .slice(0, 3),
    }))
    .sort((a, b) => rank[a.severity] - rank[b.severity] || b.affected - a.affected)
    .slice(0, 15);
  return {
    score: result.score.score,
    categoryScores: result.score.categoryScores,
    issueCounts: result.issueCounts,
    pagesAnalyzed: result.pagesAnalyzed,
    topIssues,
    limitations: result.limitations,
    scoring: {
      version: DEFAULT_SCORING_CONFIG.version,
      note: 'Site health is a diagnostic index calculated by Surfaced from the crawled pages. It is not a Google ranking score.',
    },
  };
}
