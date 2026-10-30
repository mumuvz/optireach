// Deterministic audit rule engine. Pure function: the same crawl data always yields the same issues.
import {
  ISSUE_SEVERITIES,
  AUDIT_CATEGORIES,
  computeAuditScore,
  requireAuditRule,
  type AuditCategory,
  type AuditScoreResult,
  type IssueSeverity,
} from '@surfaced/shared';
import { sha256Hex } from '../crypto';
import type { AnalysisInput, AnalysisPage, DetectedIssue } from './model';

export interface IssueCounts {
  total: number;
  bySeverity: Record<IssueSeverity, number>;
  byCategory: Record<AuditCategory, number>;
}

export interface AnalysisResult {
  issues: DetectedIssue[];
  score: AuditScoreResult;
  issueCounts: IssueCounts;
  pagesAnalyzed: number;
  /** Internal inlink counts per URL (link graph). */
  inlinks: Map<string, number>;
  indexability: Map<string, { indexable: boolean; reason: string | null }>;
  limitations: string[];
}

const THRESHOLDS = {
  titleMax: 60,
  titleMin: 15,
  descriptionMax: 160,
  descriptionMin: 50,
  thinWords: 200,
  slowMs: 1500,
  verySlowMs: 3000,
  largeHtmlBytes: 1024 * 1024,
  compressMinBytes: 10 * 1024,
  maxDepth: 4,
  blockingScripts: 3,
  nearDuplicateJaccard: 0.85,
  simhashDistance: 3,
  /**
   * Candidate pairs visited per near-duplicate check. Indexed matching only visits pairs that can be similar, so real
   * sites stay far below these; they bound one audit when thousands of pages are almost identical.
   */
  nearDuplicateTitleComparisons: 20_000_000,
  nearDuplicateContentComparisons: 100_000_000,
} as const;

/** Similar URLs listed in a duplicate issue's evidence. */
const SIMILAR_URLS = 10;

const ORG_TYPES = new Set([
  'Organization',
  'Corporation',
  'LocalBusiness',
  'OnlineBusiness',
  'OnlineStore',
  'NGO',
  'EducationalOrganization',
  'GovernmentOrganization',
  'MedicalOrganization',
  'Store',
  'Restaurant',
  'ProfessionalService',
]);

function fingerprint(ruleId: string, subject: string, key = ''): string {
  return sha256Hex(`${ruleId}|${subject}|${key}`);
}

class IssueCollector {
  readonly issues: DetectedIssue[] = [];

  add(
    ruleId: string,
    url: string | null,
    description: string,
    evidence: Record<string, unknown> = {},
    severity?: IssueSeverity,
    key = '',
  ) {
    const rule = requireAuditRule(ruleId);
    this.issues.push({
      ruleId,
      category: rule.category,
      severity: severity ?? rule.severity,
      scope: rule.scope,
      url: rule.scope === 'site' ? null : url,
      title: rule.title,
      description,
      evidence,
      suggestedFix: rule.fix,
      fingerprint: fingerprint(ruleId, rule.scope === 'site' ? 'site' : (url ?? 'site'), key),
    });
  }
}

const isNoindex = (p: AnalysisPage) =>
  /\bnoindex\b|\bnone\b/i.test(`${p.metaRobots ?? ''} ${p.xRobotsTag ?? ''}`);
const selfUrl = (p: AnalysisPage) => p.finalUrl ?? p.url;
const stripTrailingSlash = (u: string) =>
  u.endsWith('/') && new URL(u).pathname !== '/' ? u.slice(0, -1) : u;
const sameUrl = (a: string, b: string) => stripTrailingSlash(a) === stripTrailingSlash(b);

function words(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared += 1;
  return shared / (a.size + b.size - shared);
}

function popcount32(x: number): number {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  x = (x + (x >>> 4)) & 0x0f0f0f0f;
  return Math.imul(x, 0x01010101) >>> 24;
}

/** The `keep` smallest values of two ascending lists of distinct numbers, ascending. */
function smallest(a: readonly number[], b: readonly number[], keep = SIMILAR_URLS): number[] {
  const out: number[] = [];
  let i = 0;
  let j = 0;
  while (out.length < keep && (i < a.length || j < b.length)) {
    if (j >= b.length || (i < a.length && a[i]! < b[j]!)) out.push(a[i++]!);
    else out.push(b[j++]!);
  }
  return out;
}

