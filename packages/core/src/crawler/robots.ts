// robots.txt handling following RFC 9309:
//  - 2xx: parse and obey; 4xx: no restrictions; 5xx/unreachable: assume complete disallow.
import robotsParser from 'robots-parser';
import type { SafeFetcher } from './fetcher';

export type RobotsStatus = 'ok' | 'missing' | 'unreachable';

export interface RobotsInfo {
  url: string;
  status: RobotsStatus;
  statusCode: number | null;
  sitemaps: string[];
  /** Crawl-delay for our user agent in seconds, if declared. */
  crawlDelaySec: number | null;
  disallowAll: boolean;
  error: string | null;
  isAllowed(url: string): boolean;
}

/** Product token used for robots.txt group matching, e.g. "SurfacedBot" from "SurfacedBot/0.1 (+...)". */
export function robotsAgentToken(userAgent: string): string {
  return userAgent.split(/[\s/]/)[0] || userAgent;
}

const MAX_ROBOTS_BYTES = 512 * 1024; // RFC 9309 requires parsing at least 500 KiB

export async function fetchRobots(
  fetcher: SafeFetcher,
  origin: string,
  signal?: AbortSignal,
): Promise<RobotsInfo> {
  const url = `${origin}/robots.txt`;
  const token = robotsAgentToken(fetcher.userAgent);
  let result = await fetcher.fetch(url, {
    accept: 'text/plain,*/*;q=0.5',
    maxBodyBytes: MAX_ROBOTS_BYTES,
    signal,
  });
  if (result.error || (result.statusCode !== null && result.statusCode >= 500)) {
    // One retry for transient failures before assuming "disallow all".
    result = await fetcher.fetch(url, {
      accept: 'text/plain,*/*;q=0.5',
      maxBodyBytes: MAX_ROBOTS_BYTES,
      signal,
    });
  }

  if (result.error || result.statusCode === null || result.statusCode >= 500) {
    return {
      url,
      status: 'unreachable',
      statusCode: result.statusCode,
      sitemaps: [],
      crawlDelaySec: null,
      disallowAll: true,
      error: result.error?.message ?? `HTTP ${result.statusCode}`,
      isAllowed: () => false,
    };
  }
  if (result.statusCode >= 400) {
    return {
      url,
      status: 'missing',
      statusCode: result.statusCode,
      sitemaps: [],
      crawlDelaySec: null,
      disallowAll: false,
      error: null,
      isAllowed: () => true,
    };
  }

  const robots = robotsParser(url, result.body?.toString('utf8') ?? '');
  const delay = robots.getCrawlDelay(token);
  return {
    url,
    status: 'ok',
    statusCode: result.statusCode,
    sitemaps: robots.getSitemaps(),
    crawlDelaySec: typeof delay === 'number' && Number.isFinite(delay) ? delay : null,
    disallowAll:
      robots.isDisallowed(`${origin}/`, token) === true &&
      robots.isDisallowed(`${origin}/robots-probe-${Date.now()}`, token) === true,
    error: null,
    // URLs on other origins return undefined from robots-parser; treat as "not covered" (allowed).
    isAllowed: (target: string) => robots.isAllowed(target, token) !== false,
  };
}
