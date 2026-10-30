import {
  DEFAULT_CRAWL_SETTINGS,
  VISIBILITY_PROVIDERS,
  captureMethodOfProvider,
  manualProviderKey,
  observationProviderLabel,
  surfaceOfProvider,
} from '@surfaced/shared';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { ProviderError } from '../src/ai/llm';
import { randomToken } from '../src/crypto';
import { disconnectPrisma, getPrisma } from '../src/db';
import { resetEnvCache } from '../src/env';
import {
  DataForSeoAiModeProvider,
  GeminiVisibilityProvider,
  executeVisibilityRun,
  parseAiModeResult,
  recordManualObservation,
  setVisibilityProviderOverrides,
  type AiVisibilityProvider,
  type VisibilityRequest,
} from '../src/visibility';

const prisma = getPrisma();
afterEach(() => setVisibilityProviderOverrides({}));
afterAll(async () => {
  await disconnectPrisma();
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

const request: VisibilityRequest = {
  prompt: 'best jewellers in surat',
  country: 'IN',
  city: 'Surat',
  language: 'en',
};

describe('surfaces and labels', () => {
  it('keeps every surface and source apart', () => {
    expect(manualProviderKey('GOOGLE_AI_MODE')).toBe('manual_google_ai_mode');
    expect(surfaceOfProvider('manual_google_ai_overview')).toBe('GOOGLE_AI_OVERVIEW');
    expect(surfaceOfProvider('dataforseo_ai_mode')).toBe('GOOGLE_AI_MODE');
    expect(surfaceOfProvider('openai_web_search')).toBeNull();
    expect(observationProviderLabel('manual_chatgpt')).toBe('Manual observation · ChatGPT');
    expect(observationProviderLabel('openai_web_search')).toBe(VISIBILITY_PROVIDERS.openai_web_search.label);
    expect(observationProviderLabel('retired_provider')).toBe('retired_provider');
    expect(['manual_gemini', 'mock_demo', 'dataforseo_ai_mode', 'gemini_model_knowledge'].map(captureMethodOfProvider)).toEqual(['MANUAL', 'DEMO', 'LICENSED_PROVIDER', 'API']); // prettier-ignore
  });
});

describe('Gemini (ungrounded)', () => {
  it('asks without grounding tools, skips thought parts and states its limits', async () => {
    const google = fakeFetch(() => ({
      body: {
        candidates: [{ content: { parts: [{ text: 'thinking…', thought: true }, { text: 'Popular jewellers in Surat include Navkar.' }] }, finishReason: 'STOP' }], // prettier-ignore
        usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 30, thoughtsTokenCount: 5 },
        modelVersion: 'gemini-3.8-flash-001',
      },
    }));
    const result = await withEnv({ GEMINI_API_KEY: 'test-key', GEMINI_MODEL: 'gemini-3.8-flash' }, () =>
      new GeminiVisibilityProvider(google.fn).observe(request),
    );
    expect(result).toMatchObject({ answerText: 'Popular jewellers in Surat include Navkar.', model: 'gemini-3.8-flash-001', citations: [], captureMethod: 'API', usage: { inputTokens: 12, outputTokens: 35 } }); // prettier-ignore
    expect(result.limitations!.join(' ')).toMatch(/without Google Search grounding.*no location/);
    const call = google.calls[0]!;
    expect(call.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent',
    );
    expect((call.init.headers as Record<string, string>)['x-goog-api-key']).toBe('test-key');
    const body = JSON.parse(String(call.init.body));
    expect(body.tools).toBeUndefined();
    expect(body.contents[0].parts[0].text).toBe('best jewellers in surat');
  });

  it('is not configured without a key and reports rate limits as retryable', async () => {
    await expect(new GeminiVisibilityProvider(fakeFetch(() => ({ body: {} })).fn).observe(request)).rejects.toMatchObject({ code: 'NOT_CONFIGURED' }); // prettier-ignore
    const limited = fakeFetch(() => ({ status: 429, body: { error: { message: 'quota' } } }));
    const error = await withEnv({ GEMINI_API_KEY: 'k' }, () => new GeminiVisibilityProvider(limited.fn).observe(request).catch((e: unknown) => e)); // prettier-ignore
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ code: 'RATE_LIMITED', retryable: true });
  });
});

