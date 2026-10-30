import { describe, expect, it } from 'vitest';
import {
  AUDIT_CATEGORIES,
  AUDIT_RULES,
  DEFAULT_CATEGORY_WEIGHTS,
  ISSUE_SEVERITIES,
  bucketStart,
  computeAuditScore,
  computeVisibilityMetrics,
  computeVisibilityTrend,
  describeComposition,
  getAuditRule,
  scoreBand,
  type ObservationFacts,
} from '../src/index';
import { listMarkdownSections, renderMarkdown, replaceMarkdownSection } from '../src/markdown';

describe('audit rule catalog', () => {
  it('has unique ids and valid metadata', () => {
    const ids = AUDIT_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const rule of AUDIT_RULES) {
      expect(rule.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(AUDIT_CATEGORIES).toContain(rule.category);
      expect(ISSUE_SEVERITIES).toContain(rule.severity);
      expect(rule.title.length).toBeGreaterThan(5);
      expect(rule.fix.length).toBeGreaterThan(10);
    }
  });

  it('covers every scoring category', () => {
    for (const category of AUDIT_CATEGORIES) {
      expect(AUDIT_RULES.some((r) => r.category === category)).toBe(true);
    }
    expect(getAuditRule('title-missing')?.category).toBe('METADATA');
    expect(getAuditRule('nope')).toBeUndefined();
  });

  it('never promises rankings in rule text', () => {
    for (const rule of AUDIT_RULES) {
      expect(`${rule.impact} ${rule.fix}`.toLowerCase()).not.toMatch(
        /guarantee(?!s? rich)|rank #?1|top ranking/,
      );
    }
  });
});

describe('audit scoring', () => {
  it('weights sum to 100', () => {
    expect(Object.values(DEFAULT_CATEGORY_WEIGHTS).reduce((a, b) => a + b, 0)).toBe(100);
  });

  it('scores a clean site at 100', () => {
    const result = computeAuditScore([], 10);
    expect(result.score).toBe(100);
    for (const category of AUDIT_CATEGORIES) expect(result.categoryScores[category]).toBe(100);
  });

  it('normalizes page penalties by pages analyzed and caps each page', () => {
    // 10 pages; one page has three HIGH metadata issues (0.6 × 3 capped to 1) → penalty 10.
    const issues = Array.from({ length: 3 }, () => ({
      category: 'METADATA' as const,
      severity: 'HIGH' as const,
      scope: 'page' as const,
      url: 'https://a.test/x',
    }));
    const result = computeAuditScore(issues, 10);
    expect(result.categoryScores.METADATA).toBe(90);
    expect(result.categoryScores.CRAWLABILITY).toBe(100);
    // overall = (90×15 + 100×85) / 100 = 98.5 → 99 (Math.round)
    expect(result.score).toBe(99);
  });

  it('applies fixed penalties for site-level issues', () => {
    const result = computeAuditScore(
      [{ category: 'CRAWLABILITY', severity: 'MEDIUM', scope: 'site', url: null }],
      50,
    );
    expect(result.categoryScores.CRAWLABILITY).toBe(85);
  });

  it('never goes below zero and is deterministic', () => {
    const issues = Array.from({ length: 20 }, () => ({
      category: 'HTTP_ERRORS' as const,
      severity: 'CRITICAL' as const,
      scope: 'site' as const,
    }));
    const first = computeAuditScore(issues, 1);
    expect(first.categoryScores.HTTP_ERRORS).toBe(0);
    expect(computeAuditScore(issues, 1)).toEqual(first);
    expect(scoreBand(85)).toBe('good');
    expect(scoreBand(60)).toBe('fair');
    expect(scoreBand(10)).toBe('poor');
  });
});

function obs(partial: Partial<ObservationFacts> & { id: string }): ObservationFacts {
  return {
    promptId: 'p1',
    provider: 'mock_demo',
    country: 'US',
    language: 'en',
    observedAt: '2026-10-05T10:00:00Z',
    succeeded: true,
    brandMentioned: false,
    brandCited: false,
    competitorsMentioned: [],
    competitorsCited: [],
    citationDomains: [],
    ...partial,
  };
}

