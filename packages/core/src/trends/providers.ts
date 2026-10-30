// Keyword trends providers. Each report uses exactly one provider; their data is never mixed.
//   PYTRENDS           optional Python service (services/pytrends) built on the unofficial pytrends library; experimental
//   DATAFORSEO         licensed Google Trends data through DataForSEO (paid per request)
//   GOOGLE_TRENDS_API  the official Google Trends API: a closed alpha whose request format Google shares only with
//                      accepted testers, so it is reported as unavailable until it is implemented and tested
//   CSV_IMPORT         files the user exported from trends.google.com (nothing is fetched)
//   FIXTURE            generated development data, clearly labeled and refused in production
import { createHash } from 'node:crypto';
import {
  TREND_MAX_KEYWORDS,
  TREND_SOURCE_LABELS,
  TREND_TIME_RANGES,
  countryName,
  trendRegionOptions,
  type TrendData,
  type TrendDataType,
  type TrendInterest,
  type TrendLiveSource,
  type TrendProviderStatusDto,
  type TrendRegionalInterest,
  type TrendRegionResolution,
  type TrendRelatedQueries,
  type TrendRelatedTopics,
  type TrendSource,
  type TrendTimeRange,
} from '@surfaced/shared';
import { getEnv } from '../env';
import { errorMessage } from '../errors';

export type TrendsFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface TrendFetchRequest {
  keywords: string[];
  country: string | null;
  region: string | null;
  timeRange: TrendTimeRange;
  category: number;
  language: string;
  include: TrendDataType[];
}

/** What happened to one provider request; stored as a TrendProviderEvent. */
export type TrendOutcome =
  | 'SUCCESS'
  | 'CACHE_HIT'
  | 'NO_DATA'
  | 'RATE_LIMITED'
  | 'TIMEOUT'
  | 'DISALLOWED'
  | 'NOT_CONFIGURED'
  | 'UNAVAILABLE'
  | 'INVALID_REQUEST'
  | 'ERROR';

export interface TrendOperation {
  operation: string;
  outcome: TrendOutcome;
  message: string | null;
  durationMs: number;
}

export interface TrendFetchResult {
  data: TrendData;
  /** True when some requested data could not be fetched (see limitations). */
  partial: boolean;
  limitations: string[];
  /** Calls made to the provider, for cost tracking. */
  requests: number;
  costUsd: number;
  operations: TrendOperation[];
}

export class TrendProviderError extends Error {
  constructor(
    readonly provider: TrendSource,
    readonly code: TrendOutcome,
    message: string,
    readonly retryAfterSeconds: number | null = null,
    readonly operations: TrendOperation[] = [],
  ) {
    super(message);
    this.name = 'TrendProviderError';
  }

  /** Errors a quick retry would not fix (rate limits, refusals, missing setup, no data). */
  get permanent(): boolean {
    return this.code !== 'TIMEOUT' && this.code !== 'ERROR';
  }
}

export interface DataForSeoCredentials {
  login: string;
  password: string;
}

export interface TrendFetchContext {
  fetchImpl?: TrendsFetch;
  /** DataForSEO credentials (tests); defaults to the configured ones. */
  credentials?: DataForSeoCredentials | null;
}

export interface TrendProviderMeta {
  label: string;
  kind: 'live' | 'import' | 'fixture';
  experimental: boolean;
  paid: boolean;
  capabilities: TrendProviderStatusDto['capabilities'];
}

export interface KeywordTrendsProvider {
  readonly key: TrendSource;
  readonly meta: TrendProviderMeta;
  /** Whether credentials or a service address are set (no network calls). */
  configured(): { configured: boolean; detail: string };
  /** Live check of a separately running service, when the provider has one. */
  health?(fetchImpl?: TrendsFetch): Promise<NonNullable<TrendProviderStatusDto['health']>>;
  /** Absent for providers that do not fetch (CSV) or are not implemented (Google Trends API alpha). */
  fetch?(request: TrendFetchRequest, context?: TrendFetchContext): Promise<TrendFetchResult>;
}

const ALL_CAPABILITIES = {
  interest: true,
  regions: true,
  relatedQueries: true,
  relatedTopics: true,
  subregions: true,
  maxKeywords: TREND_MAX_KEYWORDS,
};

