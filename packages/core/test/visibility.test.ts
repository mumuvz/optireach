import { DEFAULT_CRAWL_SETTINGS } from '@surfaced/shared';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { ProviderError } from '../src/ai/llm';
import { ensureDefaultPlans } from '../src/billing';
import { randomToken } from '../src/crypto';
import { disconnectPrisma, getPrisma } from '../src/db';
import {
  MockVisibilityProvider,
  executeVisibilityRun,
  findMentions,
  getVisibilitySummary,
  listVisibilityProviderStatuses,
  normalizeCitations,
  setVisibilityProviderOverrides,
  type AiVisibilityProvider,
  type EntitySpec,
  type VisibilityResult,
} from '../src/visibility';

const prisma = getPrisma();
afterEach(() => setVisibilityProviderOverrides({}));
afterAll(async () => {
  await disconnectPrisma();
});

const brand: EntitySpec = {
  id: null,
  type: 'BRAND',
  name: 'Acme',
  domain: 'acme.com',
  aliases: ['Acme Tools'],
};
const rival: EntitySpec = { id: 'c1', type: 'COMPETITOR', name: 'Rival', domain: 'rival.io', aliases: [] };

describe('mention matching', () => {
  it('matches whole words, aliases and domains, ranked by first appearance', () => {
    const text =
      'Top picks: Rival is popular. Many teams also like acme.com, and Acme Tools has a free plan.';
    const mentions = findMentions(text, [brand, rival]);
    expect(mentions.map((m) => [m.entity.name, m.rank, m.matchType])).toEqual([
      ['Rival', 1, 'NAME'],
      ['Acme', 2, 'DOMAIN'],
    ]);
    expect(mentions[1]!.snippet).toContain('acme.com');
  });

  it('does not match substrings of other words', () => {
    expect(findMentions('Acmeville and Rivalry are unrelated.', [brand, rival])).toEqual([]);
    expect(findMentions('Über-Acme? Yes: Acme!', [brand]).map((m) => m.matchedText)).toEqual(['Acme']);
  });
});

describe('citation normalization', () => {
  it('dedupes URLs, strips utm params, keeps the strongest source type and attributes domains', () => {
    const citations = normalizeCitations(
      [
        { url: 'https://www.acme.com/pricing?utm_source=openai', title: null, sourceType: 'SEARCH_RESULT' },
        { url: 'https://www.acme.com/pricing', title: 'Pricing', sourceType: 'INLINE_CITATION' },
        { url: 'https://blog.rival.io/post', title: 'Rival blog', sourceType: 'SEARCH_RESULT' },
        { url: 'javascript:alert(1)', title: null, sourceType: 'MENTIONED_URL' },
      ],
      'acme.com',
      [rival],
    );
    expect(citations).toEqual([
      {
        url: 'https://www.acme.com/pricing',
        domain: 'acme.com',
        title: 'Pricing',
        position: 1,
        sourceType: 'INLINE_CITATION',
        isOwnedDomain: true,
        competitorId: null,
      },
      {
        url: 'https://blog.rival.io/post',
        domain: 'blog.rival.io',
        title: 'Rival blog',
        position: 2,
        sourceType: 'SEARCH_RESULT',
        isOwnedDomain: false,
        competitorId: 'c1',
      },
    ]);
  });
});

describe('providers', () => {
  it('reports configuration honestly', () => {
    const statuses = Object.fromEntries(listVisibilityProviderStatuses().map((s) => [s.key, s]));
    expect(statuses.openai_web_search).toMatchObject({ configured: false, status: 'not_configured' });
    expect(statuses.perplexity_sonar).toMatchObject({ configured: false, status: 'not_configured' });
    expect(statuses.mock_demo).toMatchObject({ configured: true, status: 'demo' });
  });

  it('produces deterministic, clearly labeled demo answers', async () => {
    const provider = new MockVisibilityProvider(() => new Date('2026-10-05T00:00:00Z'));
    const context = {
      brand,
      competitors: [rival, { id: 'c2', name: 'Other', domain: 'other.net', aliases: [] }],
    };
    const a = await provider.observe({ prompt: 'best tools', country: 'US', language: 'en' }, context);
    const b = await provider.observe({ prompt: 'best tools', country: 'US', language: 'en' }, context);
    expect(a).toEqual(b);
    expect(a.isDemo).toBe(true);
    expect(a.answerText).toContain('Demo data — not a real AI response');
  });
});

