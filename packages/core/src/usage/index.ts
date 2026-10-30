// Usage metering and plan-limit enforcement. Usage records are idempotent (unique idempotencyKey),
// so a retried job never double-counts; limits reset each UTC calendar month.
import {
  USAGE_METRICS,
  USAGE_METRIC_LABELS,
  checkQuota,
  monthlyLimitFor,
  usagePeriodKey,
  type PlanLimits,
  type UsageMetric,
} from '@surfaced/shared';
import { billingGroupWorkspaceIds, billingRootWorkspaceId, getWorkspacePlan } from '../billing/plans';
import { Prisma, type PrismaClient } from '../db';
import { Errors } from '../errors';

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Monthly usage that counts against the workspace's allowance. Agency-billed client workspaces share their
 * agency's plan, so usage is summed across the billing group (records keep the workspace that used them).
 */
export async function getUsageCount(
  db: Db,
  workspaceId: string,
  metric: UsageMetric,
  periodKey = usagePeriodKey(),
) {
  const group = await billingGroupWorkspaceIds(db, workspaceId);
  const result = await db.usageRecord.aggregate({
    where: { workspaceId: { in: group }, metric, periodKey },
    _sum: { quantity: true },
  });
  return result._sum.quantity ?? 0;
}

/** Throws 402 PLAN_LIMIT_REACHED when `requested` more units would exceed the monthly allowance. */
export async function assertMonthlyQuota(
  db: Db,
  workspaceId: string,
  metric: UsageMetric,
  requested = 1,
): Promise<{ limits: PlanLimits; used: number; limit: number | null }> {
  const { limits, plan } = await getWorkspacePlan(db, workspaceId);
  const limit = monthlyLimitFor(limits, metric);
  const used = await getUsageCount(db, workspaceId, metric);
  const decision = checkQuota(limit, used, requested);
  if (!decision.allowed) {
    throw Errors.planLimit(
      `Your ${plan.name} plan includes ${limit} ${USAGE_METRIC_LABELS[metric].toLowerCase()} per month (${used} used). Upgrade to continue.`,
      { metric, limit, used, requested, plan: plan.key },
    );
  }
  return { limits, used, limit };
}

export interface UsageEvent {
  workspaceId: string;
  projectId?: string | null;
  metric: UsageMetric;
  quantity: number;
  /** Unique per billable event, e.g. "audit:<crawlJobId>" or "visibility:<observationKey>". */
  idempotencyKey: string;
  periodKey?: string;
}

/** Records usage once per idempotency key. Returns false when the event was already recorded. */
export async function recordUsage(db: Db, event: UsageEvent): Promise<boolean> {
  if (event.quantity <= 0) return false;
  const existing = await db.usageRecord.findUnique({ where: { idempotencyKey: event.idempotencyKey } });
  if (existing) return false;
  try {
    await db.usageRecord.create({
      data: {
        workspaceId: event.workspaceId,
        projectId: event.projectId ?? null,
        metric: event.metric,
        quantity: event.quantity,
        periodKey: event.periodKey ?? usagePeriodKey(),
        idempotencyKey: event.idempotencyKey,
      },
    });
    return true;
  } catch (error) {
    // Concurrent duplicate: the unique index guarantees exactly one record.
    if ((error as { code?: string }).code === 'P2002') return false;
    throw error;
  }
}

/**
 * Serializes quota checks for one billing group by locking the billing root's subscription row for the
 * duration of the transaction, so two concurrent requests cannot both pass the same remaining allowance.
 */