function googleDate(timeRange: TrendTimeRange): string {
  return TREND_TIME_RANGES.find((t) => t.key === timeRange)?.googleDate ?? 'today 3-m';
}

function average(values: (number | null)[]): number | null {
  const known = values.filter((v): v is number => v !== null);
  return known.length ? Math.round((known.reduce((a, b) => a + b, 0) / known.length) * 10) / 10 : null;
}

function resolutionFor(request: TrendFetchRequest): TrendRegionResolution {
  return request.region ? 'CITY' : request.country ? 'REGION' : 'COUNTRY';
}

const unique = (items: string[]) => [...new Set(items)];

// ---------------- pytrends (optional Python service) ----------------

interface PytrendsError {
  error?: { code?: string; message?: string; retryAfterSeconds?: number | null };
}
interface PytrendsInterest {
  points: { date: string; values: Record<string, number | null>; isPartial: boolean }[];
  cached?: boolean;
}
interface PytrendsRegions {
  resolution: TrendRegionResolution;
  regions: { name: string; geoCode: string | null; values: Record<string, number | null> }[];
  limitations?: string[];
  cached?: boolean;
}
interface PytrendsRelated {
  keyword: string;
  queries: { top: { label: string; value: number }[]; rising: { label: string; growth: string }[] };
  topics: {
    top: { label: string; value: number; topicType?: string }[];
    rising: { label: string; growth: string; topicType?: string }[];
  };
  limitations?: string[];
  cached?: boolean;
}

const PYTRENDS_OUTCOMES: Record<string, TrendOutcome> = {
  RATE_LIMITED: 'RATE_LIMITED',
  TIMEOUT: 'TIMEOUT',
  DISALLOWED: 'DISALLOWED',
  NO_DATA: 'NO_DATA',
  INVALID_REQUEST: 'INVALID_REQUEST',
  UNAUTHORIZED: 'NOT_CONFIGURED',
  UNAVAILABLE: 'UNAVAILABLE',
};

export class PytrendsProvider implements KeywordTrendsProvider {
  readonly key = 'PYTRENDS' as const;
  readonly meta: TrendProviderMeta = {
    label: TREND_SOURCE_LABELS.PYTRENDS,
    kind: 'live',
    experimental: true,
    paid: false,
    capabilities: ALL_CAPABILITIES,
  };

  configured() {
    return getEnv().PYTRENDS_SERVICE_URL
      ? {
          configured: true,
          detail:
            'Experimental and free. pytrends is an unofficial, archived library that reads Google Trends’ website endpoints, which Google may change or block at any time. Requests are slow on purpose (one every few seconds) and stop for a while when Google rate-limits them.',
        }
      : {
          configured: false,
          detail:
            'Not set up. Run the pytrends service (npm run trends:setup, then npm run trends:start) and set PYTRENDS_SERVICE_URL.',
        };
  }

  private headers(): Record<string, string> {
    const token = getEnv().PYTRENDS_SERVICE_TOKEN;
    return { 'content-type': 'application/json', ...(token ? { 'x-service-token': token } : {}) };
  }

  async health(fetchImpl: TrendsFetch = fetch) {
    const checkedAt = new Date().toISOString();
    try {
      const response = await fetchImpl(new URL('/health', getEnv().PYTRENDS_SERVICE_URL).toString(), {
        method: 'GET',
        headers: this.headers(),
        signal: AbortSignal.timeout(3000),
      });
      if (response.status === 401)
        return { ok: false, coolingDownSeconds: 0, lastError: 'The service token does not match PYTRENDS_SERVICE_TOKEN.', checkedAt }; // prettier-ignore
      const body = (await response.json()) as {
        ok?: boolean;
        robotsAllowed?: boolean | null;
        coolingDownSeconds?: number;
        lastError?: string | null;
      };
      const robotsBlocked = body.robotsAllowed === false;
      return {
        ok: Boolean(body.ok) && !robotsBlocked && !(body.coolingDownSeconds ?? 0),
        coolingDownSeconds: body.coolingDownSeconds ?? 0,
        lastError: robotsBlocked
          ? 'trends.google.com/robots.txt no longer allows these requests.'
          : (body.lastError ?? null),
        checkedAt,
      };
    } catch {
      return {
        ok: false,
        coolingDownSeconds: 0,
        lastError: 'The pytrends service is not reachable.',
        checkedAt,
      };
    }
  }