const AI_MODE_RESPONSE = {
  status_code: 20000,
  tasks: [
    {
      status_code: 20000,
      cost: 0.004,
      result: [
        {
          check_url: 'https://www.google.com/search?q=best+jewellers+in+surat&udm=50',
          items: [
            {
              type: 'ai_overview',
              markdown: 'Top jewellers in Surat include **Navkar Jewellers** and Rival Gold.',
              references: [
                {
                  source: 'Navkar',
                  domain: 'navkar.example.in',
                  url: 'https://navkar.example.in/',
                  title: 'Navkar',
                },
              ],
              items: [{ type: 'ai_overview_element', text: 'x', references: [{ url: 'https://navkar.example.in/', title: 'dup' }, { url: 'https://rival.example/', title: 'Rival' }], links: [{ url: 'javascript:alert(1)' }] }], // prettier-ignore
            },
          ],
        },
      ],
    },
  ],
};

describe('Google AI Mode through DataForSEO', () => {
  const DFS = { SERP_PROVIDER: 'dataforseo', DATAFORSEO_LOGIN: 'user', DATAFORSEO_PASSWORD: 'secret' };

  it('uses the business location’s coordinates when it has them, and keeps the references', async () => {
    const dfs = fakeFetch(() => ({ body: AI_MODE_RESPONSE }));
    const result = await withEnv(DFS, () =>
      new DataForSeoAiModeProvider(dfs.fn).observe({
        ...request,
        coordinates: { latitude: 21.1702, longitude: 72.8311 },
      }),
    );
    expect(dfs.calls[0]!.url).toBe('https://api.dataforseo.com/v3/serp/google/ai_mode/live/advanced');
    expect(JSON.parse(String(dfs.calls[0]!.init.body))).toEqual([{ keyword: 'best jewellers in surat', location_coordinate: '21.1702000,72.8311000,11z', language_code: 'en', device: 'mobile' }]); // prettier-ignore
    expect(result).toMatchObject({ answerText: 'Top jewellers in Surat include **Navkar Jewellers** and Rival Gold.', captureMethod: 'LICENSED_PROVIDER', usage: { costUsd: 0.004 } }); // prettier-ignore
    expect(result.citations.map((c) => c.url)).toEqual([
      'https://navkar.example.in/',
      'https://rival.example/',
    ]);
    expect(result.limitations!.join(' ')).toMatch(/licensed provider.*coordinates/);
  });

  it('falls back to the country and says so; reports a missing AI answer and account errors', async () => {
    const dfs = fakeFetch(() => ({ body: AI_MODE_RESPONSE }));
    const result = await withEnv(DFS, () => new DataForSeoAiModeProvider(dfs.fn).observe(request));
    expect(JSON.parse(String(dfs.calls[0]!.init.body))[0]).toMatchObject({ location_name: 'India' });
    expect(result.limitations![1]).toMatch(/India only: no business location in Surat has coordinates/);
    expect(parseAiModeResult({ tasks: [{ result: [{ items: [{ type: 'organic' }] }] }] })).toBeNull();
    const none = fakeFetch(() => ({
      body: { status_code: 20000, tasks: [{ status_code: 20000, result: [{ items: [] }] }] },
    }));
    await expect(withEnv(DFS, () => new DataForSeoAiModeProvider(none.fn).observe(request))).rejects.toMatchObject({ code: 'BAD_RESPONSE' }); // prettier-ignore
    const denied = fakeFetch(() => ({ body: { status_code: 20000, tasks: [{ status_code: 40100, status_message: 'You are not authorized' }] } })); // prettier-ignore
    await expect(withEnv(DFS, () => new DataForSeoAiModeProvider(denied.fn).observe(request))).rejects.toMatchObject({ code: 'AUTH_FAILED' }); // prettier-ignore
    expect(new DataForSeoAiModeProvider().status().configured).toBe(false);
  });
});

async function setup() {
  const workspace = await prisma.workspace.create({
    data: { name: 'AI WS', slug: `ai-${randomToken(6).toLowerCase()}` },
  });
  const project = await prisma.project.create({
    data: { workspaceId: workspace.id, name: 'Navkar Jewellers', websiteUrl: 'https://navkar.example.in/', domain: 'navkar.example.in', targetCountries: ['IN'], targetLanguages: ['en'], crawlSettings: DEFAULT_CRAWL_SETTINGS }, // prettier-ignore
  });
  await prisma.projectCompetitor.create({ data: { projectId: project.id, name: 'Rival Gold', domain: 'rival.example', status: 'CONFIRMED' } }); // prettier-ignore
  await prisma.businessLocation.create({
    data: { projectId: project.id, name: 'Navkar Jewellers', city: 'Surat', country: 'IN', addressLine1: 'Ghod Dod Road', latitude: 21.1702, longitude: 72.8311, isPrimary: true }, // prettier-ignore
  });
  const prompt = await prisma.aiPrompt.create({
    data: { projectId: project.id, text: 'best jewellers in surat', country: 'IN', city: 'Surat', language: 'en', targetBrand: 'Navkar Jewellers', providers: ['dataforseo_ai_mode'], frequency: 'MANUAL' }, // prettier-ignore
  });
  return { project, prompt };
}

