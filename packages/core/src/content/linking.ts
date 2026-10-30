import { escapeHtml, type FaqItem, type InternalLinkSuggestion } from '@surfaced/shared';
import { renderMarkdown } from '@surfaced/shared/markdown';
import type { PrismaClient } from '../db';

const STOPWORDS = new Set(
  'a an and are as at be best by can do does for from guide how in is it of on or our the to top vs what when where which who why with your you'.split(
    ' ',
  ),
);

function tokens(text: string): Set<string> {
  return new Set(
    (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length > 2 && !STOPWORDS.has(w)),
  );
}

/**
 * Internal link suggestions from the project's latest completed crawl: indexable pages whose title or
 * H1 shares topic terms with the content. Uses only real crawled pages; returns [] without a crawl.
 */
export async function suggestInternalLinks(
  prisma: PrismaClient,
  projectId: string,
  topic: { keyword: string; title: string; secondary?: string[]; excludeUrl?: string | null },
  limit = 8,
): Promise<{ suggestions: InternalLinkSuggestion[]; crawledAt: string | null }> {
  const crawl = await prisma.crawlJob.findFirst({
    where: { projectId, status: 'SUCCEEDED' },
    orderBy: { finishedAt: 'desc' },
    select: { id: true, finishedAt: true },
  });
  if (!crawl) return { suggestions: [], crawledAt: null };
  const pages = await prisma.crawledPage.findMany({
    where: { crawlJobId: crawl.id, isIndexable: true },
    select: { url: true, title: true, h1: true },
    take: 5000,
  });
  const wanted = tokens([topic.keyword, topic.title, ...(topic.secondary ?? [])].join(' '));
  const scored = pages
    .filter((p) => p.url !== topic.excludeUrl)
    .map((p) => {
      const pageTokens = tokens(`${p.title ?? ''} ${p.h1 ?? ''}`);
      const shared = [...wanted].filter((t) => pageTokens.has(t));
      return { page: p, shared };
    })
    .filter((s) => s.shared.length > 0)
    .sort((a, b) => b.shared.length - a.shared.length || a.page.url.length - b.page.url.length)
    .slice(0, limit);
  return {
    suggestions: scored.map(({ page, shared }) => ({
      url: page.url,
      anchorText: (page.h1 || page.title || page.url).trim().slice(0, 80),
      reason: `Shares topic terms: ${shared.slice(0, 5).join(', ')}`,
    })),
    crawledAt: crawl.finishedAt?.toISOString() ?? null,
  };
}

export interface JsonLdInput {
  title: string;
  description: string | null;
  url: string | null;
  language: string;
  brandName: string;
  brandUrl: string | null;
  faqs: FaqItem[];
  dateModified: Date;
}

/**
 * Article (+ FAQPage when FAQs exist) JSON-LD describing the document. Publish FAQPage markup only if
 * the questions and answers are visible on the page; structured data does not guarantee rich results.
 */
export function buildArticleJsonLd(input: JsonLdInput): Record<string, unknown> {
  const article: Record<string, unknown> = {
    '@type': 'Article',
    headline: input.title.slice(0, 110),
    inLanguage: input.language,
    dateModified: input.dateModified.toISOString(),
    publisher: {
      '@type': 'Organization',
      name: input.brandName,
      ...(input.brandUrl ? { url: input.brandUrl } : {}),
    },
  };
  if (input.description) article.description = input.description;
  if (input.url) article.mainEntityOfPage = { '@type': 'WebPage', '@id': input.url };
  const graph: Record<string, unknown>[] = [article];
  if (input.faqs.length) {
    graph.push({
      '@type': 'FAQPage',
      mainEntity: input.faqs.map((f) => ({
        '@type': 'Question',
        name: f.question,
        acceptedAnswer: { '@type': 'Answer', text: f.answer },
      })),
    });
  }
  return { '@context': 'https://schema.org', '@graph': graph };
}

export interface ExportInput {
  title: string;
  metaTitle: string | null;
  metaDescription: string | null;
  body: string;
  faqs: FaqItem[];
  schemaJsonLd: unknown;
  language: string;
}

export function exportMarkdown(input: ExportInput): string {
  const front = ['---', `title: ${JSON.stringify(input.title)}`];
  if (input.metaTitle) front.push(`metaTitle: ${JSON.stringify(input.metaTitle)}`);
  if (input.metaDescription) front.push(`metaDescription: ${JSON.stringify(input.metaDescription)}`);
  front.push('---', '');
  const faq = input.faqs.length
    ? `\n\n## Frequently asked questions\n\n${input.faqs.map((f) => `### ${f.question}\n\n${f.answer}`).join('\n\n')}`
    : '';
  return `${front.join('\n')}# ${input.title}\n\n${input.body.trim()}${faq}\n`;
}

/** Standalone HTML export. The body comes from safe Markdown rendering (raw HTML is escaped). */
export function exportHtml(input: ExportInput): string {
  const faqHtml = input.faqs.length
    ? `<section><h2>Frequently asked questions</h2>${input.faqs.map((f) => `<h3>${escapeHtml(f.question)}</h3><p>${escapeHtml(f.answer)}</p>`).join('')}</section>`
    : '';
  // JSON-LD inside <script>: escape "<" so the content can never close the script element.
  const jsonLd = input.schemaJsonLd
    ? `<script type="application/ld+json">${JSON.stringify(input.schemaJsonLd).replace(/</g, '\\u003c')}</script>`
    : '';
  return `<!doctype html>
<html lang="${escapeHtml(input.language)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(input.metaTitle || input.title)}</title>
${input.metaDescription ? `<meta name="description" content="${escapeHtml(input.metaDescription)}">` : ''}
${jsonLd}
</head>
<body>
<article>
<h1>${escapeHtml(input.title)}</h1>
${renderMarkdown(input.body)}
${faqHtml}
</article>
</body>
</html>
`;
}
