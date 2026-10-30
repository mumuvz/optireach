import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PLANS,
  PLAN_KEYS,
  USAGE_METRICS,
  USAGE_METRIC_LIMIT_KEY,
  checkQuota,
  findDefaultPlan,
  isFrequencyAllowed,
  monthlyLimitFor,
  planDefinitionSchema,
  planLimitsSchema,
  usagePeriodBounds,
  usagePeriodKey,
  withPlanLimitDefaults,
  yearlyMonthlyEquivalent,
  type PlanLimits,
} from '../src/index';

const NUMERIC_LIMITS = [
  'projects',
  'teamMembers',
  'pagesPerAudit',
  'auditsPerMonth',
  'trackedPrompts',
  'visibilityChecksPerMonth',
  'contentGenerationsPerMonth',
  'keywordSuggestionsPerMonth',
  'competitorsPerProject',
  'competitorSnapshotsPerMonth',
  'reportsPerMonth',
  'businessLocations',
  'localRankPointsPerMonth',
  'productsTracked',
  'trackedKeywords',
  'rankChecksPerMonth',
  'webVitalsUrls',
  'webVitalsChecksPerMonth',
  'marketsPerProject',
  'alertRules',
  'apiRequestsPerMonth',
  'clientWorkspaces',
  'scheduledReports',
] as const satisfies readonly (keyof PlanLimits)[];

describe('default plans', () => {
  it('validates every plan against the schema', () => {
    for (const plan of DEFAULT_PLANS) expect(() => planDefinitionSchema.parse(plan)).not.toThrow();
  });

  it('defines the four tiers in order with unique keys', () => {
    expect(DEFAULT_PLANS.map((p) => p.key)).toEqual([...PLAN_KEYS]);
    expect(DEFAULT_PLANS.map((p) => p.sortOrder)).toEqual([0, 1, 2, 3]);
    expect(DEFAULT_PLANS.filter((p) => p.highlighted)).toHaveLength(1);
  });

  it('never decreases a limit when moving up a tier', () => {
    for (let i = 1; i < DEFAULT_PLANS.length; i++) {
      const lower = DEFAULT_PLANS[i - 1]!.limits;
      const higher = DEFAULT_PLANS[i]!.limits;
      // null means no cap, which ranks above any number.
      const value = (v: number | null) => v ?? Number.POSITIVE_INFINITY;
      for (const key of NUMERIC_LIMITS) expect(value(higher[key])).toBeGreaterThanOrEqual(value(lower[key]));
      for (const freq of lower.promptFrequencies) expect(higher.promptFrequencies).toContain(freq);
    }
  });

  it('crawls every page by default on every plan', () => {
    for (const plan of DEFAULT_PLANS) expect(plan.limits.pagesPerAudit).toBeNull();
  });

  it('matches the brief: free is limited, growth adds competitor comparison, agency adds white-label', () => {
    const free = findDefaultPlan('FREE')!;
    expect(free.priceMonthly).toBe(0);
    expect(free.limits.projects).toBe(1);
    expect(free.limits.scheduledAudits).toBe(false);
    expect(findDefaultPlan('STARTER')!.limits.scheduledAudits).toBe(true);
    expect(findDefaultPlan('GROWTH')!.limits.competitorAnalysis).toBe(true);
    expect(findDefaultPlan('STARTER')!.limits.competitorAnalysis).toBe(false);
    expect(findDefaultPlan('AGENCY')!.limits.whiteLabelReports).toBe(true);
    expect(findDefaultPlan('GROWTH')!.limits.whiteLabelReports).toBe(false);
  });

  it('prices yearly plans below twelve monthly payments', () => {
    for (const plan of DEFAULT_PLANS.filter((p) => p.priceMonthly > 0)) {
      expect(plan.priceYearly).toBeLessThan(plan.priceMonthly * 12);
      expect(yearlyMonthlyEquivalent(plan)).toBeLessThan(plan.priceMonthly);
    }
  });

  it('rejects malformed limits', () => {
    const limits = { ...DEFAULT_PLANS[0]!.limits, projects: -1 };
    expect(planLimitsSchema.safeParse(limits).success).toBe(false);
    expect(planLimitsSchema.safeParse({ ...DEFAULT_PLANS[0]!.limits, promptFrequencies: [] }).success).toBe(
      false,
    );
  });
});

