// AI visibility provider adapters. Only official APIs are used, and a provider is reported as
// configured only when its credentials are present. The demo provider is deterministic fixture data
// and every result it produces is flagged isDemo.
import {
  VISIBILITY_PROVIDERS,
  languageName,
  type CaptureMethod,
  type CitationSourceType,
  type ProviderStatusDto,
  type Sentiment,
  type VisibilityProviderKey,
  type VisibilityProviderMeta,
} from '@surfaced/shared';
import { createHash } from 'node:crypto';
import { getOpenAiClient, ProviderError, supportsReasoning, toProviderError } from '../ai/llm';
import { getEnv } from '../env';
import { DataForSeoAiModeProvider, GeminiVisibilityProvider } from './google-providers';

export interface VisibilityRequest {
  prompt: string;
  country: string;
  /** City the answer should be local to (providers that cannot use it say so in the limitations). */
  city?: string | null;
  /** Coordinates of a business location in that city, for providers that take a position. */
  coordinates?: { latitude: number; longitude: number } | null;
  language: string;
  signal?: AbortSignal;
}

export interface EntityRef {
  id: string | null;
  name: string;
  /** Null for a business without a website (matched by name and aliases only). */
  domain: string | null;
  aliases: string[];
}

export interface VisibilityContext {
  brand: EntityRef;
  competitors: EntityRef[];
}

export interface ProviderCitation {
  url: string;
  title: string | null;
  sourceType: CitationSourceType;
}

export interface VisibilityResult {
  answerText: string;
  citations: ProviderCitation[];
  model: string | null;
  /** Provider response with secrets removed and long fields truncated. */
  raw: Record<string, unknown>;
  latencyMs: number;
  usage: Record<string, number | null> | null;
  isDemo: boolean;
  /** Only the demo provider supplies a fixture sentiment; real sentiment is an AI estimate computed later. */
  fixtureSentiment?: Sentiment | null;
  /** How the answer was obtained (defaults to API, or DEMO for fixtures). */
  captureMethod?: CaptureMethod;
  /** What this answer can and cannot show (location applied, approximation of the consumer product…). */
  limitations?: string[];
}

export interface AiVisibilityProvider {
  readonly key: VisibilityProviderKey;
  readonly meta: VisibilityProviderMeta;
  status(): Pick<ProviderStatusDto, 'configured' | 'status' | 'detail'>;
  observe(request: VisibilityRequest, context: VisibilityContext): Promise<VisibilityResult>;
}

const MAX_ANSWER_CHARS = 20_000;

function truncate(text: string, max = 4000): string {
  return text.length > max ? `${text.slice(0, max)}… [truncated]` : text;
}

function answerInstruction(language: string): string {
  return `Answer the user's question helpfully and accurately. Respond in ${languageName(language)}.`;
}

// ---------------- OpenAI (Responses API) ----------------

interface OpenAiOutputItem {
  type: string;
  content?: { type: string; text?: string; annotations?: { type: string; url?: string; title?: string }[] }[];
  action?: { type: string; query?: string; queries?: string[]; sources?: { type: string; url: string }[] };
}

export class OpenAIVisibilityProvider implements AiVisibilityProvider {
  readonly key: VisibilityProviderKey;
  readonly meta: VisibilityProviderMeta;

  constructor(private readonly webSearch: boolean) {
    this.key = webSearch ? 'openai_web_search' : 'openai_model_knowledge';
    this.meta = VISIBILITY_PROVIDERS[this.key];
  }

  status() {
    const env = getEnv();
    return env.OPENAI_API_KEY
      ? {
          configured: true,
          status: 'configured' as const,
          detail: `Model ${env.OPENAI_VISIBILITY_MODEL}${this.webSearch ? ' with the web_search tool' : ', no browsing'}`,
        }
      : {
          configured: false,
          status: 'not_configured' as const,
          detail: 'Provider not configured: set OPENAI_API_KEY.',
        };
  }

