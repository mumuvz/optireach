import { recordAuditLog } from '@surfaced/core/audit-log';
import {
  RazorpayBillingAdapter,
  StripeBillingAdapter,
  WebhookSignatureError,
  activateDevSubscription,
  applyBillingEvent,
  getBillingAdapter,
  getWorkspacePlan,
  listPlans,
  toPlanDto,
  type BillingAdapter,
  type BillingEvent,
} from '@surfaced/core/billing';
import { randomToken } from '@surfaced/core/crypto';
import { getEnv } from '@surfaced/core/env';
import { Errors } from '@surfaced/core/errors';
import { getUsageSummary } from '@surfaced/core/usage';
import {
  DEFAULT_PLAN_KEY,
  checkoutSchema,
  idSchema,
  paginationSchema,
  workspaceRefSchema,
} from '@surfaced/shared';
import type { Request } from 'express';
import { z } from 'zod';
import { iso, ok, pageMeta, paginate } from '../lib/http';
import { route, type AnyRoute } from '../lib/router';
import { requireWorkspaceAccess } from '../services/access';
import type { AppDeps, AuthUser } from '../types';

function billingMode() {
  const provider = getEnv().BILLING_PROVIDER;
  return {
    provider,
    mode: provider === 'dev' ? 'development' : provider === 'none' ? 'disabled' : 'live',
  } as const;
}