export async function withWorkspaceLock<T>(
  prisma: PrismaClient,
  workspaceId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  const root = await billingRootWorkspaceId(prisma, workspaceId);
  return prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM subscriptions WHERE workspaceId = ${root} FOR UPDATE`;
      return fn(tx);
    },
    { timeout: 15_000, maxWait: 5_000 },
  );
}

export type CountLimitKind =
  | 'projects'
  | 'teamMembers'
  | 'trackedPrompts'
  | 'competitorsPerProject'
  | 'businessLocations'
  | 'productsTracked'
  | 'trackedKeywords'
  | 'webVitalsUrls'
  | 'marketsPerProject'
  | 'alertRules'
  | 'clientWorkspaces'
  | 'scheduledReports';

const COUNT_LABELS: Record<CountLimitKind, string> = {
  projects: 'projects',
  teamMembers: 'team members',
  trackedPrompts: 'tracked prompts',
  competitorsPerProject: 'competitors per project',
  businessLocations: 'business locations',
  productsTracked: 'tracked products',
  trackedKeywords: 'tracked keywords',
  webVitalsUrls: 'Web Vitals URLs',
  marketsPerProject: 'markets per project',
  alertRules: 'alert rules',
  clientWorkspaces: 'client workspaces',
  scheduledReports: 'scheduled reports',
};

/** Projects counted against the plan: pooled across an agency's billing group. */
export async function countProjectsForLimit(db: Db, workspaceId: string): Promise<number> {
  const group = await billingGroupWorkspaceIds(db, workspaceId);
  return db.project.count({ where: { workspaceId: { in: group } } });
}

/** Active business locations counted against the plan, pooled across an agency's billing group. */
export async function countLocationsForLimit(db: Db, workspaceId: string): Promise<number> {
  const group = await billingGroupWorkspaceIds(db, workspaceId);
  return db.businessLocation.count({ where: { archivedAt: null, project: { workspaceId: { in: group } } } });
}

/**
 * Products counted against the plan, pooled across the billing group. A product present both in an imported feed and
 * in the connected Merchant Center account (same country, language and id) counts once.
 */
export async function countProductsForLimit(db: Db, workspaceId: string): Promise<number> {
  const group = await billingGroupWorkspaceIds(db, workspaceId);
  const projects = await db.project.findMany({ where: { workspaceId: { in: group } }, select: { id: true } });
  if (!projects.length) return 0;
  const rows = await db.$queryRaw<{ n: bigint | number }[]>`
    SELECT COUNT(DISTINCT projectId, feedLabel, contentLanguage, offerId) AS n
    FROM merchant_products WHERE projectId IN (${Prisma.join(projects.map((p) => p.id))})`;
  return Number(rows[0]?.n ?? 0);
}

/** Team seats used in a workspace. Client-role users (client portal) do not take team seats. */
export function countTeamMembers(db: Db, workspaceId: string): Promise<number> {
  return db.workspaceMember.count({ where: { workspaceId, role: { not: 'CLIENT' } } });
}

/** Requires a boolean plan feature, e.g. `ecommerce` or `authorityTools`. */
export async function assertPlanFeature(
  db: Db,
  workspaceId: string,
  feature: { [K in keyof PlanLimits]: PlanLimits[K] extends boolean ? K : never }[keyof PlanLimits],
  label: string,
): Promise<PlanLimits> {
  const { limits, plan } = await getWorkspacePlan(db, workspaceId);
  if (!limits[feature])
    throw Errors.planLimit(`${label} is not included in the ${plan.name} plan. Upgrade to use it.`, {
      feature,
      plan: plan.key,
    });
  return limits;
}

/** Checks a non-monthly count limit (current count + additional must stay within the plan). */
export async function assertCountLimit(
  db: Db,
  workspaceId: string,
  kind: CountLimitKind,
  currentCount: number,
  additional = 1,
): Promise<PlanLimits> {
  const { limits, plan } = await getWorkspacePlan(db, workspaceId);
  const limit = limits[kind];
  if (currentCount + additional > limit) {
    throw Errors.planLimit(
      `Your ${plan.name} plan allows ${limit} ${COUNT_LABELS[kind]}. Upgrade to add more.`,
      { kind, limit, current: currentCount, requested: additional, plan: plan.key },
    );
  }
  return limits;
}

export interface UsageSummary {
  periodKey: string;
  plan: { key: string; name: string };
  /** True when usage is pooled with an agency's billing group; the numbers then cover the whole group. */
  pooled: boolean;
  billingWorkspaceId: string;
  metrics: { metric: UsageMetric; label: string; used: number; limit: number | null }[];
  counts: { kind: CountLimitKind; label: string; used: number; limit: number }[];
}

export async function getUsageSummary(prisma: PrismaClient, workspaceId: string): Promise<UsageSummary> {
  const periodKey = usagePeriodKey();
  const { plan, limits, billingWorkspaceId } = await getWorkspacePlan(prisma, workspaceId);
  const group = await billingGroupWorkspaceIds(prisma, workspaceId);
  const grouped = await prisma.usageRecord.groupBy({
    by: ['metric'],
    where: { workspaceId: { in: group }, periodKey },
    _sum: { quantity: true },
  });
  const used = new Map(grouped.map((g) => [g.metric, g._sum.quantity ?? 0]));
  const [projects, members, prompts, locations, products] = await Promise.all([
    prisma.project.count({ where: { workspaceId: { in: group } } }),
    countTeamMembers(prisma, workspaceId),
    prisma.aiPrompt.count({ where: { project: { workspaceId: { in: group } } } }),
    countLocationsForLimit(prisma, workspaceId),
    countProductsForLimit(prisma, workspaceId),
  ]);
  return {
    periodKey,
    plan: { key: plan.key, name: plan.name },
    pooled: group.length > 1,
    billingWorkspaceId,
    metrics: USAGE_METRICS.map((metric) => ({
      metric,
      label: USAGE_METRIC_LABELS[metric],
      used: used.get(metric) ?? 0,
      limit: monthlyLimitFor(limits, metric),
    })),
    counts: [
      { kind: 'projects', label: 'Projects', used: projects, limit: limits.projects },
      { kind: 'teamMembers', label: 'Team members', used: members, limit: limits.teamMembers },
      { kind: 'trackedPrompts', label: 'Tracked prompts', used: prompts, limit: limits.trackedPrompts },
      {
        kind: 'businessLocations',
        label: 'Business locations',
        used: locations,
        limit: limits.businessLocations,
      },
      { kind: 'productsTracked', label: 'Tracked products', used: products, limit: limits.productsTracked },
    ],
  };
}
