// Browser API client. Sessions live in an HTTP-only cookie, so every request is sent with
// credentials. State-changing requests carry the X-CSRF-Token header (signed double-submit token).
// The token is read from the sf_csrf cookie when it is readable (same-site deployments) and from
// GET /auth/csrf otherwise. A request rejected with CSRF_INVALID is retried once with a fresh token.
import type { ApiErrorBody, ErrorCode, PageMeta, ValidationIssue } from '@surfaced/shared';
import { API_BASE } from './config';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode | 'NETWORK_ERROR',
    message: string,
    readonly details?: unknown,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** Validation issues keyed by field name (the "body." / "query." prefix is removed). */
  get fieldErrors(): Record<string, string> {
    if (this.code !== 'VALIDATION_ERROR' || !Array.isArray(this.details)) return {};
    const out: Record<string, string> = {};
    for (const issue of this.details as ValidationIssue[]) {
      const key = issue.path.replace(/^(body|query|params)\.?/, '') || '_';
      out[key] ??= issue.message;
    }
    return out;
  }
}

export interface Paged<T> {
  items: T[];
  meta: PageMeta;
}

type Query = Record<string, string | number | boolean | null | undefined | string[]>;

let csrfToken: string | null = null;

function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  const match = document.cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match ? decodeURIComponent(match[1]!) : null;
}

async function fetchCsrfToken(): Promise<string> {
  const res = await fetch(`${API_BASE}/auth/csrf`, { credentials: 'include' });
  const body = (await res.json()) as { data: { csrfToken: string } };
  csrfToken = body.data.csrfToken;
  return csrfToken;
}

async function currentCsrfToken(): Promise<string> {
  return readCookie('sf_csrf') ?? csrfToken ?? fetchCsrfToken();
}

export function buildUrl(path: string, query?: Query): string {
  const url = `${API_BASE}${path}`;
  if (!query) return url;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) value.forEach((v) => params.append(key, v));
    else params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${url}?${qs}` : url;
}

/** Called on 401 for authenticated requests (the auth provider redirects to the login page). */
let onUnauthenticated: (() => void) | null = null;
export function setUnauthenticatedHandler(handler: (() => void) | null): void {
  onUnauthenticated = handler;
}

interface RequestOptions {
  query?: Query;
  body?: unknown;
  /** Raw text body (CSV import). */
  text?: string;
  signal?: AbortSignal;
  /** Suppress the global 401 handler (used by the session probe). */
  silent401?: boolean;
}

async function toApiError(res: Response): Promise<ApiError> {
  let body: Partial<ApiErrorBody> | null;
  try {
    body = (await res.json()) as ApiErrorBody;
  } catch {
    body = null;
  }
  const error = body?.error;
  if (error) return new ApiError(res.status, error.code, error.message, error.details, error.requestId);
  return new ApiError(
    res.status,
    res.status >= 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST',
    `Request failed (${res.status}).`,
  );
}

async function send(method: string, path: string, opts: RequestOptions, retried = false): Promise<Response> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  let body: BodyInit | undefined;
  if (opts.text !== undefined) {
    headers['Content-Type'] = 'text/plain; charset=utf-8';
    body = opts.text;
  } else if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  if (method !== 'GET') headers['X-CSRF-Token'] = await currentCsrfToken();

  let res: Response;
  try {
    res = await fetch(buildUrl(path, opts.query), {
      method,
      headers,
      body,
      credentials: 'include',
      signal: opts.signal,
    });
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw error;
    throw new ApiError(
      0,
      'NETWORK_ERROR',
      'Could not reach the server. Check your connection and try again.',
    );
  }
  if (res.status === 403 && method !== 'GET' && !retried) {
    const clone = res.clone();
    const err = await toApiError(clone);
    if (err.code === 'CSRF_INVALID') {
      csrfToken = null;
      await fetchCsrfToken();
      return send(method, path, opts, true);
    }
  }
  return res;
}

async function request<T>(
  method: string,
  path: string,
  opts: RequestOptions = {},
): Promise<{ data: T; meta?: PageMeta }> {
  const res = await send(method, path, opts);
  if (res.status === 204) return { data: undefined as T };
  if (!res.ok) {
    const error = await toApiError(res);
    if (res.status === 401 && !opts.silent401) onUnauthenticated?.();
    throw error;
  }
  return (await res.json()) as { data: T; meta?: PageMeta };
}

export const api = {
  async get<T>(path: string, query?: Query, opts: Omit<RequestOptions, 'query'> = {}): Promise<T> {
    return (await request<T>('GET', path, { ...opts, query })).data;
  },
  /** For endpoints that return an object plus pagination metadata. */
  async getWithMeta<T>(path: string, query?: Query): Promise<{ data: T; meta: PageMeta | undefined }> {
    const res = await request<T>('GET', path, { query });
    return { data: res.data, meta: res.meta };
  },
  async page<T>(path: string, query?: Query): Promise<Paged<T>> {
    const res = await request<T[]>('GET', path, { query });
    return {
      items: res.data,
      meta: res.meta ?? { page: 1, pageSize: res.data.length, total: res.data.length, totalPages: 1 },
    };
  },
  async post<T>(path: string, body?: unknown, opts: Omit<RequestOptions, 'body'> = {}): Promise<T> {
    return (await request<T>('POST', path, { ...opts, body: body ?? {} })).data;
  },
  async patch<T>(path: string, body: unknown): Promise<T> {
    return (await request<T>('PATCH', path, { body })).data;
  },
  async put<T>(path: string, body: unknown): Promise<T> {
    return (await request<T>('PUT', path, { body })).data;
  },
  async delete<T = void>(path: string): Promise<T> {
    return (await request<T>('DELETE', path)).data;
  },
  /** Downloads a file response (CSV, Markdown, PDF) and hands it to the browser. */
  async download(path: string, query?: Query, fallbackName = 'download'): Promise<void> {
    const res = await send('GET', path, { query });
    if (!res.ok) throw await toApiError(res);
    const blob = await res.blob();
    const disposition = res.headers.get('content-disposition') ?? '';
    const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
    const name = match ? decodeURIComponent(match[1]!) : fallbackName;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },
  url: buildUrl,
};

/** Human-readable message for any thrown value. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Something went wrong.';
}