class StubProvider implements AiVisibilityProvider {
  readonly meta = {
    key: 'openai_web_search' as const,
    label: 'Stub',
    vendor: 'Test',
    kind: 'live_search' as const,
    description: '',
  };
  calls = 0;
  constructor(
    readonly key: 'openai_web_search' | 'perplexity_sonar',
    private readonly behaviour: (call: number) => VisibilityResult | ProviderError,
  ) {}
  status() {
    return { configured: true, status: 'configured' as const, detail: 'stub' };
  }
  async observe(): Promise<VisibilityResult> {
    this.calls += 1;
    const outcome = this.behaviour(this.calls);
    if (outcome instanceof ProviderError) throw outcome;
    return outcome;
  }
}

const answer = (text: string, urls: string[]): VisibilityResult => ({
  answerText: text,
  citations: urls.map((url) => ({ url, title: null, sourceType: 'INLINE_CITATION' as const })),
  model: 'stub-model',
  raw: { stub: true },
  latencyMs: 1,
  usage: null,
  isDemo: false,
});

async function setup() {
  await ensureDefaultPlans(prisma);
  const workspace = await prisma.workspace.create({
    data: { name: 'Vis WS', slug: `vis-${randomToken(6).toLowerCase()}` },
  });
  const project = await prisma.project.create({
    data: {
      workspaceId: workspace.id,
      name: 'Acme',
      websiteUrl: 'https://acme.com/',
      domain: `acme-${randomToken(4).toLowerCase()}.com`,
      targetCountries: ['US'],
      targetLanguages: ['en'],
      crawlSettings: DEFAULT_CRAWL_SETTINGS,
    },
  });
  const competitor = await prisma.projectCompetitor.create({
    data: { projectId: project.id, name: 'Rival', domain: 'rival.io' },
  });
  const prompts = await Promise.all(
    ['best crm for startups', 'top crm tools uk'].map((text) =>
      prisma.aiPrompt.create({
        data: {
          projectId: project.id,
          text,
          country: 'US',
          language: 'en',
          targetBrand: 'Acme',
          providers: ['openai_web_search', 'perplexity_sonar'],
          frequency: 'WEEKLY',
        },
      }),
    ),
  );
  return { workspace, project, competitor, prompts };
}

