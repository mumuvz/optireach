import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  GeminiLlmProvider,
  OpenAiLlmProvider,
  ProviderError,
  getLlmProvider,
  getLlmProviderByKey,
  listLlmProviders,
  setLlmProviderOverride,
} from '../src/ai';
import { resetEnvCache } from '../src/env';

afterEach(() => {
  setLlmProviderOverride(undefined);
  process.env.GEMINI_API_KEY = '';
  process.env.LLM_PROVIDER = 'dev';
  resetEnvCache();
});

async function withEnv<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const before = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  resetEnvCache();
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(before)) process.env[k] = v ?? '';
    resetEnvCache();
  }
}

function fakeFetch(handler: (url: string, init: RequestInit) => { status?: number; body: unknown }) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    const { status = 200, body } = handler(url, init ?? {});
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fn, calls };
}

const schema = z.object({
  intent: z.enum(['INFORMATIONAL', 'COMMERCIAL']),
  keywords: z.array(z.string()).max(5),
});
const geminiAnswer = (text: string, extra: Record<string, unknown> = {}) => ({
  body: {
    candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 15, thoughtsTokenCount: 5 },
    modelVersion: 'gemini-3.8-flash-001',
    ...extra,
  },
});

describe('Gemini LLM provider', () => {
  it('requests JSON without grounding, passes the schema, validates the result and reports usage', async () => {
    const google = fakeFetch(() =>
      geminiAnswer('{"intent":"COMMERCIAL","keywords":["gst software","billing app"]}'),
    );
    const result = await withEnv({ GEMINI_API_KEY: 'k', GEMINI_MODEL: 'gemini-3.8-flash' }, () =>
      new GeminiLlmProvider(google.fn).generateJson({
        schema,
        schemaName: 'keyword_ideas',
        system: 'You are an SEO strategist.',
        user: 'Classify: gst billing software',
      }),
    );
    expect(result).toMatchObject({ provider: 'gemini', model: 'gemini-3.8-flash-001', isDevAdapter: false, data: { intent: 'COMMERCIAL', keywords: ['gst software', 'billing app'] }, usage: { inputTokens: 20, outputTokens: 20 } }); // prettier-ignore
    const call = google.calls[0]!;
    expect(call.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent',
    );
    expect((call.init.headers as Record<string, string>)['x-goog-api-key']).toBe('k');
    const body = JSON.parse(String(call.init.body));
    expect(body.tools).toBeUndefined();
    expect(body.generationConfig.responseMimeType).toBe('application/json');
    expect(body.systemInstruction.parts[0].text).toMatch(/JSON Schema/);
    expect(body.contents[0].parts[0].text).toBe('Classify: gst billing software');
  });

  it('strips markdown code fences and retries once on invalid JSON', async () => {
    let n = 0;
    const google = fakeFetch(() => {
      n += 1;
      return n === 1 ? geminiAnswer('not json at all') : geminiAnswer('```json\n{"intent":"INFORMATIONAL","keywords":[]}\n```'); // prettier-ignore
    });
    const result = await withEnv({ GEMINI_API_KEY: 'k' }, () =>
      new GeminiLlmProvider(google.fn).generateJson({ schema, schemaName: 's', system: 'x', user: 'y' }),
    );
    expect(result.data).toEqual({ intent: 'INFORMATIONAL', keywords: [] });
    expect(google.calls).toHaveLength(2);
  });

  it('reports max-output-tokens and rate limits honestly, and needs a key', async () => {
    const truncated = fakeFetch(() => geminiAnswer('', { candidates: [{ content: { parts: [] }, finishReason: 'MAX_TOKENS' }] })); // prettier-ignore
    const maxErr = await withEnv({ GEMINI_API_KEY: 'k' }, () => new GeminiLlmProvider(truncated.fn).generateJson({ schema, schemaName: 's', system: 'x', user: 'y' }).catch((e: unknown) => e)); // prettier-ignore
    expect(maxErr).toBeInstanceOf(ProviderError);
    expect(maxErr).toMatchObject({ code: 'BAD_RESPONSE', retryable: false });
    expect(truncated.calls).toHaveLength(1);

    const limited = fakeFetch(() => ({ status: 429, body: { error: { message: 'quota' } } }));
    expect(await withEnv({ GEMINI_API_KEY: 'k' }, () => new GeminiLlmProvider(limited.fn).generateJson({ schema, schemaName: 's', system: 'x', user: 'y' }).catch((e: unknown) => e))).toMatchObject({ code: 'RATE_LIMITED', retryable: true }); // prettier-ignore

    const badKey = fakeFetch(() => ({ status: 403, body: { error: { message: 'bad key' } } }));
    expect(await withEnv({ GEMINI_API_KEY: 'k' }, () => new GeminiLlmProvider(badKey.fn).generateJson({ schema, schemaName: 's', system: 'x', user: 'y' }).catch((e: unknown) => e))).toMatchObject({ code: 'AUTH_FAILED' }); // prettier-ignore

    await expect(new GeminiLlmProvider(fakeFetch(() => geminiAnswer('{}')).fn).generateJson({ schema, schemaName: 's', system: 'x', user: 'y' })).rejects.toMatchObject({ code: 'NOT_CONFIGURED' }); // prettier-ignore
  });

  it('is selected by LLM_PROVIDER=gemini, and the env rejects gemini without a key', async () => {
    await withEnv({ LLM_PROVIDER: 'gemini', GEMINI_API_KEY: 'k' }, async () => {
      expect(getLlmProvider()).toBeInstanceOf(GeminiLlmProvider);
    });
    // LLM_PROVIDER=gemini without a key is a startup configuration error (like OpenAI).
    await expect(withEnv({ LLM_PROVIDER: 'gemini', GEMINI_API_KEY: '' }, async () => getLlmProvider())).rejects.toThrow(/GEMINI_API_KEY is required/); // prettier-ignore
  });
});

