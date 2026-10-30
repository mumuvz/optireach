// Google AI visibility adapters (docs/providers/ai-and-serp-providers.md):
//  - Gemini API without grounding: what the model says about a brand. Grounded answers (Google Search or Maps
//    grounding) are never requested, because Google's terms forbid storing and analyzing them.
//  - Google AI Mode through the licensed provider DataForSEO (Google offers no API), opt-in with
//    SERP_PROVIDER=dataforseo, labeled as licensed data.
import { VISIBILITY_PROVIDERS, countryName, languageName } from '@surfaced/shared';
import { ProviderError, toProviderError } from '../ai/llm';
import { getEnv } from '../env';
import type {
  AiVisibilityProvider,
  ProviderCitation,
  VisibilityRequest,
  VisibilityResult,
} from './providers';

type Fetch = typeof fetch;
const MAX_ANSWER_CHARS = 20_000;

function httpError(
  vendor: string,
  status: number,
  detail: string,
  retryAfterSeconds?: number,
): ProviderError {
  if (status === 401 || status === 403)
    return new ProviderError('AUTH_FAILED', `${vendor} rejected the credentials (HTTP ${status}).`);
  if (status === 429)
    return new ProviderError(
      'RATE_LIMITED',
      `${vendor} rate limit reached.`,
      true,
      retryAfterSeconds && Number.isFinite(retryAfterSeconds) ? retryAfterSeconds * 1000 : undefined,
    );
  if (status >= 500) return new ProviderError('UPSTREAM_ERROR', `${vendor} returned HTTP ${status}.`, true);
  return new ProviderError('INVALID_REQUEST', `${vendor} rejected the request (HTTP ${status})${detail ? `: ${detail.slice(0, 300)}` : ''}.`); // prettier-ignore
}

const timeout = (signal: AbortSignal | undefined, ms: number) =>
  signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);

// ---------------- Gemini (ungrounded) ----------------

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
  modelVersion?: string;
  promptFeedback?: { blockReason?: string };
  error?: { message?: string };
}

export class GeminiVisibilityProvider implements AiVisibilityProvider {
  readonly key = 'gemini_model_knowledge' as const;
  readonly meta = VISIBILITY_PROVIDERS.gemini_model_knowledge;

  constructor(private readonly httpFetch: Fetch = fetch) {}

  status() {
    const env = getEnv();
    return env.GEMINI_API_KEY
      ? { configured: true, status: 'configured' as const, detail: `Gemini API (${env.GEMINI_MODEL}), no Google Search grounding` } // prettier-ignore
      : { configured: false, status: 'not_configured' as const, detail: 'Provider not configured: set GEMINI_API_KEY.' }; // prettier-ignore
  }

