// Platform administration for provider costs and managed-service providers. Auth mode "admin" (404 for others);
// every change is recorded in the audit log.
import { recordAuditLog } from '@surfaced/core/audit-log';
import { providerCostSummary } from '@surfaced/core/costs';
import type { ProviderRate } from '@surfaced/core/db';
import { Errors } from '@surfaced/core/errors';
import {
  dateRangeQuerySchema,
  idSchema,
  providerRateCreateSchema,
  type ProviderCostLineDto,
  type ProviderRateDto,
} from '@surfaced/shared';
import { z } from 'zod';
import { created, noContent, ok } from '../lib/http';
import { route, type AnyRoute } from '../lib/router';
import type { AppDeps } from '../types';

export function toProviderRateDto(rate: ProviderRate): ProviderRateDto {
  return {
    id: rate.id,
    provider: rate.provider,
    operation: rate.operation,
    unit: rate.unit,
    price: Number(rate.priceMicros) / 1_000_000,
    unitQuantity: rate.unitQuantity,
    currency: rate.currency,
    effectiveFrom: rate.effectiveFrom.toISOString(),
    note: rate.note,
  };
}

export function toCostLineDto(
  line: Awaited<ReturnType<typeof providerCostSummary>>[number],
): ProviderCostLineDto {
  return {
    provider: line.provider,
    operation: line.operation,
    calls: line.calls,
    requests: line.requests,
    inputTokens: line.inputTokens,
    outputTokens: line.outputTokens,
    cost: Object.fromEntries(
      Object.entries(line.costMicros).map(([currency, micros]) => [currency, micros / 1_000_000]),
    ),
    unpricedCalls: line.unpricedCalls,
  };
}

/** Defaults to the current UTC month. */
export function monthRange(query: { from?: Date; to?: Date }): { from: Date; to: Date } {
  const now = new Date();
  const from = query.from ?? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const to = query.to ?? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  if (to <= from) throw Errors.badRequest('The end date must be after the start date.');
  return { from, to };
}

export function adminOpsRoutes(deps: AppDeps): AnyRoute[] {
  const { prisma } = deps;
  const tags = ['Admin'];
  return [
    route({
      method: 'get',
      path: '/provider-rates',
      summary: 'Configured provider unit prices used to estimate costs',
      tags,
      auth: 'admin',
      handler: async () => {
        const rates = await prisma.providerRate.findMany({
          orderBy: [{ provider: 'asc' }, { operation: 'asc' }, { effectiveFrom: 'desc' }],
        });
        return ok(rates.map(toProviderRateDto));
      },
    }),
    route({
      method: 'post',
      path: '/provider-rates',
      summary: 'Add a provider unit price (takes effect from its date; older rates stay for past usage)',
      tags,
      auth: 'admin',
      body: providerRateCreateSchema,
      successStatus: 201,
      handler: async ({ user, body }) => {
        const rate = await prisma.providerRate.create({
          data: {
            provider: body.provider,
            operation: body.operation ?? null,
            unit: body.unit,
            priceMicros: BigInt(Math.round(body.price * 1_000_000)),
            unitQuantity: body.unitQuantity,
            currency: body.currency,
            effectiveFrom: body.effectiveFrom,
            note: body.note ?? null,
            createdById: user.id,
          },
        });
        await recordAuditLog(prisma, {
          action: 'admin.provider_rate_created',
          actorUserId: user.id,
          targetType: 'ProviderRate',
          targetId: rate.id,
          metadata: { provider: rate.provider, operation: rate.operation, unit: rate.unit },
        });
        return created(toProviderRateDto(rate));
      },
    }),
    route({
      method: 'delete',
      path: '/provider-rates/:rateId',
      summary: 'Delete a provider rate (costs already recorded keep their estimate)',
      tags,
      auth: 'admin',
      params: z.object({ rateId: idSchema }),
      handler: async ({ user, params }) => {
        const deleted = await prisma.providerRate.deleteMany({ where: { id: params.rateId } });
        if (deleted.count === 0) throw Errors.notFound('Rate');
        await recordAuditLog(prisma, {
          action: 'admin.provider_rate_deleted',
          actorUserId: user.id,
          targetType: 'ProviderRate',
          targetId: params.rateId,
        });
        return noContent();
      },
    }),
    route({
      method: 'get',
      path: '/provider-costs',
      summary: 'Platform-wide provider usage and estimated costs for a period (default: this month)',
      tags,
      auth: 'admin',
      query: dateRangeQuerySchema,
      handler: async ({ query }) => {
        const range = monthRange(query);
        const lines = await providerCostSummary(prisma, range);
        return ok({
          from: range.from.toISOString(),
          to: range.to.toISOString(),
          lines: lines.map(toCostLineDto),
        });
      },
    }),
    route({
      method: 'patch',
      path: '/workspaces/:workspaceId/service-provider',
      summary: 'Mark a workspace as the managed-services provider (it can manage client workspaces)',
      tags,
      auth: 'admin',
      params: z.object({ workspaceId: idSchema }),
      body: z.object({ isServiceProvider: z.boolean() }),
      handler: async ({ user, params, body }) => {
        const workspace = await prisma.workspace.findUnique({ where: { id: params.workspaceId } });
        if (!workspace) throw Errors.notFound('Workspace');
        const updated = await prisma.workspace.update({
          where: { id: workspace.id },
          data: { isServiceProvider: body.isServiceProvider },
        });
        await recordAuditLog(prisma, {
          action: 'admin.service_provider_changed',
          actorUserId: user.id,
          workspaceId: workspace.id,
          targetType: 'Workspace',
          targetId: workspace.id,
          metadata: { isServiceProvider: body.isServiceProvider },
        });
        return ok({ id: updated.id, isServiceProvider: updated.isServiceProvider });
      },
    }),
  ];
}
