// Provider usage and estimated costs (docs/extension-plan.md D-027). Every paid or metered external call is recorded
// once (unique idempotency key). Cost is estimated only from administrator-configured rates; without a rate the
// usage is kept and reported as "not priced" instead of guessing a price.
import type { Prisma, PrismaClient, ProviderRate } from './db';
import { getLogger } from './logger';

type Db = PrismaClient | Prisma.TransactionClient;

export type RateUnit = 'input_token' | 'output_token' | 'request';
export const RATE_UNITS: readonly RateUnit[] = ['input_token', 'output_token', 'request'];

export interface ProviderUsageInput {
  workspaceId?: string | null;
  projectId?: string | null;
  /** e.g. "openai", "perplexity", "gemini", "dataforseo", "google_pagespeed". */
  provider: string;
  /** e.g. "visibility_check", "content_generation", "rank_check", "grid_point". */
  operation: string;
  model?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  requests?: number;
  backgroundJobId?: string | null;
  /** Unique per external call, e.g. "visibility:<observationKey>". */
  idempotencyKey: string;
  occurredAt?: Date;
}

/** Picks the most specific rate per unit: an operation-specific rate beats a provider-wide one; newest wins. */
export function selectRates(rates: ProviderRate[], operation: string): Map<RateUnit, ProviderRate> {
  const chosen = new Map<RateUnit, ProviderRate>();
  const ordered = [...rates].sort((a, b) => {
    const specificity = Number(b.operation === operation) - Number(a.operation === operation);
    return specificity || b.effectiveFrom.getTime() - a.effectiveFrom.getTime();
  });
  for (const rate of ordered) {
    if (rate.operation !== null && rate.operation !== operation) continue;
    const unit = rate.unit as RateUnit;
    if (RATE_UNITS.includes(unit) && !chosen.has(unit)) chosen.set(unit, rate);
  }
  return chosen;
}

/**
 * Estimated cost in millionths of the rate currency, or null when a unit that was used has no rate (or rates use
 * different currencies). Integer arithmetic avoids floating-point drift.
 */
export function estimateCostMicros(
  usage: { inputTokens?: number | null; outputTokens?: number | null; requests?: number },
  rates: Map<RateUnit, ProviderRate>,
): { costMicros: bigint; currency: string } | null {
  const quantities: [RateUnit, number][] = [
    ['input_token', usage.inputTokens ?? 0],
    ['output_token', usage.outputTokens ?? 0],
    ['request', usage.requests ?? 1],
  ];
  let total = 0n;
  let currency: string | null = null;
  for (const [unit, quantity] of quantities) {
    if (quantity <= 0) continue;
    const rate = rates.get(unit);
    if (!rate) return null;
    if (currency && rate.currency !== currency) return null;
    currency = rate.currency;
    total += (BigInt(Math.round(quantity)) * rate.priceMicros) / BigInt(Math.max(1, rate.unitQuantity));
  }
  return currency ? { costMicros: total, currency } : null;
}

/** Records one external call. Returns false when the same call was already recorded (retries). */
export async function recordProviderUsage(db: Db, input: ProviderUsageInput): Promise<boolean> {
  const occurredAt = input.occurredAt ?? new Date();
  try {
    const rates = await db.providerRate.findMany({
      where: { provider: input.provider, effectiveFrom: { lte: occurredAt } },
    });
    const cost = estimateCostMicros(input, selectRates(rates, input.operation));
    await db.providerUsageEvent.create({
      data: {
        workspaceId: input.workspaceId ?? null,
        projectId: input.projectId ?? null,
        provider: input.provider.slice(0, 40),
        operation: input.operation.slice(0, 40),
        model: input.model?.slice(0, 80) ?? null,
        inputTokens: input.inputTokens ?? null,
        outputTokens: input.outputTokens ?? null,
        requests: input.requests ?? 1,
        costMicros: cost?.costMicros ?? null,
        currency: cost?.currency ?? null,
        backgroundJobId: input.backgroundJobId ?? null,
        idempotencyKey: input.idempotencyKey.slice(0, 160),
        occurredAt,
      },
    });
    return true;
  } catch (error) {
    if ((error as { code?: string }).code === 'P2002') return false;
    // Cost tracking must never break the operation that incurred the cost.
    getLogger('costs').error({ err: error, provider: input.provider }, 'Could not record provider usage');
    return false;
  }
}

export interface ProviderCostLine {
  provider: string;
  operation: string;
  calls: number;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  /** Sum of priced events, per currency. */
  costMicros: Record<string, number>;
  /** Events without a configured rate. */
  unpricedCalls: number;
}

/** Provider usage and estimated costs for a set of workspaces (or the whole platform) in a date range. */
export async function providerCostSummary(
  db: Db,
  { workspaceIds, from, to }: { workspaceIds?: string[]; from: Date; to: Date },
): Promise<ProviderCostLine[]> {
  const rows = await db.providerUsageEvent.findMany({
    where: {
      occurredAt: { gte: from, lt: to },
      ...(workspaceIds ? { workspaceId: { in: workspaceIds } } : {}),
    },
    select: {
      provider: true,
      operation: true,
      requests: true,
      inputTokens: true,
      outputTokens: true,
      costMicros: true,
      currency: true,
    },
  });
  const lines = new Map<string, ProviderCostLine>();
  for (const row of rows) {
    const key = `${row.provider}\u0000${row.operation}`;
    let line = lines.get(key);
    if (!line) {
      line = {
        provider: row.provider,
        operation: row.operation,
        calls: 0,
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        costMicros: {},
        unpricedCalls: 0,
      };
      lines.set(key, line);
    }
    line.calls += 1;
    line.requests += row.requests;
    line.inputTokens += row.inputTokens ?? 0;
    line.outputTokens += row.outputTokens ?? 0;
    if (row.costMicros === null || !row.currency) line.unpricedCalls += 1;
    else line.costMicros[row.currency] = (line.costMicros[row.currency] ?? 0) + Number(row.costMicros);
  }
  return [...lines.values()].sort((a, b) => a.provider.localeCompare(b.provider) || b.calls - a.calls);
}
