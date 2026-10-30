// Keyword trends: relative search interest from Google Trends, through a configured provider (pytrends, DataForSEO,
// the official Google Trends API alpha) or CSV files exported from trends.google.com, compared with the words on the
// project's crawled pages. Google Trends values are relative interest (100 = the peak in the chosen period and place,
// scaled separately for every request), never search volumes, and are never mixed with other providers' metrics.
import { z } from 'zod';
import { KEYWORD_PRIORITIES } from './enums';
import { countryCodeSchema, idSchema } from './schemas/common';
import { dateOnlySchema } from './schemas/operations';
import { trendCityRegion, trendRegionName } from './trend-regions';

export const TREND_TIME_RANGES = [
  { key: 'past_7_days', label: 'Past 7 days', googleDate: 'now 7-d' },
  { key: 'past_30_days', label: 'Past 30 days', googleDate: 'today 1-m' },
  { key: 'past_90_days', label: 'Past 90 days', googleDate: 'today 3-m' },
  { key: 'past_12_months', label: 'Past 12 months', googleDate: 'today 12-m' },
  { key: 'past_5_years', label: 'Past 5 years', googleDate: 'today 5-y' },
] as const;
export type TrendTimeRange = (typeof TREND_TIME_RANGES)[number]['key'];
const TIME_RANGE_KEYS = TREND_TIME_RANGES.map((t) => t.key) as [TrendTimeRange, ...TrendTimeRange[]];

/** Google Trends compares at most five terms at a time. */
export const TREND_MAX_KEYWORDS = 5;

/** Where a report's data came from. Every report has exactly one source; sources are never merged. */
export const TREND_SOURCES = [
  'PYTRENDS',
  'DATAFORSEO',
  'GOOGLE_TRENDS_API',
  'CSV_IMPORT',
  'FIXTURE',
] as const;
export type TrendSource = (typeof TREND_SOURCES)[number];
/** Sources that fetch data on request (FIXTURE only in development and tests). */
export const TREND_LIVE_SOURCES = ['PYTRENDS', 'DATAFORSEO', 'GOOGLE_TRENDS_API', 'FIXTURE'] as const;
export type TrendLiveSource = (typeof TREND_LIVE_SOURCES)[number];

export const TREND_SOURCE_LABELS: Record<TrendSource, string> = {
  PYTRENDS: 'Google Trends via pytrends (unofficial, experimental)',
  DATAFORSEO: 'Google Trends via DataForSEO (licensed, paid)',
  GOOGLE_TRENDS_API: 'Google Trends API (official alpha)',
  CSV_IMPORT: 'CSV exported from Google Trends',
  FIXTURE: 'Development fixture (not real Google data)',
};

export type TrendSourceType = 'LIVE' | 'CSV' | 'FIXTURE';
export function trendSourceType(source: TrendSource): TrendSourceType {
  return source === 'CSV_IMPORT' ? 'CSV' : source === 'FIXTURE' ? 'FIXTURE' : 'LIVE';
}

/** The kinds of Google Trends data a report can hold. */
export const TREND_DATA_TYPES = ['interest', 'regions', 'related_queries', 'related_topics'] as const;
export type TrendDataType = (typeof TREND_DATA_TYPES)[number];
export const TREND_DATA_TYPE_LABELS: Record<TrendDataType, string> = {
  interest: 'Interest over time',
  regions: 'Interest by region',
  related_queries: 'Related queries',
  related_topics: 'Related topics',
};

