import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_CRAWL_SETTINGS, type GapAnalysisResult } from '@surfaced/shared';
import type { LlmJsonRequest, LlmProvider, LlmResult } from '../src/ai';
import { ensureDefaultPlans } from '../src/billing';
import {
  buildGapActions,
  classifyPlatform,
  contentWords,
  domainLabel,
  executeGapAnalysis,
  findSpelling,
  registrableDomain,
  saveGapActionAsRecommendation,
  validateExtraction,
} from '../src/competitors';
import { SafeFetcher, type FetchOptions, type FetchResult } from '../src/crawler';
import { randomToken } from '../src/crypto';
import { disconnectPrisma, getPrisma } from '../src/db';

describe('gap analysis helpers', () => {
  it('finds brand spellings across words and hyphens', () => {
    expect(findSpelling('We like Crafty Art for cards.', 'craftyart')).toBe('Crafty Art');
    expect(findSpelling('Try Greetings-Island today', 'greetingsisland')).toBe('Greetings-Island');
    expect(findSpelling('Use eInvit.', 'einvit')).toBe('eInvit');
    expect(findSpelling('Crafty, Art and more', 'craftyart')).toBeNull();
    expect(findSpelling('Craft Yard', 'craftyart')).toBeNull();
  });

  it('keeps only extracted brands and quotes that appear in the answer', () => {
    const answer =
      'The **best overall** option is **Canva**: lots of *Indian* wedding templates.\n1. **WeddingBazaar / WedMeGood tools** for vendors. Indian wedding invite sites also exist. Share on WhatsApp.';
    const kept = validateExtraction(answer, [
      {
        name: 'Canva',
        reasons: [
          { attribute: 'Indian Templates!', quote: 'lots of Indian wedding templates' },
          { attribute: 'invented', quote: 'free forever with no ads' },
        ],
      },
      { name: 'Imaginary Invites', reasons: [] },
      { name: 'WhatsApp', reasons: [] },
      { name: 'WeddingBazaar / WedMeGood tools', reasons: [] },
      { name: 'Indian wedding invite sites', reasons: [] },
    ]);
    expect(kept.map((b) => b.name)).toEqual(['Canva', 'WeddingBazaar', 'WedMeGood']);
    expect(kept[0]!.reasons).toEqual([
      { attribute: 'indian templates', quote: 'lots of Indian wedding templates' },
    ]);
  });

  it('classifies domains', () => {
    expect(registrableDomain('content-management-files.canva.com')).toBe('canva.com');
    expect(registrableDomain('shop.example.co.in')).toBe('example.co.in');
    expect(domainLabel('www.einvit.in')).toBe('einvit');
    expect(classifyPlatform('old.reddit.com')).toBe('COMMUNITY');
    expect(classifyPlatform('play.google.com')).toBe('APP_STORE');
    expect(classifyPlatform('img1.wsimg.com')).toBe('FILE_HOST');
    expect(classifyPlatform('issuewire.com')).toBe('PRESS_RELEASE');
    expect(classifyPlatform('einvit.in')).toBeNull();
  });

  it('reduces prompts to their significant words', () => {
    expect(contentWords('Best app to make digital wedding invitations in India')).toEqual([
      'digital',
      'wedding',
      'invitation',
      'india',
    ]);
  });
});

