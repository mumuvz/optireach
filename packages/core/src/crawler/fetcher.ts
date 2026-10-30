// SSRF-safe HTTP fetcher used by the crawler, robots/sitemap discovery and competitor snapshots.
//  - DNS is resolved by our own `lookup`, which rejects non-public addresses; the socket connects
//    to exactly the validated address (no DNS-rebinding window).
//  - Redirects are followed manually so every hop is re-validated against the URL policy.
//  - Bodies are streamed and capped after decompression; requests have header/body timeouts.
import type { LookupFunction } from 'node:net';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import type { Readable } from 'node:stream';
import { Agent, request } from 'undici';
import { getEnv } from '../env';
import {
  UnsafeTargetError,
  assertUrlPolicy,
  resolvePublicAddresses,
  type Resolver,
  systemResolver,
} from './ssrf';

export interface RedirectHop {
  url: string;
  statusCode: number;
}

export interface FetchResult {
  requestedUrl: string;
  finalUrl: string;
  statusCode: number | null;
  headers: Record<string, string>;
  contentType: string | null;
  contentEncoding: string | null;
  redirectChain: RedirectHop[];
  body: Buffer | null;
  bodyTruncated: boolean;
  /** Time until response headers of the final hop. */
  responseTimeMs: number | null;
  totalTimeMs: number;
  error: { code: FetchErrorCode; message: string } | null;
}

export type FetchErrorCode =
  | 'BLOCKED'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'DNS_FAILURE'
  | 'CONNECTION_FAILED'
  | 'TOO_MANY_REDIRECTS'
  | 'REDIRECT_LOOP'
  | 'INVALID_REDIRECT'
  | 'DISALLOWED'
  | 'NETWORK_ERROR';

export interface FetchOptions {
  accept?: string;
  readBody?: boolean;
  maxBodyBytes?: number;
  signal?: AbortSignal;
  method?: 'GET' | 'HEAD';
  /** Called before every hop (including redirects); return false to stop, e.g. when robots.txt disallows the URL. */
  beforeRequest?: (url: URL) => Promise<boolean>;
}