const trendKeywordSchema = z
  .string()
  .trim()
  .min(2, 'Each term needs at least 2 characters')
  .max(100)
  .refine((v) => !/[<>|"+=~!:*()[\]{}]/.test(v), 'Remove special characters such as quotes or brackets');

/** ISO 3166-2 sub-region, e.g. IN-GJ (Gujarat). */
export const trendRegionSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{2}-[A-Z0-9]{1,3}$/, 'Use a region code such as IN-GJ');

const settingsShape = {
  keywords: z
    .array(trendKeywordSchema)
    .min(1, 'Add at least one term')
    .max(TREND_MAX_KEYWORDS, `Compare at most ${TREND_MAX_KEYWORDS} terms`),
  /** ISO country; null means worldwide. */
  country: countryCodeSchema.nullable().default(null),
  /** Sub-region of the country (ISO 3166-2); null means the whole country. */
  region: trendRegionSchema.nullable().default(null),
  /**
   * City filter: compares searches that mention the city ("wedding card surat"), measured in the city's region.
   * Google Trends cannot filter to a single city (outside US metro areas). Known cities fill in their region.
   */
  city: z
    .string()
    .trim()
    .min(2, 'Enter a city name')
    .max(60)
    .regex(/^\p{L}[\p{L} .'-]*$/u, 'Enter only the city name')
    .nullable()
    .default(null),
  timeRange: z.enum(TIME_RANGE_KEYS).default('past_90_days'),
  /** Google Trends category id (0 = all categories). */
  category: z.int().min(0).max(100_000).default(0),
  /** Live provider; the first available one when omitted. */
  provider: z.enum(TREND_LIVE_SOURCES).optional(),
  include: z
    .array(z.enum(TREND_DATA_TYPES))
    .min(1)
    .default([...TREND_DATA_TYPES])
    .transform((v) => (v.includes('interest') ? [...new Set(v)] : ['interest' as const, ...new Set(v)])),
  /** AI suggestions of where to use the missing terms (counts as one AI keyword run). */
  suggestPlacements: z.boolean().default(true),
};

type Place = { country?: string | null; region?: string | null; city?: string | null };

function regionInsideCountry(v: Place, ctx: z.RefinementCtx) {
  if (v.region && v.region.slice(0, 2) !== v.country)
    ctx.addIssue({
      code: 'custom',
      path: ['region'],
      message: 'Choose a region inside the selected country',
    });
  if (v.city && !v.country)
    ctx.addIssue({ code: 'custom', path: ['city'], message: 'Choose the country of the city first' });
  const known = trendCityRegion(v.country, v.city);
  if (known && v.region && v.region !== known)
    ctx.addIssue({
      code: 'custom',
      path: ['region'],
      message: `${v.city} is in ${trendRegionName(known)}: choose that region or the whole country`,
    });
}

/** A known city fills in its region, so its searches are measured where the city is. */
function cityRegion<T extends Place>(v: T): T {
  return v.city && !v.region ? { ...v, region: trendCityRegion(v.country, v.city) } : v;
}

export const trendSettingsSchema = z
  .object(settingsShape)
  .superRefine(regionInsideCountry)
  .transform(cityRegion);
export type TrendSettingsInput = z.input<typeof trendSettingsSchema>;
export type TrendSettings = z.output<typeof trendSettingsSchema>;

/** Google Trends CSV exports are small (a five-year weekly series is about 10 KB). */
export const TREND_IMPORT_MAX_FILES = 12;
const TREND_IMPORT_MAX_FILE_CHARS = 200_000;

/** CSV files exported from trends.google.com (any of the four charts' downloads). */
export const trendImportSchema = z
  .object({
    keywords: z.array(trendKeywordSchema).min(1).max(TREND_MAX_KEYWORDS).optional(),
    country: settingsShape.country,
    region: settingsShape.region,
    timeRange: settingsShape.timeRange,
    category: settingsShape.category,
    suggestPlacements: settingsShape.suggestPlacements,
    files: z
      .array(
        z.object({
          name: z.string().trim().max(200),
          content: z
            .string()
            .max(TREND_IMPORT_MAX_FILE_CHARS, 'The file is too large for a Google Trends export'),
          /** For related queries or topics: the term the file belongs to (Google's file does not say). */
          keyword: trendKeywordSchema.optional(),
        }),
      )
      .min(1, 'Add a CSV file')
      .max(TREND_IMPORT_MAX_FILES, `Add at most ${TREND_IMPORT_MAX_FILES} files`),
  })
  .superRefine(regionInsideCountry);
export type TrendImportInput = z.input<typeof trendImportSchema>;

/** A saved comparison, optionally refreshed on a schedule. */
export const TREND_SCHEDULES = ['NONE', 'WEEKLY', 'MONTHLY'] as const;
export type TrendSchedule = (typeof TREND_SCHEDULES)[number];

export const trendSavedQuerySchema = z
  .object({
    name: z.string().trim().min(2, 'Enter at least 2 characters').max(120),
    keywords: settingsShape.keywords,
    country: settingsShape.country,
    region: settingsShape.region,
    city: settingsShape.city,
    timeRange: settingsShape.timeRange,
    category: settingsShape.category,
    provider: settingsShape.provider,
    schedule: z.enum(TREND_SCHEDULES).default('NONE'),
  })
  .superRefine(regionInsideCountry)
  .transform(cityRegion);
export type TrendSavedQueryInput = z.input<typeof trendSavedQuerySchema>;

export const trendSavedQueryUpdateSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  schedule: z.enum(TREND_SCHEDULES).optional(),
});

/** Adds report terms to the project's keywords, optionally in a keyword list (collection). */
export const trendSaveKeywordsSchema = z
  .object({
    terms: z.array(z.string().trim().min(2).max(200)).min(1).max(50),
    listId: idSchema.optional(),
    /** Creates the list when it does not exist yet. */
    listName: z.string().trim().min(1).max(120).optional(),
    priority: z.enum(KEYWORD_PRIORITIES).default('MEDIUM'),
  })
  .refine((v) => !(v.listId && v.listName), { message: 'Choose a list or name a new one, not both' });
export type TrendSaveKeywordsInput = z.input<typeof trendSaveKeywordsSchema>;

/** Plans content for a term: a content brief, and a task with a due date when one is given. */
export const trendBriefSchema = z.object({
  term: z.string().trim().min(2).max(200),
  dueDate: dateOnlySchema.optional(),
});
export type TrendBriefInput = z.input<typeof trendBriefSchema>;

export const TREND_EXPORT_PARTS = ['interest', 'regions', 'related', 'terms'] as const;
export type TrendExportPart = (typeof TREND_EXPORT_PARTS)[number];

/** The same comparison on trends.google.com, so anyone can check the numbers. */
export function googleTrendsExploreUrl(settings: {
  keywords: string[];
  country: string | null;
  region?: string | null;
  timeRange: TrendTimeRange;
  category: number;
}): string {
  const date = TREND_TIME_RANGES.find((t) => t.key === settings.timeRange)?.googleDate ?? 'today 3-m';
  const geo = settings.region ?? settings.country;
  const params = [
    geo ? `geo=${encodeURIComponent(geo)}` : null,
    `date=${encodeURIComponent(date)}`,
    settings.category ? `cat=${settings.category}` : null,
    `q=${encodeURIComponent(settings.keywords.map((k) => encodeURIComponent(k)).join(','))}`,
  ].filter(Boolean);
  return `https://trends.google.com/explore?${params.join('&')}`;
}

// ---------------- Data ----------------

export interface TrendSeries {
  keyword: string;
  /** Relative interest per period (0–100); null where Google had no data. */
  values: (number | null)[];
  average: number | null;
}

export interface TrendInterest {
  /** Start of each period (yyyy-mm-dd, or with a time for hourly data). */
  dates: string[];
  series: TrendSeries[];
  /** Per period: true while Google is still collecting data for it (usually the latest period). */
  partial?: boolean[];
}

export interface TrendRelatedQueries {
  /** The term the queries relate to, when known. */
  keyword: string | null;
  /** Relative popularity (100 = the most searched related query). */
  top: { query: string; value: number }[];
  /** Growth: "Breakout" (over 5,000%) or a percentage such as "+250%". */
  rising: { query: string; value: string }[];
}

export interface TrendRelatedTopics {
  keyword: string | null;
  /** Topic name and Google's type for it ("Topic", "Software company", …). */
  top: { topic: string; type: string | null; value: number }[];
  rising: { topic: string; type: string | null; value: string }[];
}

export type TrendRegionResolution = 'COUNTRY' | 'REGION' | 'CITY' | 'DMA';

export interface TrendRegionalInterest {
  resolution: TrendRegionResolution;
  keywords: string[];
  /** Values follow `keywords`. */
  regions: { geoCode: string | null; name: string; values: (number | null)[] }[];
  /**
   * single: one term, 100 = the region with the highest share of searches for it. share: several terms, each
   * region's searches split between them (they add up to 100), so compare terms within a region, not regions.
   */
  comparison: 'single' | 'share';
}

export interface TrendData {
  interest: TrendInterest | null;
  related: TrendRelatedQueries[];
  regions?: TrendRegionalInterest | null;
  topics?: TrendRelatedTopics[];
}

/** Rising, stable or falling interest, comparing the first and last thirds of a series (complete periods only). */
export type TrendDirection = 'rising' | 'stable' | 'falling' | 'no_data';

export function trendDirection(values: (number | null)[], partial: boolean[] = []): TrendDirection {
  const known = values.filter((v, i): v is number => v !== null && !partial[i]);
  if (known.length < 6) return 'no_data';
  const third = Math.floor(known.length / 3);
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const first = mean(known.slice(0, third));
  const last = mean(known.slice(-third));
  if (first === 0 && last === 0) return 'no_data';
  const change = (last - first) / Math.max(first, 1);
  if (change >= 0.2 && last - first >= 3) return 'rising';
  if (change <= -0.2 && first - last >= 3) return 'falling';
  return 'stable';
}

// ---------------- CSV import ----------------

function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      cells.push(cell);
      cell = '';
    } else cell += ch;
  }
  cells.push(cell);
  return cells.map((c) => c.trim());
}

