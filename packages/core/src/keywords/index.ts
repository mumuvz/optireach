// Keyword CSV import/export and AI keyword ideas. Measured metrics (search volume, difficulty, CPC)
// are only ever filled by a licensed data provider; none is bundled, so they stay empty.
import {
  KEYWORD_IMPORT_MAX_ROWS,
  KEYWORD_PRIORITIES,
  KEYWORD_STATUSES,
  SEARCH_INTENTS,
  keywordInputSchema,
  languageName,
  type KeywordPriority,
  type KeywordStatus,
  type SearchIntent,
} from '@surfaced/shared';
import { parse } from 'csv-parse/sync';
import { getLlmProvider, ProviderError, type LlmProvider, type LlmProviderKey } from '../ai/llm';
import { keywordIdeasOutputSchema } from '../content/generation';
import type { PrismaClient } from '../db';
import { recordUsage } from '../usage';

export function normalizePhrase(phrase: string): string {
  return phrase.trim().toLowerCase().replace(/\s+/g, ' ');
}

export interface ParsedKeywordRow {
  phrase: string;
  intent?: SearchIntent;
  priority: KeywordPriority;
  status: KeywordStatus;
  country: string;
  language: string;
  relatedQuestions: string[];
  targetUrl?: string;
  notes?: string;
  cluster?: string;
  list?: string;
}

export interface CsvParseResult {
  rows: ParsedKeywordRow[];
  errors: { line: number; message: string }[];
  totalRows: number;
}

const HEADER_ALIASES: Record<string, string> = {
  keyword: 'phrase',
  phrase: 'phrase',
  query: 'phrase',
  intent: 'intent',
  'search intent': 'intent',
  priority: 'priority',
  status: 'status',
  country: 'country',
  language: 'language',
  cluster: 'cluster',
  'topic cluster': 'cluster',
  list: 'list',
  'target url': 'targetUrl',
  target_url: 'targetUrl',
  url: 'targetUrl',
  'related questions': 'relatedQuestions',
  related_questions: 'relatedQuestions',
  questions: 'relatedQuestions',
  notes: 'notes',
};

function pickEnum<T extends string>(values: readonly T[], raw: string | undefined): T | undefined {
  if (!raw) return undefined;
  const upper = raw
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '_');
  return values.find((v) => v === upper);
}

/** Parses keyword CSV text (header row required; columns matched case-insensitively). */
export function parseKeywordCsv(
  text: string,
  defaults: { country: string; language: string },
): CsvParseResult {
  let records: Record<string, string>[];
  try {
    records = parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text, {
      columns: (headers: string[]) => headers.map((h) => HEADER_ALIASES[h.trim().toLowerCase()] ?? h.trim()),
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true,
      bom: true,
      to: KEYWORD_IMPORT_MAX_ROWS + 1,
    }) as Record<string, string>[];
  } catch (error) {
    return {
      rows: [],
      errors: [
        {
          line: 0,
          message: `Could not read the CSV: ${error instanceof Error ? error.message : 'invalid format'}`,
        },
      ],
      totalRows: 0,
    };
  }
  const errors: CsvParseResult['errors'] = [];
  if (records.length > KEYWORD_IMPORT_MAX_ROWS) {
    errors.push({
      line: 0,
      message: `Only the first ${KEYWORD_IMPORT_MAX_ROWS} rows were imported. Split larger files.`,
    });
    records = records.slice(0, KEYWORD_IMPORT_MAX_ROWS);
  }
  if (records.length && !('phrase' in records[0]!)) {
    return {
      rows: [],
      errors: [{ line: 1, message: 'Missing a "keyword" (or "phrase") column in the header row.' }],
      totalRows: records.length,
    };
  }
  const rows: ParsedKeywordRow[] = [];
  records.forEach((record, index) => {
    const line = index + 2; // header is line 1
    const candidate = {
      phrase: record.phrase ?? '',
      intent: pickEnum(SEARCH_INTENTS, record.intent),
      priority: pickEnum(KEYWORD_PRIORITIES, record.priority) ?? 'MEDIUM',
      status: pickEnum(KEYWORD_STATUSES, record.status) ?? 'IDEA',
      country: (record.country || defaults.country).toUpperCase(),
      language: record.language || defaults.language,
      relatedQuestions: (record.relatedQuestions ?? '')
        .split('|')
        .map((q) => q.trim())
        .filter((q) => q.length >= 3)
        .slice(0, 20),
      targetUrl: record.targetUrl || undefined,
      notes: record.notes || undefined,
    };
    const parsed = keywordInputSchema.safeParse(candidate);
    if (!parsed.success) {
      errors.push({
        line,
        message: parsed.error.issues.map((i) => `${i.path.join('.') || 'row'}: ${i.message}`).join('; '),
      });
      return;
    }
    rows.push({ ...parsed.data, cluster: record.cluster || undefined, list: record.list || undefined });
  });
  return { rows, errors, totalRows: records.length };
}