describe('usage limits', () => {
  const limits = findDefaultPlan('STARTER')!.limits;

  it('maps every usage metric to a monthly limit or explicitly to none', () => {
    for (const metric of USAGE_METRICS) expect(metric in USAGE_METRIC_LIMIT_KEY).toBe(true);
    expect(monthlyLimitFor(limits, 'AUDIT_RUN')).toBe(limits.auditsPerMonth);
    expect(monthlyLimitFor(limits, 'VISIBILITY_CHECK')).toBe(limits.visibilityChecksPerMonth);
    expect(monthlyLimitFor(limits, 'CRAWL_PAGES')).toBeNull();
  });

  it('computes quota decisions', () => {
    expect(checkQuota(10, 9, 1)).toEqual({ allowed: true, limit: 10, used: 9, requested: 1, remaining: 1 });
    expect(checkQuota(10, 10, 1).allowed).toBe(false);
    expect(checkQuota(10, 8, 5)).toMatchObject({ allowed: false, remaining: 2 });
    expect(checkQuota(0, 0, 1).allowed).toBe(false);
    expect(checkQuota(null, 1_000_000, 50)).toMatchObject({ allowed: true, remaining: null });
  });

  it('restricts prompt frequencies by plan', () => {
    expect(isFrequencyAllowed(findDefaultPlan('FREE')!.limits, 'DAILY')).toBe(false);
    expect(isFrequencyAllowed(findDefaultPlan('GROWTH')!.limits, 'DAILY')).toBe(true);
  });

  it('uses UTC calendar months for usage periods', () => {
    const date = new Date('2026-10-31T23:30:00-05:00'); // 2026-11-01 04:30 UTC
    expect(usagePeriodKey(date)).toBe('2026-11');
    const { start, end } = usagePeriodBounds(new Date('2026-02-15T12:00:00Z'));
    expect(start.toISOString()).toBe('2026-02-01T00:00:00.000Z');
    expect(end.toISOString()).toBe('2026-03-01T00:00:00.000Z');
  });
});

describe('stored plans created before new limits existed', () => {
  // A Growth plan saved before the extension: it lacks every new key and has an admin-edited project limit.
  const legacyGrowth = { ...findDefaultPlan('GROWTH')!.limits } as Record<string, unknown>;
  for (const key of ['businessLocations', 'ecommerce', 'authorityTools', 'clientPortal', 'trackedKeywords'])
    delete legacyGrowth[key];
  legacyGrowth.projects = 7;

  it('completes missing keys from the default plan with the same key, keeping stored values', () => {
    const limits = planLimitsSchema.parse(withPlanLimitDefaults(legacyGrowth, 'GROWTH'));
    expect(limits.projects).toBe(7);
    expect(limits.businessLocations).toBe(findDefaultPlan('GROWTH')!.limits.businessLocations);
    expect(limits.authorityTools).toBe(true);
  });

  it('uses Free defaults for custom plans so new features are never granted by accident', () => {
    const limits = planLimitsSchema.parse(withPlanLimitDefaults(legacyGrowth, 'CUSTOM_ENTERPRISE'));
    expect(limits.authorityTools).toBe(false);
    expect(limits.clientPortal).toBe(false);
    expect(limits.projects).toBe(7);
  });

  it('leaves non-object values for the schema to reject', () => {
    expect(withPlanLimitDefaults(null, 'FREE')).toBeNull();
    expect(planLimitsSchema.safeParse(withPlanLimitDefaults([], 'FREE')).success).toBe(false);
  });
});