const DATE_HEADER = /^(week|day|month|year|time|date|hour)\b/i;
const REGION_HEADER = /^(region|subregion|country|city|metro|dma|state|province)$/i;
const RELATED_HEADER = /^(quer(y|ies)|topics?|search terms?|related (quer(y|ies)|topics?))$/i;
const GROWTH = /^(breakout|\+?[\d,.]+\s?%)$/i;

function normalizeDate(value: string): string | null {
  const v = value.trim();
  if (/^\d{4}-\d{2}(-\d{2})?(T[\d:]+)?$/.test(v)) return v;
  if (!/\d{4}/.test(v)) return null;
  const parsed = Date.parse(v);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString().slice(0, 10);
}

function parseInterestValue(value: string): number | null {
  const v = value.trim();
  if (!v) return null;
  if (v === '<1' || v === '<1%') return 0;
  const n = Number(v.replace('%', ''));
  return Number.isFinite(n) ? n : null;
}

/** "wedding invitation: (India)" → "wedding invitation". */
function headerKeyword(cell: string): string {
  return cell.replace(/:\s*\([^)]*\)\s*$/, '').trim();
}

function headerNote(cell: string | undefined): string | null {
  return cell?.match(/:\s*\(([^)]*)\)\s*$/)?.[1]?.trim() || null;
}