export interface SafeFetcherOptions {
  userAgent?: string;
  timeoutMs?: number;
  maxBodyBytes?: number;
  maxRedirects?: number;
  /** host:port pairs reachable despite SSRF rules (development only). */
  allowlist?: string[];
  resolver?: Resolver;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function makeLookup(resolver: Resolver, allowlist: string[]): LookupFunction {
  return ((
    hostname: string,
    options: { all?: boolean; family?: number | string },
    callback: (...args: unknown[]) => void,
  ) => {
    const allowPrivate = allowlist.some((entry) => entry.startsWith(`${hostname.toLowerCase()}:`));
    resolvePublicAddresses(hostname, { resolver, allowPrivate })
      .then((addresses) => {
        const family =
          options.family === 'IPv4' ? 4 : options.family === 'IPv6' ? 6 : Number(options.family) || 0;
        const usable = family ? addresses.filter((a) => a.family === family) : addresses;
        if (usable.length === 0)
          return callback(new UnsafeTargetError('DNS_FAILURE', `No usable address for ${hostname}`));
        if (options.all)
          return callback(
            null,
            usable.map((a) => ({ address: a.address, family: a.family })),
          );
        return callback(null, usable[0]!.address, usable[0]!.family);
      })
      .catch((error) => callback(error));
  }) as unknown as LookupFunction;
}

function classify(error: unknown, signal?: AbortSignal): { code: FetchErrorCode; message: string } {
  if (error instanceof UnsafeTargetError) {
    return { code: error.violation === 'DNS_FAILURE' ? 'DNS_FAILURE' : 'BLOCKED', message: error.message };
  }
  const err = error as { code?: string; name?: string; message?: string; cause?: unknown };
  if (err.cause instanceof UnsafeTargetError) return classify(err.cause, signal);
  if (signal?.aborted && signal.reason === 'cancelled')
    return { code: 'CANCELLED', message: 'Request cancelled' };
  if (err.name === 'AbortError' || err.name === 'TimeoutError' || err.code?.includes('TIMEOUT')) {
    return { code: 'TIMEOUT', message: 'The server did not respond in time' };
  }
  if (err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN')
    return { code: 'DNS_FAILURE', message: 'The domain could not be resolved' };
  if (
    err.code === 'ECONNREFUSED' ||
    err.code === 'ECONNRESET' ||
    err.code === 'UND_ERR_SOCKET' ||
    err.code === 'EHOSTUNREACH'
  ) {
    return { code: 'CONNECTION_FAILED', message: `Connection failed (${err.code})` };
  }
  return { code: 'NETWORK_ERROR', message: (err.message ?? 'Network error').slice(0, 300) };
}

async function readCapped(
  stream: Readable,
  encoding: string | null,
  maxBytes: number,
): Promise<{ body: Buffer; truncated: boolean }> {
  let source: Readable = stream;
  const enc = encoding?.toLowerCase();
  if (enc === 'gzip' || enc === 'x-gzip') source = stream.pipe(createGunzip());
  else if (enc === 'br') source = stream.pipe(createBrotliDecompress());
  else if (enc === 'deflate') source = stream.pipe(createInflate());
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  try {
    for await (const chunk of source) {
      const buf = chunk as Buffer;
      if (size + buf.length > maxBytes) {
        chunks.push(buf.subarray(0, maxBytes - size));
        size = maxBytes;
        truncated = true;
        break;
      }
      chunks.push(buf);
      size += buf.length;
    }
  } finally {
    if (truncated) {
      stream.destroy();
      if (source !== stream) source.destroy();
    }
  }
  return { body: Buffer.concat(chunks, size), truncated };
}

export class SafeFetcher {
  private readonly agent: Agent;
  readonly userAgent: string;
  private readonly timeoutMs: number;
  private readonly maxBodyBytes: number;
  private readonly maxRedirects: number;
  private readonly allowlist: string[];

  constructor(options: SafeFetcherOptions = {}) {
    const env = getEnv();
    this.userAgent = options.userAgent ?? env.CRAWLER_USER_AGENT;
    this.timeoutMs = options.timeoutMs ?? env.CRAWLER_REQUEST_TIMEOUT_MS;
    this.maxBodyBytes = options.maxBodyBytes ?? env.CRAWLER_MAX_BODY_BYTES;
    this.maxRedirects = options.maxRedirects ?? 5;
    this.allowlist = options.allowlist ?? env.crawlerDevAllowlist;
    this.agent = new Agent({
      connect: {
        lookup: makeLookup(options.resolver ?? systemResolver, this.allowlist),
        timeout: Math.min(10_000, this.timeoutMs),
      },
      headersTimeout: this.timeoutMs,
      bodyTimeout: this.timeoutMs,
      connections: 8,
      keepAliveTimeout: 4000,
    });
  }

  async fetch(url: string, options: FetchOptions = {}): Promise<FetchResult> {
    const started = Date.now();
    const redirectChain: RedirectHop[] = [];
    const visited = new Set<string>();
    let current = url;
    const timeout = AbortSignal.timeout(this.timeoutMs * 2);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    const base: Omit<
      FetchResult,
      | 'finalUrl'
      | 'statusCode'
      | 'headers'
      | 'contentType'
      | 'contentEncoding'
      | 'body'
      | 'bodyTruncated'
      | 'responseTimeMs'
      | 'totalTimeMs'
      | 'error'
    > = {
      requestedUrl: url,
      redirectChain,
    };
    const failure = (error: { code: FetchErrorCode; message: string }): FetchResult => ({
      ...base,
      finalUrl: current,
      statusCode: null,
      headers: {},
      contentType: null,
      contentEncoding: null,
      body: null,
      bodyTruncated: false,
      responseTimeMs: null,
      totalTimeMs: Date.now() - started,
      error,
    });

    for (let hop = 0; ; hop++) {
      let parsed: URL;
      try {
        parsed = new URL(current);
        assertUrlPolicy(parsed, this.allowlist);
      } catch (error) {
        return failure(
          error instanceof UnsafeTargetError
            ? { code: 'BLOCKED', message: error.message }
            : { code: 'INVALID_REDIRECT', message: 'Invalid URL' },
        );
      }
      if (visited.has(current)) return failure({ code: 'REDIRECT_LOOP', message: 'Redirect loop detected' });
      visited.add(current);
      if (options.beforeRequest && !(await options.beforeRequest(parsed))) {
        return failure({ code: 'DISALLOWED', message: 'Blocked by robots.txt' });
      }

      const hopStarted = Date.now();
      let response: Awaited<ReturnType<typeof request>>;
      try {
        response = await request(current, {
          dispatcher: this.agent,
          method: options.method ?? 'GET',
          signal,
          headers: {
            'user-agent': this.userAgent,
            accept: options.accept ?? 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
            'accept-encoding': 'gzip, deflate, br',
            'accept-language': 'en;q=0.9,*;q=0.5',
          },
        });
      } catch (error) {
        return failure(classify(error, options.signal));
      }
      const responseTimeMs = Date.now() - hopStarted;
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(response.headers)) {
        if (value !== undefined)
          headers[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value);
      }

      if (REDIRECT_STATUSES.has(response.statusCode) && headers.location) {
        await response.body.dump().catch(() => undefined);
        redirectChain.push({ url: current, statusCode: response.statusCode });
        if (hop >= this.maxRedirects)
          return failure({ code: 'TOO_MANY_REDIRECTS', message: `More than ${this.maxRedirects} redirects` });
        try {
          const next = new URL(headers.location, current);
          next.hash = '';
          current = next.toString();
        } catch {
          return failure({ code: 'INVALID_REDIRECT', message: 'Redirect location is not a valid URL' });
        }
        continue;
      }

      const contentType = headers['content-type'] ?? null;
      const contentEncoding = headers['content-encoding'] ?? null;
      let body: Buffer | null = null;
      let bodyTruncated = false;
      if (options.readBody === false || options.method === 'HEAD') {
        await response.body.dump().catch(() => undefined);
      } else {
        try {
          const read = await readCapped(
            response.body as unknown as Readable,
            contentEncoding,
            options.maxBodyBytes ?? this.maxBodyBytes,
          );
          body = read.body;
          bodyTruncated = read.truncated;
        } catch (error) {
          return {
            ...failure(classify(error, options.signal)),
            statusCode: response.statusCode,
            headers,
            contentType,
            responseTimeMs,
          };
        }
      }
      return {
        ...base,
        finalUrl: current,
        statusCode: response.statusCode,
        headers,
        contentType,
        contentEncoding,
        body,
        bodyTruncated,
        responseTimeMs,
        totalTimeMs: Date.now() - started,
        error: null,
      };
    }
  }

  async close(): Promise<void> {
    await this.agent.close();
  }
}