describe('LLM provider registry (runs research on each configured provider)', () => {
  it('lists every provider with which are configured and which is the default', async () => {
    await withEnv({ LLM_PROVIDER: 'openai', OPENAI_API_KEY: 'o', GEMINI_API_KEY: 'g' }, async () => {
      const list = listLlmProviders();
      expect(list.map((p) => p.key)).toEqual(['openai', 'gemini', 'dev']);
      expect(list.find((p) => p.key === 'openai')).toMatchObject({ configured: true, isDefault: true });
      expect(list.find((p) => p.key === 'gemini')).toMatchObject({ configured: true, isDefault: false });
      expect(list.find((p) => p.key === 'dev')).toMatchObject({ configured: true, isDevAdapter: true });
    });
    // A provider with no key is listed but not configured, so the client can show it as unavailable.
    await withEnv({ LLM_PROVIDER: 'openai', OPENAI_API_KEY: 'o', GEMINI_API_KEY: '' }, async () => {
      expect(listLlmProviders().find((p) => p.key === 'gemini')).toMatchObject({ configured: false });
    });
  });

  it('returns a specific provider by key regardless of the default, so providers can be compared', async () => {
    await withEnv({ LLM_PROVIDER: 'openai', OPENAI_API_KEY: 'o', GEMINI_API_KEY: 'g' }, async () => {
      // The default is OpenAI, but a caller can still run Gemini for the same request.
      expect(getLlmProvider()).toBeInstanceOf(OpenAiLlmProvider);
      expect(getLlmProvider('gemini')).toBeInstanceOf(GeminiLlmProvider);
      expect(getLlmProvider('openai')).toBeInstanceOf(OpenAiLlmProvider);
      expect(getLlmProviderByKey('gemini')).toBeInstanceOf(GeminiLlmProvider);
    });
    // A provider the server has no key for resolves to null (the feature then reports "not configured").
    await withEnv({ LLM_PROVIDER: 'openai', OPENAI_API_KEY: 'o', GEMINI_API_KEY: '' }, async () => {
      expect(getLlmProvider('gemini')).toBeNull();
      expect(getLlmProviderByKey('gemini')).toBeNull();
    });
  });
});