/** "Canva - Software company" → { topic: "Canva", type: "Software company" }. */
function splitTopic(label: string): { topic: string; type: string | null } {
  const m = label.match(/^(.*\S)\s+-\s+([A-Z][^]*)$/);
  return m ? { topic: m[1]!.trim(), type: m[2]!.trim() } : { topic: label, type: null };
}

const average = (values: (number | null)[]) => {
  const known = values.filter((v): v is number => v !== null);
  return known.length ? Math.round((known.reduce((a, b) => a + b, 0) / known.length) * 10) / 10 : null;
};

export type TrendCsvKind = 'interest_over_time' | 'interest_by_region' | 'related_queries' | 'related_topics';
export const TREND_CSV_KIND_LABELS: Record<TrendCsvKind, string> = {
  interest_over_time: 'Interest over time',
  interest_by_region: 'Interest by region',
  related_queries: 'Related queries',
  related_topics: 'Related topics',
};

export interface ParsedTrendsCsv {
  kind: TrendCsvKind | null;
  interest: TrendInterest | null;
  related: TrendRelatedQueries | null;
  regions: TrendRegionalInterest | null;
  topics: TrendRelatedTopics | null;
  /** Text in brackets after the term in the column headers: the place ("India") or, for regional data, the dates. */
  headerNote: string | null;
  warnings: string[];
}