function baseResult(overrides: Partial<GapAnalysisResult> = {}): Omit<GapAnalysisResult, 'actions'> {
  const you = {
    name: 'Shubhlink',
    key: 'shubhlink',
    isYou: true,
    competitorId: null,
    tracked: true,
    domain: 'shubhlink.test',
    answers: 0,
    mentionRate: 0,
    citedAnswers: 0,
    promptIds: [],
    reasons: [],
    quotes: [],
    detection: 'tracked' as const,
    aliasSuggestion: null,
  };
  return {
    version: 1,
    window: { from: '2026-07-01T00:00:00.000Z', to: '2026-10-01T00:00:00.000Z', days: 90 },
    answers: 4,
    demoAnswersExcluded: 0,
    prompts: [],
    providers: ['openai_web_search'],
    you,
    brands: [you],
    attributes: [],
    sources: [],
    readiness: {
      robots: {
        url: 'https://shubhlink.test/robots.txt',
        status: 'ok',
        httpStatus: 200,
        error: null,
        agents: [],
      },
      homepage: {
        url: 'https://shubhlink.test/',
        status: 'OK',
        httpStatus: 200,
        title: 'Shubhlink',
        metaDescription: null,
        h1: null,
        wordCount: 600,
        schemaTypes: ['Organization'],
        error: null,
      },
      audit: { auditRunId: 'a1', score: 90, finishedAt: null, pagesAnalyzed: 10, issues: [] },
    },
    method: { brandDetection: 'ai_extraction', extractionModel: 'm', answersExtracted: 4, liveChecks: true },
    notes: [],
    ...overrides,
  };
}

describe('buildGapActions', () => {
  it('puts blocked AI search crawlers first and ignores training-only crawlers', () => {
    const result = baseResult();
    result.readiness.robots.agents = [
      { agent: 'OAI-SearchBot', label: 'OpenAI search', purpose: '', search: true, allowed: false },
      { agent: 'GPTBot', label: 'OpenAI training', purpose: '', search: false, allowed: false },
    ];
    const actions = buildGapActions(result, { name: 'Shubhlink', domain: 'shubhlink.test' });
    expect(actions[0]).toMatchObject({
      key: 'crawler-access',
      priority: 1,
      title: 'Allow OAI-SearchBot in robots.txt',
    });
    expect(actions[0]!.why).not.toContain('GPTBot');
  });

  it('only suggests joining list pages, not product sites that name one rival', () => {
    const check = (url: string, brandsOnPage: string[]) => ({
      url,
      status: 'OK' as const,
      title: null,
      brandsOnPage,
      youOnPage: false,
      linksToYou: false,
      checkedAt: '2026-10-01T00:00:00.000Z',
      note: null,
    });
    const source = (
      domain: string,
      type: 'COMPARISON_ARTICLE' | 'OTHER',
      checks: ReturnType<typeof check>[],
    ) => ({
      domain,
      type,
      brand: null,
      answers: 1,
      citations: 1,
      urls: [],
      brandsInAnswers: [],
      youNamedInAnswers: 0,
      comparisonPages: [],
      checks,
    });
    const actions = buildGapActions(
      baseResult({
        sources: [
          source('lists.test', 'COMPARISON_ARTICLE', [check('https://lists.test/best-apps', ['Canva'])]),
          source('rival.test', 'OTHER', [check('https://rival.test/', ['Canva'])]),
        ],
      }),
      { name: 'Shubhlink', domain: 'shubhlink.test' },
    );
    const lists = actions.find((a) => a.key === 'third-party-lists')!;
    expect(lists.evidence.urls).toEqual(['https://lists.test/best-apps']);
  });

  it('asks for a page when no crawled page targets a question, and to rephrase task-like prompts', () => {
    const prompt = (id: string, text: string, named: number, brands: string[]) => ({
      promptId: id,
      prompt: text,
      answers: 2,
      youNamed: 0,
      youCited: 0,
      brandsNamed: brands.map((name) => ({ name, answers: 1 })),
      topSources: [],
      attributes: [{ attribute: 'whatsapp sharing', answers: 1 }],
      answersNamingBrands: named,
      recommendsBrands: named > 0,
      yourPage: null,
      pageMatchAvailable: true,
    });
    const actions = buildGapActions(
      baseResult({
        prompts: [
          prompt('p1', 'Best wedding invitation app', 2, ['Canva']),
          prompt('p2', 'make an invite', 0, []),
        ],
      }),
      { name: 'Shubhlink', domain: 'shubhlink.test' },
    );
    const page = actions.find((a) => a.key === 'prompt-page:p1')!;
    expect(page).toMatchObject({ priority: 2, category: 'AEO' });
    expect(page.why).toContain('Canva (1)');
    expect(page.why).toContain('whatsapp sharing');
    expect(actions.find((a) => a.key === 'rephrase-prompts')?.evidence.promptIds).toEqual(['p2']);
  });
});

