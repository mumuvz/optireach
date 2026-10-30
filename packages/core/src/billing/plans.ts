import {
  DEFAULT_PLANS,
  DEFAULT_PLAN_KEY,
  findDefaultPlan,
  planLimitsSchema,
  withPlanLimitDefaults,
  type PlanLimits,
} from '@surfaced/shared';
import type { Prisma, PrismaClient, Subscription, SubscriptionPlan } from '../db';
import { getLogger } from '../logger';

export interface PlanDto {
  id: string;
  key: string;
  name: string;
  description: string;
  currency: string;
  priceMonthly: number;
  priceYearly: number;
  limits: PlanLimits;
  features: string[];
  highlighted: boolean;
  sortOrder: number;
  isActive: boolean;
}

/**
 * Validates the JSON limits column. Keys added after the plan was stored are completed from the matching default
 * plan; invalid data falls back to the most restrictive default plan.
 */
export function parsePlanLimits(raw: unknown, planKey = 'unknown'): PlanLimits {
  const parsed = planLimitsSchema.safeParse(withPlanLimitDefaults(raw, planKey));
  if (parsed.success) return parsed.data;
  getLogger('billing').error(
    { planKey, issues: parsed.error.issues },
    'Invalid plan limits in database; using Free limits',
  );
  return findDefaultPlan(DEFAULT_PLAN_KEY)!.limits;
}

export function toPlanDto(plan: SubscriptionPlan): PlanDto {
  return {
    id: plan.id,
    key: plan.key,
    name: plan.name,
    description: plan.description,
    currency: plan.currency,
    priceMonthly: Number(plan.priceMonthly),
    priceYearly: Number(plan.priceYearly),
    limits: parsePlanLimits(plan.limits, plan.key),
    features: Array.isArray(plan.features) ? (plan.features as unknown[]).map(String) : [],
    highlighted: plan.highlighted,
    sortOrder: plan.sortOrder,
    isActive: plan.isActive,
  };
}

export async function listPlans(prisma: PrismaClient, { activeOnly = true } = {}): Promise<PlanDto[]> {
  const plans = await prisma.subscriptionPlan.findMany({
    where: activeOnly ? { isActive: true } : {},
    orderBy: { sortOrder: 'asc' },
  });
  return plans.map(toPlanDto);
}

/**
 * Inserts any missing default plans. Existing plans are left untouched so admin edits survive
 * re-seeding. Safe to run repeatedly (used by the seed script and tests).
 */
export async function ensureDefaultPlans(prisma: PrismaClient): Promise<void> {
  for (const plan of DEFAULT_PLANS) {
    await prisma.subscriptionPlan.upsert({
      where: { key: plan.key },
      update: {},
      create: {
        key: plan.key,
        name: plan.name,
        description: plan.description,
        currency: plan.currency,
        priceMonthly: plan.priceMonthly,
        priceYearly: plan.priceYearly,
        limits: plan.limits,
        features: plan.features,
        highlighted: plan.highlighted,
        sortOrder: plan.sortOrder,
      },
    });
  }
}

export interface WorkspacePlan {
  plan: PlanDto;
  limits: PlanLimits;
  subscription: Subscription | null;
  /** Workspace whose subscription applies: the agency for agency-billed client workspaces (D-024). */
  billingWorkspaceId: string;
}

type Db = PrismaClient | Prisma.TransactionClient;

/** The workspace whose subscription governs `workspaceId`: its agency when the agency pays, otherwise itself. */
export async function billingRootWorkspaceId(db: Db, workspaceId: string): Promise<string> {
  const link = await db.agencyClientLink.findFirst({
    where: { clientWorkspaceId: workspaceId, status: 'ACTIVE', billingMode: 'AGENCY' },
    select: { agencyWorkspaceId: true },
  });
  return link?.agencyWorkspaceId ?? workspaceId;
}

/** Workspaces that share one plan and pooled monthly quotas: the billing root and its agency-billed clients. */
export async function billingGroupWorkspaceIds(db: Db, workspaceId: string): Promise<string[]> {
  const root = await billingRootWorkspaceId(db, workspaceId);
  const clients = await db.agencyClientLink.findMany({
    where: { agencyWorkspaceId: root, status: 'ACTIVE', billingMode: 'AGENCY' },
    select: { clientWorkspaceId: true },
  });
  return [root, ...clients.map((c) => c.clientWorkspaceId)];
}

/**
 * Effective plan for a workspace. Canceled/unpaid subscriptions and missing records fall back to
 * the Free plan; PAST_DUE keeps the paid plan during the provider's retry window. Agency-billed client
 * workspaces use their agency's plan.
 */
export async function getWorkspacePlan(db: Db, workspaceId: string): Promise<WorkspacePlan> {
  const billingWorkspaceId = await billingRootWorkspaceId(db, workspaceId);
  const record = await db.subscription.findUnique({
    where: { workspaceId: billingWorkspaceId },
    include: { plan: true },
  });
  let subscription: Subscription | null = null;
  if (record) {
    const { plan: subscribedPlan, ...rest } = record;
    subscription = rest;
    if (['ACTIVE', 'TRIALING', 'PAST_DUE'].includes(record.status) && subscribedPlan.isActive) {
      const plan = toPlanDto(subscribedPlan);
      return { plan, limits: plan.limits, subscription, billingWorkspaceId };
    }
  }
  const free = await db.subscriptionPlan.findUnique({ where: { key: DEFAULT_PLAN_KEY } });
  if (free) {
    const plan = toPlanDto(free);
    return { plan, limits: plan.limits, subscription, billingWorkspaceId };
  }
  // Plans not seeded yet: use the built-in Free definition.
  const fallback = findDefaultPlan(DEFAULT_PLAN_KEY)!;
  return {
    plan: { id: 'builtin-free', ...fallback, isActive: true },
    limits: fallback.limits,
    subscription: null,
    billingWorkspaceId,
  };
}