export function billingRoutes(deps: AppDeps): { billing: AnyRoute[]; usage: AnyRoute[] } {
  const { prisma } = deps;
  const tags = ['Billing'];

  const webhookAdapter = (name: 'STRIPE' | 'RAZORPAY'): BillingAdapter => {
    const injected = deps.billingAdapters?.[name];
    if (injected) return injected;
    const env = getEnv();
    if (name === 'STRIPE' && env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET)
      return new StripeBillingAdapter();
    if (name === 'RAZORPAY' && env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET && env.RAZORPAY_WEBHOOK_SECRET)
      return new RazorpayBillingAdapter();
    throw Errors.providerNotConfigured(name === 'STRIPE' ? 'Stripe' : 'Razorpay');
  };

  async function subscriptionView(workspaceId: string) {
    const { plan, subscription } = await getWorkspacePlan(prisma, workspaceId);
    return {
      plan,
      billing: billingMode(),
      subscription: subscription
        ? {
            status: subscription.status,
            provider: subscription.provider,
            interval: subscription.interval,
            currentPeriodStart: iso(subscription.currentPeriodStart),
            currentPeriodEnd: iso(subscription.currentPeriodEnd),
            cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
            canceledAt: iso(subscription.canceledAt),
            lastPaymentFailedAt: iso(subscription.lastPaymentFailedAt),
            hasPortal: subscription.provider === 'STRIPE' && Boolean(subscription.providerCustomerId),
          }
        : null,
    };
  }

  const webhookHandler =
    (name: 'STRIPE' | 'RAZORPAY') =>
    async ({ req }: { req: Request }) => {
      const adapter = webhookAdapter(name);
      const raw = Buffer.isBuffer(req.body)
        ? req.body
        : Buffer.from(typeof req.body === 'string' ? req.body : '');
      let event: BillingEvent;
      try {
        event = adapter.parseWebhook(raw, req.headers);
      } catch (error) {
        if (error instanceof WebhookSignatureError) throw Errors.badRequest('Invalid webhook signature.');
        throw Errors.badRequest('Malformed webhook payload.');
      }
      const result = await applyBillingEvent(prisma, event);
      return ok({ received: true, result });
    };

  const billing: AnyRoute[] = [
    route({
      method: 'get',
      path: '/plans',
      summary: 'Active subscription plans (public)',
      tags,
      auth: 'public',
      handler: async () => ok({ plans: await listPlans(prisma), billing: billingMode() }),
    }),
    route({
      method: 'get',
      path: '/subscription',
      summary: 'Current plan and subscription status for a workspace',
      tags,
      auth: 'user',
      query: workspaceRefSchema,
      handler: async ({ user, query }) => {
        await requireWorkspaceAccess(prisma, user, query.workspaceId, 'billing.read');
        return ok(await subscriptionView(query.workspaceId));
      },
    }),
    route({
      method: 'post',
      path: '/checkout',
      summary:
        'Start a plan change. Paid providers return a hosted checkout URL; payment is confirmed only by webhook.',
      tags,
      auth: 'user',
      body: checkoutSchema,
      handler: async ({ req, user, body }) => {
        await requireWorkspaceAccess(prisma, user, body.workspaceId, 'billing.manage');
        const adapter = getBillingAdapter();
        if (!adapter)
          throw Errors.providerNotConfigured('Billing', {
            detail: 'Set BILLING_PROVIDER to stripe or razorpay.',
          });
        const planRow = await prisma.subscriptionPlan.findUnique({ where: { key: body.planKey } });
        if (!planRow || !planRow.isActive) throw Errors.notFound('Plan');
        const plan = toPlanDto(planRow);
        const current = await prisma.subscription.findUnique({
          where: { workspaceId: body.workspaceId },
          include: { plan: true },
        });

        if (adapter.name === 'DEV') {
          await activateDevSubscription(prisma, body.workspaceId, plan.key, body.interval);
          await recordAuditLog(prisma, {
            action: 'billing.plan_changed_dev',
            actorUserId: user.id,
            workspaceId: body.workspaceId,
            targetType: 'Subscription',
            targetId: body.workspaceId,
            ipAddress: req.clientIp,
            metadata: {
              plan: plan.key,
              interval: body.interval,
              note: 'Development billing mode — no payment processed',
            },
          });
          return ok({
            mode: 'activated',
            url: null,
            development: true,
            ...(await subscriptionView(body.workspaceId)),
          });
        }

        if (plan.key === DEFAULT_PLAN_KEY) {
          if (current?.providerSubscriptionId && current.status !== 'CANCELED') {
            await adapter.setCancelAtPeriodEnd(current.providerSubscriptionId, true);
            await prisma.subscription.update({
              where: { id: current.id },
              data: { cancelAtPeriodEnd: true },
            });
          }
          return ok({ mode: 'scheduled_cancel', url: null, ...(await subscriptionView(body.workspaceId)) });
        }
        const fullUser = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
        if (!fullUser.emailVerifiedAt) throw Errors.emailNotVerified();
        if (
          current?.providerSubscriptionId &&
          ['ACTIVE', 'TRIALING', 'PAST_DUE'].includes(current.status) &&
          current.plan.key !== DEFAULT_PLAN_KEY
        ) {
          throw Errors.conflict(
            adapter.name === 'STRIPE'
              ? 'This workspace already has a paid subscription. Use "Manage billing" to change plans.'
              : 'This workspace already has a paid subscription. Cancel it before choosing a different plan.',
          );
        }
        const appUrl = getEnv().APP_URL;
        const result = await adapter.createCheckout({
          workspaceId: body.workspaceId,
          plan: {
            ...plan,
            stripePriceMonthlyId: planRow.stripePriceMonthlyId,
            stripePriceYearlyId: planRow.stripePriceYearlyId,
            razorpayPlanMonthlyId: planRow.razorpayPlanMonthlyId,
            razorpayPlanYearlyId: planRow.razorpayPlanYearlyId,
          },
          interval: body.interval,
          customerEmail: fullUser.email,
          existingCustomerId: current?.provider === adapter.name ? current.providerCustomerId : null,
          successUrl: `${appUrl}/app/billing?checkout=success`,
          cancelUrl: `${appUrl}/app/billing?checkout=cancelled`,
        });
        await recordAuditLog(prisma, {
          action: 'billing.checkout_started',
          actorUserId: user.id,
          workspaceId: body.workspaceId,
          metadata: { plan: plan.key, interval: body.interval, provider: adapter.name },
        });
        return ok({ mode: result.mode, url: result.url });
      },
    }),
    route({
      method: 'post',
      path: '/portal',
      summary: 'Open the Stripe customer portal',
      tags,
      auth: 'user',
      body: workspaceRefSchema,
      handler: async ({ user, body }) => {
        await requireWorkspaceAccess(prisma, user, body.workspaceId, 'billing.manage');
        const sub = await prisma.subscription.findUnique({ where: { workspaceId: body.workspaceId } });
        const adapter = getBillingAdapter();
        if (!adapter || adapter.name !== 'STRIPE' || !sub?.providerCustomerId)
          throw Errors.badRequest('A billing portal is not available for this workspace.');
        return ok(await adapter.createPortal(sub.providerCustomerId, `${getEnv().APP_URL}/app/billing`));
      },
    }),
    route({
      method: 'post',
      path: '/cancel',
      summary: 'Cancel at the end of the current billing period',
      tags,
      auth: 'user',
      body: workspaceRefSchema,
      handler: async ({ user, body }) => {
        await requireWorkspaceAccess(prisma, user, body.workspaceId, 'billing.manage');
        const sub = await prisma.subscription.findUnique({
          where: { workspaceId: body.workspaceId },
          include: { plan: true },
        });
        if (!sub || sub.plan.key === DEFAULT_PLAN_KEY || sub.status === 'CANCELED')
          throw Errors.conflict('There is no paid subscription to cancel.');
        const adapter = getBillingAdapter();
        if (adapter && adapter.name !== 'DEV' && sub.providerSubscriptionId)
          await adapter.setCancelAtPeriodEnd(sub.providerSubscriptionId, true);
        await prisma.subscription.update({ where: { id: sub.id }, data: { cancelAtPeriodEnd: true } });
        await recordAuditLog(prisma, {
          action: 'billing.cancel_requested',
          actorUserId: user.id,
          workspaceId: body.workspaceId,
        });
        return ok(await subscriptionView(body.workspaceId));
      },
    }),
    route({
      method: 'post',
      path: '/resume',
      summary: 'Undo a scheduled cancellation',
      tags,
      auth: 'user',
      body: workspaceRefSchema,
      handler: async ({ user, body }) => {
        await requireWorkspaceAccess(prisma, user, body.workspaceId, 'billing.manage');
        const sub = await prisma.subscription.findUnique({ where: { workspaceId: body.workspaceId } });
        if (!sub?.cancelAtPeriodEnd || sub.status === 'CANCELED')
          throw Errors.conflict('There is no scheduled cancellation to undo.');
        const adapter = getBillingAdapter();
        if (adapter && adapter.name !== 'DEV' && sub.providerSubscriptionId)
          await adapter.setCancelAtPeriodEnd(sub.providerSubscriptionId, false);
        await prisma.subscription.update({ where: { id: sub.id }, data: { cancelAtPeriodEnd: false } });
        return ok(await subscriptionView(body.workspaceId));
      },
    }),
    route({
      method: 'get',
      path: '/invoices',
      summary: 'Billing history',
      tags,
      auth: 'user',
      query: workspaceRefSchema.extend(paginationSchema.shape),
      handler: async ({ user, query }) => {
        await requireWorkspaceAccess(prisma, user, query.workspaceId, 'billing.read');
        const where = { workspaceId: query.workspaceId };
        const [total, rows] = await Promise.all([
          prisma.billingInvoice.count({ where }),
          prisma.billingInvoice.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            ...paginate(query.page, query.pageSize),
          }),
        ]);
        return ok(
          rows.map((i) => ({
            id: i.id,
            provider: i.provider,
            amount: i.amount.toString(),
            currency: i.currency,
            status: i.status,
            description: i.description,
            periodStart: iso(i.periodStart),
            periodEnd: iso(i.periodEnd),
            hostedUrl: i.hostedUrl,
            paidAt: iso(i.paidAt),
            createdAt: i.createdAt.toISOString(),
          })),
          pageMeta(query.page, query.pageSize, total),
        );
      },
    }),
    route({
      method: 'post',
      path: '/webhooks/stripe',
      summary: 'Stripe webhook endpoint (signature-verified, idempotent)',
      tags,
      auth: 'public',
      handler: webhookHandler('STRIPE'),
    }),
    route({
      method: 'post',
      path: '/webhooks/razorpay',
      summary: 'Razorpay webhook endpoint (signature-verified, idempotent)',
      tags,
      auth: 'public',
      handler: webhookHandler('RAZORPAY'),
    }),
    route({
      method: 'post',
      path: '/dev/simulate',
      summary: 'Development only: simulate billing events to exercise UI states (no real payments)',
      tags,
      auth: 'user',
      body: workspaceRefSchema.extend({
        event: z.enum(['payment_failed', 'payment_recovered', 'cancel_now']),
      }),
      handler: async ({ user, body }) => {
        if (getEnv().BILLING_PROVIDER !== 'dev' || getEnv().isProduction) throw Errors.notFound('Endpoint');
        await requireWorkspaceAccess(prisma, user, body.workspaceId, 'billing.manage');
        const { plan } = await getWorkspacePlan(prisma, body.workspaceId);
        const eventId = `dev_${randomToken(9)}`;
        const base = {
          provider: 'DEV' as const,
          eventId,
          type: `dev.${body.event}`,
          workspaceId: body.workspaceId,
          providerSubscriptionId: null,
          providerCustomerId: null,
        };
        const event: BillingEvent =
          body.event === 'payment_failed'
            ? {
                ...base,
                paymentFailed: true,
                invoice: {
                  id: eventId,
                  amount: plan.priceMonthly,
                  currency: plan.currency,
                  status: 'FAILED',
                  hostedUrl: null,
                  periodStart: null,
                  periodEnd: null,
                  paidAt: null,
                  description: '[Development simulation — no real payment]',
                },
              }
            : body.event === 'payment_recovered'
              ? {
                  ...base,
                  subscription: {
                    status: 'ACTIVE',
                    planKey: plan.key,
                    priceRef: null,
                    interval: null,
                    currentPeriodStart: null,
                    currentPeriodEnd: null,
                    cancelAtPeriodEnd: false,
                    canceledAt: null,
                  },
                }
              : {
                  ...base,
                  subscription: {
                    status: 'CANCELED',
                    planKey: plan.key,
                    priceRef: null,
                    interval: null,
                    currentPeriodStart: null,
                    currentPeriodEnd: null,
                    cancelAtPeriodEnd: false,
                    canceledAt: new Date(),
                  },
                };
        await applyBillingEvent(prisma, event);
        return ok(await subscriptionView(body.workspaceId));
      },
    }),
  ];

  const usage: AnyRoute[] = [
    route({
      method: 'get',
      path: '/',
      summary: 'Usage for the current UTC month against plan limits',
      tags: ['Usage'],
      auth: 'user',
      query: z.object({ workspaceId: idSchema }),
      handler: async ({ user, query }: { user: AuthUser; query: { workspaceId: string } }) => {
        await requireWorkspaceAccess(prisma, user, query.workspaceId, 'usage.read');
        return ok(await getUsageSummary(prisma, query.workspaceId));
      },
    }),
  ];
  return { billing, usage };
}