/** Fake provider: returns one real brand with a valid and an invented quote, plus brands the answer never names. */
class FakeExtractor implements LlmProvider {
  readonly key = 'openai' as const;
  readonly label = 'Fake extractor';
  readonly isDevAdapter = false;
  calls = 0;

  async generateJson<T>(request: LlmJsonRequest<T>): Promise<LlmResult<T>> {
    this.calls += 1;
    const blocks = request.user.split('\n---').filter((b) => b.includes('Answer id:'));
    const answers = blocks.map((block) => {
      const id = /Answer id: (\S+)/.exec(block)![1]!;
      const brands = [
        { name: 'Imaginary Invites', reasons: [] },
        { name: 'WhatsApp', reasons: [] },
      ];
      if (block.includes('Canva'))
        brands.push({
          name: 'Canva',
          reasons: [
            { attribute: 'indian templates', quote: 'lots of Indian wedding templates' },
            { attribute: 'made up', quote: 'this sentence is not in the answer' },
          ],
        } as never);
      if (block.includes('Crafty Art')) brands.push({ name: 'Crafty Art', reasons: [] });
      return { id, brands };
    });
    return {
      data: request.schema.parse({ answers }),
      provider: 'openai',
      model: 'fake-model',
      isDevAdapter: false,
      usage: { inputTokens: 100, outputTokens: 20 },
    };
  }
}

/** Reaches only the local fixture server; any other host is reported as blocked without a request. */
class LocalOnlyFetcher extends SafeFetcher {
  override async fetch(url: string, options: FetchOptions = {}): Promise<FetchResult> {
    if (new URL(url).hostname === '127.0.0.1') return super.fetch(url, options);
    return {
      requestedUrl: url,
      finalUrl: url,
      statusCode: null,
      headers: {},
      contentType: null,
      contentEncoding: null,
      redirectChain: [],
      body: null,
      bodyTruncated: false,
      responseTimeMs: null,
      totalTimeMs: 0,
      error: { code: 'BLOCKED', message: 'Test fetcher: external hosts are not contacted.' },
    };
  }
}

