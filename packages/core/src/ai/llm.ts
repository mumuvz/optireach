// LLM adapter used for content generation, keyword ideas, entity verification and sentiment estimates.
// Keys stay on the server. The development adapter returns caller-supplied template output and is
// always labeled as such — it never pretends to be an AI model.
import OpenAI, { APIError } from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import { z } from 'zod';
import { getEnv } from '../env';

export type ProviderErrorCode =
  | 'NOT_CONFIGURED'
  | 'AUTH_FAILED'
  | 'RATE_LIMITED'
  | 'TIMEOUT'
  | 'BAD_RESPONSE'
  | 'UPSTREAM_ERROR'
  | 'INVALID_REQUEST';

export class ProviderError extends Error {
  constructor(
    public readonly code: ProviderErrorCode,
    message: string,
    public readonly retryable = false,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

/** Maps SDK/network errors to ProviderError (retryable for 429/5xx/timeouts). */
export function toProviderError(error: unknown, vendor: string): ProviderError {
  if (error instanceof ProviderError) return error;
  if (error instanceof APIError) {
    const status = error.status ?? 0;
    const retryAfter = Number(error.headers?.get?.('retry-after'));
    if (status === 401 || status === 403)
      return new ProviderError('AUTH_FAILED', `${vendor} rejected the API key (HTTP ${status}).`);
    if (status === 429)
      return new ProviderError(
        'RATE_LIMITED',
        `${vendor} rate limit reached.`,
        true,
        Number.isFinite(retryAfter) ? retryAfter * 1000 : undefined,
      );
    if (status >= 500) return new ProviderError('UPSTREAM_ERROR', `${vendor} returned HTTP ${status}.`, true);
    if (status === 400 || status === 404 || status === 422)
      return new ProviderError(
        'INVALID_REQUEST',
        `${vendor} rejected the request: ${error.message.slice(0, 300)}`,
      );
  }
  const err = error as { name?: string; message?: string };
  if (
    err?.name === 'APIConnectionTimeoutError' ||
    err?.name === 'TimeoutError' ||
    err?.name === 'AbortError'
  ) {
    return new ProviderError('TIMEOUT', `${vendor} did not respond in time.`, true);
  }
  return new ProviderError(
    'UPSTREAM_ERROR',
    `${vendor} request failed: ${(err?.message ?? 'unknown error').slice(0, 300)}`,
    true,
  );
}

export interface LlmUsage {
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface LlmJsonRequest<T> {
  /** Output schema. Use only required fields (nullable instead of optional) for strict structured output. */
  schema: z.ZodType<T>;
  schemaName: string;
  system: string;
  user: string;
  maxOutputTokens?: number;
  model?: string;
  signal?: AbortSignal;
  /** Deterministic template output used only by the development adapter. */
  devFallback?: () => T;
}

export interface LlmResult<T> {
  data: T;
  provider: string;
  model: string;
  isDevAdapter: boolean;
  usage: LlmUsage | null;
}

export interface LlmProvider {
  readonly key: 'openai' | 'gemini' | 'dev';
  readonly label: string;
  readonly isDevAdapter: boolean;
  generateJson<T>(request: LlmJsonRequest<T>): Promise<LlmResult<T>>;
}

/** gpt-5.x and o-series models accept a reasoning effort; older chat models reject the parameter. */
export function supportsReasoning(model: string): boolean {
  return /^(gpt-5|gpt-6|o\d)/i.test(model);
}

let sharedClient: OpenAI | null = null;
export function getOpenAiClient(): OpenAI {
  const env = getEnv();
  if (!env.OPENAI_API_KEY) throw new ProviderError('NOT_CONFIGURED', 'OPENAI_API_KEY is not set.');
  sharedClient ??= new OpenAI({
    apiKey: env.OPENAI_API_KEY,
    baseURL: env.OPENAI_BASE_URL,
    maxRetries: 2,
    timeout: 180_000,
  });
  return sharedClient;
}

export class OpenAiLlmProvider implements LlmProvider {
  readonly key = 'openai' as const;
  readonly label = 'OpenAI';
  readonly isDevAdapter = false;

  async generateJson<T>(request: LlmJsonRequest<T>): Promise<LlmResult<T>> {
    const env = getEnv();
    const model = request.model ?? env.OPENAI_MODEL;
    try {
      const response = await getOpenAiClient().responses.parse(
        {
          model,
          instructions: request.system,
          input: request.user,
          max_output_tokens: request.maxOutputTokens ?? env.OPENAI_MAX_OUTPUT_TOKENS,
          ...(supportsReasoning(model) ? { reasoning: { effort: 'low' as const } } : {}),
          text: { format: zodTextFormat(request.schema as never, request.schemaName) },
        },
        { signal: request.signal },
      );
      const parsed = response.output_parsed as T | null;
      if (parsed === null || parsed === undefined) {
        const reason = response.incomplete_details?.reason;
        throw new ProviderError(
          'BAD_RESPONSE',
          reason === 'max_output_tokens'
            ? 'The model ran out of output tokens before finishing.'
            : 'The model did not return valid structured output.',
          reason !== 'max_output_tokens',
        );
      }
      return {
        data: request.schema.parse(parsed),
        provider: 'openai',
        model: response.model ?? model,
        isDevAdapter: false,
        usage: {
          inputTokens: response.usage?.input_tokens ?? null,
          outputTokens: response.usage?.output_tokens ?? null,
        },
      };
    } catch (error) {
      throw toProviderError(error, 'OpenAI');
    }
  }
}

// ---------------- Gemini (Google Generative Language API) ----------------

/** A JSON object matching the schema, built from the zod schema so the model knows the exact shape to return. */
function jsonSchemaFor(schema: z.ZodType): unknown {
  try {
    return z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'output' });
  } catch {
    return null;
  }
}

function geminiHttpError(status: number, detail: string, retryAfterMs?: number): ProviderError {
  if (status === 401 || status === 403) return new ProviderError('AUTH_FAILED', `Gemini rejected the API key (HTTP ${status}).`); // prettier-ignore
  if (status === 429) return new ProviderError('RATE_LIMITED', `Gemini rate limit or quota reached.${detail}`, true, retryAfterMs); // prettier-ignore
  if (status >= 500) return new ProviderError('UPSTREAM_ERROR', `Gemini returned HTTP ${status}.`, true);
  return new ProviderError('INVALID_REQUEST', `Gemini rejected the request (HTTP ${status}).${detail}`);
}

interface GeminiGenerateResponse {
  candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
  modelVersion?: string;
  promptFeedback?: { blockReason?: string };
  error?: { message?: string };
}

/**
 * Gemini for structured JSON generation. Uses the official Generative Language API with JSON response mode; the
 * model is asked to match the request's schema (JSON Schema derived from zod) and the result is validated with zod
 * before use, so malformed output is rejected, never passed through. Grounding is never enabled here.
 */
export class GeminiLlmProvider implements LlmProvider {
  readonly key = 'gemini' as const;
  readonly label = 'Gemini';
  readonly isDevAdapter = false;