/** Pages sharing one key (a normalized title or a content fingerprint), as indexes in page order. */
interface PageGroup {
  members: number[];
  /** Pages in other groups that are near duplicates of this one: how many, and the first few in page order. */
  nearCount: number;
  nearFirst: number[];
}

const newGroup = (): PageGroup => ({ members: [], nearCount: 0, nearFirst: [] });

function linkNear(a: PageGroup, b: PageGroup) {
  a.nearCount += b.members.length;
  a.nearFirst = smallest(a.nearFirst, b.members.slice(0, SIMILAR_URLS));
  b.nearCount += a.members.length;
  b.nearFirst = smallest(b.nearFirst, a.members.slice(0, SIMILAR_URLS));
}

/**
 * Groups of pages whose titles are near duplicates: word-set Jaccard similarity at or above the threshold t, with
 * identical titles left to the exact-duplicate rule. Prefix filtering (PPJoin): with words ordered rarest first, two
 * titles reaching t always share a word between the probing prefix of the larger one and the indexing prefix of the
 * smaller one, and the smaller one has at least t × the larger size. Titles are processed smallest first, so only
 * pairs that can reach t are compared and the result equals comparing every pair of pages.
 * Returns false when the comparison budget ran out.
 */
function linkNearDuplicateTitles(groups: (PageGroup & { words: string[] })[]): boolean {
  const t = THRESHOLDS.nearDuplicateJaccard;
  // Minimum shared words, rounded so that floating-point error can only lengthen a prefix.
  const atLeast = (fraction: number, size: number) => Math.ceil(fraction * size - 1e-9);
  const frequency = new Map<string, number>();
  for (const g of groups) for (const w of g.words) frequency.set(w, (frequency.get(w) ?? 0) + 1);
  for (const g of groups)
    g.words.sort((a, b) => frequency.get(a)! - frequency.get(b)! || (a < b ? -1 : a > b ? 1 : 0));
  const order = groups.map((_, i) => i);
  order.sort((a, b) => groups[a]!.words.length - groups[b]!.words.length || a - b);
  const sets = groups.map((g) => new Set(g.words));
  // Word → groups whose indexing prefix contains it, in processing order (so by ascending size).
  const postings = new Map<string, number[]>();
  const comparedWith = new Int32Array(groups.length).fill(-1);
  let comparisons = 0;
  for (const gi of order) {
    const g = groups[gi]!;
    const size = g.words.length;
    const minSize = atLeast(t, size);
    const probe = size - atLeast(t, size) + 1;
    for (let k = 0; k < probe; k++) {
      const list = postings.get(g.words[k]!);
      if (!list) continue;
      // Skip titles too small to reach the threshold (binary search: the list is ordered by size).
      let low = 0;
      let high = list.length;
      while (low < high) {
        const mid = (low + high) >>> 1;
        if (groups[list[mid]!]!.words.length < minSize) low = mid + 1;
        else high = mid;
      }
      for (let p = low; p < list.length; p++) {
        const gj = list[p]!;
        if (comparedWith[gj] === gi) continue;
        comparedWith[gj] = gi;
        if (++comparisons > THRESHOLDS.nearDuplicateTitleComparisons) return false;
        if (jaccard(sets[gi]!, sets[gj]!) >= t) linkNear(g, groups[gj]!);
      }
    }
    const indexed = size - atLeast((2 * t) / (1 + t), size) + 1;
    for (let k = 0; k < indexed; k++) {
      const list = postings.get(g.words[k]!);
      if (list) list.push(gi);
      else postings.set(g.words[k]!, [gi]);
    }
  }
  return true;
}

/** Bit widths of the six fingerprint blocks used to find near-duplicate content. */
const FINGERPRINT_BLOCKS = [11, 11, 11, 11, 10, 10] as const;

/**
 * Groups of pages whose 64-bit content fingerprints differ in at most `simhashDistance` (3) bits. Split into six
 * blocks, two such fingerprints agree exactly on at least three blocks, so every pair is found under one of the 20
 * three-block keys (compared once, under the first three blocks it agrees on). Long keys keep buckets small even when
 * many pages share a template, and the result equals comparing every pair. Returns false when the budget ran out.
 */
