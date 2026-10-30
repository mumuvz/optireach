// Safe Markdown → HTML rendering used for content previews, exports and reports.
// Raw HTML in the Markdown source is escaped (never passed through), and link/image URLs are
// restricted to safe protocols, so LLM or user-provided Markdown cannot inject scripts.
import { Marked, type Tokens } from 'marked';
import { escapeHtml } from './util';

const SAFE_URL = /^(?:https?:|mailto:|#|\/(?!\/))/i;

function safeHref(href: string | null | undefined): string | null {
  if (!href) return null;
  const trimmed = href.trim();
  return SAFE_URL.test(trimmed) ? trimmed : null;
}

function createRenderer(): Marked {
  const marked = new Marked({ gfm: true, breaks: false, async: false });
  marked.use({
    renderer: {
      html(token: Tokens.HTML | Tokens.Tag) {
        return escapeHtml(token.text);
      },
      link(token: Tokens.Link) {
        const text = this.parser.parseInline(token.tokens);
        const href = safeHref(token.href);
        if (!href) return text;
        const title = token.title ? ` title="${escapeHtml(token.title)}"` : '';
        const external = /^https?:/i.test(href) ? ' rel="noopener noreferrer nofollow" target="_blank"' : '';
        return `<a href="${escapeHtml(href)}"${title}${external}>${text}</a>`;
      },
      image(token: Tokens.Image) {
        const href = safeHref(token.href);
        if (!href) return escapeHtml(token.text);
        const title = token.title ? ` title="${escapeHtml(token.title)}"` : '';
        return `<img src="${escapeHtml(href)}" alt="${escapeHtml(token.text)}"${title} loading="lazy">`;
      },
    },
  });
  return marked;
}

let renderer: Marked | null = null;

export function renderMarkdown(markdown: string): string {
  renderer ??= createRenderer();
  return renderer.parse(markdown, { async: false }) as string;
}

/** Extracts "## Heading" sections from Markdown (used for section regeneration). */
export interface MarkdownSection {
  heading: string;
  level: number;
  start: number;
  end: number;
}

export function listMarkdownSections(markdown: string): MarkdownSection[] {
  const lines = markdown.split('\n');
  const sections: MarkdownSection[] = [];
  let offset = 0;
  let inFence = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    const match = !inFence ? /^(#{2,3})\s+(.+?)\s*#*\s*$/.exec(line) : null;
    if (match) {
      const previous = sections[sections.length - 1];
      if (previous) previous.end = offset;
      sections.push({
        heading: match[2] ?? '',
        level: (match[1] ?? '').length,
        start: offset,
        end: markdown.length,
      });
    }
    offset += line.length + 1;
  }
  return sections;
}

/** Replaces the body of the section with the given heading (heading line included in `replacement`). */
export function replaceMarkdownSection(
  markdown: string,
  heading: string,
  replacement: string,
): string | null {
  const sections = listMarkdownSections(markdown);
  const index = sections.findIndex((s) => s.heading.trim().toLowerCase() === heading.trim().toLowerCase());
  if (index === -1) return null;
  const target = sections[index]!;
  // A section ends where the next heading of the same or higher level begins.
  let end = markdown.length;
  for (let i = index + 1; i < sections.length; i++) {
    const s = sections[i]!;
    if (s.level <= target.level) {
      end = s.start;
      break;
    }
  }
  const before = markdown.slice(0, target.start);
  const after = markdown.slice(end);
  const body = replacement.endsWith('\n') ? replacement : `${replacement}\n`;
  return `${before}${body}${after.startsWith('\n') || after === '' ? '' : '\n'}${after}`;
}
