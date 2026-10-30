import { z } from 'zod';
import { PROMPT_FREQUENCIES, type PromptFrequency, type UsageMetric } from './enums';

/**
 * Plan limits. Stored as JSON in subscription_plans.limits and always validated with
 * `planLimitsSchema` when read, so admin edits cannot introduce malformed values.
 * Monthly limits reset on the first day of each UTC calendar month (see docs/decisions.md D-015).
 */
export const planLimitsSchema = z.object({
  /** Projects per workspace. */
  projects: z.int().min(0).max(10_000),
  /** Workspace members, including the owner. */
  teamMembers: z.int().min(1).max(10_000),
  /** Maximum pages fetched in a single audit crawl; null means every page the crawler can reach. */
  pagesPerAudit: z.int().min(1).max(10_000_000).nullable(),
  auditsPerMonth: z.int().min(0).max(100_000),
  scheduledAudits: z.boolean(),
  /** Active + paused prompts per workspace. */
  trackedPrompts: z.int().min(0).max(100_000),
  /** One check = one prompt observed by one provider. */
  visibilityChecksPerMonth: z.int().min(0).max(10_000_000),
  promptFrequencies: z.array(z.enum(PROMPT_FREQUENCIES)).min(1),
  contentGenerationsPerMonth: z.int().min(0).max(1_000_000),
  keywordSuggestionsPerMonth: z.int().min(0).max(1_000_000),
  competitorsPerProject: z.int().min(0).max(1_000),
  /** Competitor snapshots, metadata comparison and topic-gap analysis. */
  competitorAnalysis: z.boolean(),
  competitorSnapshotsPerMonth: z.int().min(0).max(100_000),
  reportsPerMonth: z.int().min(0).max(100_000),
  whiteLabelReports: z.boolean(),
  // Extension features (docs/extension-plan.md). Stored plans created before these keys existed are completed
  // from the default plan with the same key by `withPlanLimitDefaults`, never silently set to Free.
  /** Business locations per workspace (0 disables local SEO). */
  businessLocations: z.int().min(0).max(100_000),
  /** Grid points checked through a licensed provider per month. */
  localRankPointsPerMonth: z.int().min(0).max(10_000_000),
  /** Product catalogue, structured data checks and Merchant Center. */
  ecommerce: z.boolean(),
  productsTracked: z.int().min(0).max(1_000_000),
  trackedKeywords: z.int().min(0).max(100_000),
  rankChecksPerMonth: z.int().min(0).max(10_000_000),
  webVitalsUrls: z.int().min(0).max(100_000),
  webVitalsChecksPerMonth: z.int().min(0).max(1_000_000),
  marketsPerProject: z.int().min(1).max(500),
  cmsPublishing: z.boolean(),
  /** Backlinks, digital PR, brand mentions and community workflows. */
  authorityTools: z.boolean(),
  attribution: z.boolean(),
  alertRules: z.int().min(0).max(10_000),
  apiAccess: z.boolean(),
  apiRequestsPerMonth: z.int().min(0).max(100_000_000),
  /** Client workspaces an agency can manage. */
  clientWorkspaces: z.int().min(0).max(10_000),
  /** Inviting Client-role users and the branded client portal. */
  clientPortal: z.boolean(),
  scheduledReports: z.int().min(0).max(10_000),
});
export type PlanLimits = z.infer<typeof planLimitsSchema>;

export const PLAN_KEYS = ['FREE', 'STARTER', 'GROWTH', 'AGENCY'] as const;
export type PlanKey = (typeof PLAN_KEYS)[number];
export const DEFAULT_PLAN_KEY: PlanKey = 'FREE';

export const planDefinitionSchema = z.object({
  key: z.string().regex(/^[A-Z][A-Z0-9_]{1,31}$/),
  name: z.string().min(1).max(60),
  description: z.string().min(1).max(500),
  currency: z.string().regex(/^[A-Z]{3}$/),
  priceMonthly: z.number().min(0).max(1_000_000),
  priceYearly: z.number().min(0).max(10_000_000),
  limits: planLimitsSchema,
  features: z.array(z.string().min(1).max(160)).max(30),
  highlighted: z.boolean(),
  sortOrder: z.int(),
});
export type PlanDefinition = z.infer<typeof planDefinitionSchema>;

/**
 * Default plans. The seed script writes these to subscription_plans; administrators can then edit
 * prices and limits in the admin area. The public pricing page renders these values in the
 * prerendered HTML and refreshes them from GET /api/v1/billing/plans after load.
 */
