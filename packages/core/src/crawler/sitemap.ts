// XML sitemap discovery: urlset and sitemapindex documents, optionally gzip-compressed.
// Bounded by URL count, number of sitemap files and nesting depth.
import { gunzipSync } from 'node:zlib';
import { XMLParser } from 'fast-xml-parser';
import type { SafeFetcher } from './fetcher';
import { normalizeCrawlUrl } from './url-utils';

export interface SitemapFileInfo {
  url: string;
  statusCode: number | null;
  type: 'urlset' | 'index' | 'unknown';
  urlCount: number;
  error: string | null;
}

export interface SitemapDiscovery {
  files: SitemapFileInfo[];
  urls: string[];
  truncated: boolean;
  /** True when at least one sitemap was found and parsed. */
  found: boolean;
}

export interface SitemapOptions {
  maxUrls?: number;
  maxFiles?: number;
  maxDepth?: number;
  inScope?: (url: string) => boolean;
  signal?: AbortSignal;
}

const parser = new XMLParser({
  ignoreAttributes: true,
  removeNSPrefix: true,
  trimValues: true,
  processEntities: true,
});

function toArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/** Parses a sitemap document. Exported for unit tests. */
export function parseSitemapXml(xml: string): { type: 'urlset' | 'index' | 'unknown'; locs: string[] } {
  const doc = parser.parse(xml) as Record<string, unknown>;
  const urlset = doc.urlset as { url?: { loc?: unknown } | { loc?: unknown }[] } | undefined;
  if (urlset) {
    return {
      type: 'urlset',
      locs: toArray(urlset.url)
        .map((u) => String(u?.loc ?? ''))
        .filter(Boolean),
    };
  }
  const index = doc.sitemapindex as { sitemap?: { loc?: unknown } | { loc?: unknown }[] } | undefined;
  if (index) {
    return {
      type: 'index',
      locs: toArray(index.sitemap)
        .map((s) => String(s?.loc ?? ''))
        .filter(Boolean),
    };
  }
  return { type: 'unknown', locs: [] };
}

function decodeBody(body: Buffer): string {
  // Gzip magic bytes: 1f 8b. Cap decompressed size to 50 MB (the sitemap protocol limit).
  if (body.length > 2 && body[0] === 0x1f && body[1] === 0x8b) {
    return gunzipSync(body, { maxOutputLength: 50 * 1024 * 1024 }).toString('utf8');
  }
  return body.toString('utf8');
}

export async function discoverSitemaps(
  fetcher: SafeFetcher,
  candidates: string[],
  options: SitemapOptions = {},
): Promise<SitemapDiscovery> {
  const maxUrls = options.maxUrls ?? 10_000;
  const maxFiles = options.maxFiles ?? 25;
  const maxDepth = options.maxDepth ?? 3;
  const files: SitemapFileInfo[] = [];
  const urls = new Set<string>();
  const seenFiles = new Set<string>();
  let truncated = false;
  const queue = candidates.map((url) => ({ url, depth: 0 }));

  while (queue.length && files.length < maxFiles) {
    const { url, depth } = queue.shift()!;
    const normalized = normalizeCrawlUrl(url);
    if (!normalized || seenFiles.has(normalized)) continue;
    seenFiles.add(normalized);

    const result = await fetcher.fetch(normalized, {
      accept: 'application/xml,text/xml;q=0.9,*/*;q=0.5',
      maxBodyBytes: 20 * 1024 * 1024,
      signal: options.signal,
    });
    const info: SitemapFileInfo = {
      url: normalized,
      statusCode: result.statusCode,
      type: 'unknown',
      urlCount: 0,
      error: null,
    };
    files.push(info);
    if (result.error || result.statusCode === null || result.statusCode >= 400 || !result.body) {
      info.error = result.error?.message ?? `HTTP ${result.statusCode}`;
      continue;
    }
    try {
      const parsed = parseSitemapXml(decodeBody(result.body));
      info.type = parsed.type;
      if (parsed.type === 'unknown') {
        info.error = 'Not a valid urlset or sitemapindex document';
        continue;
      }
      info.urlCount = parsed.locs.length;
      if (parsed.type === 'index') {
        if (depth >= maxDepth) {
          truncated = true;
          continue;
        }
        for (const loc of parsed.locs) queue.push({ url: loc, depth: depth + 1 });
      } else {
        for (const loc of parsed.locs) {
          const pageUrl = normalizeCrawlUrl(loc);
          if (!pageUrl || (options.inScope && !options.inScope(pageUrl))) continue;
          if (urls.size >= maxUrls) {
            truncated = true;
            break;
          }
          urls.add(pageUrl);
        }
      }
    } catch (error) {
      info.error = `Could not parse sitemap: ${error instanceof Error ? error.message.slice(0, 200) : 'unknown error'}`;
    }
  }
  if (queue.length) truncated = true;
  return { files, urls: [...urls], truncated, found: files.some((f) => f.type !== 'unknown' && !f.error) };
}