  async observe(request: VisibilityRequest): Promise<VisibilityResult> {
    const env = getEnv();
    if (!env.GEMINI_API_KEY) throw new ProviderError('NOT_CONFIGURED', 'GEMINI_API_KEY is not set.');
    const model = env.GEMINI_MODEL;
    const started = Date.now();
    let response: Response;
    try {
      response = await this.httpFetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        {
          method: 'POST',
          headers: { 'x-goog-api-key': env.GEMINI_API_KEY, 'content-type': 'application/json' },
          // No `tools`: grounding with Google Search or Maps is deliberately not used.
          body: JSON.stringify({
            systemInstruction: {
              parts: [{ text: `Answer the user's question helpfully and accurately. Respond in ${languageName(request.language)}.` }], // prettier-ignore
            },
            contents: [{ role: 'user', parts: [{ text: request.prompt }] }],
            generationConfig: { maxOutputTokens: 3000 },
          }),
          signal: timeout(request.signal, 120_000),
        },
      );
    } catch (error) {
      throw toProviderError(error, 'Gemini');
    }
    const json = (await response.json().catch(() => ({}))) as GeminiResponse;
    if (!response.ok)
      throw httpError(
        'Gemini',
        response.status,
        json.error?.message ?? '',
        Number(response.headers.get('retry-after')),
      );
    if (json.promptFeedback?.blockReason)
      throw new ProviderError(
        'BAD_RESPONSE',
        `Gemini did not answer (blocked: ${json.promptFeedback.blockReason}).`,
      );
    const answerText = (json.candidates?.[0]?.content?.parts ?? [])
      .filter((p) => !p.thought && p.text)
      .map((p) => p.text)
      .join('')
      .trim();
    if (!answerText) throw new ProviderError('BAD_RESPONSE', 'Gemini returned no answer text.', true);
    return {
      answerText: answerText.slice(0, MAX_ANSWER_CHARS),
      citations: [],
      model: json.modelVersion ?? model,
      raw: {
        modelVersion: json.modelVersion ?? null,
        finishReason: json.candidates?.[0]?.finishReason ?? null,
      },
      latencyMs: Date.now() - started,
      usage: {
        inputTokens: json.usageMetadata?.promptTokenCount ?? null,
        outputTokens: (json.usageMetadata?.candidatesTokenCount ?? 0) + (json.usageMetadata?.thoughtsTokenCount ?? 0) || null, // prettier-ignore
      },
      isDemo: false,
      captureMethod: 'API',
      limitations: [
        'Gemini API answer without Google Search grounding: what the model has learned, not a live search and not the Gemini app.',
        ...(request.city
          ? ['The model has no location; the city is reflected only when the prompt itself names it.']
          : []),
      ],
    };
  }
}

// ---------------- Google AI Mode (DataForSEO) ----------------

interface DfsReference {
  source?: string;
  domain?: string;
  url?: string;
  title?: string;
}
interface DfsAiOverview {
  type?: string;
  markdown?: string;
  items?: { type?: string; title?: string; text?: string; markdown?: string; links?: { url?: string; title?: string }[] | null; references?: DfsReference[] | null }[]; // prettier-ignore
  references?: DfsReference[] | null;
}
interface DfsResponse {
  status_code?: number;
  status_message?: string;
  cost?: number;
  tasks?: {
    status_code?: number;
    status_message?: string;
    cost?: number;
    result?: { check_url?: string; datetime?: string; items?: DfsAiOverview[] | null }[] | null;
  }[];
}