const NOTHING: ParsedTrendsCsv = {
  kind: null,
  interest: null,
  related: null,
  regions: null,
  topics: null,
  headerNote: null,
  warnings: [],
};

function parseRelated(rows: string[][], fileName: string): ParsedTrendsCsv | null {
  const items: { label: string; raw: string; list: 'top' | 'rising' | null }[] = [];
  let list: 'top' | 'rising' | null = null;
  let inTable = false;
  let topicHeader = false;
  for (const row of rows) {
    const [first = '', second = ''] = row;
    const label = first.toUpperCase();
    if ((label === 'TOP' || label === 'RISING') && !row.slice(1).some(Boolean)) {
      list = label === 'TOP' ? 'top' : 'rising';
      inTable = true;
      continue;
    }
    if (RELATED_HEADER.test(first)) {
      topicHeader ||= /topic/i.test(first);
      if (/increase|rising|growth|change/i.test(second)) list = 'rising';
      else if (/interest|popularity|value|top/i.test(second)) list = list ?? 'top';
      inTable = true;
      continue;
    }
    if (!inTable) continue;
    if (!first) continue;
    if (/^category:/i.test(first)) continue;
    items.push({ label: first, raw: second, list });
  }
  if (!items.length) return null;
  const top: { label: string; value: number }[] = [];
  const rising: { label: string; value: string }[] = [];
  for (const item of items) {
    const isGrowth = GROWTH.test(item.raw);
    if (item.list === 'rising' || (item.list === null && isGrowth))
      rising.push({ label: item.label, value: item.raw || '—' });
    else {
      const n = Number(item.raw);
      if (Number.isFinite(n) && item.raw !== '') top.push({ label: item.label, value: n });
    }
  }
  if (!top.length && !rising.length) return null;
  const all = [...top, ...rising];
  const topicLike = all.filter((i) => splitTopic(i.label).type !== null).length;
  const topics = topicHeader || /entit|topic/i.test(fileName) || topicLike * 5 >= all.length * 3;
  if (topics)
    return {
      ...NOTHING,
      kind: 'related_topics',
      topics: {
        keyword: null,
        top: top.map((t) => ({ ...splitTopic(t.label), value: t.value })),
        rising: rising.map((t) => ({ ...splitTopic(t.label), value: t.value })),
      },
    };
  return {
    ...NOTHING,
    kind: 'related_queries',
    related: {
      keyword: null,
      top: top.map((t) => ({ query: t.label, value: t.value })),
      rising: rising.map((t) => ({ query: t.label, value: t.value })),
    },
  };
}

/**
 * Reads the CSV files Google Trends exports: "Interest over time" (a date column plus one column per term),
 * "Interest by subregion/region/city" (a place column plus one column per term), "Related queries" and "Related
 * topics" (TOP and RISING sections). Unknown layouts return nulls rather than guessed numbers.
 */