  private async call<T>(
    path: string,
    body: Record<string, unknown>,
    operation: string,
    operations: TrendOperation[],
    fetchImpl: TrendsFetch,
  ): Promise<T> {
    const env = getEnv();
    const started = Date.now();
    const fail = (code: TrendOutcome, message: string, retryAfter: number | null = null) => {
      operations.push({ operation, outcome: code, message, durationMs: Date.now() - started });
      return new TrendProviderError('PYTRENDS', code, message, retryAfter, operations);
    };
    let response: Response;
    try {
      response = await fetchImpl(new URL(path, env.PYTRENDS_SERVICE_URL).toString(), {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(env.PYTRENDS_TIMEOUT_MS),
      });
    } catch (error) {
      const timedOut =
        error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      throw timedOut
        ? fail('TIMEOUT', `The pytrends service did not answer within ${Math.round(env.PYTRENDS_TIMEOUT_MS / 1000)} seconds.`) // prettier-ignore
        : fail('UNAVAILABLE', 'The pytrends service is not reachable. An administrator needs to start it (npm run trends:start).'); // prettier-ignore
    }
    const json = (await response.json().catch(() => null)) as (T & PytrendsError) | null;
    if (!response.ok || !json) {
      const code = PYTRENDS_OUTCOMES[json?.error?.code ?? ''] ?? 'ERROR';
      const retryAfter = json?.error?.retryAfterSeconds ?? null;
      const message =
        code === 'RATE_LIMITED'
          ? `Google Trends is rate-limiting requests from this server${retryAfter ? `; try again in about ${Math.max(1, Math.ceil(retryAfter / 60))} minutes` : ''}. Surfaced does not work around Google’s limits.` // prettier-ignore
          : code === 'NOT_CONFIGURED'
            ? 'The pytrends service refused the request: PYTRENDS_SERVICE_TOKEN does not match the service’s token.'
            : (json?.error?.message ?? `The pytrends service answered HTTP ${response.status}.`);
      throw fail(code, message, retryAfter);
    }
    operations.push({
      operation,
      outcome: (json as { cached?: boolean }).cached ? 'CACHE_HIT' : 'SUCCESS',
      message: null,
      durationMs: Date.now() - started,
    });
    return json;
  }

