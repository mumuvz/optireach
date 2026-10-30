// Isomorphic URL helpers. These perform *syntactic* validation only; the server additionally applies
// SSRF rules (DNS resolution, private-address blocking, port allowlist) before fetching anything.

export type UrlErrorCode =
  | 'EMPTY'
  | 'TOO_LONG'
  | 'INVALID_URL'
  | 'UNSUPPORTED_PROTOCOL'
  | 'CREDENTIALS_NOT_ALLOWED'
  | 'INVALID_HOSTNAME';

export class UrlValidationError extends Error {
  constructor(
    public readonly code: UrlErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'UrlValidationError';
  }
}

export interface NormalizedWebsite {
  /** Start URL without query string or fragment, e.g. "https://example.com/". */
  url: string;
  origin: string;
  protocol: 'http:' | 'https:';
  /** Lower-case ASCII (punycode) hostname, without trailing dot. */
  hostname: string;
  /** Hostname without a leading "www.". Used as the project/competitor identity. */
  domain: string;
  /** Explicit non-default port, or "" when the default port is used. */
  port: string;
}

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
const LABEL_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
const TLD_RE = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;
const IPV4_RE = /^(?:\d{1,3}\.){3}\d{1,3}$/;

export const MAX_URL_LENGTH = 2048;

export function isIpLiteral(hostname: string): boolean {
  return IPV4_RE.test(hostname) || (hostname.startsWith('[') && hostname.endsWith(']'));
}

/** A dotted DNS name with valid labels and a plausible TLD (no IPs, no single-label names). */
export function isPlausibleHostname(hostname: string): boolean {
  if (hostname.length === 0 || hostname.length > 253) return false;
  const labels = hostname.split('.');
  if (labels.length < 2) return false;
  if (!labels.every((label) => LABEL_RE.test(label))) return false;
  return TLD_RE.test(labels[labels.length - 1] ?? '');
}

export function stripWww(hostname: string): string {
  return hostname.startsWith('www.') ? hostname.slice(4) : hostname;
}

/**
 * Normalizes user input such as "Example.com/pricing?x=1" into a crawlable start URL.
 * Accepts localhost/IP literals syntactically (the server decides whether they are allowed).
 */
export function normalizeWebsiteUrl(input: string): NormalizedWebsite {
  const raw = input.trim();
  if (!raw) throw new UrlValidationError('EMPTY', 'Enter a website address.');
  if (raw.length > MAX_URL_LENGTH) throw new UrlValidationError('TOO_LONG', 'That address is too long.');

  const withScheme = SCHEME_RE.test(raw) ? raw : `https://${raw}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new UrlValidationError(
      'INVALID_URL',
      'Enter a valid website address, for example https://example.com.',
    );
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new UrlValidationError('UNSUPPORTED_PROTOCOL', 'Only http:// and https:// websites are supported.');
  }
  if (parsed.username || parsed.password) {
    throw new UrlValidationError(
      'CREDENTIALS_NOT_ALLOWED',
      'Remove the username or password from the address.',
    );
  }

  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
  const hostOk = hostname === 'localhost' || isIpLiteral(hostname) || isPlausibleHostname(hostname);
  if (!hostOk) {
    throw new UrlValidationError('INVALID_HOSTNAME', 'Enter a full domain name, for example example.com.');
  }

  const port = parsed.port;
  const host = port ? `${hostname}:${port}` : hostname;
  const origin = `${parsed.protocol}//${host}`;
  const pathname = parsed.pathname || '/';

  return {
    url: `${origin}${pathname}`,
    origin,
    protocol: parsed.protocol,
    hostname,
    domain: stripWww(hostname),
    port,
  };
}

export type SafeParseResult<T> = { ok: true; value: T } | { ok: false; error: UrlValidationError };

export function safeNormalizeWebsiteUrl(input: string): SafeParseResult<NormalizedWebsite> {
  try {
    return { ok: true, value: normalizeWebsiteUrl(input) };
  } catch (error) {
    if (error instanceof UrlValidationError) return { ok: false, error };
    throw error;
  }
}

/** Normalizes a competitor or brand domain ("https://www.Example.com/x" → "example.com"). */
export function normalizeDomain(input: string): string {
  return normalizeWebsiteUrl(input).domain;
}

/** Extracts the comparable domain of an absolute URL, or null if it cannot be parsed. */
export function domainOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return stripWww(parsed.hostname.toLowerCase().replace(/\.$/, ''));
  } catch {
    return null;
  }
}

/** True when `candidate` equals `domain` or is a subdomain of it (both without "www."). */
export function isSameOrSubdomain(candidate: string, domain: string): boolean {
  const c = stripWww(candidate.toLowerCase());
  const d = stripWww(domain.toLowerCase());
  return c === d || c.endsWith(`.${d}`);
}