describe('runs with locality', () => {
  it('passes the prompt city and the matching location’s coordinates, and stores how the answer was captured', async () => {
    const { project, prompt } = await setup();
    let seen: VisibilityRequest | null = null;
    const fake: AiVisibilityProvider = {
      key: 'dataforseo_ai_mode',
      meta: VISIBILITY_PROVIDERS.dataforseo_ai_mode,
      status: () => ({ configured: true, status: 'configured', detail: 'test' }),
      observe: async (req) => {
        seen = req;
        return { answerText: 'Navkar Jewellers is a well-known jeweller in Surat.', citations: [{ url: 'https://navkar.example.in/', title: null, sourceType: 'INLINE_CITATION' }], model: 'google-ai-mode', raw: {}, latencyMs: 1, usage: null, isDemo: false, captureMethod: 'LICENSED_PROVIDER', limitations: ['Collected by a licensed provider.'] }; // prettier-ignore
      },
    };
    setVisibilityProviderOverrides({ dataforseo_ai_mode: fake });
    const run = await prisma.aiVisibilityRun.create({ data: { projectId: project.id } });
    await executeVisibilityRun(prisma, run.id, [prompt.id], null, null);
    expect(seen).toMatchObject({ city: 'Surat', coordinates: { latitude: 21.1702, longitude: 72.8311 } });
    const observation = await prisma.aiVisibilityObservation.findFirstOrThrow({ where: { runId: run.id } });
    expect(observation).toMatchObject({ city: 'Surat', captureMethod: 'LICENSED_PROVIDER', brandMentioned: true, brandCited: true, limitations: ['Collected by a licensed provider.'] }); // prettier-ignore
  });
});

describe('manual observations', () => {
  it('analyzes the pasted answer like an API answer and labels it manual', async () => {
    const { project, prompt } = await setup();
    const { observationId } = await recordManualObservation(prisma, {
      projectId: project.id,
      userId: 'user-1',
      input: {
        promptId: prompt.id,
        surface: 'GOOGLE_AI_MODE',
        answerText:
          'For bridal sets, Rival Gold and Navkar Jewellers are often recommended. More at https://rival.example/bridal.',
        citedUrls: ['https://navkar.example.in/bridal'],
        observedAt: '2026-10-24T05:30:00.000Z',
        note: 'Mobile, signed out',
      },
      now: new Date('2026-10-24T06:00:00Z'),
    });
    const o = await prisma.aiVisibilityObservation.findUniqueOrThrow({ where: { id: observationId }, include: { mentions: true, citations: true } }); // prettier-ignore
    expect(o).toMatchObject({ provider: 'manual_google_ai_mode', captureMethod: 'MANUAL', city: 'Surat', country: 'IN', brandMentioned: true, brandRank: 2, brandCited: true, isDemo: false, capturedById: 'user-1', note: 'Mobile, signed out' }); // prettier-ignore
    expect(o.observedAt.toISOString()).toBe('2026-10-24T05:30:00.000Z');
    expect(o.citations.map((c) => [c.domain, c.sourceType])).toEqual([['navkar.example.in', 'INLINE_CITATION'], ['rival.example', 'MENTIONED_URL']]); // prettier-ignore
    expect((o.limitations as string[])[0]).toMatch(/Entered by a person from Google AI Mode/);
    expect(
      await prisma.usageRecord.count({ where: { projectId: project.id, metric: 'VISIBILITY_CHECK' } }),
    ).toBe(0);

    await expect(recordManualObservation(prisma, { projectId: project.id, userId: 'u', input: { promptId: prompt.id, surface: 'CHATGPT', answerText: 'An answer long enough to store.', observedAt: '2030-01-01T00:00:00.000Z' } })).rejects.toThrow(/future/); // prettier-ignore
    await expect(recordManualObservation(prisma, { projectId: 'otherproject0000000000', userId: 'u', input: { promptId: prompt.id, surface: 'CHATGPT', answerText: 'An answer long enough to store.' } })).rejects.toThrow(/Prompt not found/); // prettier-ignore
  });
});