  async fetch(request: TrendFetchRequest, context: TrendFetchContext = {}): Promise<TrendFetchResult> {
    if (!this.configured().configured)
      throw new TrendProviderError('PYTRENDS', 'NOT_CONFIGURED', this.configured().detail);
    const fetchImpl = context.fetchImpl ?? fetch;
    const operations: TrendOperation[] = [];
    const limitations: string[] = [];
    let partial = false;
    const base = {
      geo: request.region ?? request.country ?? '',
      timeframe: googleDate(request.timeRange),
      category: request.category,
      hl: request.language === 'en' ? 'en-US' : request.language,
    };

    // Interest over time is the core of a report: when it fails, the report fails with the reason.
    const iot = await this.call<PytrendsInterest>('/interest-over-time', { ...base, keywords: request.keywords }, 'interest_over_time', operations, fetchImpl); // prettier-ignore
    const interest: TrendInterest = {
      dates: iot.points.map((p) => p.date),
      series: request.keywords.map((keyword) => {
        const values = iot.points.map((p) => p.values[keyword] ?? null);
        return { keyword, values, average: average(values) };
      }),
      partial: iot.points.map((p) => Boolean(p.isPartial)),
    };

    // Other parts are fetched one by one; one that fails is listed as missing instead of failing the report.
    let stopped: TrendProviderError | null = null;
    const optional = async <T>(label: string, run: () => Promise<T>): Promise<T | null> => {
      if (stopped) return null;
      try {
        return await run();
      } catch (error) {
        if (!(error instanceof TrendProviderError)) throw error;
        if (error.code === 'NO_DATA')
          limitations.push(`${label}: Google Trends has no data for this search.`);
        else {
          partial = true;
          limitations.push(`${label} could not be fetched: ${error.message}`);
          if (['RATE_LIMITED', 'DISALLOWED', 'UNAVAILABLE', 'NOT_CONFIGURED'].includes(error.code))
            stopped = error;
        }
        return null;
      }
    };

    let regions: TrendRegionalInterest | null = null;
    if (request.include.includes('regions')) {
      const resolution = resolutionFor(request);
      const r = await optional(
        'Interest by region',
        () =>
        this.call<PytrendsRegions>('/interest-by-region', { ...base, keywords: request.keywords, resolution }, 'interest_by_region', operations, fetchImpl), // prettier-ignore
      );
      if (r) {
        regions = {
          resolution: r.resolution ?? resolution,
          keywords: request.keywords,
          regions: r.regions.map((g) => ({ geoCode: g.geoCode ?? null, name: g.name, values: request.keywords.map((k) => g.values[k] ?? null) })), // prettier-ignore
          comparison: request.keywords.length > 1 ? 'share' : 'single',
        };
        limitations.push(...(r.limitations ?? []));
      }
    }

    const kinds = [
      ...(request.include.includes('related_queries') ? ['queries'] : []),
      ...(request.include.includes('related_topics') ? ['topics'] : []),
    ];
    const related: TrendRelatedQueries[] = [];
    const topics: TrendRelatedTopics[] = [];
    if (kinds.length) {
      const skipped: string[] = [];
      for (const keyword of request.keywords) {
        if (stopped) {
          skipped.push(keyword);
          continue;
        }
        const r = await optional(`Related searches for “${keyword}”`, () =>
          this.call<PytrendsRelated>(
            '/related',
            { ...base, keyword, kinds },
            'related',
            operations,
            fetchImpl,
          ),
        );
        if (!r) continue;
        if (kinds.includes('queries'))
          related.push({
            keyword,
            top: r.queries.top.map((q) => ({ query: q.label, value: q.value })),
            rising: r.queries.rising.map((q) => ({ query: q.label, value: q.growth })),
          });
        // Google often has no related topics; an empty list is reported as a limitation, not shown as a group.
        if (kinds.includes('topics') && (r.topics.top.length || r.topics.rising.length))
          topics.push({
            keyword,
            top: r.topics.top.map((t) => ({ topic: t.label, type: t.topicType ?? null, value: t.value })),
            rising: r.topics.rising.map((t) => ({
              topic: t.label,
              type: t.topicType ?? null,
              value: t.growth,
            })),
          });
        limitations.push(...(r.limitations ?? []));
      }
      if (skipped.length) {
        partial = true;
        limitations.push(`Related searches were not fetched for ${skipped.map((k) => `“${k}”`).join(', ')}, because earlier requests were stopped.`); // prettier-ignore
      }
    }
    return {
      data: { interest, related, regions, topics },
      partial,
      limitations: unique(limitations),
      requests: operations.length,
      costUsd: 0,
      operations,
    };
  }
}

// ---------------- DataForSEO (licensed, paid) ----------------

const DATAFORSEO_URL = 'https://api.dataforseo.com/v3/keywords_data/google_trends/explore/live';

interface DataForSeoTask {
  status_code: number;
  status_message: string;
  cost?: number;
  result?: { items?: { type: string; keywords?: string[]; data?: unknown }[] }[] | null;
}

export function configuredDataForSeoCredentials(): DataForSeoCredentials | null {
  const env = getEnv();
  return env.DATAFORSEO_LOGIN && env.DATAFORSEO_PASSWORD
    ? { login: env.DATAFORSEO_LOGIN, password: env.DATAFORSEO_PASSWORD }
    : null;
}

