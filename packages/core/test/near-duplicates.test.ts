// Near-duplicate detection runs on every indexable page with indexed matching. These tests compare it with the
// straightforward all-pairs comparison it replaced, on generated pages with deliberate near-duplicate clusters.
import { describe, expect, it } from 'vitest';
import { analyzeSite, type AnalysisInput, type AnalysisPage, type CrawlContext } from '../src/audit';

const NEAR_RULES = new Set(['title-near-duplicate', 'duplicate-content']);

function analysisPage(url: string, overrides: Partial<AnalysisPage> = {}): AnalysisPage {
  return {
    url,
    finalUrl: null,
    depth: 1,
    source: 'LINK',
    statusCode: 200,
    responseTimeMs: 120,
    contentLength: 8000,
    redirectChain: [],
    isHtml: true,
    compressed: true,
    xRobotsTag: null,
    fetchError: null,
    fetchErrorCode: null,
    inSitemap: false,
    analyzed: true,
    title: null,
    titleCount: 1,
    metaDescription: null,
    metaDescriptionCount: 0,
    canonicals: [],
    metaRobots: null,
    lang: 'en',
    headings: [],
    h1Count: 1,
    imagesTotal: 0,
    imagesMissingAlt: 0,
    imagesMissingDimensions: 0,
    jsonLd: [],
    structuredDataTypes: [],
    hasViewport: true,
    ogTitle: null,
    ogDescription: null,
    wordCount: 600,
    contentHash: null,
    blockingScriptsInHead: 0,
    insecureResources: [],
    questionHeadings: 0,
    hasFaqContent: false,
    internalLinks: [],
    genericAnchors: [],
    ...overrides,
  };
}

const crawl: CrawlContext = {
  rootUrl: 'https://dup.example.test/',
  robots: {
    url: 'https://dup.example.test/robots.txt',
    status: 'ok',
    statusCode: 200,
    sitemaps: [],
    crawlDelaySec: null,
    disallowAll: false,
    error: null,
  },
  sitemap: { files: [], truncated: false, found: false, urlCount: 0 },
  httpsRedirect: 'ok',
  blockedByRobots: [],
  stoppedReason: null,
  limitReached: false,
};

/** Deterministic pseudo-random numbers (mulberry32). */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const VOCABULARY = Array.from({ length: 120 }, (_, i) => `word${i}`);

/** Pages with clusters of similar titles (shared words, one word changed, reordered) and similar fingerprints. */
function generatePages(count: number, seed: number): AnalysisPage[] {
  const random = rng(seed);
  const pick = <T>(items: readonly T[]) => items[Math.floor(random() * items.length)]!;
  const baseTitles: string[][] = [];
  const baseHashes: bigint[] = [];
  const pages: AnalysisPage[] = [];
  for (let i = 0; i < count; i++) {
    let words: string[];
    const roll = random();
    if (baseTitles.length && roll < 0.55) {
      words = [...pick(baseTitles)];
      const edit = random();
      if (edit < 0.3) words[Math.floor(random() * words.length)] = pick(VOCABULARY);
      else if (edit < 0.5) words.push(pick(VOCABULARY));
      else if (edit < 0.65 && words.length > 1) words.splice(Math.floor(random() * words.length), 1);
      else if (edit < 0.8) words.reverse();
      // otherwise an exact duplicate title
    } else {
      words = Array.from({ length: 1 + Math.floor(random() * 14) }, () => pick(VOCABULARY));
      baseTitles.push(words);
    }
    const titleRoll = random();
    const title =
      titleRoll < 0.04
        ? null
        : titleRoll < 0.06
          ? ' — '
          : `${random() < 0.5 ? '  ' : ''}${words.join(random() < 0.5 ? ' ' : ' | ')}${random() < 0.2 ? '  ' : ''}`;

    let hash: bigint | null;
    const hashRoll = random();
    if (hashRoll < 0.08) hash = null;
    else if (baseHashes.length && hashRoll < 0.6) {
      hash = pick(baseHashes);
      const flips = Math.floor(random() * 6); // 0–5 bits: some within the 3-bit threshold, some not
      for (let f = 0; f < flips; f++) hash ^= 1n << BigInt(Math.floor(random() * 64));
    } else {
      hash = BigInt(Math.floor(random() * 2 ** 32)) * 2n ** 32n + BigInt(Math.floor(random() * 2 ** 32));
      baseHashes.push(hash);
    }
    pages.push(
      analysisPage(`https://dup.example.test/p/${i}`, {
        title,
        contentHash: hash === null ? null : hash.toString(16).padStart(16, '0'),
      }),
    );
  }
  return pages;
}