/** CSV cell escaping that also neutralizes spreadsheet formula injection (=, +, -, @, tab, CR). */
export function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export interface KeywordExportRow {
  phrase: string;
  intent: string | null;
  priority: string;
  status: string;
  country: string;
  language: string;
  cluster: string | null;
  list: string | null;
  targetUrl: string | null;
  relatedQuestions: string[];
  notes: string | null;
  searchVolume: number | null;
  difficulty: number | null;
  cpc: string | null;
  metricsSource: string | null;
}

export function keywordsToCsv(rows: KeywordExportRow[]): string {
  const header = [
    'keyword',
    'intent',
    'priority',
    'status',
    'country',
    'language',
    'cluster',
    'list',
    'target_url',
    'related_questions',
    'notes',
    'search_volume',
    'difficulty',
    'cpc',
    'metrics_source',
  ];
  const lines = rows.map((r) =>
    [
      r.phrase,
      r.intent,
      r.priority,
      r.status,
      r.country,
      r.language,
      r.cluster,
      r.list,
      r.targetUrl,
      r.relatedQuestions.join(' | '),
      r.notes,
      r.searchVolume,
      r.difficulty,
      r.cpc,
      r.metricsSource,
    ]
      .map(csvCell)
      .join(','),
  );
  return [header.join(','), ...lines].join('\r\n') + '\r\n';
}

export interface KeywordSuggestionPayload {
  projectId: string;
  /** Focus topic; absent for ideas about the whole business. */
  seed?: string | null;
  country: string;
  language: string;
  count: number;
  /** Which LLM provider to run on; absent uses the server default. The worker resolves it to a provider. */
  provider?: LlmProviderKey | null;
}

export interface KeywordSuggestionResult {
  suggestions: {
    phrase: string;
    intent: SearchIntent;
    relatedQuestions: string[];
    rationale: string;
    alreadyTracked: boolean;
  }[];
  isDevAdapter: boolean;
  /** The provider that actually generated these ideas, so a comparison can be labeled by provider. */
  provider: LlmProviderKey;
  model: string;
  label: string;
}

/**
 * What the business shows about itself: description, primary keywords, competitors and the titles of its crawled
 * pages (its real products and services). Keeps AI keyword ideas tied to what the business actually offers.
 */