  async observe(request: VisibilityRequest): Promise<VisibilityResult> {
    const env = getEnv();
    const model = env.OPENAI_VISIBILITY_MODEL;
    const started = Date.now();
    try {
      const response = await getOpenAiClient().responses.create(
        {
          model,
          instructions: answerInstruction(request.language),
          input: request.prompt,
          max_output_tokens: 3000,
          ...(supportsReasoning(model) ? { reasoning: { effort: 'low' as const } } : {}),
          ...(this.webSearch
            ? {
                tools: [
                  {
                    type: 'web_search' as const,
                    search_context_size: 'medium' as const,
                    user_location: {
                      type: 'approximate' as const,
                      country: request.country,
                      ...(request.city ? { city: request.city } : {}),
                    },
                  },
                ],
                include: ['web_search_call.action.sources' as const],
              }
            : {}),
        },
        { signal: request.signal },
      );
      const output = (response.output ?? []) as unknown as OpenAiOutputItem[];
      const citations: ProviderCitation[] = [];
      const queries: string[] = [];
      for (const item of output) {
        if (item.type === 'message') {
          for (const part of item.content ?? []) {
            for (const annotation of part.annotations ?? []) {
              if (annotation.type === 'url_citation' && annotation.url) {
                citations.push({
                  url: annotation.url,
                  title: annotation.title ?? null,
                  sourceType: 'INLINE_CITATION',
                });
              }
            }
          }
        } else if (item.type === 'web_search_call' && item.action?.type === 'search') {
          queries.push(...(item.action.queries ?? (item.action.query ? [item.action.query] : [])));
          for (const source of item.action.sources ?? [])
            citations.push({ url: source.url, title: null, sourceType: 'SEARCH_RESULT' });
        }
      }
      const answerText = (response.output_text ?? '').slice(0, MAX_ANSWER_CHARS);
      if (!answerText.trim())
        throw new ProviderError('BAD_RESPONSE', 'OpenAI returned an empty answer.', true);
      return {
        answerText,
        citations,
        model: response.model ?? model,
        raw: {
          id: response.id,
          model: response.model,
          status: response.status,
          webSearch: this.webSearch,
          searchQueries: queries.slice(0, 20),
          outputTypes: output.map((o) => o.type),
          answerPreview: truncate(answerText, 2000),
        },
        latencyMs: Date.now() - started,
        usage: {
          inputTokens: response.usage?.input_tokens ?? null,
          outputTokens: response.usage?.output_tokens ?? null,
        },
        isDemo: false,
        captureMethod: 'API',
        limitations: this.webSearch
          ? [
              'OpenAI API with web search: approximates, but is not, ChatGPT search, which also personalizes answers.',
              `Location sent to the web search tool as approximate: ${request.city ? `${request.city}, ` : ''}${request.country}.`,
            ]
          : [
              'Model knowledge without browsing: what the model has learned, not a live search.',
              ...(request.city
                ? ['The model has no location; the city is reflected only when the prompt itself names it.']
                : []),
            ],
      };
    } catch (error) {
      throw toProviderError(error, 'OpenAI');
    }
  }
}

// ---------------- Perplexity (Agent API) ----------------

interface PerplexityResult {
  id?: number | string;
  url?: string;
  title?: string;
  date?: string | null;
}

export class PerplexityVisibilityProvider implements AiVisibilityProvider {
  readonly key = 'perplexity_sonar' as const;
  readonly meta = VISIBILITY_PROVIDERS.perplexity_sonar;

  status() {
    return getEnv().PERPLEXITY_API_KEY
      ? {
          configured: true,
          status: 'configured' as const,
          detail: 'Perplexity Agent API (preset "fast", web search)',
        }
      : {
          configured: false,
          status: 'not_configured' as const,
          detail: 'Provider not configured: set PERPLEXITY_API_KEY.',
        };
  }