/** Text and references of an AI Mode answer (the `ai_overview` item). Null when Google showed no AI answer. */
export function parseAiModeResult(
  json: DfsResponse,
): { answerText: string; citations: ProviderCitation[]; checkUrl: string | null } | null {
  // prettier-ignore
  const result = json.tasks?.[0]?.result?.[0];
  const overview = (result?.items ?? []).find((i) => i.type === 'ai_overview');
  if (!overview) return null;
  const answerText =
    overview.markdown?.trim() ||
    (overview.items ?? [])
      .map((i) => i.markdown ?? [i.title, i.text].filter(Boolean).join('\n'))
      .filter(Boolean)
      .join('\n\n')
      .trim();
  const refs = [
    ...(overview.references ?? []),
    ...(overview.items ?? []).flatMap((i) => [...(i.references ?? []), ...(i.links ?? []).map((l) => ({ url: l.url, title: l.title }))]), // prettier-ignore
  ];
  const seen = new Set<string>();
  const citations: ProviderCitation[] = [];
  for (const r of refs) {
    if (!r.url || !/^https?:\/\//i.test(r.url) || seen.has(r.url)) continue;
    seen.add(r.url);
    citations.push({
      url: r.url,
      title: r.title ?? (r as DfsReference).source ?? null,
      sourceType: 'INLINE_CITATION',
    });
  }
  return { answerText, citations, checkUrl: result?.check_url ?? null };
}

export class DataForSeoAiModeProvider implements AiVisibilityProvider {
  readonly key = 'dataforseo_ai_mode' as const;
  readonly meta = VISIBILITY_PROVIDERS.dataforseo_ai_mode;

  constructor(private readonly httpFetch: Fetch = fetch) {}

  status() {
    const env = getEnv();
    if (env.SERP_PROVIDER !== 'dataforseo')
      return { configured: false, status: 'not_configured' as const, detail: 'Not enabled: Google offers no API for AI Mode. An operator can enable the licensed DataForSEO provider (SERP_PROVIDER=dataforseo). Manual observations work without it.' }; // prettier-ignore
    return env.DATAFORSEO_LOGIN && env.DATAFORSEO_PASSWORD
      ? { configured: true, status: 'configured' as const, detail: 'Licensed SERP data (DataForSEO), about $0.004 per answer. DataForSEO licenses its own collection, not Google’s consent.' } // prettier-ignore
      : { configured: false, status: 'not_configured' as const, detail: 'SERP_PROVIDER=dataforseo needs DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD.' }; // prettier-ignore
  }

  async observe(request: VisibilityRequest): Promise<VisibilityResult> {
    const env = getEnv();
    if (env.SERP_PROVIDER !== 'dataforseo' || !env.DATAFORSEO_LOGIN || !env.DATAFORSEO_PASSWORD)
      throw new ProviderError('NOT_CONFIGURED', this.status().detail);
    const started = Date.now();
    const coordinates = request.coordinates;
    const task = {
      keyword: request.prompt.slice(0, 700),
      ...(coordinates
        ? {
            location_coordinate: `${coordinates.latitude.toFixed(7)},${coordinates.longitude.toFixed(7)},11z`,
          }
        : { location_name: countryName(request.country) }),
      language_code: request.language,
      device: 'mobile',
    };
    let response: Response;
    try {
      response = await this.httpFetch('https://api.dataforseo.com/v3/serp/google/ai_mode/live/advanced', {
        method: 'POST',
        headers: {
          authorization: `Basic ${Buffer.from(`${env.DATAFORSEO_LOGIN}:${env.DATAFORSEO_PASSWORD}`).toString('base64')}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify([task]),
        signal: timeout(request.signal, 120_000),
      });
    } catch (error) {
      throw toProviderError(error, 'DataForSEO');
    }
    const json = (await response.json().catch(() => ({}))) as DfsResponse;
    if (!response.ok) throw httpError('DataForSEO', response.status, json.status_message ?? '');
    const taskStatus = json.tasks?.[0]?.status_code ?? json.status_code;
    if (taskStatus && taskStatus !== 20000) {
      const message = json.tasks?.[0]?.status_message ?? json.status_message ?? 'Unknown error';
      // 40xxx are request or account problems; 50xxx are DataForSEO-side and can be retried.
      throw new ProviderError(taskStatus >= 50000 ? 'UPSTREAM_ERROR' : taskStatus === 40100 || taskStatus === 40200 || taskStatus === 40210 ? 'AUTH_FAILED' : 'INVALID_REQUEST', `DataForSEO: ${message} (${taskStatus}).`, taskStatus >= 50000); // prettier-ignore
    }
    const parsed = parseAiModeResult(json);
    if (!parsed || !parsed.answerText)
      throw new ProviderError(
        'BAD_RESPONSE',
        'Google showed no AI Mode answer for this prompt and location.',
      );
    const cost = json.tasks?.[0]?.cost ?? json.cost ?? null;
    return {
      answerText: parsed.answerText.slice(0, MAX_ANSWER_CHARS),
      citations: parsed.citations.slice(0, 100),
      model: 'google-ai-mode',
      raw: { checkUrl: parsed.checkUrl, location: coordinates ? 'coordinates' : 'country', costUsd: cost },
      latencyMs: Date.now() - started,
      usage: { costUsd: typeof cost === 'number' ? cost : null },
      isDemo: false,
      captureMethod: 'LICENSED_PROVIDER',
      limitations: [
        'Collected by a licensed provider (DataForSEO), not by Google; answers vary with time, account and device (mobile).',
        coordinates
          ? 'Located at the business location’s coordinates (city level).'
          : request.city
            ? `Located in ${countryName(request.country)} only: no business location in ${request.city} has coordinates.`
            : `Located in ${countryName(request.country)}.`,
      ],
    };
  }
}