async function dataForSeoCall(
  body: Record<string, unknown>,
  fetchImpl: TrendsFetch,
  credentials: DataForSeoCredentials,
): Promise<{ task: DataForSeoTask; cost: number }> {
  const auth = Buffer.from(`${credentials.login}:${credentials.password}`).toString('base64');
  let response: Response;
  try {
    response = await fetchImpl(DATAFORSEO_URL, {
      method: 'POST',
      headers: { authorization: `Basic ${auth}`, 'content-type': 'application/json' },
      body: JSON.stringify([body]),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    throw new TrendProviderError('DATAFORSEO', timedOut ? 'TIMEOUT' : 'UNAVAILABLE', timedOut ? 'DataForSEO did not answer within 60 seconds.' : `DataForSEO could not be reached: ${errorMessage(error)}`); // prettier-ignore
  }
  if (response.status === 401 || response.status === 403)
    throw new TrendProviderError(
      'DATAFORSEO',
      'NOT_CONFIGURED',
      'DataForSEO rejected the login and password.',
    );
  if (response.status === 429)
    throw new TrendProviderError('DATAFORSEO', 'RATE_LIMITED', 'DataForSEO is rate-limiting requests; try again later.'); // prettier-ignore
  if (!response.ok)
    throw new TrendProviderError('DATAFORSEO', 'ERROR', `DataForSEO returned HTTP ${response.status}.`);
  const json = (await response.json()) as {
    status_code: number;
    status_message: string;
    tasks?: DataForSeoTask[];
  };
  if (json.status_code !== 20000)
    throw new TrendProviderError('DATAFORSEO', 'ERROR', `DataForSEO: ${json.status_message}`);
  const task = json.tasks?.[0];
  if (!task) throw new TrendProviderError('DATAFORSEO', 'ERROR', 'DataForSEO returned no task.');
  if (task.status_code !== 20000)
    throw new TrendProviderError('DATAFORSEO', 'ERROR', `DataForSEO: ${task.status_message}`);
  return { task, cost: task.cost ?? 0 };
}

/**
 * Interest over time (and the regional breakdown) for up to five terms, then related queries and topics for each
 * term, since DataForSEO returns those for one term per request. Implemented from DataForSEO's documentation.
 */
export async function fetchTrendsFromDataForSeo(
  request: Pick<TrendFetchRequest, 'keywords' | 'country' | 'timeRange' | 'category'> &
    Partial<Pick<TrendFetchRequest, 'region' | 'include'>>,
  fetchImpl: TrendsFetch = fetch,
  credentials: DataForSeoCredentials | null = configuredDataForSeoCredentials(),
): Promise<TrendFetchResult> {
  if (!credentials)
    throw new TrendProviderError('DATAFORSEO', 'NOT_CONFIGURED', 'DataForSEO is not configured (DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD).'); // prettier-ignore
  if (request.region)
    throw new TrendProviderError('DATAFORSEO', 'INVALID_REQUEST', 'Sub-regions are not supported with DataForSEO here; choose the whole country or another source.'); // prettier-ignore
  const include = request.include ?? ['interest', 'related_queries'];
  const base = {
    ...(request.country ? { location_name: countryName(request.country) } : {}),
    type: 'web',
    time_range: request.timeRange,
    ...(request.category ? { category_code: request.category } : {}),
  };
  const operations: TrendOperation[] = [];
  const limitations: string[] = [];
  let costUsd = 0;
  const timed = async (operation: string, body: Record<string, unknown>) => {
    const started = Date.now();
    try {
      const result = await dataForSeoCall(body, fetchImpl, credentials);
      operations.push({ operation, outcome: 'SUCCESS', message: null, durationMs: Date.now() - started });
      costUsd += result.cost;
      return result;
    } catch (error) {
      const e = error instanceof TrendProviderError ? error : new TrendProviderError('DATAFORSEO', 'ERROR', errorMessage(error)); // prettier-ignore
      operations.push({ operation, outcome: e.code, message: e.message, durationMs: Date.now() - started });
      throw new TrendProviderError('DATAFORSEO', e.code, e.message, e.retryAfterSeconds, operations);
    }
  };

  const graph = await timed('interest_over_time', {
    ...base,
    keywords: request.keywords,
    item_types: ['google_trends_graph', ...(include.includes('regions') ? ['google_trends_map'] : [])],
  });
  const items = graph.task.result?.[0]?.items ?? [];
  const graphItem = items.find((i) => i.type === 'google_trends_graph');
  const points = (graphItem?.data ?? []) as { date_from: string; missing_data?: boolean; values: (number | null)[] }[]; // prettier-ignore
  const keywords = graphItem?.keywords?.length ? graphItem.keywords : request.keywords;
  const interest: TrendInterest | null = points.length
    ? {
        dates: points.map((p) => p.date_from),
        series: keywords.map((keyword, k) => {
          const values = points.map((p) => (p.missing_data ? null : (p.values?.[k] ?? null)));
          return { keyword, values, average: average(values) };
        }),
      }
    : null;
  if (!interest) throw new TrendProviderError('DATAFORSEO', 'NO_DATA', 'Google Trends (through DataForSEO) has no data for these terms, place and period.', null, operations); // prettier-ignore

  let regions: TrendRegionalInterest | null = null;
  if (include.includes('regions')) {
    const map = items.find((i) => i.type === 'google_trends_map');
    const rows = (map?.data ?? []) as { geo_id?: string; geo_name?: string; values?: (number | null)[] }[];
    if (rows.length)
      regions = {
        resolution: request.country ? 'REGION' : 'COUNTRY',
        keywords,
        regions: rows.map((r) => ({ geoCode: r.geo_id ?? null, name: r.geo_name ?? r.geo_id ?? '—', values: keywords.map((_, k) => r.values?.[k] ?? null) })), // prettier-ignore
        comparison: keywords.length > 1 ? 'share' : 'single',
      };
    else limitations.push('Interest by region: DataForSEO returned no regional data for this search.');
  }

  const related: TrendRelatedQueries[] = [];
  const topics: TrendRelatedTopics[] = [];
  const itemTypes = [
    ...(include.includes('related_queries') ? ['google_trends_queries_list'] : []),
    ...(include.includes('related_topics') ? ['google_trends_topics_list'] : []),
  ];
  let partial = false;
  if (itemTypes.length)
    for (const keyword of request.keywords) {
      let call: Awaited<ReturnType<typeof timed>>;
      try {
        call = await timed('related', { ...base, keywords: [keyword], item_types: itemTypes });
      } catch (error) {
        partial = true;
        limitations.push(`Related searches for “${keyword}” could not be fetched: ${errorMessage(error)}`);
        if (error instanceof TrendProviderError && error.code === 'RATE_LIMITED') break;
        continue;
      }
      const list = call.task.result?.[0]?.items ?? [];
      const queries = (list.find((i) => i.type === 'google_trends_queries_list')?.data ?? {}) as {
        top?: { query: string; value: number }[] | null;
        rising?: { query: string; value: number }[] | null;
      };
      const topicData = (list.find((i) => i.type === 'google_trends_topics_list')?.data ?? {}) as {
        top?: { topic_title: string; topic_type?: string; value: number }[] | null;
        rising?: { topic_title: string; topic_type?: string; value: number }[] | null;
      };
      const growth = (value: number) => (value >= 5000 ? 'Breakout' : `+${value}%`);
      if (include.includes('related_queries'))
        related.push({
          keyword,
          top: (queries.top ?? []).map((q) => ({ query: q.query, value: q.value })),
          rising: (queries.rising ?? []).map((q) => ({ query: q.query, value: growth(q.value) })),
        });
      if (include.includes('related_topics'))
        topics.push({
          keyword,
          top: (topicData.top ?? []).map((t) => ({ topic: t.topic_title, type: t.topic_type ?? null, value: t.value })), // prettier-ignore
          rising: (topicData.rising ?? []).map((t) => ({ topic: t.topic_title, type: t.topic_type ?? null, value: growth(t.value) })), // prettier-ignore
        });
    }
  return {
    data: { interest, related, regions, topics },
    partial,
    limitations: unique(limitations),
    requests: operations.length,
    costUsd,
    operations,
  };
}

class DataForSeoProvider implements KeywordTrendsProvider {
  readonly key = 'DATAFORSEO' as const;
  readonly meta: TrendProviderMeta = {
    label: TREND_SOURCE_LABELS.DATAFORSEO,
    kind: 'live',
    experimental: false,
    paid: true,
    capabilities: { ...ALL_CAPABILITIES, subregions: false },
  };

  configured() {
    return configuredDataForSeoCredentials()
      ? {
          configured: true,
          detail: 'Licensed Google Trends data, paid per request (about $0.01 per lookup).',
        }
      : {
          configured: false,
          detail: 'Optional, paid. Set DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD to use it.',
        };
  }

  fetch(request: TrendFetchRequest, context: TrendFetchContext = {}) {
    return fetchTrendsFromDataForSeo(
      request,
      context.fetchImpl,
      context.credentials === undefined ? configuredDataForSeoCredentials() : context.credentials,
    );
  }
}

// ---------------- Official Google Trends API (alpha) ----------------

class GoogleTrendsApiProvider implements KeywordTrendsProvider {
  readonly key = 'GOOGLE_TRENDS_API' as const;
  readonly meta: TrendProviderMeta = {
    label: TREND_SOURCE_LABELS.GOOGLE_TRENDS_API,
    kind: 'live',
    experimental: true,
    paid: false,
    capabilities: { ...ALL_CAPABILITIES, relatedQueries: false, relatedTopics: false },
  };

  configured() {
    const env = getEnv();
    const credentials = Boolean(env.GOOGLE_TRENDS_API_KEY && env.GOOGLE_TRENDS_API_ALPHA_ACCESS);
    return {
      configured: credentials,
      detail: credentials
        ? 'Credentials are set, but this adapter is not implemented: Google shares the alpha API’s request format only with accepted testers, and Surfaced has not been tested against it.'
        : 'Not available. The official Google Trends API is a closed alpha (apply at developers.google.com/search/apis/trends). It needs GOOGLE_TRENDS_API_KEY, GOOGLE_TRENDS_API_ALPHA_ACCESS=true and an implemented, tested adapter.',
    };
  }
  // No fetch(): the request format is not public, so nothing is sent until it is implemented and tested.
}

// ---------------- CSV import ----------------

class CsvImportProvider implements KeywordTrendsProvider {
  readonly key = 'CSV_IMPORT' as const;
  readonly meta: TrendProviderMeta = {
    label: TREND_SOURCE_LABELS.CSV_IMPORT,
    kind: 'import',
    experimental: false,
    paid: false,
    capabilities: ALL_CAPABILITIES,
  };

  configured() {
    return {
      configured: true,
      detail:
        'Always available and free: download the charts from trends.google.com (the download icon on each chart) and import the files.',
    };
  }
}

// ---------------- Development fixture ----------------

function seeded(text: string): () => number {
  let state = createHash('sha256').update(text).digest().readUInt32LE(0) || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return ((state >>> 0) % 10_000) / 10_000;
  };
}

/** Deterministic generated data for development and automated tests. Never real Google data. */
class FixtureProvider implements KeywordTrendsProvider {
  readonly key = 'FIXTURE' as const;
  readonly meta: TrendProviderMeta = {
    label: TREND_SOURCE_LABELS.FIXTURE,
    kind: 'fixture',
    experimental: false,
    paid: false,
    capabilities: ALL_CAPABILITIES,
  };

  configured() {
    return {
      configured: !getEnv().isProduction,
      detail: 'Generated sample data for development and tests. It is not real Google Trends data.',
    };
  }

  async fetch(request: TrendFetchRequest): Promise<TrendFetchResult> {
    const days = { past_7_days: 7, past_30_days: 30, past_90_days: 90, past_12_months: 365, past_5_years: 1825 }[request.timeRange]; // prettier-ignore
    const step = days > 120 ? 7 : 1;
    const end = new Date(Date.UTC(2026, 9, 18));
    const dates: string[] = [];
    for (let d = days - step; d >= 0; d -= step)
      dates.push(new Date(end.getTime() - d * 86_400_000).toISOString().slice(0, 10));
    const raw = request.keywords.map((keyword) => {
      const rand = seeded(`${keyword}|${request.country}|${request.timeRange}`);
      const level = 10 + rand() * 60;
      const slope = (rand() - 0.4) * 0.6;
      return dates.map((_, i) => Math.max(0, level * (1 + (slope * i) / dates.length) + Math.sin(i / 3) * 6 + rand() * 8)); // prettier-ignore
    });
    const peak = Math.max(1, ...raw.flat());
    const interest: TrendInterest = {
      dates,
      series: request.keywords.map((keyword, k) => {
        const values = raw[k]!.map((v) => Math.round((v / peak) * 100));
        return { keyword, values, average: average(values) };
      }),
      partial: dates.map((_, i) => i === dates.length - 1),
    };
    const places = request.country
      ? trendRegionOptions(request.country)
          .slice(0, 8)
          .map((r) => ({ geoCode: r.code, name: r.name }))
      : ['IN', 'US', 'GB', 'CA', 'AU'].map((c) => ({ geoCode: c, name: countryName(c) }));
    const regions: TrendRegionalInterest | null = request.include.includes('regions')
      ? {
          resolution: resolutionFor(request),
          keywords: request.keywords,
          regions: places.map((place) => {
            const rand = seeded(`${place.geoCode}|${request.keywords.join(',')}`);
            const raw = request.keywords.map(() => 1 + rand() * 99);
            const total = raw.reduce((a, b) => a + b, 0);
            return { ...place, values: raw.map((v) => Math.round(request.keywords.length > 1 ? (v / total) * 100 : v)) }; // prettier-ignore
          }),
          comparison: request.keywords.length > 1 ? 'share' : 'single',
        }
      : null;
    const related = request.include.includes('related_queries')
      ? request.keywords.map((keyword) => ({
          keyword,
          top: [`${keyword} ideas`, `${keyword} online`, `best ${keyword}`, `free ${keyword}`].map((query, i) => ({ query, value: 100 - i * 20 })), // prettier-ignore
          rising: [{ query: `how to make ${keyword}`, value: 'Breakout' }, { query: `${keyword} 2026`, value: '+250%' }], // prettier-ignore
        }))
      : [];
    const topics = request.include.includes('related_topics')
      ? request.keywords.map((keyword) => ({
          keyword,
          top: [{ topic: keyword.replace(/\b\w/g, (c) => c.toUpperCase()), type: 'Topic', value: 100 }],
          rising: [],
        }))
      : [];
    return {
      data: { interest, related, regions, topics },
      partial: false,
      limitations: ['Development fixture: generated sample data, not real Google Trends data.'],
      requests: 0,
      costUsd: 0,
      operations: [{ operation: 'fixture', outcome: 'SUCCESS', message: null, durationMs: 0 }],
    };
  }
}

// ---------------- Registry ----------------

const factories: Record<TrendSource, () => KeywordTrendsProvider> = {
  PYTRENDS: () => new PytrendsProvider(),
  DATAFORSEO: () => new DataForSeoProvider(),
  GOOGLE_TRENDS_API: () => new GoogleTrendsApiProvider(),
  CSV_IMPORT: () => new CsvImportProvider(),
  FIXTURE: () => new FixtureProvider(),
};

/** Names used in TRENDS_PROVIDERS. */
export const TREND_PROVIDER_SETTING_NAMES: Record<TrendSource, string> = {
  PYTRENDS: 'pytrends',
  DATAFORSEO: 'dataforseo',
  GOOGLE_TRENDS_API: 'google_trends_api',
  CSV_IMPORT: 'csv',
  FIXTURE: 'fixture',
};

/** Order in which a request without a named provider picks one: official first, then free, then paid. */
export const TREND_LIVE_PREFERENCE: TrendLiveSource[] = [
  'GOOGLE_TRENDS_API',
  'PYTRENDS',
  'DATAFORSEO',
  'FIXTURE',
];

let overrides: Partial<Record<TrendSource, KeywordTrendsProvider>> = {};

export function getTrendsProvider(key: TrendSource): KeywordTrendsProvider {
  return overrides[key] ?? factories[key]();
}

/** Test hook. */
export function setTrendsProviderOverrides(next: Partial<Record<TrendSource, KeywordTrendsProvider>>): void {
  overrides = next;
}

/** Providers the administrator allows (TRENDS_PROVIDERS). The fixture is never allowed in production. */
export function isTrendSourceEnabled(key: TrendSource): boolean {
  const env = getEnv();
  if (key === 'FIXTURE' && env.isProduction) return false;
  const names = env.TRENDS_PROVIDERS.split(',').map((n) => n.trim().toLowerCase());
  return names.includes(TREND_PROVIDER_SETTING_NAMES[key]);
}

/** Enabled, configured and implemented (it can fetch). Health is checked separately. */
export function isLiveSourceUsable(key: TrendLiveSource): boolean {
  const provider = getTrendsProvider(key);
  return (
    isTrendSourceEnabled(key) && provider.configured().configured && typeof provider.fetch === 'function'
  );
}

export function defaultLiveSource(): TrendLiveSource | null {
  return TREND_LIVE_PREFERENCE.find((key) => isLiveSourceUsable(key)) ?? null;
}

export const TREND_PROVIDER_ORDER: TrendSource[] = ['PYTRENDS', 'DATAFORSEO', 'GOOGLE_TRENDS_API', 'CSV_IMPORT', 'FIXTURE']; // prettier-ignore