function linkNearDuplicateContent(groups: (PageGroup & { hi: number; lo: number })[]): boolean {
  const width = FINGERPRINT_BLOCKS.length;
  const blocks = new Int32Array(groups.length * width);
  groups.forEach((g, gi) => {
    let value = (BigInt(g.hi) << 32n) | BigInt(g.lo);
    FINGERPRINT_BLOCKS.forEach((bits, k) => {
      blocks[gi * width + k] = Number(value & ((1n << BigInt(bits)) - 1n));
      value >>= BigInt(bits);
    });
  });
  let comparisons = 0;
  for (let a = 0; a < width; a++)
    for (let b = a + 1; b < width; b++)
      for (let c = b + 1; c < width; c++) {
        const buckets = new Map<number, number[]>();
        for (let gi = 0; gi < groups.length; gi++) {
          const x = gi * width;
          // Blocks are at most 11 bits, so this key is exact.
          const key = blocks[x + a]! + blocks[x + b]! * 2048 + blocks[x + c]! * 4_194_304;
          const bucket = buckets.get(key);
          if (!bucket) {
            buckets.set(key, [gi]);
            continue;
          }
          for (const gj of bucket) {
            if (++comparisons > THRESHOLDS.nearDuplicateContentComparisons) return false;
            const y = gj * width;
            let comparedEarlier = false;
            for (let k = 0; k < c && !comparedEarlier; k++)
              comparedEarlier = k !== a && k !== b && blocks[x + k] === blocks[y + k];
            if (comparedEarlier) continue;
            const p = groups[gi]!;
            const q = groups[gj]!;
            if (popcount32(p.hi ^ q.hi) + popcount32(p.lo ^ q.lo) <= THRESHOLDS.simhashDistance)
              linkNear(p, q);
          }
          bucket.push(gi);
        }
      }
  return true;
}

