import * as cheerio from 'cheerio';
import { countWords } from '@surfaced/shared';
import { normalizeCrawlUrl } from './url-utils';

export interface ExtractedLink {
  url: string;
  anchorText: string;
  nofollow: boolean;
}

export interface ExtractedImage {
  src: string | null;
  hasAlt: boolean;
  hasDimensions: boolean;
}

export interface JsonLdBlock {
  index: number;
  types: string[];
  error: string | null;
  missingContext: boolean;
  missingType: boolean;
  requiredMissing: { type: string; props: string[] }[];
}

export interface PageExtract {
  /** Links whose anchor text is generic ("click here"), collected before URL de-duplication. */
  genericAnchors: ExtractedLink[];
  title: string | null;
  titleCount: number;
  metaDescription: string | null;
  metaDescriptionCount: number;
  canonicals: string[];
  metaRobots: string | null;
  lang: string | null;
  headings: { level: number; text: string }[];
  h1: string | null;
  h1Count: number;
  links: ExtractedLink[];
  images: ExtractedImage[];
  jsonLd: JsonLdBlock[];
  structuredDataTypes: string[];
  microdataTypes: string[];
  hasViewport: boolean;
  ogTitle: string | null;
  ogDescription: string | null;
  ogImage: string | null;
  wordCount: number;
  /** Visible text (truncated) used for near-duplicate fingerprints. */
  text: string;
  blockingScriptsInHead: number;
  insecureResources: string[];
  questionHeadings: number;
  hasFaqContent: boolean;
}

/** Key properties checked for common schema.org types (a pragmatic subset, not full validation). */
const REQUIRED_PROPS: Record<string, string[]> = {
  Organization: ['name', 'url'],
  Corporation: ['name', 'url'],
  LocalBusiness: ['name', 'address'],
  Article: ['headline'],
  BlogPosting: ['headline'],
  NewsArticle: ['headline'],
  Product: ['name'],
  FAQPage: ['mainEntity'],
  QAPage: ['mainEntity'],
  BreadcrumbList: ['itemListElement'],
  Event: ['name', 'startDate'],
  Recipe: ['name'],
  HowTo: ['name', 'step'],
  VideoObject: ['name', 'thumbnailUrl', 'uploadDate'],
  WebSite: ['name', 'url'],
  SoftwareApplication: ['name'],
};

const QUESTION_START = /^(what|how|why|when|where|who|which|can|could|does|do|is|are|should|will|would)\b/i;
const GENERIC_ANCHORS = new Set([
  'click here',
  'here',
  'read more',
  'more',
  'learn more',
  'this',
  'link',
  'click',
  'details',
  'continue',
]);

export function isGenericAnchor(text: string): boolean {
  return GENERIC_ANCHORS.has(
    text
      .trim()
      .toLowerCase()
      .replace(/[.!…»›→]+$/u, '')
      .trim(),
  );
}
const MAX_LINKS = 500;
const MAX_HEADINGS = 100;

function clean(text: string | undefined | null): string {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}

function typesOf(node: Record<string, unknown>): string[] {
  const raw = node['@type'];
  if (typeof raw === 'string') return [raw];
  if (Array.isArray(raw)) return raw.filter((t): t is string => typeof t === 'string');
  return [];
}

function analyzeJsonLd(raw: string, index: number): JsonLdBlock {
  const block: JsonLdBlock = {
    index,
    types: [],
    error: null,
    missingContext: false,
    missingType: false,
    requiredMissing: [],
  };
  let data: unknown;
  try {
    data = JSON.parse(raw.trim());
  } catch (error) {
    block.error = error instanceof Error ? error.message.slice(0, 200) : 'Invalid JSON';
    return block;
  }
  const roots = Array.isArray(data) ? data : [data];
  for (const root of roots) {
    if (!root || typeof root !== 'object') continue;
    const rootObj = root as Record<string, unknown>;
    const context = rootObj['@context'];
    if (
      !(typeof context === 'string' && /schema\.org/i.test(context)) &&
      !(typeof context === 'object' && context !== null)
    ) {
      block.missingContext = true;
    }
    const graph = Array.isArray(rootObj['@graph']) ? (rootObj['@graph'] as unknown[]) : [rootObj];
    for (const item of graph) {
      if (!item || typeof item !== 'object') continue;
      const node = item as Record<string, unknown>;
      const types = typesOf(node);
      if (types.length === 0) {
        if (!('@graph' in node)) block.missingType = true;
        continue;
      }
      block.types.push(...types);
      for (const type of types) {
        const required = REQUIRED_PROPS[type];
        if (!required) continue;
        const missing = required.filter(
          (prop) => node[prop] === undefined || node[prop] === null || node[prop] === '',
        );
        if (missing.length) block.requiredMissing.push({ type, props: missing });
      }
    }
  }
  return block;
}