export function parseTrendsCsv(content: string, fileName = ''): ParsedTrendsCsv {
  const lines = content.replace(/^\uFEFF/, '').split(/\r?\n/);
  const rows = lines.map(splitCsvLine);

  // Interest by region: a header whose first cell names the kind of place.
  const regionAt = rows.findIndex((r) => r.length >= 2 && REGION_HEADER.test(r[0]!));
  if (regionAt !== -1) {
    const header = rows[regionAt]!;
    const keywords = header.slice(1).map(headerKeyword).filter(Boolean);
    const regions: TrendRegionalInterest['regions'] = [];
    for (const row of rows.slice(regionAt + 1)) {
      if (!row[0]) {
        if (regions.length) break;
        continue;
      }
      regions.push({ geoCode: null, name: row[0], values: keywords.map((_, k) => parseInterestValue(row[k + 1] ?? '')) });
    } // prettier-ignore
    if (!keywords.length || !regions.length) return NOTHING;
    const kindOfPlace = header[0]!.toLowerCase();
    const resolution: TrendRegionResolution =
      kindOfPlace === 'country' ? 'COUNTRY' : kindOfPlace === 'city' ? 'CITY' : kindOfPlace === 'metro' || kindOfPlace === 'dma' ? 'DMA' : 'REGION'; // prettier-ignore
    return {
      ...NOTHING,
      kind: 'interest_by_region',
      regions: { resolution, keywords, regions, comparison: keywords.length > 1 ? 'share' : 'single' },
      headerNote: headerNote(header[1]),
    };
  }

  // Related queries or topics: TOP and RISING sections, or a table headed "query" / "topic".
  const related = parseRelated(rows, fileName);
  if (related) return related;

  // Interest over time: a header whose first cell names the period, followed by dated rows.
  const headerAt = rows.findIndex(
    (r, i) =>
      r.length >= 2 &&
      (DATE_HEADER.test(r[0]!) ||
        (normalizeDate(rows[i + 1]?.[0] ?? '') !== null && normalizeDate(r[0]!) === null)),
  );
  if (headerAt === -1) return NOTHING;
  const keywords = rows[headerAt]!.slice(1).map(headerKeyword).filter(Boolean);
  const dates: string[] = [];
  const values: (number | null)[][] = keywords.map(() => []);
  for (const row of rows.slice(headerAt + 1)) {
    const date = normalizeDate(row[0] ?? '');
    if (!date) continue;
    dates.push(date);
    keywords.forEach((_, k) => values[k]!.push(parseInterestValue(row[k + 1] ?? '')));
  }
  if (!dates.length || !keywords.length) return NOTHING;
  return {
    ...NOTHING,
    kind: 'interest_over_time',
    interest: {
      dates,
      series: keywords.map((keyword, k) => ({ keyword, values: values[k]!, average: average(values[k]!) })),
    },
    headerNote: headerNote(rows[headerAt]![1]),
  };
}

export interface TrendCsvFilePreview {
  name: string;
  kind: TrendCsvKind | null;
  /** Terms the file compares (for related files: the term chosen for it, when known). */
  keywords: string[];
  rows: number;
  /** First and last period or place, for checking the file is the right one. */
  first: string | null;
  last: string | null;
  headerNote: string | null;
  /** The first rows as Google wrote them. */
  sample: string[][];
  error: string | null;
}

export interface TrendCsvPreview {
  files: TrendCsvFilePreview[];
  keywords: string[];
  data: TrendData;
  ok: boolean;
  warnings: string[];
}

const sameTerms = (a: string[], b: string[]) =>
  a.length === b.length && a.every((t) => b.some((u) => u.toLowerCase() === t.toLowerCase()));

/**
 * Reads several exported files into one data set and reports what was found in each, so the user can check the
 * import before it is saved. Files that are not Google Trends exports are reported, never guessed at.
 */