export const DEFAULT_PLANS: readonly PlanDefinition[] = Object.freeze([
  {
    key: 'FREE',
    name: 'Free',
    description: 'Run a technical audit and start tracking a few AI answers for one website.',
    currency: 'USD',
    priceMonthly: 0,
    priceYearly: 0,
    highlighted: false,
    sortOrder: 0,
    limits: {
      projects: 1,
      teamMembers: 1,
      pagesPerAudit: null,
      auditsPerMonth: 4,
      scheduledAudits: false,
      trackedPrompts: 5,
      visibilityChecksPerMonth: 60,
      promptFrequencies: ['MANUAL', 'WEEKLY'],
      contentGenerationsPerMonth: 3,
      keywordSuggestionsPerMonth: 3,
      competitorsPerProject: 2,
      competitorAnalysis: false,
      competitorSnapshotsPerMonth: 0,
      reportsPerMonth: 2,
      whiteLabelReports: false,
      businessLocations: 1,
      localRankPointsPerMonth: 0,
      ecommerce: false,
      productsTracked: 0,
      trackedKeywords: 0,
      rankChecksPerMonth: 0,
      webVitalsUrls: 3,
      webVitalsChecksPerMonth: 30,
      marketsPerProject: 1,
      cmsPublishing: false,
      authorityTools: false,
      attribution: false,
      alertRules: 2,
      apiAccess: false,
      apiRequestsPerMonth: 0,
      clientWorkspaces: 0,
      clientPortal: false,
      scheduledReports: 0,
    },
    features: [
      '1 project',
      'Audits crawl every page of your site',
      '5 tracked AI prompts',
      '3 AI content generations / month',
      'Basic HTML & PDF reports',
    ],
  },
  {
    key: 'STARTER',
    name: 'Starter',
    description: 'Scheduled audits and regular AI visibility tracking for a growing site.',
    currency: 'USD',
    priceMonthly: 49,
    priceYearly: 490,
    highlighted: false,
    sortOrder: 1,
    limits: {
      projects: 2,
      teamMembers: 2,
      pagesPerAudit: null,
      auditsPerMonth: 20,
      scheduledAudits: true,
      trackedPrompts: 25,
      visibilityChecksPerMonth: 500,
      promptFrequencies: ['MANUAL', 'WEEKLY', 'MONTHLY'],
      contentGenerationsPerMonth: 20,
      keywordSuggestionsPerMonth: 20,
      competitorsPerProject: 3,
      competitorAnalysis: false,
      competitorSnapshotsPerMonth: 0,
      reportsPerMonth: 10,
      whiteLabelReports: false,
      businessLocations: 3,
      localRankPointsPerMonth: 500,
      ecommerce: true,
      productsTracked: 500,
      trackedKeywords: 50,
      rankChecksPerMonth: 1500,
      webVitalsUrls: 10,
      webVitalsChecksPerMonth: 300,
      marketsPerProject: 2,
      cmsPublishing: true,
      authorityTools: false,
      attribution: true,
      alertRules: 10,
      apiAccess: false,
      apiRequestsPerMonth: 0,
      clientWorkspaces: 0,
      clientPortal: false,
      scheduledReports: 2,
    },
    features: [
      '2 projects · 2 team members',
      'Audits crawl every page of your site',
      'Scheduled weekly or monthly audits',
      '25 tracked AI prompts',
      '20 AI content generations / month',
    ],
  },
  {
    key: 'GROWTH',
    name: 'Growth',
    description: 'Content workflows, competitor comparison and expanded reporting for teams.',
    currency: 'USD',
    priceMonthly: 149,
    priceYearly: 1490,
    highlighted: true,
    sortOrder: 2,
    limits: {
      projects: 5,
      teamMembers: 5,
      pagesPerAudit: null,
      auditsPerMonth: 60,
      scheduledAudits: true,
      trackedPrompts: 100,
      visibilityChecksPerMonth: 3000,
      promptFrequencies: ['MANUAL', 'DAILY', 'WEEKLY', 'MONTHLY'],
      contentGenerationsPerMonth: 75,
      keywordSuggestionsPerMonth: 75,
      competitorsPerProject: 10,
      competitorAnalysis: true,
      competitorSnapshotsPerMonth: 50,
      reportsPerMonth: 40,
      whiteLabelReports: false,
      businessLocations: 10,
      localRankPointsPerMonth: 3000,
      ecommerce: true,
      productsTracked: 5000,
      trackedKeywords: 250,
      rankChecksPerMonth: 7500,
      webVitalsUrls: 50,
      webVitalsChecksPerMonth: 1500,
      marketsPerProject: 5,
      cmsPublishing: true,
      authorityTools: true,
      attribution: true,
      alertRules: 50,
      apiAccess: true,
      apiRequestsPerMonth: 50_000,
      clientWorkspaces: 0,
      clientPortal: false,
      scheduledReports: 10,
    },
    features: [
      '5 projects · 5 team members',
      'Audits crawl every page of your site',
      '100 tracked AI prompts, daily tracking',
      'Competitor comparison & topic gaps',
      '75 AI content generations / month',
    ],
  },
  {
    key: 'AGENCY',
    name: 'Agency',
    description: 'Multiple client projects, larger teams and white-label reports.',
    currency: 'USD',
    priceMonthly: 399,
    priceYearly: 3990,
    highlighted: false,
    sortOrder: 3,
    limits: {
      projects: 25,
      teamMembers: 15,
      pagesPerAudit: null,
      auditsPerMonth: 250,
      scheduledAudits: true,
      trackedPrompts: 400,
      visibilityChecksPerMonth: 12000,
      promptFrequencies: ['MANUAL', 'DAILY', 'WEEKLY', 'MONTHLY'],
      contentGenerationsPerMonth: 300,
      keywordSuggestionsPerMonth: 300,
      competitorsPerProject: 25,
      competitorAnalysis: true,
      competitorSnapshotsPerMonth: 250,
      reportsPerMonth: 200,
      whiteLabelReports: true,
      businessLocations: 100,
      localRankPointsPerMonth: 20_000,
      ecommerce: true,
      productsTracked: 50_000,
      trackedKeywords: 1500,
      rankChecksPerMonth: 45_000,
      webVitalsUrls: 300,
      webVitalsChecksPerMonth: 9000,
      marketsPerProject: 25,
      cmsPublishing: true,
      authorityTools: true,
      attribution: true,
      alertRules: 300,
      apiAccess: true,
      apiRequestsPerMonth: 500_000,
      clientWorkspaces: 25,
      clientPortal: true,
      scheduledReports: 100,
    },
    features: [
      '25 client projects · 15 team members',
      'Audits crawl every page of your site',
      '400 tracked AI prompts',
      'White-label reports',
      '300 AI content generations / month',
    ],
  },
]);