function checkPage(
  page: AnalysisPage,
  c: IssueCollector,
  byUrl: Map<string, AnalysisPage>,
  inlinks: Map<string, number>,
) {
  const url = page.url;
  // ---------- HTTP and fetch errors ----------
  if (page.fetchErrorCode === 'TOO_MANY_REDIRECTS' || page.fetchErrorCode === 'REDIRECT_LOOP') {
    c.add('redirect-loop', url, `The URL did not resolve after following redirects (${page.fetchError}).`, {
      redirectChain: page.redirectChain,
    });
  } else if (
    page.fetchError &&
    page.statusCode === null &&
    !['BLOCKED', 'DISALLOWED', 'CANCELLED'].includes(page.fetchErrorCode ?? '')
  ) {
    c.add('fetch-failed', url, `The page could not be fetched: ${page.fetchError}.`, {
      error: page.fetchError,
      code: page.fetchErrorCode,
    });
  }
  if (page.statusCode !== null && page.statusCode >= 500) {
    c.add('http-5xx', url, `The server returned HTTP ${page.statusCode}.`, { statusCode: page.statusCode });
  } else if (page.statusCode !== null && page.statusCode >= 400) {
    c.add('http-4xx', url, `The page returned HTTP ${page.statusCode}.`, { statusCode: page.statusCode });
  }
  if (page.redirectChain.length >= 2) {
    c.add(
      'redirect-chain',
      url,
      `This URL passes through ${page.redirectChain.length} redirects before reaching ${page.finalUrl ?? 'its destination'}.`,
      {
        chain: [...page.redirectChain, { url: page.finalUrl, statusCode: page.statusCode }],
      },
    );
  }
  if (page.inSitemap) {
    const problems: string[] = [];
    if (page.statusCode !== 200)
      problems.push(page.statusCode === null ? 'could not be fetched' : `returns HTTP ${page.statusCode}`);
    if (page.redirectChain.length) problems.push('redirects');
    if (page.analyzed && isNoindex(page)) problems.push('is marked noindex');
    if (page.analyzed && page.canonicals[0] && !sameUrl(page.canonicals[0], selfUrl(page)))
      problems.push('canonicalizes to another URL');
    if (problems.length)
      c.add('sitemap-non-indexable-url', url, `Listed in the sitemap but ${problems.join(', ')}.`, {
        problems,
      });
  }
  if (!page.analyzed) return;

  // ---------- Crawlability & indexability ----------
  const noindex = isNoindex(page);
  if (noindex)
    c.add(
      'page-noindex',
      url,
      'A robots directive (meta robots or X-Robots-Tag) excludes this page from indexing.',
      { metaRobots: page.metaRobots, xRobotsTag: page.xRobotsTag },
    );
  if (page.canonicals.length > 1)
    c.add('canonical-multiple', url, `Found ${page.canonicals.length} canonical tags.`, {
      canonicals: page.canonicals,
    });
  const canonical = page.canonicals[0];
  if (!canonical && !noindex) c.add('canonical-missing', url, 'No canonical link element was found.');
  if (canonical && !sameUrl(canonical, selfUrl(page))) {
    const target = byUrl.get(canonical);
    if (target && (target.statusCode !== 200 || target.redirectChain.length > 0)) {
      c.add(
        'canonical-target-error',
        url,
        `The canonical URL ${canonical} returns ${target.statusCode ?? 'an error'}${target.redirectChain.length ? ' after redirecting' : ''}.`,
        { canonical, targetStatus: target.statusCode },
      );
    } else {
      c.add('canonical-points-elsewhere', url, `The canonical URL points to ${canonical}.`, { canonical });
    }
  }

  // ---------- Metadata ----------
  const title = page.title?.trim() ?? '';
  if (!title) c.add('title-missing', url, 'The page has no <title> element or it is empty.');
  else if (title.length > THRESHOLDS.titleMax)
    c.add('title-too-long', url, `The title is ${title.length} characters long.`, {
      title,
      length: title.length,
    });
  else if (title.length < THRESHOLDS.titleMin)
    c.add('title-too-short', url, `The title is only ${title.length} characters long.`, {
      title,
      length: title.length,
    });
  const description = page.metaDescription?.trim() ?? '';
  if (!description && !noindex) c.add('meta-description-missing', url, 'No meta description was found.');
  else if (description.length > THRESHOLDS.descriptionMax)
    c.add(
      'meta-description-too-long',
      url,
      `The meta description is ${description.length} characters long.`,
      { description, length: description.length },
    );
  else if (description && description.length < THRESHOLDS.descriptionMin)
    c.add(
      'meta-description-too-short',
      url,
      `The meta description is only ${description.length} characters long.`,
      { description, length: description.length },
    );
  if (!page.ogTitle && !page.ogDescription)
    c.add('og-tags-missing', url, 'Neither og:title nor og:description is set.');

  // ---------- Content structure ----------
  if (page.h1Count === 0) c.add('h1-missing', url, 'The page has no H1 heading.');
  else if (page.h1Count > 1)
    c.add('h1-multiple', url, `The page has ${page.h1Count} H1 headings.`, {
      h1s: page.headings
        .filter((h) => h.level === 1)
        .map((h) => h.text)
        .slice(0, 5),
    });
  const skips: string[] = [];
  for (let i = 1; i < page.headings.length; i++) {
    const prev = page.headings[i - 1]!;
    const curr = page.headings[i]!;
    if (curr.level > prev.level + 1)
      skips.push(`H${prev.level} → H${curr.level} ("${curr.text.slice(0, 60)}")`);
  }
  if (skips.length)
    c.add('heading-level-skipped', url, `Heading levels jump ${skips.length} time(s).`, {
      examples: skips.slice(0, 5),
    });
  if (!page.lang) c.add('missing-lang', url, 'The <html> element has no lang attribute.');
  if (!noindex && page.wordCount < THRESHOLDS.thinWords)
    c.add('thin-content', url, `The page has about ${page.wordCount} words of visible text.`, {
      wordCount: page.wordCount,
    });

  // ---------- Images ----------
  if (page.imagesMissingAlt > 0)
    c.add(
      'img-missing-alt',
      url,
      `${page.imagesMissingAlt} of ${page.imagesTotal} images have no alt attribute.`,
      { missing: page.imagesMissingAlt, total: page.imagesTotal },
    );
  if (page.imagesMissingDimensions > 0)
    c.add(
      'img-missing-dimensions',
      url,
      `${page.imagesMissingDimensions} images have no width/height attributes.`,
      { count: page.imagesMissingDimensions },
    );

  // ---------- Structured data ----------
  const parseErrors = page.jsonLd.filter((b) => b.error);
  if (parseErrors.length)
    c.add('jsonld-parse-error', url, `${parseErrors.length} JSON-LD block(s) could not be parsed.`, {
      errors: parseErrors.map((b) => ({ block: b.index + 1, message: b.error })),
    });
  if (page.jsonLd.some((b) => b.missingType))
    c.add('jsonld-missing-type', url, 'A JSON-LD object has no @type.');
  if (page.jsonLd.some((b) => !b.error && b.missingContext))
    c.add('jsonld-missing-context', url, 'A JSON-LD block has no schema.org @context.');
  const missingProps = page.jsonLd.flatMap((b) => b.requiredMissing);
  if (missingProps.length) {
    c.add(
      'jsonld-required-props',
      url,
      `Structured data is missing ${missingProps.map((m) => `${m.type}: ${m.props.join(', ')}`).join('; ')}.`,
      { missing: missingProps.slice(0, 10) },
    );
  }

  // ---------- Performance observations ----------
  if (page.responseTimeMs !== null && page.responseTimeMs > THRESHOLDS.slowMs) {
    c.add(
      'slow-response',
      url,
      `The server took ${page.responseTimeMs} ms to respond.`,
      { responseTimeMs: page.responseTimeMs },
      page.responseTimeMs > THRESHOLDS.verySlowMs ? 'HIGH' : 'MEDIUM',
    );
  }
  if (page.contentLength !== null && page.contentLength > THRESHOLDS.largeHtmlBytes) {
    c.add('large-html', url, `The HTML document is ${(page.contentLength / 1024 / 1024).toFixed(1)} MB.`, {
      bytes: page.contentLength,
    });
  }
  if (!page.compressed && page.contentLength !== null && page.contentLength > THRESHOLDS.compressMinBytes) {
    c.add(
      'uncompressed-response',
      url,
      `${Math.round(page.contentLength / 1024)} KB of HTML was served without gzip or Brotli.`,
      { bytes: page.contentLength },
    );
  }
  if (!page.hasViewport) c.add('viewport-missing', url, 'No viewport meta tag was found.');
  if (page.blockingScriptsInHead >= THRESHOLDS.blockingScripts)
    c.add('many-blocking-scripts', url, `${page.blockingScriptsInHead} synchronous scripts load in <head>.`, {
      count: page.blockingScriptsInHead,
    });
  if (page.insecureResources.length)
    c.add('mixed-content', url, `${page.insecureResources.length} resource(s) load over insecure HTTP.`, {
      resources: page.insecureResources.slice(0, 10),
    });

  // ---------- Internal links ----------
  if (page.internalLinks.length === 0)
    c.add('no-internal-outlinks', url, 'The page does not link to any other page on the site.');
  const broken: { url: string; status: number | null }[] = [];
  const redirecting: string[] = [];
  for (const link of page.internalLinks) {
    const target = byUrl.get(link.url);
    if (!target) continue;
    if (
      (target.statusCode !== null && target.statusCode >= 400) ||
      (target.statusCode === null && target.fetchError && target.fetchErrorCode !== 'DISALLOWED')
    ) {
      broken.push({ url: link.url, status: target.statusCode });
    } else if (target.redirectChain.length > 0 && target.url === link.url) {
      redirecting.push(link.url);
    }
  }
  if (broken.length)
    c.add('broken-internal-link', url, `${broken.length} internal link(s) on this page lead to errors.`, {
      brokenLinks: broken.slice(0, 20),
    });
  if (redirecting.length)
    c.add(
      'internal-link-to-redirect',
      url,
      `${redirecting.length} internal link(s) point to redirecting URLs.`,
      { links: redirecting.slice(0, 20) },
    );
  const generic = page.genericAnchors;
  if (generic.length)
    c.add('generic-anchor-text', url, `${generic.length} internal link(s) use generic anchor text.`, {
      examples: generic.slice(0, 5).map((l) => ({ anchor: l.anchorText, url: l.url })),
    });
  const nofollow = page.internalLinks.filter((l) => l.nofollow);
  if (nofollow.length)
    c.add('nofollow-internal-links', url, `${nofollow.length} internal link(s) have rel="nofollow".`, {
      links: nofollow.slice(0, 10).map((l) => l.url),
    });
  if (page.depth > THRESHOLDS.maxDepth)
    c.add('deep-page', url, `The page is ${page.depth} clicks from the start page.`, { depth: page.depth });
  if (page.inSitemap && page.source !== 'SEED' && (inlinks.get(url) ?? 0) === 0) {
    c.add('orphan-page', url, 'The page is listed in the sitemap but no crawled page links to it.');
  }
}