/** The all-pairs comparison the indexed matching replaced (for indexable pages, in page order). */
function bruteForce(pages: AnalysisPage[]) {
  const words = (text: string) => new Set(text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
  const jaccard = (a: Set<string>, b: Set<string>) => {
    if (!a.size || !b.size) return 0;
    let shared = 0;
    for (const w of a) if (b.has(w)) shared += 1;
    return shared / (a.size + b.size - shared);
  };
  const popcount = (x: bigint) => {
    let n = 0;
    while (x) {
      x &= x - 1n;
      n += 1;
    }
    return n;
  };
  const titleWords = pages.map((p) => words(p.title ?? ''));
  const hashes = pages.map((p) => (p.contentHash ? BigInt(`0x${p.contentHash}`) : null));
  const nearTitle = new Map<number, string[]>();
  const nearContent = new Map<number, string[]>();
  for (let i = 0; i < pages.length; i++) {
    for (let j = i + 1; j < pages.length; j++) {
      const ta = (pages[i]!.title ?? '').trim().toLowerCase();
      const tb = (pages[j]!.title ?? '').trim().toLowerCase();
      if (ta && tb && ta !== tb && jaccard(titleWords[i]!, titleWords[j]!) >= 0.85) {
        nearTitle.set(i, [...(nearTitle.get(i) ?? []), pages[j]!.url]);
        nearTitle.set(j, [...(nearTitle.get(j) ?? []), pages[i]!.url]);
      }
      const ha = hashes[i];
      const hb = hashes[j];
      if (ha != null && hb != null && popcount(ha ^ hb) <= 3) {
        nearContent.set(i, [...(nearContent.get(i) ?? []), pages[j]!.url]);
        nearContent.set(j, [...(nearContent.get(j) ?? []), pages[i]!.url]);
      }
    }
  }
  const issues = new Map<string, { description: string; evidence: Record<string, unknown> }>();
  for (const [i, others] of nearTitle)
    issues.set(`title-near-duplicate ${pages[i]!.url}`, {
      description: `The title is nearly identical to ${others.length} other page(s).`,
      evidence: { title: pages[i]!.title, similarUrls: others.slice(0, 10) },
    });
  for (const [i, others] of nearContent)
    issues.set(`duplicate-content ${pages[i]!.url}`, {
      description: `The visible text is nearly identical to ${others.length} other page(s).`,
      evidence: { similarUrls: others.slice(0, 10) },
    });
  return issues;
}

function nearIssues(pages: AnalysisPage[]) {
  const input: AnalysisInput = { pages, crawl };
  const result = analyzeSite(input);
  const issues = new Map<string, { description: string; evidence: Record<string, unknown> }>();
  for (const issue of result.issues)
    if (NEAR_RULES.has(issue.ruleId))
      issues.set(`${issue.ruleId} ${issue.url}`, {
        description: issue.description,
        evidence: issue.evidence,
      });
  return { issues, limitations: result.limitations };
}

describe('near-duplicate detection', () => {
  it.each([1, 2, 3, 4])('matches the all-pairs comparison exactly (seed %i)', (seed) => {
    const pages = generatePages(700, seed);
    const expected = bruteForce(pages);
    const { issues, limitations } = nearIssues(pages);
    // The generated clusters must actually exercise both rules.
    expect([...expected.keys()].filter((k) => k.startsWith('title-near')).length).toBeGreaterThan(20);
    expect([...expected.keys()].filter((k) => k.startsWith('duplicate-content')).length).toBeGreaterThan(20);
    expect(issues).toEqual(expected);
    expect(limitations.join(' ')).not.toMatch(/Near-duplicate/);
  });

  it('compares every indexable page, not only the first ones', () => {
    const filler = generatePages(4000, 9).map((p, i) =>
      // Unique titles and fingerprints far apart from each other, so only the planted pair is similar.
      ({
        ...p,
        title: `Unique page ${i} about ${i * 7919}`,
        contentHash: ((BigInt(i) * 0x9e3779b97f4a7c15n) % 2n ** 64n).toString(16).padStart(16, '0'),
      }),
    );
    filler[3500] = {
      ...filler[3500]!,
      title: 'Waterproof hiking boots for wet trails and rocky paths',
      contentHash: 'f0f0f0f0f0f0f0f0',
    };
    filler[3900] = {
      ...filler[3900]!,
      title: 'Waterproof hiking boots for wet trails and rocky paths!',
      contentHash: 'f0f0f0f0f0f0f0f1',
    };
    const { issues, limitations } = nearIssues(filler);
    expect(issues.get(`duplicate-content ${filler[3500]!.url}`)?.evidence.similarUrls).toEqual([
      filler[3900]!.url,
    ]);
    // Same words, different punctuation: a near duplicate rather than an exact one.
    expect(issues.get(`title-near-duplicate ${filler[3900]!.url}`)?.evidence.similarUrls).toEqual([
      filler[3500]!.url,
    ]);
    expect(limitations.join(' ')).not.toMatch(/limited to the first|Near-duplicate/);
  });

  it('counts large groups of identical pages without comparing every pair', () => {
    const pages = Array.from({ length: 3000 }, (_, i) =>
      analysisPage(`https://dup.example.test/same/${i}`, {
        title: 'Same template page',
        contentHash: '0123456789abcdef',
      }),
    );
    const { issues } = nearIssues(pages);
    const first = issues.get(`duplicate-content ${pages[0]!.url}`)!;
    expect(first.description).toBe('The visible text is nearly identical to 2999 other page(s).');
    expect(first.evidence.similarUrls).toEqual(pages.slice(1, 11).map((p) => p.url));
    const late = issues.get(`duplicate-content ${pages[2500]!.url}`)!;
    expect(late.evidence.similarUrls).toEqual(pages.slice(0, 10).map((p) => p.url));
    // Identical titles are exact duplicates, never near duplicates.
    expect([...issues.keys()].some((k) => k.startsWith('title-near'))).toBe(false);
  });
});