describe('executeGapAnalysis (MySQL + local site)', () => {
  const prisma = getPrisma();
  let server: Server;
  let origin = '';

  beforeAll(async () => {
    server = createServer((req, res) => {
      const html = (body: string) => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><html lang="en"><head><title>Page</title></head><body>${body}</body></html>`);
      };
      if (req.url === '/robots.txt') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('User-agent: OAI-SearchBot\nDisallow: /\n\nUser-agent: *\nAllow: /\n');
      } else if (req.url === '/') html('<h1>Invites</h1><p>Make digital invites.</p>');
      else if (req.url === '/blog/best-invitation-apps')
        html(
          '<h1>Best invitation apps</h1><p>We compared Canva and Greetings Island for Indian weddings.</p>',
        );
      else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await disconnectPrisma();
  });

  async function setup() {
    await ensureDefaultPlans(prisma);
    const workspace = await prisma.workspace.create({
      data: { name: 'Gap WS', slug: `gap-${randomToken(6).toLowerCase()}` },
    });
    // The site is served locally; the brand's domain is a separate name so cited local pages count as third-party.
    const project = await prisma.project.create({
      data: {
        workspaceId: workspace.id,
        name: 'Shubhlink',
        websiteUrl: `${origin}/`,
        domain: `shubhlink-${randomToken(4).toLowerCase()}.test`,
        targetCountries: ['IN'],
        targetLanguages: ['en'],
        crawlSettings: DEFAULT_CRAWL_SETTINGS,
        competitors: { create: [{ name: 'craftyart', domain: 'craftyartapp.com' }] },
      },
      include: { competitors: true },
    });
    const prompt = (text: string) =>
      prisma.aiPrompt.create({
        data: {
          projectId: project.id,
          text,
          country: 'IN',
          language: 'en',
          targetBrand: 'Shubhlink',
          providers: [],
        },
      });
    const best = await prompt('Best app for wedding invitations in India');
    const task = await prompt('digital invitation creation');
    const run = await prisma.aiVisibilityRun.create({ data: { projectId: project.id, status: 'SUCCEEDED' } });
    const observe = (
      key: string,
      promptRow: { id: string; text: string },
      answerText: string,
      citations: { url: string; domain: string }[] = [],
      isDemo = false,
    ) =>
      prisma.aiVisibilityObservation.create({
        data: {
          runId: run.id,
          promptId: promptRow.id,
          projectId: project.id,
          provider: 'openai_web_search',
          country: 'IN',
          language: 'en',
          promptText: promptRow.text,
          status: 'SUCCEEDED',
          isDemo,
          answerText,
          idempotencyKey: `${run.id}:${key}`,
          citations: {
            create: citations.map((c, position) => ({
              ...c,
              position,
              sourceType: 'SEARCH_RESULT' as const,
            })),
          },
        },
      });
    await observe(
      'o1',
      best,
      'For Indian weddings, **Canva** is the best option: lots of Indian wedding templates and easy sharing. **Greetings Island** is another choice.',
      [
        { url: 'https://www.canva.com/wedding-invitations/', domain: 'canva.com' },
        { url: 'https://content-files.canva.com/x.png', domain: 'content-files.canva.com' },
        { url: 'https://www.greetingsisland.com/invitations', domain: 'greetingsisland.com' },
        { url: `${origin}/blog/best-invitation-apps?utm_source=openai`, domain: '127.0.0.1' },
        { url: 'https://www.reddit.com/r/DesiWeddings/comments/abc', domain: 'reddit.com' },
        {
          url: 'https://play.google.com/store/apps/details?id=com.example.invites',
          domain: 'play.google.com',
        },
      ],
    );
    await observe('o2', best, 'Many people use Canva. Crafty Art also offers templates.');
    await observe(
      'o3',
      task,
      'Sure, send me the event details and I will write the invitation text for you.',
    );
    await observe('o4', best, 'Canva is great.', [], true);
    const analysis = await prisma.visibilityGapAnalysis.create({ data: { projectId: project.id } });
    return { project, analysis, best, task };
  }

  it('finds who AI recommends and why, from verified evidence, and builds the plan', async () => {
    const { project, analysis, best, task } = await setup();
    const llm = new FakeExtractor();
    const fetcher = new LocalOnlyFetcher({ allowlist: ['127.0.0.1:*'], timeoutMs: 5000 });
    try {
      const outcome = await executeGapAnalysis(prisma, analysis.id, { llm, fetcher });
      expect(outcome.answers).toBe(3);
    } finally {
      await fetcher.close();
    }
    const stored = await prisma.visibilityGapAnalysis.findUniqueOrThrow({ where: { id: analysis.id } });
    expect(stored.status).toBe('SUCCEEDED');
    const r = stored.result as unknown as GapAnalysisResult;
    expect(r.demoAnswersExcluded).toBe(1);
    expect(llm.calls).toBe(1);

    const byName = new Map(r.brands.map((b) => [b.name, b]));
    // Brands the answers never name are dropped, and so are channels such as WhatsApp.
    expect(byName.has('Imaginary Invites')).toBe(false);
    expect(byName.has('WhatsApp')).toBe(false);
    const canva = byName.get('Canva')!;
    expect(canva).toMatchObject({
      tracked: false,
      answers: 2,
      domain: 'canva.com',
      detection: 'ai_extraction',
    });
    expect(canva.reasons.map((x) => x.attribute)).toEqual(['indian templates']);
    expect(canva.reasons[0]!.quotes[0]!.text).toBe('lots of Indian wedding templates');
    // Found without AI: the answer names a website it cites.
    expect(byName.get('Greetings Island')).toMatchObject({
      answers: 1,
      detection: 'domain',
      domain: 'greetingsisland.com',
    });
    // Tracked competitor written differently in the answers.
    expect(byName.get('craftyart')).toMatchObject({
      tracked: true,
      answers: 1,
      aliasSuggestion: 'Crafty Art',
    });
    expect(r.you).toMatchObject({ answers: 0, isYou: true });

    const source = (domain: string) => r.sources.find((s) => s.domain === domain)!;
    expect(source('canva.com')).toMatchObject({ type: 'RECOMMENDED_BRAND', brand: 'Canva', citations: 2 });
    expect(source('reddit.com')).toMatchObject({ type: 'COMMUNITY' });
    expect(source('reddit.com').checks[0]?.status).toBe('UNSAFE_URL');
    expect(source('play.google.com').type).toBe('APP_STORE');
    const article = source('127.0.0.1');
    expect(article.type).toBe('COMPARISON_ARTICLE');
    expect(article.checks[0]).toMatchObject({ status: 'OK', youOnPage: false });
    expect(article.checks[0]!.brandsOnPage.sort()).toEqual(['Canva', 'Greetings Island']);

    expect(r.readiness.robots.agents.find((a) => a.agent === 'OAI-SearchBot')?.allowed).toBe(false);
    expect(r.readiness.robots.agents.find((a) => a.agent === 'PerplexityBot')?.allowed).toBe(true);
    expect(r.readiness.homepage).toMatchObject({ status: 'OK', h1: 'Invites' });

    const bestPrompt = r.prompts.find((p) => p.promptId === best.id)!;
    expect(bestPrompt).toMatchObject({
      answers: 2,
      youNamed: 0,
      answersNamingBrands: 2,
      pageMatchAvailable: false,
    });
    expect(r.prompts.find((p) => p.promptId === task.id)).toMatchObject({ recommendsBrands: false });

    const keys = r.actions.map((a) => a.key);
    expect(keys[0]).toBe('crawler-access');
    expect(keys).toEqual(
      expect.arrayContaining([
        'homepage-thin',
        'run-audit',
        `prompt-page:${best.id}`,
        'third-party-lists',
        'community',
        'app-store',
        'track-brands',
        'aliases',
        'rephrase-prompts',
      ]),
    );
    const track = r.actions.find((a) => a.key === 'track-brands')!;
    expect(track.trackBrands).toEqual([{ name: 'Canva', domain: 'canva.com' }]);
    expect(
      await prisma.providerUsageEvent.count({ where: { projectId: project.id, operation: 'gap_analysis' } }),
    ).toBe(1);

    // Saving an action as a recommendation is idempotent per action.
    const action = r.actions.find((a) => a.key === 'third-party-lists')!;
    const first = await saveGapActionAsRecommendation(prisma, project.id, analysis.id, action);
    const again = await saveGapActionAsRecommendation(prisma, project.id, analysis.id, action);
    expect(first.created).toBe(true);
    expect(again).toEqual({ id: first.id, created: false });
    const rec = await prisma.recommendation.findUniqueOrThrow({ where: { id: first.id } });
    expect(rec).toMatchObject({ source: 'AI_VISIBILITY', category: 'AUTHORITY', severity: 'HIGH' });
    expect(rec.expectedBenefit).toContain('not guaranteed');
  });

  it('works without AI extraction or live checks, saying so', async () => {
    const { analysis } = await setup();
    await executeGapAnalysis(prisma, analysis.id, { llm: null, liveChecks: false });
    const r = (await prisma.visibilityGapAnalysis.findUniqueOrThrow({ where: { id: analysis.id } }))
      .result as unknown as GapAnalysisResult;
    expect(r.method).toMatchObject({ brandDetection: 'domain_only', liveChecks: false, answersExtracted: 0 });
    // Without extraction, Canva is still found where an answer names a website it cites.
    expect(r.brands.find((b) => b.name === 'Canva')?.detection).toBe('domain');
    expect(r.readiness.robots.status).toBe('not_checked');
    expect(r.notes.join(' ')).toMatch(/No AI provider is configured/);
    expect(r.notes.join(' ')).toMatch(/Live checks were skipped/);
    expect(r.actions.some((a) => a.key === 'crawler-access')).toBe(false);
  });
});