describe('executeVisibilityRun', () => {
  it('stores observations, mentions, citations, failures and usage; retries are idempotent', async () => {
    const { workspace, project, prompts } = await setup();
    const ok = new StubProvider('openai_web_search', () =>
      answer(`For CRM, consider Rival first and then Acme. See https://${project.domain}/crm`, [
        `https://${project.domain}/crm`,
        'https://rival.io/',
      ]),
    );
    // Perplexity: first call rate-limited (retryable) then succeeds; later calls fail permanently.
    const flaky = new StubProvider('perplexity_sonar', (call) =>
      call === 1
        ? new ProviderError('RATE_LIMITED', 'slow down', true, 10)
        : call === 2
          ? answer('Rival is the main option.', ['https://rival.io/'])
          : new ProviderError('AUTH_FAILED', 'bad key'),
    );
    setVisibilityProviderOverrides({ openai_web_search: ok, perplexity_sonar: flaky });

    const run = await prisma.aiVisibilityRun.create({ data: { projectId: project.id } });
    const outcome = await executeVisibilityRun(prisma, run.id, null, null, null);
    expect(outcome).toEqual({ observations: 4, succeeded: 3, failed: 1 });

    const observations = await prisma.aiVisibilityObservation.findMany({
      where: { runId: run.id },
      include: { mentions: true, citations: true },
    });
    const failedObs = observations.find((o) => o.status === 'FAILED')!;
    expect(failedObs).toMatchObject({ provider: 'perplexity_sonar', errorCode: 'AUTH_FAILED' });
    const retried = observations.find((o) => o.provider === 'perplexity_sonar' && o.status === 'SUCCEEDED')!;
    expect(retried.attempts).toBe(2);
    const openai = observations.find((o) => o.provider === 'openai_web_search')!;
    expect(openai).toMatchObject({ brandMentioned: true, brandCited: true, brandRank: 2, sentiment: null });
    expect(openai.citations.find((c) => c.isOwnedDomain)?.domain).toBe(project.domain);
    expect(openai.citations.find((c) => c.domain === 'rival.io')?.competitorId).toBeTruthy();

    const usage = await prisma.usageRecord.aggregate({
      where: { workspaceId: workspace.id, metric: 'VISIBILITY_CHECK' },
      _sum: { quantity: true },
    });
    expect(usage._sum.quantity).toBe(3);
    const storedRun = await prisma.aiVisibilityRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(storedRun).toMatchObject({ status: 'SUCCEEDED', successCount: 3, failureCount: 1 });
    expect(
      (await prisma.aiPrompt.findUniqueOrThrow({ where: { id: prompts[0]!.id } })).nextRunAt,
    ).not.toBeNull();

    // Retrying the same run never duplicates observations or usage.
    const callsBefore = ok.calls + flaky.calls;
    await executeVisibilityRun(prisma, run.id, null, null, null);
    expect(ok.calls + flaky.calls).toBe(callsBefore);
    expect(await prisma.aiVisibilityObservation.count({ where: { runId: run.id } })).toBe(4);
    const usageAfter = await prisma.usageRecord.aggregate({
      where: { workspaceId: workspace.id, metric: 'VISIBILITY_CHECK' },
      _sum: { quantity: true },
    });
    expect(usageAfter._sum.quantity).toBe(3);

    // Metrics are computed from the stored rows.
    const summary = await getVisibilitySummary(prisma, project.id, { provider: 'all' });
    expect(summary.metrics.totals).toEqual({ observations: 4, successful: 3, failed: 1 });
    expect(summary.metrics.mentionRate).toBeCloseTo(2 / 3); // the two OpenAI answers mention Acme
    expect(summary.metrics.citationRate).toBeCloseTo(2 / 3);
    expect(summary.metrics.competitors[0]).toMatchObject({ name: 'Rival', mentions: 3, mentionRate: 1 });
    expect(summary.metrics.shareOfVoice.brand).toBeCloseTo(2 / 5);
    expect(summary.composition).toMatchObject({
      providers: ['openai_web_search', 'perplexity_sonar'],
      mixedProviders: true,
      promptCount: 2,
    });
    expect(summary.notes.join(' ')).toMatch(/pool 2 providers/);

    const onlyOpenAi = await getVisibilitySummary(prisma, project.id, { provider: 'openai_web_search' });
    expect(onlyOpenAi.metrics.mentionRate).toBe(1);
    expect(onlyOpenAi.composition.mixedProviders).toBe(false);
  });

  it('records a failed observation when a provider is not configured', async () => {
    const { project } = await setup();
    const run = await prisma.aiVisibilityRun.create({ data: { projectId: project.id } });
    const outcome = await executeVisibilityRun(prisma, run.id, null, null, null);
    expect(outcome.succeeded).toBe(0);
    const errors = await prisma.aiVisibilityObservation.findMany({
      where: { runId: run.id },
      select: { errorCode: true },
    });
    expect(new Set(errors.map((e) => e.errorCode))).toEqual(new Set(['NOT_CONFIGURED']));
    expect((await prisma.aiVisibilityRun.findUniqueOrThrow({ where: { id: run.id } })).status).toBe('FAILED');
  });
});
