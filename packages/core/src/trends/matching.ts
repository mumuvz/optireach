// Whether the project's crawled pages target a search term: the term's words together (as a phrase) in a page's
// address, title, main heading, one sub-heading or description. Words scattered over a page do not count.
import type { TrendPageField, TrendTerm, TrendTermStatus } from '@surfaced/shared';
import { contentTokens, contentWords } from '../competitors/gap';
import type { Prisma, PrismaClient } from '../db';

type Db = PrismaClient | Prisma.TransactionClient;

export interface PageWords {
  url: string;
  title: string | null;
  h1: string | null;
  headings: string[];
  fields: Record<TrendPageField, Set<string>>;
  /** Each field (each heading separately) as ordered words, for phrase matching. */
  phrases: { field: TrendPageField; tokens: string[] }[];
}

/** HTML pages of the latest completed crawl, as words per field. */
export async function loadSitePages(
  db: Db,
  projectId: string,
): Promise<{ crawl: { id: string; finishedAt: Date | null } | null; pages: PageWords[] }> {
  const crawl = await db.crawlJob.findFirst({
    where: { projectId, status: 'SUCCEEDED' },
    orderBy: { finishedAt: 'desc' },
    select: { id: true, finishedAt: true },
  });
  if (!crawl) return { crawl: null, pages: [] };
  const rows = await db.crawledPage.findMany({
    where: { crawlJobId: crawl.id, isHtml: true, statusCode: 200 },
    select: { url: true, title: true, h1: true, metaDescription: true, headings: true },
    take: 20_000,
  });
  const pages = rows.map((p) => {
    const headings = Array.isArray(p.headings)
      ? (p.headings as { level?: number; text?: string }[]).map((h) => (h.text ?? '').trim()).filter(Boolean)
      : [];
    let path = '';
    try {
      path = new URL(p.url).pathname.replace(/[-_/.]+/g, ' ');
    } catch {
      // keep empty
    }
    return {
      url: p.url,
      title: p.title,
      h1: p.h1,
      headings: headings.slice(0, 30),
      fields: {
        address: new Set(contentWords(path)),
        title: new Set(contentWords(p.title ?? '')),
        h1: new Set(contentWords(p.h1 ?? '')),
        heading: new Set(contentWords(headings.join(' '))),
        description: new Set(contentWords(p.metaDescription ?? '')),
      },
      phrases: [
        { field: 'address' as const, tokens: contentTokens(path) },
        { field: 'title' as const, tokens: contentTokens(p.title ?? '') },
        { field: 'h1' as const, tokens: contentTokens(p.h1 ?? '') },
        { field: 'description' as const, tokens: contentTokens(p.metaDescription ?? '') },
        ...headings.map((h) => ({ field: 'heading' as const, tokens: contentTokens(h) })),
      ],
    };
  });
  return { crawl, pages };
}

/**
 * True when `needle` occurs in `hay` in order, with at most `maxGap` other words between consecutive words
 * ("digital wedding invitations" contains "digital invitation").
 */
export function containsPhrase(hay: string[], needle: string[], maxGap = 1): boolean {
  if (!needle.length) return false;
  for (let i = 0; i < hay.length; i++) {
    if (hay[i] !== needle[0]) continue;
    let at = i;
    let ok = true;
    for (let k = 1; k < needle.length && ok; k++) {
      let found = -1;
      for (let p = at + 1; p <= Math.min(hay.length - 1, at + 1 + maxGap); p++)
        if (hay[p] === needle[k]) {
          found = p;
          break;
        }
      if (found === -1) ok = false;
      else at = found;
    }
    if (ok) return true;
  }
  return false;
}

const FIELD_ORDER: TrendPageField[] = ['title', 'h1', 'address', 'heading', 'description'];

export function matchTerm(term: string, pages: PageWords[]) {
  const tokens = contentTokens(term);
  const words = [...new Set(tokens)];
  const matched = new Set<string>();
  let allOnOnePage = false;
  const hits: (TrendTerm['pages'][number] & { weight: number })[] = [];
  for (const page of pages) {
    const all = new Set<string>();
    for (const set of Object.values(page.fields)) for (const w of set) all.add(w);
    for (const w of words) if (all.has(w)) matched.add(w);
    if (words.length && words.every((w) => all.has(w))) allOnOnePage = true;
    const fields = [
      ...new Set(page.phrases.filter((p) => containsPhrase(p.tokens, tokens)).map((p) => p.field)),
    ];
    if (fields.length)
      hits.push({
        url: page.url,
        title: page.title,
        fields: FIELD_ORDER.filter((f) => fields.includes(f)),
        weight: Math.min(...fields.map((f) => FIELD_ORDER.indexOf(f))),
      });
  }
  hits.sort((a, b) => a.weight - b.weight || a.url.length - b.url.length);
  return {
    words,
    matched: words.filter((w) => matched.has(w)),
    allOnOnePage,
    hits: hits.map(({ weight: _weight, ...hit }) => hit),
  };
}

/**
 * Present: a page targets the term in its title, main heading or address. Partial: the term is only mentioned in
 * sub-headings or descriptions, or its words are on the site but never together. Missing: neither.
 */
export function termCoverage(term: string, pages: PageWords[]) {
  const { words, matched, allOnOnePage, hits } = matchTerm(term, pages);
  const status: TrendTermStatus =
    hits.some((h) => h.fields.some((f) => f === 'title' || f === 'h1' || f === 'address')) // prettier-ignore
      ? 'present'
      : hits.length || allOnOnePage || matched.length * 2 >= words.length
        ? 'partial'
        : 'missing';
  return {
    status,
    matchedWords: matched,
    missingWords: words.filter((w) => !matched.includes(w)),
    pages: hits.slice(0, 5),
  };
}