  async observe(request: VisibilityRequest): Promise<VisibilityResult> {
    const env = getEnv();
    if (!env.PERPLEXITY_API_KEY) throw new ProviderError('NOT_CONFIGURED', 'PERPLEXITY_API_KEY is not set.');
    const started = Date.now();
    let response: Response;
    try {
      response = await fetch('https://api.perplexity.ai/v1/agent', {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.PERPLEXITY_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          preset: env.PERPLEXITY_MODEL === 'sonar' ? 'fast' : env.PERPLEXITY_MODEL,
          instructions: answerInstruction(request.language),
          input: request.prompt,
          max_output_tokens: 3000,
          tools: [{ type: 'web_search', user_location: { country: request.country } }],
        }),
        signal: request.signal
          ? AbortSignal.any([request.signal, AbortSignal.timeout(120_000)])
          : AbortSignal.timeout(120_000),
      });
    } catch (error) {
      throw toProviderError(error, 'Perplexity');
    }
    if (response.status === 401 || response.status === 403)
      throw new ProviderError('AUTH_FAILED', `Perplexity rejected the API key (HTTP ${response.status}).`);
    if (response.status === 429) {
      const retryAfter = Number(response.headers.get('retry-after'));
      throw new ProviderError(
        'RATE_LIMITED',
        'Perplexity rate limit reached.',
        true,
        Number.isFinite(retryAfter) ? retryAfter * 1000 : undefined,
      );
    }
    if (response.status >= 500)
      throw new ProviderError('UPSTREAM_ERROR', `Perplexity returned HTTP ${response.status}.`, true);
    if (!response.ok)
      throw new ProviderError(
        'INVALID_REQUEST',
        `Perplexity rejected the request (HTTP ${response.status}).`,
      );

    const json = (await response.json()) as {
      model?: string;
      output_text?: string;
      output?: { type: string; results?: PerplexityResult[]; content?: { type: string; text?: string }[] }[];
      results?: PerplexityResult[];
      usage?: Record<string, number>;
    };
    const results: PerplexityResult[] = [
      ...(json.output ?? []).filter((o) => o.type === 'search_results').flatMap((o) => o.results ?? []),
      ...(json.results ?? []),
    ];
    const answerText = (
      json.output_text ??
      (json.output ?? [])
        .filter((o) => o.type === 'message')
        .flatMap((o) => o.content ?? [])
        .map((c) => c.text ?? '')
        .join('\n')
    ).slice(0, MAX_ANSWER_CHARS);
    if (!answerText.trim())
      throw new ProviderError('BAD_RESPONSE', 'Perplexity returned an empty answer.', true);

    // Inline markers look like [1] (preset "fast") or [web:1]; they reference search result ids.
    const cited = new Set([...answerText.matchAll(/\[(?:web:)?(\d+)\]/g)].map((m) => m[1]));
    const citations: ProviderCitation[] = results
      .filter((r) => typeof r.url === 'string')
      .map((r) => ({
        url: r.url!,
        title: r.title ?? null,
        sourceType: r.id !== undefined && cited.has(String(r.id)) ? 'INLINE_CITATION' : 'SEARCH_RESULT',
      }));
    return {
      answerText,
      citations,
      model: json.model ?? 'perplexity-agent',
      raw: { model: json.model, resultCount: results.length, answerPreview: truncate(answerText, 2000) },
      latencyMs: Date.now() - started,
      usage: json.usage ?? null,
      isDemo: false,
      captureMethod: 'API',
      limitations: [
        'Perplexity Agent API with web search: close to, but not the same as, the Perplexity app.',
        request.city
          ? `Located in ${request.country} only: Perplexity receives the country, not the city.`
          : `Located in ${request.country}.`,
      ],
    };
  }
}

// ---------------- Demo fixtures (development only) ----------------

function hashInt(seed: string): number {
  return createHash('sha256').update(seed).digest().readUInt32BE(0);
}