export function extractPage(html: string, pageUrl: string): PageExtract {
  const $ = cheerio.load(html);
  // A line break separates words ("Elegant<br>Digital" reads as two words, not "ElegantDigital").
  $('br').replaceWith(' ');
  const baseHref = $('base[href]').first().attr('href');
  const base = (baseHref && normalizeCrawlUrl(baseHref, pageUrl)) || pageUrl;
  const isHttps = pageUrl.startsWith('https:');

  const titles = $('head title, title').toArray();
  const metaDescriptions = $('meta[name="description" i]').toArray();
  const canonicals = $('link[rel~="canonical" i]')
    .toArray()
    .map((el) => normalizeCrawlUrl($(el).attr('href') ?? '', base))
    .filter((u): u is string => Boolean(u));

  const headings: { level: number; text: string }[] = [];
  $('h1, h2, h3, h4, h5, h6').each((_i, el) => {
    if (headings.length >= MAX_HEADINGS) return false;
    headings.push({ level: Number(el.tagName.slice(1)), text: clean($(el).text()).slice(0, 300) });
    return undefined;
  });
  const h1s = headings.filter((h) => h.level === 1);

  const links: ExtractedLink[] = [];
  const genericAnchors: ExtractedLink[] = [];
  const seenLinks = new Set<string>();
  $('a[href]').each((_i, el) => {
    if (links.length >= MAX_LINKS) return false;
    const href = ($(el).attr('href') ?? '').trim();
    if (!href || /^(javascript|mailto|tel|data|sms):/i.test(href) || href.startsWith('#')) return undefined;
    const url = normalizeCrawlUrl(href, base);
    if (!url) return undefined;
    const rel = ($(el).attr('rel') ?? '').toLowerCase();
    let anchorText = clean($(el).text());
    if (!anchorText) anchorText = clean($(el).find('img[alt]').first().attr('alt'));
    const link = { url, anchorText: anchorText.slice(0, 255), nofollow: /\bnofollow\b/.test(rel) };
    if (isGenericAnchor(link.anchorText) && genericAnchors.length < 20) genericAnchors.push(link);
    if (seenLinks.has(url)) return undefined;
    seenLinks.add(url);
    links.push(link);
    return undefined;
  });

  const images: ExtractedImage[] = $('img')
    .toArray()
    .slice(0, 500)
    .map((el) => {
      const node = $(el);
      const src = node.attr('src') ?? node.attr('data-src') ?? null;
      return {
        src: src ? normalizeCrawlUrl(src, base) : null,
        hasAlt: node.attr('alt') !== undefined,
        hasDimensions: node.attr('width') !== undefined && node.attr('height') !== undefined,
      };
    });

  const jsonLd = $('script[type="application/ld+json" i]')
    .toArray()
    .slice(0, 50)
    .map((el, index) => analyzeJsonLd($(el).text(), index));
  const microdataTypes = [
    ...new Set(
      $('[itemscope][itemtype]')
        .toArray()
        .map((el) => ($(el).attr('itemtype') ?? '').split('/').pop() ?? '')
        .filter(Boolean),
    ),
  ];
  const structuredDataTypes = [...new Set([...jsonLd.flatMap((b) => b.types), ...microdataTypes])];

  const blockingScriptsInHead = $('head script[src]')
    .toArray()
    .filter((el) => {
      const node = $(el);
      return (
        node.attr('async') === undefined &&
        node.attr('defer') === undefined &&
        (node.attr('type') ?? '').toLowerCase() !== 'module'
      );
    }).length;

  const insecureResources = isHttps
    ? [
        ...$('img[src^="http:" i], script[src^="http:" i], iframe[src^="http:" i], source[src^="http:" i]')
          .toArray()
          .map((el) => $(el).attr('src') ?? ''),
        ...$('link[rel~="stylesheet" i][href^="http:" i]')
          .toArray()
          .map((el) => $(el).attr('href') ?? ''),
      ]
        .filter(Boolean)
        .slice(0, 20)
    : [];

  const questionHeadings = headings.filter(
    (h) => h.level >= 2 && (h.text.endsWith('?') || QUESTION_START.test(h.text)),
  ).length;
  const hasFaqContent =
    questionHeadings >= 2 ||
    structuredDataTypes.some((t) => t === 'FAQPage' || t === 'QAPage') ||
    $('[id*="faq" i], [class*="faq" i]').length > 0;

  // Visible text: drop non-content elements before reading body text.
  $('script, style, noscript, template, svg, iframe').remove();
  const text = clean($('body').text() || $.root().text());

  return {
    genericAnchors,
    title: titles.length ? clean($(titles[0]).text()).slice(0, 1024) || null : null,
    titleCount: titles.length,
    metaDescription: metaDescriptions.length ? clean($(metaDescriptions[0]).attr('content')) || null : null,
    metaDescriptionCount: metaDescriptions.length,
    canonicals,
    metaRobots: clean($('meta[name="robots" i]').first().attr('content')).toLowerCase() || null,
    lang: clean($('html').attr('lang')) || null,
    headings,
    h1: h1s[0]?.text ?? null,
    h1Count: h1s.length,
    links,
    images,
    jsonLd,
    structuredDataTypes,
    microdataTypes,
    hasViewport: $('meta[name="viewport" i]').length > 0,
    ogTitle: clean($('meta[property="og:title" i]').attr('content')) || null,
    ogDescription: clean($('meta[property="og:description" i]').attr('content')) || null,
    ogImage: clean($('meta[property="og:image" i]').attr('content')) || null,
    wordCount: countWords(text),
    text: text.slice(0, 50_000),
    blockingScriptsInHead,
    insecureResources,
    questionHeadings,
    hasFaqContent,
  };
}
