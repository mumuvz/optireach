import { stripWww } from '@surfaced/shared';
import { sha256Hex } from '../crypto';

const TRACKING_PARAMS =
  /^(utm_[a-z_]+|gclid|gbraid|wbraid|fbclid|msclkid|mc_cid|mc_eid|_hsenc|_hsmi|yclid|igshid)$/i;

const NON_HTML_EXTENSIONS = new Set([
  'jpg',
  'jpeg',
  'png',
  'gif',
  'webp',
  'avif',
  'svg',
  'ico',
  'bmp',
  'tif',
  'tiff',
  'css',
  'js',
  'mjs',
  'map',
  'json',
  'xml',
  'txt',
  'csv',
  'rss',
  'atom',
  'pdf',
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
  'odt',
  'rtf',
  'zip',
  'gz',
  'tgz',
  'rar',
  '7z',
  'tar',
  'dmg',
  'exe',
  'msi',
  'apk',
  'iso',
  'mp3',
  'mp4',
  'm4a',
  'wav',
  'ogg',
  'webm',
  'mov',
  'avi',
  'mkv',
  'flac',
  'woff',
  'woff2',
  'ttf',
  'otf',
  'eot',
]);

/**
 * Canonical form used to deduplicate crawl targets: absolute http(s), no fragment, lower-case host,
 * default port removed, tracking parameters removed. The path and remaining query are preserved
 * because they can change the content served.
 */
export function normalizeCrawlUrl(raw: string, base?: string): string | null {
  let url: URL;
  try {
    url = base ? new URL(raw, base) : new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  url.hash = '';
  url.hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  if ((url.protocol === 'http:' && url.port === '80') || (url.protocol === 'https:' && url.port === '443'))
    url.port = '';
  if (url.search) {
    const kept = [...url.searchParams.entries()].filter(([key]) => !TRACKING_PARAMS.test(key));
    url.search = kept.length ? new URLSearchParams(kept).toString() : '';
  }
  if (!url.pathname) url.pathname = '/';
  return url.toString();
}

export function urlHash(normalizedUrl: string): string {
  return sha256Hex(normalizedUrl);
}

/** Same site = same registrable host (ignoring "www."), optionally including subdomains. */
export function isInScope(url: string, rootHost: string, includeSubdomains: boolean): boolean {
  let host: string;
  try {
    host = stripWww(new URL(url).hostname.toLowerCase());
  } catch {
    return false;
  }
  const root = stripWww(rootHost.toLowerCase());
  return host === root || (includeSubdomains && host.endsWith(`.${root}`));
}

/** Skips URLs whose extension clearly indicates a non-HTML asset. */
export function looksLikeHtmlUrl(url: string): boolean {
  try {
    const path = new URL(url).pathname.toLowerCase();
    const last = path.split('/').pop() ?? '';
    const dot = last.lastIndexOf('.');
    if (dot === -1) return true;
    return !NON_HTML_EXTENSIONS.has(last.slice(dot + 1));
  } catch {
    return false;
  }
}

export function isHtmlContentType(contentType: string | null | undefined): boolean {
  if (!contentType) return false;
  const type = contentType.split(';')[0]?.trim().toLowerCase();
  return type === 'text/html' || type === 'application/xhtml+xml';
}