/** Monthly limit key for each metered usage metric. */
export const USAGE_METRIC_LIMIT_KEY: Record<UsageMetric, keyof PlanLimits | null> = {
  AUDIT_RUN: 'auditsPerMonth',
  CRAWL_PAGES: null, // bounded per audit by pagesPerAudit, not monthly
  VISIBILITY_CHECK: 'visibilityChecksPerMonth',
  CONTENT_GENERATION: 'contentGenerationsPerMonth',
  KEYWORD_SUGGESTION: 'keywordSuggestionsPerMonth',
  COMPETITOR_SNAPSHOT: 'competitorSnapshotsPerMonth',
  REPORT: 'reportsPerMonth',
  RANK_CHECK: 'rankChecksPerMonth',
  LOCAL_RANK_POINT: 'localRankPointsPerMonth',
  WEB_VITALS_CHECK: 'webVitalsChecksPerMonth',
  API_REQUEST: 'apiRequestsPerMonth',
};

export const USAGE_METRIC_LABELS: Record<UsageMetric, string> = {
  AUDIT_RUN: 'Audits',
  CRAWL_PAGES: 'Pages crawled',
  VISIBILITY_CHECK: 'AI visibility checks',
  CONTENT_GENERATION: 'AI content generations',
  KEYWORD_SUGGESTION: 'AI keyword suggestion runs',
  COMPETITOR_SNAPSHOT: 'Competitor snapshots',
  REPORT: 'Reports',
  RANK_CHECK: 'Rank checks',
  LOCAL_RANK_POINT: 'Local grid points',
  WEB_VITALS_CHECK: 'Web Vitals checks',
  API_REQUEST: 'API requests',
};

/**
 * Completes stored plan limits with keys added after the plan was saved. Missing keys come from the default plan
 * with the same key, or from Free for custom plans. Existing values are never changed.
 */
export function withPlanLimitDefaults(raw: unknown, planKey: string): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const defaults = (findDefaultPlan(planKey) ?? findDefaultPlan(DEFAULT_PLAN_KEY))!.limits;
  return { ...defaults, ...(raw as Record<string, unknown>) };
}

/** Returns the monthly allowance for a metric, or null when the metric has no monthly cap. */
export function monthlyLimitFor(limits: PlanLimits, metric: UsageMetric): number | null {
  const key = USAGE_METRIC_LIMIT_KEY[metric];
  if (!key) return null;
  const value = limits[key];
  return typeof value === 'number' ? value : null;
}

export interface QuotaCheck {
  allowed: boolean;
  limit: number | null;
  used: number;
  requested: number;
  remaining: number | null;
}

/** Pure quota arithmetic shared by the API (enforcement) and the UI (usage meters). */
export function checkQuota(limit: number | null, used: number, requested = 1): QuotaCheck {
  if (limit === null) return { allowed: true, limit, used, requested, remaining: null };
  const remaining = Math.max(0, limit - used);
  return { allowed: used + requested <= limit, limit, used, requested, remaining };
}

export function isFrequencyAllowed(limits: PlanLimits, frequency: PromptFrequency): boolean {
  return limits.promptFrequencies.includes(frequency);
}

/** UTC calendar-month key used for usage metering, e.g. "2026-10". */
export function usagePeriodKey(date: Date = new Date()): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Inclusive start / exclusive end of the UTC month that contains `date`. */
export function usagePeriodBounds(date: Date = new Date()): { start: Date; end: Date } {
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  const end = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
  return { start, end };
}

export function findDefaultPlan(key: string): PlanDefinition | undefined {
  return DEFAULT_PLANS.find((p) => p.key === key);
}

/** Yearly price expressed as a monthly equivalent, rounded to cents. */
export function yearlyMonthlyEquivalent(plan: Pick<PlanDefinition, 'priceYearly'>): number {
  return Math.round((plan.priceYearly / 12) * 100) / 100;
}