export async function businessContext(
  prisma: PrismaClient,
  project: { id: string; description: string | null; competitors?: { name: string }[] },
): Promise<string> {
  const [primary, crawl] = await Promise.all([
    prisma.projectKeyword.findMany({
      where: { projectId: project.id, isPrimary: true },
      select: { phrase: true },
      take: 20,
    }),
    prisma.crawlJob.findFirst({
      where: { projectId: project.id, status: 'SUCCEEDED' },
      orderBy: { finishedAt: 'desc' },
      select: { id: true },
    }),
  ]);
  const pages = crawl
    ? await prisma.crawledPage.findMany({
        where: { crawlJobId: crawl.id, isHtml: true, statusCode: 200, isIndexable: true },
        select: { title: true, h1: true },
        orderBy: { depth: 'asc' },
        take: 200,
      })
    : [];
  const titles = [
    ...new Set(pages.map((p) => (p.h1 || p.title || '').replace(/\s+/g, ' ').trim()).filter(Boolean)),
  ]
    .slice(0, 40)
    .map((t) => t.slice(0, 90));
  return [
    project.description ? `About: ${project.description.slice(0, 600)}` : '',
    primary.length ? `Primary keywords: ${primary.map((k) => k.phrase).join(', ')}` : '',
    project.competitors?.length ? `Competitors: ${project.competitors.map((c) => c.name).join(', ')}` : '',
    titles.length ? `Pages on the website: ${titles.join(' | ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Generates keyword ideas. They are explicitly unmeasured estimates (no volume/difficulty/CPC). */
export async function executeKeywordSuggestions(
  prisma: PrismaClient,
  backgroundJobId: string,
  payload: KeywordSuggestionPayload,
  llm: LlmProvider | null = getLlmProvider(),
): Promise<KeywordSuggestionResult> {
  if (!llm)
    throw new ProviderError(
      'NOT_CONFIGURED',
      'Keyword suggestions need an LLM provider (LLM_PROVIDER=none).',
    );
  const project = await prisma.project.findUniqueOrThrow({
    where: { id: payload.projectId },
    include: { competitors: { select: { name: true } } },
  });
  const context = await businessContext(prisma, project);
  const seed = payload.seed?.trim() || null;
  const { data, model, isDevAdapter } = await llm.generateJson({
    schema: keywordIdeasOutputSchema,
    schemaName: 'keyword_ideas',
    system:
      'You are an SEO strategist. Suggest realistic search queries people would type into Google or ask an AI assistant when looking for what this business offers. Base the ideas on the business context given (its pages, products and keywords); do not suggest products or services the business does not show. Do not estimate or mention search volume, difficulty, CPC or rankings. Return queries in the requested language.',
    user: [
      `Business: ${project.name} (${project.websiteUrl})${project.industry ? `, industry ${project.industry}` : ''}.`,
      context,
      seed ? `Focus topic: ${seed}` : 'Focus: the main products and services shown above.',
      `Market: ${payload.country}, language ${languageName(payload.language)}.`,
      `Suggest ${payload.count} distinct keyword ideas across informational, commercial and transactional intent, each with 2–3 related questions and a one-sentence rationale.`,
    ]
      .filter(Boolean)
      .join('\n'),
    maxOutputTokens: Math.min(8000, 1500 + payload.count * 160),
    devFallback: () => ({
      keywords: Array.from({ length: Math.min(payload.count, 8) }, (_, i) => ({
        phrase: `${seed ?? project.name} ${['guide', 'pricing', 'alternatives', 'for beginners', 'checklist', 'vs competitors', 'near me', 'best practices'][i]}`,
        intent: (
          [
            'INFORMATIONAL',
            'COMMERCIAL',
            'COMMERCIAL',
            'INFORMATIONAL',
            'INFORMATIONAL',
            'COMMERCIAL',
            'TRANSACTIONAL',
            'INFORMATIONAL',
          ] as const
        )[i]!,
        relatedQuestions: [`What is ${seed ?? project.name}?`, `How much does ${seed ?? project.name} cost?`],
        rationale: 'Development adapter template idea (not AI-generated).',
      })),
    }),
  });
  const existing = new Set(
    (
      await prisma.projectKeyword.findMany({
        where: { projectId: payload.projectId, country: payload.country, language: payload.language },
        select: { normalizedPhrase: true },
      })
    ).map((k) => k.normalizedPhrase),
  );
  const seen = new Set<string>();
  const suggestions = data.keywords
    .map((k) => ({
      ...k,
      phrase: k.phrase.trim().slice(0, 200),
      relatedQuestions: k.relatedQuestions.slice(0, 5),
    }))
    .filter(
      (k) =>
        k.phrase.length > 1 && !seen.has(normalizePhrase(k.phrase)) && seen.add(normalizePhrase(k.phrase)),
    )
    .slice(0, payload.count)
    .map((k) => ({ ...k, alreadyTracked: existing.has(normalizePhrase(k.phrase)) }));
  await recordUsage(prisma, {
    workspaceId: project.workspaceId,
    projectId: project.id,
    metric: 'KEYWORD_SUGGESTION',
    quantity: 1,
    idempotencyKey: `keywords:${backgroundJobId}`,
  });
  return {
    suggestions,
    isDevAdapter,
    provider: llm.key,
    model,
    label: isDevAdapter
      ? 'Development adapter templates — not AI-generated and not measured.'
      : `AI-generated ideas from ${llm.label} (${model}) — estimates without measured search volume, difficulty or CPC.`,
  };
}

export { keywordOpportunities, scoreKeyword, trendSignalFor } from './opportunity';
