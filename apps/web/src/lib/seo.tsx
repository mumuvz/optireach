// Per-page <head> metadata. During prerendering, <Seo> reports its data to a collector provided by
// entry-server.tsx and the tags are written into the static HTML. In the browser, it updates the
// managed tags (marked data-seo) after client-side navigation, so both paths produce the same head.
import { createContext, useContext, useEffect } from 'react';
import { APP_NAME, absoluteUrl } from './config';

export interface SeoData {
  title: string;
  description: string;
  /** Path of the canonical URL, e.g. "/pricing". */
  path: string;
  noindex?: boolean;
  ogType?: 'website' | 'article';
  image?: string;
  jsonLd?: Record<string, unknown> | Record<string, unknown>[];
  publishedTime?: string;
}

export interface HeadCollector {
  data: SeoData | null;
}

export const HeadContext = createContext<HeadCollector | null>(null);

const DEFAULT_IMAGE = '/og-image.png';

export function fullTitle(title: string): string {
  return title.includes(APP_NAME) ? title : `${title} | ${APP_NAME}`;
}

const escapeAttr = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** JSON for a <script type="application/ld+json"> block; "<" and line separators are escaped so the script cannot be closed early. */
const BACKSLASH = String.fromCharCode(92);
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);
export function jsonLdText(value: unknown): string {
  return JSON.stringify(value)
    .split('<')
    .join(`${BACKSLASH}u003c`)
    .split(LINE_SEPARATOR)
    .join(`${BACKSLASH}u2028`)
    .split(PARAGRAPH_SEPARATOR)
    .join(`${BACKSLASH}u2029`);
}

interface TagSpec {
  tag: 'meta' | 'link';
  attrs: Record<string, string>;
}

function tagSpecs(data: SeoData): TagSpec[] {
  const url = absoluteUrl(data.path);
  const image = absoluteUrl(data.image ?? DEFAULT_IMAGE);
  const title = fullTitle(data.title);
  const specs: TagSpec[] = [
    { tag: 'meta', attrs: { name: 'description', content: data.description } },
    { tag: 'link', attrs: { rel: 'canonical', href: url } },
    { tag: 'meta', attrs: { property: 'og:type', content: data.ogType ?? 'website' } },
    { tag: 'meta', attrs: { property: 'og:site_name', content: APP_NAME } },
    { tag: 'meta', attrs: { property: 'og:title', content: title } },
    { tag: 'meta', attrs: { property: 'og:description', content: data.description } },
    { tag: 'meta', attrs: { property: 'og:url', content: url } },
    { tag: 'meta', attrs: { property: 'og:image', content: image } },
    { tag: 'meta', attrs: { name: 'twitter:card', content: 'summary_large_image' } },
    { tag: 'meta', attrs: { name: 'twitter:title', content: title } },
    { tag: 'meta', attrs: { name: 'twitter:description', content: data.description } },
  ];
  if (data.publishedTime)
    specs.push({ tag: 'meta', attrs: { property: 'article:published_time', content: data.publishedTime } });
  if (data.noindex) specs.push({ tag: 'meta', attrs: { name: 'robots', content: 'noindex, nofollow' } });
  return specs;
}

/** Serialized head tags for the prerendered HTML. */
export function renderHeadTags(data: SeoData): string {
  const lines = [`<title>${escapeAttr(fullTitle(data.title))}</title>`];
  for (const spec of tagSpecs(data)) {
    const attrs = Object.entries(spec.attrs)
      .map(([k, v]) => `${k}="${escapeAttr(v)}"`)
      .join(' ');
    lines.push(`<${spec.tag} ${attrs} data-seo>`);
  }
  const blocks = data.jsonLd ? (Array.isArray(data.jsonLd) ? data.jsonLd : [data.jsonLd]) : [];
  for (const block of blocks)
    lines.push(`<script type="application/ld+json" data-seo>${jsonLdText(block)}</script>`);
  return lines.join('\n    ');
}

function applyHead(data: SeoData): void {
  document.title = fullTitle(data.title);
  document.head.querySelectorAll('[data-seo]').forEach((el) => el.remove());
  for (const spec of tagSpecs(data)) {
    const el = document.createElement(spec.tag);
    for (const [k, v] of Object.entries(spec.attrs)) el.setAttribute(k, v);
    el.setAttribute('data-seo', '');
    document.head.appendChild(el);
  }
  const blocks = data.jsonLd ? (Array.isArray(data.jsonLd) ? data.jsonLd : [data.jsonLd]) : [];
  for (const block of blocks) {
    const script = document.createElement('script');
    script.type = 'application/ld+json';
    script.setAttribute('data-seo', '');
    script.textContent = jsonLdText(block);
    document.head.appendChild(script);
  }
}

export function Seo(props: SeoData) {
  const collector = useContext(HeadContext);
  // Server render: record synchronously; effects do not run during prerendering.
  if (collector) collector.data = props;
  const key = JSON.stringify(props);
  useEffect(() => {
    applyHead(JSON.parse(key) as SeoData);
  }, [key]);
  return null;
}

/** Dashboard pages: a plain document title (the SPA shell is already noindex). */
export function usePageTitle(title: string): void {
  useEffect(() => {
    document.title = fullTitle(title);
  }, [title]);
}