describe('visibility metrics', () => {
  const competitors = [
    { id: 'c1', name: 'Rival' },
    { id: 'c2', name: 'Other' },
  ];
  const observations = [
    obs({
      id: '1',
      brandMentioned: true,
      brandCited: true,
      competitorsMentioned: ['c1'],
      citationDomains: ['acme.com', 'news.example.org'],
    }),
    obs({
      id: '2',
      brandMentioned: true,
      competitorsMentioned: ['c1', 'c2'],
      citationDomains: ['rival.com'],
    }),
    obs({ id: '3', competitorsMentioned: ['c1'], citationDomains: ['rival.com', 'rival.com'] }),
    obs({ id: '4', succeeded: false }),
  ];

  it('uses successful observations as the denominator', () => {
    const m = computeVisibilityMetrics(observations, competitors);
    expect(m.totals).toEqual({ observations: 4, successful: 3, failed: 1 });
    expect(m.mentionRate).toBeCloseTo(2 / 3);
    expect(m.citationRate).toBeCloseTo(1 / 3);
    expect(m.competitors[0]).toMatchObject({ id: 'c1', mentions: 3, mentionRate: 1 });
    expect(m.competitors[1]).toMatchObject({ id: 'c2', mentions: 1 });
  });

  it('computes share of voice from presence counts', () => {
    const m = computeVisibilityMetrics(observations, competitors);
    // brand 2, rival 3, other 1 → total 6
    expect(m.shareOfVoice.brand).toBeCloseTo(2 / 6);
    expect(m.shareOfVoice.competitors.map((c) => c.share)).toEqual([0.5, 1 / 6]);
  });

  it('builds the citation source distribution', () => {
    const m = computeVisibilityMetrics(observations, competitors);
    expect(m.sources[0]).toEqual({ domain: 'rival.com', citations: 3, observations: 2, share: 0.6 });
    expect(m.sources.reduce((sum, s) => sum + s.share, 0)).toBeCloseTo(1);
  });

  it('returns null rates instead of NaN when nothing succeeded', () => {
    const m = computeVisibilityMetrics([obs({ id: 'x', succeeded: false })], competitors);
    expect(m.mentionRate).toBeNull();
    expect(m.shareOfVoice.brand).toBeNull();
  });

  it('buckets trends by UTC week starting Monday', () => {
    expect(bucketStart(new Date('2026-10-04T12:00:00Z'), 'week').toISOString()).toBe(
      '2026-09-28T00:00:00.000Z',
    );
    const trend = computeVisibilityTrend(
      [
        obs({ id: 'a', observedAt: '2026-10-05T01:00:00Z', brandMentioned: true }),
        obs({ id: 'b', observedAt: '2026-10-07T01:00:00Z' }),
        obs({ id: 'c', observedAt: '2026-10-13T01:00:00Z', brandMentioned: true }),
      ],
      competitors,
      'week',
    );
    expect(trend.map((t) => [t.bucketStart.slice(0, 10), t.mentionRate])).toEqual([
      ['2026-10-05', 0.5],
      ['2026-10-12', 1],
    ]);
  });

  it('describes the composition of an observation set', () => {
    const composition = describeComposition([
      { ...obs({ id: '1' }), isDemo: true },
      {
        ...obs({ id: '2', provider: 'openai_web_search', country: 'GB', observedAt: '2026-10-09T00:00:00Z' }),
      },
    ]);
    expect(composition).toMatchObject({
      providers: ['mock_demo', 'openai_web_search'],
      countries: ['GB', 'US'],
      mixedProviders: true,
      mixedLocales: true,
      includesDemoData: true,
      promptCount: 1,
      from: '2026-10-05T10:00:00.000Z',
      to: '2026-10-09T00:00:00.000Z',
    });
  });
});

describe('markdown rendering', () => {
  it('escapes raw HTML and unsafe link protocols', () => {
    const html = renderMarkdown(
      'Hello <script>alert(1)</script> [x](javascript:alert(1)) ![i](data:image/png;base64,AAA)',
    );
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('<img');
  });

  it('renders safe links with rel attributes', () => {
    const html = renderMarkdown('[Docs](https://example.com/docs "Guide")');
    expect(html).toContain('href="https://example.com/docs"');
    expect(html).toContain('rel="noopener noreferrer nofollow"');
  });

  it('finds and replaces sections', () => {
    const md = '# Title\n\nIntro\n\n## One\nA\n\n### Sub\nB\n\n## Two\nC\n';
    expect(listMarkdownSections(md).map((s) => s.heading)).toEqual(['One', 'Sub', 'Two']);
    const replaced = replaceMarkdownSection(md, 'one', '## One\nNew text\n');
    expect(replaced).toContain('## One\nNew text\n');
    expect(replaced).not.toContain('### Sub');
    expect(replaced).toContain('## Two\nC');
    expect(replaceMarkdownSection(md, 'missing', 'x')).toBeNull();
  });
});