function checkDuplicates(indexable: AnalysisPage[], c: IssueCollector, limitations: string[]) {
  const group = (key: (p: AnalysisPage) => string | null) => {
    const groups = new Map<string, AnalysisPage[]>();
    for (const p of indexable) {
      const k = key(p);
      if (!k) continue;
      const list = groups.get(k);
      if (list) list.push(p);
      else groups.set(k, [p]);
    }
    return [...groups.values()].filter((g) => g.length > 1);
  };
  /** The first pages of a group other than `p`, in page order. */
  const otherUrls = (pages: AnalysisPage[], p: AnalysisPage) =>
    pages
      .slice(0, SIMILAR_URLS + 1)
      .filter((o) => o !== p)
      .slice(0, SIMILAR_URLS)
      .map((o) => o.url);
  for (const pages of group((p) => p.title?.trim().toLowerCase() || null)) {
    for (const p of pages) {
      c.add('title-duplicate', p.url, `${pages.length} pages share the title "${p.title}".`, {
        title: p.title,
        otherUrls: otherUrls(pages, p),
      });
    }
  }
  for (const pages of group((p) => p.metaDescription?.trim().toLowerCase() || null)) {
    for (const p of pages) {
      c.add('meta-description-duplicate', p.url, `${pages.length} pages share the same meta description.`, {
        otherUrls: otherUrls(pages, p),
      });
    }
  }

  // Near duplicates, across every indexable page.
  const titleGroups = new Map<string, PageGroup & { words: string[] }>();
  const contentGroups = new Map<string, PageGroup & { hi: number; lo: number }>();
  indexable.forEach((p, i) => {
    const title = (p.title ?? '').trim().toLowerCase();
    if (title) {
      let g = titleGroups.get(title);
      if (!g) titleGroups.set(title, (g = { ...newGroup(), words: [...words(title)] }));
      g.members.push(i);
    }
    const hash = p.contentHash?.toLowerCase();
    if (hash && /^[0-9a-f]{16}$/.test(hash)) {
      let g = contentGroups.get(hash);
      if (!g) {
        g = { ...newGroup(), hi: parseInt(hash.slice(0, 8), 16), lo: parseInt(hash.slice(8), 16) };
        contentGroups.set(hash, g);
      }
      g.members.push(i);
    }
  });
  const count = (n: number) => n.toLocaleString('en-US');

  const titled = [...titleGroups.values()].filter((g) => g.words.length > 0);
  if (!linkNearDuplicateTitles(titled))
    limitations.push(
      `Near-duplicate title checks stopped after ${count(THRESHOLDS.nearDuplicateTitleComparisons)} comparisons because very many titles are almost the same, so some near-duplicate titles may be missing.`,
    );
  for (const g of titled) {
    if (!g.nearCount) continue;
    for (const i of g.members) {
      c.add(
        'title-near-duplicate',
        indexable[i]!.url,
        `The title is nearly identical to ${g.nearCount} other page(s).`,
        { title: indexable[i]!.title, similarUrls: g.nearFirst.map((k) => indexable[k]!.url) },
      );
    }
  }

  const fingerprinted = [...contentGroups.values()];
  if (!linkNearDuplicateContent(fingerprinted))
    limitations.push(
      `Near-duplicate content checks stopped after ${count(THRESHOLDS.nearDuplicateContentComparisons)} comparisons because very many pages are almost the same, so some near-duplicate pages may be missing.`,
    );
  for (const g of fingerprinted) {
    const similar = g.members.length - 1 + g.nearCount;
    if (!similar) continue;
    for (const i of g.members) {
      const sameText = g.members
        .slice(0, SIMILAR_URLS + 1)
        .filter((m) => m !== i)
        .slice(0, SIMILAR_URLS);
      c.add(
        'duplicate-content',
        indexable[i]!.url,
        `The visible text is nearly identical to ${similar} other page(s).`,
        {
          similarUrls: smallest(sameText, g.nearFirst).map((k) => indexable[k]!.url),
        },
      );
    }
  }
}