export function buildTrendsImport(
  files: { name: string; content: string; keyword?: string }[],
  options: { keywords?: string[] } = {},
): TrendCsvPreview {
  const data: TrendData = { interest: null, related: [], regions: null, topics: [] };
  const warnings: string[] = [];
  const previews: TrendCsvFilePreview[] = [];
  const parsed = files.map((f) => ({ file: f, result: parseTrendsCsv(f.content, f.name) }));
  const known =
    options.keywords?.length
      ? options.keywords
      : (parsed.find((p) => p.result.interest)?.result.interest?.series.map((s) => s.keyword) ??
        parsed.find((p) => p.result.regions)?.result.regions?.keywords ??
        []); // prettier-ignore
  const relatedKeyword = (f: { keyword?: string }) => f.keyword ?? (known.length === 1 ? known[0]! : null);

  for (const { file, result } of parsed) {
    const base = { name: file.name, kind: result.kind, headerNote: result.headerNote, error: null };
    if (result.interest) {
      const i = result.interest;
      if (data.interest) warnings.push(`${file.name}: only the first “Interest over time” file is used.`);
      else data.interest = i;
      previews.push({ ...base, keywords: i.series.map((s) => s.keyword), rows: i.dates.length, first: i.dates[0] ?? null, last: i.dates.at(-1) ?? null,
        sample: i.dates.slice(0, 5).map((d, r) => [d, ...i.series.map((s) => (s.values[r] === null ? '' : String(s.values[r])))]) }); // prettier-ignore
    } else if (result.regions) {
      const g = result.regions;
      if (data.regions) warnings.push(`${file.name}: only the first regional file is used.`);
      else data.regions = g;
      previews.push({ ...base, keywords: g.keywords, rows: g.regions.length, first: g.regions[0]?.name ?? null, last: g.regions.at(-1)?.name ?? null,
        sample: g.regions.slice(0, 5).map((r) => [r.name, ...r.values.map((v) => (v === null ? '' : String(v)))]) }); // prettier-ignore
    } else if (result.related) {
      const keyword = relatedKeyword(file);
      data.related.push({ ...result.related, keyword });
      const all = [...result.related.top.map((q) => [q.query, String(q.value)]), ...result.related.rising.map((q) => [q.query, q.value])]; // prettier-ignore
      previews.push({ ...base, keywords: keyword ? [keyword] : [], rows: all.length, first: all[0]?.[0] ?? null, last: all.at(-1)?.[0] ?? null, sample: all.slice(0, 5) }); // prettier-ignore
    } else if (result.topics) {
      const keyword = relatedKeyword(file);
      data.topics!.push({ ...result.topics, keyword });
      const all = [...result.topics.top.map((t) => [t.topic, String(t.value)]), ...result.topics.rising.map((t) => [t.topic, t.value])]; // prettier-ignore
      previews.push({ ...base, keywords: keyword ? [keyword] : [], rows: all.length, first: all[0]?.[0] ?? null, last: all.at(-1)?.[0] ?? null, sample: all.slice(0, 5) }); // prettier-ignore
    } else {
      previews.push({ ...base, keywords: [], rows: 0, first: null, last: null, sample: [],
        error: 'Not a Google Trends export. Download a chart from Google Trends (the download icon) and upload the file unchanged.' }); // prettier-ignore
    }
  }
  if (data.interest && data.regions && !sameTerms(data.interest.series.map((s) => s.keyword), data.regions.keywords))
    warnings.push('The time and regional files compare different terms; check that they come from the same comparison.'); // prettier-ignore
  const unassigned = previews.filter((p) => (p.kind === 'related_queries' || p.kind === 'related_topics') && !p.keywords.length); // prettier-ignore
  if (unassigned.length)
    warnings.push(`${unassigned.map((p) => p.name).join(', ')}: choose which term ${unassigned.length === 1 ? 'this file belongs' : 'these files belong'} to, since Google’s file does not say.`); // prettier-ignore
  let keywords = known.length ? [...known] : [...new Set(previews.flatMap((p) => p.keywords))];
  if (keywords.length > TREND_MAX_KEYWORDS) {
    warnings.push(`Only the first ${TREND_MAX_KEYWORDS} terms are kept.`);
    keywords = keywords.slice(0, TREND_MAX_KEYWORDS);
  }
  return {
    files: previews,
    keywords,
    data,
    ok: Boolean(data.interest || data.regions || data.related.length || data.topics!.length),
    warnings,
  };
}

// ---------------- Analysis ----------------

/**
 * present: a page targets the term in its title, main heading or address. partial: the term appears only in
 * sub-headings or descriptions, or its words are on the site but never together. missing: neither.
 */
export type TrendTermStatus = 'missing' | 'partial' | 'present';
export type TrendPageField = 'address' | 'title' | 'h1' | 'heading' | 'description';

/** Google Search Console figures for a query (measured clicks and impressions, not Trends interest). */
export interface SearchConsoleQueryMetrics {
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
  rangeStart: string;
  rangeEnd: string;
}

export interface TrendTerm {
  term: string;
  origin: 'keyword' | 'top_query' | 'rising_query';
  /** Average interest (terms you compared) or related-query popularity (0–100). */
  interest: number | null;
  /** Growth label for rising queries. */
  rising: string | null;
  /** Direction of interest over the period, for the terms you compared. */
  direction?: TrendDirection | null;
  status: TrendTermStatus;
  matchedWords: string[];
  missingWords: string[];
  /** Pages where the term appears as a phrase, and in which fields (titles, main headings and addresses first). */
  pages: { url: string; title: string | null; fields: TrendPageField[] }[];
  /** Your own Search Console figures for this exact query, when connected. */
  searchConsole?: SearchConsoleQueryMetrics | null;
}