  constructor(private readonly httpFetch: typeof fetch = fetch) {}

  async generateJson<T>(request: LlmJsonRequest<T>): Promise<LlmResult<T>> {
    const env = getEnv();
    if (!env.GEMINI_API_KEY) throw new ProviderError('NOT_CONFIGURED', 'GEMINI_API_KEY is not set.');
    const model = request.model ?? env.GEMINI_MODEL;
    const schema = jsonSchemaFor(request.schema);
    const system = [
      request.system,
      'Return only a single JSON object, with no markdown fences or commentary.',
      schema ? `It must match this JSON Schema:\n${JSON.stringify(schema)}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');
    const body = {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: request.user }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        maxOutputTokens: request.maxOutputTokens ?? env.GEMINI_MAX_OUTPUT_TOKENS,
        temperature: 0.4,
      },
    };
    // One retry when the model returns text that is not valid JSON for the schema.
    let lastError: ProviderError | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      let response: Response;
      try {
        response = await this.httpFetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
          {
            method: 'POST',
            headers: { 'x-goog-api-key': env.GEMINI_API_KEY, 'content-type': 'application/json' },
            body: JSON.stringify(body),
            signal: request.signal ?? AbortSignal.timeout(180_000),
          },
        );
      } catch (error) {
        throw toProviderError(error, 'Gemini');
      }
      const json = (await response.json().catch(() => ({}))) as GeminiGenerateResponse;
      if (!response.ok)
        throw geminiHttpError(response.status, json.error?.message ? ` Google: ${json.error.message.slice(0, 200)}` : '', undefined); // prettier-ignore
      if (json.promptFeedback?.blockReason)
        throw new ProviderError(
          'BAD_RESPONSE',
          `Gemini blocked the request (${json.promptFeedback.blockReason}).`,
        );
      const candidate = json.candidates?.[0];
      const text = (candidate?.content?.parts ?? [])
        .filter((p) => !p.thought && p.text)
        .map((p) => p.text)
        .join('')
        .trim();
      if (!text) {
        lastError = new ProviderError('BAD_RESPONSE', candidate?.finishReason === 'MAX_TOKENS' ? 'Gemini ran out of output tokens before finishing.' : 'Gemini returned no content.', candidate?.finishReason !== 'MAX_TOKENS'); // prettier-ignore
        if (candidate?.finishReason === 'MAX_TOKENS') throw lastError;
        continue;
      }
      try {
        const parsed = request.schema.parse(JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, '')));
        return {
          data: parsed,
          provider: 'gemini',
          model: json.modelVersion ?? model,
          isDevAdapter: false,
          usage: {
            inputTokens: json.usageMetadata?.promptTokenCount ?? null,
            outputTokens: (json.usageMetadata?.candidatesTokenCount ?? 0) + (json.usageMetadata?.thoughtsTokenCount ?? 0) || null, // prettier-ignore
          },
        };
      } catch {
        lastError = new ProviderError('BAD_RESPONSE', 'Gemini did not return JSON matching the expected schema.', true); // prettier-ignore
      }
    }
    throw lastError ?? new ProviderError('BAD_RESPONSE', 'Gemini did not return valid structured output.');
  }
}

export class DevLlmProvider implements LlmProvider {
  readonly key = 'dev' as const;
  readonly label = 'Development adapter (template output — not AI-generated)';
  readonly isDevAdapter = true;

  async generateJson<T>(request: LlmJsonRequest<T>): Promise<LlmResult<T>> {
    if (!request.devFallback)
      throw new ProviderError('NOT_CONFIGURED', 'The development adapter has no template for this task.');
    return {
      data: request.schema.parse(request.devFallback()),
      provider: 'dev',
      model: 'dev-template',
      isDevAdapter: true,
      usage: null,
    };
  }
}

let override: LlmProvider | null | undefined;

export type LlmProviderKey = 'openai' | 'gemini' | 'dev';

/** A specific LLM provider when it is configured, else null. Used to run (and compare) a chosen provider. */
export function getLlmProviderByKey(key: LlmProviderKey): LlmProvider | null {
  const env = getEnv();
  if (key === 'openai') return env.OPENAI_API_KEY ? new OpenAiLlmProvider() : null;
  if (key === 'gemini') return env.GEMINI_API_KEY ? new GeminiLlmProvider() : null;
  if (key === 'dev') return env.isProduction ? null : new DevLlmProvider();
  return null;
}

/**
 * The LLM provider for a request. With no `preferred` key, uses the configured default (LLM_PROVIDER); with one,
 * returns that specific provider so a feature can run on — and compare — each configured provider. Null when the
 * requested or default provider is not configured (features then report "not configured"). A test override wins.
 */
export function getLlmProvider(preferred?: LlmProviderKey): LlmProvider | null {
  if (override !== undefined) return override;
  if (preferred) return getLlmProviderByKey(preferred);
  const env = getEnv();
  if (env.LLM_PROVIDER === 'openai' && env.OPENAI_API_KEY) return new OpenAiLlmProvider();
  if (env.LLM_PROVIDER === 'gemini' && env.GEMINI_API_KEY) return new GeminiLlmProvider();
  if (env.LLM_PROVIDER === 'dev') return new DevLlmProvider();
  return null;
}

export interface LlmProviderStatus {
  key: LlmProviderKey;
  label: string;
  configured: boolean;
  isDevAdapter: boolean;
  model: string | null;
  /** True for the provider used when a feature does not pick one (LLM_PROVIDER). */
  isDefault: boolean;
  detail: string;
}

/** Every LLM provider the server can use, which are configured, and which is the default. For provider comparison. */
export function listLlmProviders(): LlmProviderStatus[] {
  const env = getEnv();
  return [
    {
      key: 'openai',
      label: 'OpenAI',
      configured: Boolean(env.OPENAI_API_KEY),
      isDevAdapter: false,
      model: env.OPENAI_MODEL,
      isDefault: env.LLM_PROVIDER === 'openai',
      detail: env.OPENAI_API_KEY ? `OpenAI (${env.OPENAI_MODEL})` : 'Set OPENAI_API_KEY to enable OpenAI.',
    },
    {
      key: 'gemini',
      label: 'Gemini',
      configured: Boolean(env.GEMINI_API_KEY),
      isDevAdapter: false,
      model: env.GEMINI_MODEL,
      isDefault: env.LLM_PROVIDER === 'gemini',
      detail: env.GEMINI_API_KEY ? `Gemini (${env.GEMINI_MODEL})` : 'Set GEMINI_API_KEY to enable Gemini.',
    },
    ...(env.isProduction
      ? []
      : [
          {
            key: 'dev' as const,
            label: 'Development adapter',
            configured: true,
            isDevAdapter: true,
            model: 'dev-template',
            isDefault: env.LLM_PROVIDER === 'dev',
            detail: 'Deterministic template output, not AI-generated (development only).',
          },
        ]),
  ];
}

/** Test hook: force a provider (pass undefined to restore configuration-based selection). */
export function setLlmProviderOverride(provider: LlmProvider | null | undefined): void {
  override = provider;
}

export function llmStatus(): {
  provider: string;
  configured: boolean;
  isDevAdapter: boolean;
  detail: string;
} {
  const env = getEnv();
  if (env.LLM_PROVIDER === 'openai') {
    return env.OPENAI_API_KEY
      ? { provider: 'openai', configured: true, isDevAdapter: false, detail: `OpenAI (${env.OPENAI_MODEL})` }
      : { provider: 'openai', configured: false, isDevAdapter: false, detail: 'OPENAI_API_KEY is not set.' };
  }
  if (env.LLM_PROVIDER === 'gemini') {
    return env.GEMINI_API_KEY
      ? { provider: 'gemini', configured: true, isDevAdapter: false, detail: `Gemini (${env.GEMINI_MODEL})` }
      : { provider: 'gemini', configured: false, isDevAdapter: false, detail: 'GEMINI_API_KEY is not set.' };
  }
  if (env.LLM_PROVIDER === 'dev') {
    return {
      provider: 'dev',
      configured: true,
      isDevAdapter: true,
      detail: 'Development adapter: deterministic template text, not AI-generated.',
    };
  }
  return {
    provider: 'none',
    configured: false,
    isDevAdapter: false,
    detail: 'Content generation is disabled (LLM_PROVIDER=none).',
  };
}