function checkSite(
  input: AnalysisInput,
  pages: AnalysisPage[],
  byUrl: Map<string, AnalysisPage>,
  c: IssueCollector,
) {
  const { crawl } = input;
  if (crawl.robots.status === 'missing')
    c.add(
      'robots-txt-missing',
      null,
      `${crawl.robots.url || '/robots.txt'} returned HTTP ${crawl.robots.statusCode}.`,
      { url: crawl.robots.url, statusCode: crawl.robots.statusCode },
    );
  if (crawl.robots.status === 'unreachable')
    c.add(
      'robots-txt-unreachable',
      null,
      `robots.txt could not be fetched (${crawl.robots.error ?? 'server error'}), so the site was not crawled.`,
      { url: crawl.robots.url, error: crawl.robots.error },
    );

  if (crawl.robots.status !== 'unreachable') {
    const sitemapErrors = crawl.sitemap.files.filter((f) => f.error);
    const allMissing =
      crawl.sitemap.files.length > 0 &&
      sitemapErrors.length === crawl.sitemap.files.length &&
      sitemapErrors.every((f) => f.statusCode === 404 || f.statusCode === 410);
    if (!crawl.sitemap.found && (crawl.sitemap.files.length === 0 || allMissing)) {
      c.add('sitemap-missing', null, 'No XML sitemap was declared in robots.txt or found at /sitemap.xml.', {
        checked: crawl.sitemap.files.map((f) => f.url),
      });
    } else if (sitemapErrors.length && !allMissing) {
      c.add('sitemap-error', null, `${sitemapErrors.length} sitemap file(s) could not be read.`, {
        files: sitemapErrors.slice(0, 10),
      });
    }
  }

  const root = new URL(crawl.rootUrl);
  if (root.protocol === 'http:')
    c.add('http-not-https', null, 'The site is served over plain HTTP.', { rootUrl: crawl.rootUrl });
  else if (crawl.httpsRedirect === 'not_redirected')
    c.add('http-not-https', null, `http://${root.host}/ does not redirect to HTTPS.`, {
      rootUrl: crawl.rootUrl,
    });

  // One pass over the link graph finds the crawled pages linking to each blocked URL.
  const linkedFrom = new Map(
    crawl.blockedByRobots.map((u) => [
      u,
      { count: 0, first: [] as string[], last: null as AnalysisPage | null },
    ]),
  );
  if (linkedFrom.size)
    for (const p of pages)
      for (const link of p.internalLinks) {
        const entry = linkedFrom.get(link.url);
        if (!entry || entry.last === p) continue;
        entry.last = p;
        entry.count += 1;
        if (entry.first.length < 10) entry.first.push(p.url);
      }
  for (const blockedUrl of crawl.blockedByRobots) {
    const entry = linkedFrom.get(blockedUrl)!;
    if (entry.count)
      c.add(
        'blocked-by-robots',
        blockedUrl,
        `robots.txt disallows this URL, but ${entry.count} crawled page(s) link to it.`,
        { foundOn: entry.first },
      );
  }

  const analyzed = pages.filter((p) => p.analyzed);
  if (analyzed.length) {
    if (!analyzed.some((p) => p.structuredDataTypes.length > 0)) {
      c.add(
        'structured-data-none',
        null,
        `None of the ${analyzed.length} analyzed pages contain structured data.`,
      );
    }
    const rootPage = byUrl.get(crawl.rootUrl) ?? analyzed.find((p) => p.source === 'SEED');
    if (rootPage?.analyzed && !rootPage.structuredDataTypes.some((t) => ORG_TYPES.has(t))) {
      c.add(
        'organization-schema-missing',
        null,
        'The start page has no Organization or LocalBusiness structured data.',
        { types: rootPage.structuredDataTypes },
      );
    }
    if (analyzed.reduce((sum, p) => sum + p.questionHeadings, 0) === 0) {
      c.add(
        'aeo-no-question-headings',
        null,
        `None of the ${analyzed.length} analyzed pages contain question-style headings.`,
      );
    }
  }
}