/** ISO week key so demo answers change week to week (useful for trend charts) but stay deterministic. */
function weekKey(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

export class MockVisibilityProvider implements AiVisibilityProvider {
  readonly key = 'mock_demo' as const;
  readonly meta = VISIBILITY_PROVIDERS.mock_demo;

  constructor(private readonly now: () => Date = () => new Date()) {}

  status() {
    return getEnv().AI_DEMO_MODE
      ? {
          configured: true,
          status: 'demo' as const,
          detail: 'Demo fixtures enabled (AI_DEMO_MODE=true). Results are labeled as demo data.',
        }
      : {
          configured: false,
          status: 'disabled' as const,
          detail: 'Demo fixtures are disabled (AI_DEMO_MODE=false).',
        };
  }

  async observe(request: VisibilityRequest, context: VisibilityContext): Promise<VisibilityResult> {
    if (!getEnv().AI_DEMO_MODE) throw new ProviderError('NOT_CONFIGURED', 'Demo fixtures are disabled.');
    const seed = `${request.prompt}|${request.country}|${weekKey(this.now())}`;
    const h = hashInt(seed);
    const pool = [...context.competitors];
    const includeBrand = h % 100 < 55;
    const citeBrand = includeBrand && (h >> 8) % 100 < 60;
    if (includeBrand) pool.splice(Math.min(pool.length, (h >> 4) % (pool.length + 1)), 0, context.brand);
    const picked = pool.slice(0, Math.min(pool.length, 3 + ((h >> 12) % 2)));
    const lines = picked.map(
      (entity, index) =>
        `${index + 1}. **${entity.name}** — ${['a widely recommended option', 'praised for ease of use', 'a strong choice for small teams', 'known for good support'][(h >> (index + 2)) % 4]}.`,
    );
    const answerText = [
      `[Demo data — not a real AI response] Here are options people often consider for "${request.prompt}":`,
      '',
      ...lines,
      '',
      'Compare pricing, support and reviews before deciding.',
    ].join('\n');
    const citations: ProviderCitation[] = [
      {
        url: 'https://reviews.example.com/roundup',
        title: 'Example review roundup (demo)',
        sourceType: 'INLINE_CITATION',
      },
      ...picked
        .filter((e) => e !== context.brand || citeBrand)
        .slice(0, 3)
        .map((e) => ({
          url: `https://${e.domain}/`,
          title: `${e.name} (demo citation)`,
          sourceType: 'INLINE_CITATION' as const,
        })),
      {
        url: 'https://industry-guide.example.org/guide',
        title: 'Example industry guide (demo)',
        sourceType: 'SEARCH_RESULT',
      },
    ];
    return {
      answerText,
      citations,
      model: 'demo-fixture',
      raw: { demo: true, seed: createHash('sha256').update(seed).digest('hex').slice(0, 12) },
      latencyMs: 5,
      usage: null,
      isDemo: true,
      fixtureSentiment: includeBrand ? (['POSITIVE', 'NEUTRAL', 'NEUTRAL', 'MIXED'] as const)[h % 4] : null,
    };
  }
}

// ---------------- Registry ----------------

const factories: Record<VisibilityProviderKey, () => AiVisibilityProvider> = {
  openai_web_search: () => new OpenAIVisibilityProvider(true),
  openai_model_knowledge: () => new OpenAIVisibilityProvider(false),
  perplexity_sonar: () => new PerplexityVisibilityProvider(),
  gemini_model_knowledge: () => new GeminiVisibilityProvider(),
  dataforseo_ai_mode: () => new DataForSeoAiModeProvider(),
  mock_demo: () => new MockVisibilityProvider(),
};

let overrides: Partial<Record<VisibilityProviderKey, AiVisibilityProvider>> = {};

export function getVisibilityProvider(key: VisibilityProviderKey): AiVisibilityProvider {
  return overrides[key] ?? factories[key]();
}

/** Test hook. */
export function setVisibilityProviderOverrides(
  next: Partial<Record<VisibilityProviderKey, AiVisibilityProvider>>,
): void {
  overrides = next;
}

export function listVisibilityProviderStatuses(): ProviderStatusDto[] {
  return (Object.keys(factories) as VisibilityProviderKey[]).map((key) => {
    const provider = getVisibilityProvider(key);
    return { key, label: provider.meta.label, kind: provider.meta.kind, ...provider.status() };
  });
}