export type TrendPlacementSpot = 'title' | 'h1' | 'heading' | 'body' | 'meta_description' | 'faq';

export interface TrendPlacement {
  term: string;
  action: 'add_to_page' | 'new_page';
  /** A page of your latest crawl (verified to exist), or null for a new page. */
  pageUrl: string | null;
  pageTitle: string | null;
  /** An existing heading of that page (verified), or null. */
  section: string | null;
  /** A new heading to add, when no existing section fits. */
  newSection: string | null;
  spot: TrendPlacementSpot;
  /** Wording to adapt; AI-written, so check every claim before publishing. */
  suggestedText: string;
  reason: string;
}

export interface TrendAnalysisResult {
  version: 1;
  terms: TrendTerm[];
  placements: TrendPlacement[];
  method: {
    pagesChecked: number;
    crawlFinishedAt: string | null;
    placementModel: string | null;
    /** Whether Search Console data was available for the terms. */
    searchConsole?: { connected: boolean; rangeStart: string | null; rangeEnd: string | null };
  };
  notes: string[];
}

export type TrendFreshness = 'fresh' | 'stale' | 'imported';

export interface TrendReportSummaryDto {
  id: string;
  status: 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
  source: TrendSource;
  keywords: string[];
  country: string | null;
  region: string | null;
  /** City filter: the terms mention this city (see trendSettingsSchema.city). */
  city: string | null;
  timeRange: TrendTimeRange;
  category: number;
  trigger: 'MANUAL' | 'SCHEDULED';
  cached: boolean;
  partial: boolean;
  fetchedAt: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface TrendReportDto extends TrendReportSummaryDto {
  projectId: string;
  sourceLabel: string;
  sourceType: TrendSourceType;
  experimental: boolean;
  language: string;
  include: TrendDataType[];
  exploreUrl: string;
  data: TrendData | null;
  analysis: TrendAnalysisResult | null;
  /** When the cached data should be fetched again. */
  expiresAt: string | null;
  freshness: TrendFreshness | null;
  /** What the data cannot show, and which parts were not available. */
  limitations: string[];
  /** The CSV files a report was imported from. */
  imports: { fileName: string; kind: string; rows: number }[];
  savedQueryId: string | null;
  errorMessage: string | null;
  jobId: string | null;
}

export interface TrendProviderStatusDto {
  key: TrendSource;
  label: string;
  kind: 'live' | 'import' | 'fixture';
  /** Allowed by the server's TRENDS_PROVIDERS setting. */
  enabled: boolean;
  /** Credentials or a service address are set. */
  configured: boolean;
  /** Enabled, configured and not cooling down: requests can be made now. */
  available: boolean;
  experimental: boolean;
  paid: boolean;
  detail: string;
  capabilities: {
    interest: boolean;
    regions: boolean;
    relatedQueries: boolean;
    relatedTopics: boolean;
    subregions: boolean;
    maxKeywords: number;
  };
  health: { ok: boolean; coolingDownSeconds: number; lastError: string | null; checkedAt: string } | null;
  lastSuccessAt: string | null;
  lastFailure: { at: string; outcome: string; message: string | null } | null;
}

export interface TrendsStatusDto {
  providers: TrendProviderStatusDto[];
  /** The live provider used when a request names none. */
  defaultProvider: TrendLiveSource | null;
  searchConsole: { connected: boolean; lastSyncedAt: string | null; detail: string };
  keywordPlanner: { configured: boolean; detail: string };
  ai: { configured: boolean; detail: string };
  limits: {
    liveReportsPerWorkspacePerDay: number;
    liveReportsToday: number;
    reportsPerProjectPerDay: number;
  };
}

export interface TrendSavedQueryDto {
  id: string;
  name: string;
  keywords: string[];
  country: string | null;
  region: string | null;
  city: string | null;
  timeRange: TrendTimeRange;
  category: number;
  provider: TrendLiveSource | null;
  schedule: TrendSchedule;
  nextRunAt: string | null;
  lastReportId: string | null;
  createdAt: string;
}