export function analyzeSite(input: AnalysisInput): AnalysisResult {
  const pages = input.pages;
  const byUrl = new Map<string, AnalysisPage>();
  for (const p of pages) {
    byUrl.set(p.url, p);
    if (p.finalUrl && !byUrl.has(p.finalUrl)) byUrl.set(p.finalUrl, p);
  }
  // Inlinks = number of distinct crawled pages linking to a URL, crediting the final page when a
  // link points at a redirecting URL. A page's links are visited together and page URLs are unique
  // within a crawl, so remembering the last linking page per URL counts each linking page once.
  const sources = new Map<string, { count: number; last: string }>();
  const credit = (target: string, from: string) => {
    if (target === from) return;
    const entry = sources.get(target);
    if (!entry) sources.set(target, { count: 1, last: from });
    else if (entry.last !== from) {
      entry.count += 1;
      entry.last = from;
    }
  };
  for (const p of pages) {
    for (const link of p.internalLinks) {
      credit(link.url, p.url);
      const resolved = byUrl.get(link.url);
      if (resolved?.finalUrl && resolved.url === link.url) credit(resolved.finalUrl, p.url);
      else if (resolved && resolved.url !== link.url) credit(resolved.url, p.url);
    }
  }
  const inlinks = new Map([...sources.entries()].map(([url, entry]) => [url, entry.count]));

  const indexability = new Map<string, { indexable: boolean; reason: string | null }>();
  for (const p of pages) {
    let reason: string | null = null;
    if (p.statusCode === null) reason = 'Not fetched';
    else if (p.statusCode >= 300 && p.statusCode < 400) reason = `HTTP ${p.statusCode}`;
    else if (p.redirectChain.length) reason = 'Redirects';
    else if (p.statusCode !== 200) reason = `HTTP ${p.statusCode}`;
    else if (!p.isHtml) reason = 'Not HTML';
    else if (isNoindex(p)) reason = 'noindex';
    else if (p.canonicals[0] && !sameUrl(p.canonicals[0], selfUrl(p))) reason = 'Canonicalized elsewhere';
    indexability.set(p.url, { indexable: reason === null, reason });
  }

  const collector = new IssueCollector();
  const limitations: string[] = [];
  for (const page of pages) checkPage(page, collector, byUrl, inlinks);
  const indexable = pages.filter((p) => p.analyzed && indexability.get(p.url)?.indexable);
  checkDuplicates(indexable, collector, limitations);
  checkSite(input, pages, byUrl, collector);

  if (input.crawl.stoppedReason === 'page_limit' || input.crawl.limitReached) {
    limitations.push(
      'The crawl reached a page cap (set on the project, the plan or the server), so some pages were not analyzed. Remove the cap to crawl every page.',
    );
  }
  if (input.crawl.loopUrlsSkipped)
    limitations.push(
      `${input.crawl.loopUrlsSkipped} link(s) were not followed by loop protection: URLs with many query-string variants of the same path (such as calendars or filters) or longer than 2,048 characters.`,
    );
  if (input.crawl.stoppedReason === 'cancelled')
    limitations.push('The crawl was cancelled before it finished; results are partial.');
  if (input.crawl.stoppedReason === 'robots_unreachable')
    limitations.push(
      'robots.txt could not be fetched, so no pages were crawled (crawlers must assume the whole site is disallowed).',
    );
  const listedBlocked = input.crawl.blockedByRobots.length;
  const blockedTotal = Math.max(input.crawl.blockedByRobotsTotal ?? 0, listedBlocked);
  if (blockedTotal)
    limitations.push(
      blockedTotal > listedBlocked
        ? `${blockedTotal} URL(s) were skipped because robots.txt disallows them; links to the first ${listedBlocked} were checked.`
        : `${blockedTotal} URL(s) were skipped because robots.txt disallows them.`,
    );
  limitations.push(
    'Links to URLs that were not crawled (blocked by robots.txt, skipped by loop protection or beyond a page cap) were not checked. Rendering of JavaScript-only content is not performed.',
  );

  // Deterministic order: severity, then rule, then URL.
  const rank: Record<IssueSeverity, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
  collector.issues.sort(
    (a, b) =>
      rank[a.severity] - rank[b.severity] ||
      a.ruleId.localeCompare(b.ruleId) ||
      (a.url ?? '').localeCompare(b.url ?? ''),
  );

  const analyzedCount = pages.filter((p) => p.analyzed).length;
  const score = computeAuditScore(collector.issues, analyzedCount);
  const issueCounts: IssueCounts = {
    total: collector.issues.length,
    bySeverity: Object.fromEntries(ISSUE_SEVERITIES.map((s) => [s, 0])) as Record<IssueSeverity, number>,
    byCategory: Object.fromEntries(AUDIT_CATEGORIES.map((cat) => [cat, 0])) as Record<AuditCategory, number>,
  };
  for (const issue of collector.issues) {
    issueCounts.bySeverity[issue.severity] += 1;
    issueCounts.byCategory[issue.category] += 1;
  }
  return {
    issues: collector.issues,
    score,
    issueCounts,
    pagesAnalyzed: analyzedCount,
    inlinks,
    indexability,
    limitations,
  };
}
