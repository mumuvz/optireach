// Applies verified billing events to subscriptions and invoices, idempotently.
import { DEFAULT_PLAN_KEY, type BillingInterval, type SubscriptionStatus } from '@surfaced/shared';
import { getLogger } from '../logger';
import type { Prisma, PrismaClient, Subscription } from '../db';
import { notifyWorkspace } from '../notifications';
import type { BillingEvent } from './adapters';

export type ApplyResult = 'processed' | 'duplicate' | 'ignored' | 'unmatched';

function addInterval(from: Date, interval: BillingInterval): Date {
  const next = new Date(from);
  if (interval === 'YEAR') next.setUTCFullYear(next.getUTCFullYear() + 1);
  else next.setUTCMonth(next.getUTCMonth() + 1);
  return next;
}

async function resolvePlanId(
  prisma: PrismaClient | Prisma.TransactionClient,
  event: BillingEvent,
): Promise<string | null> {
  const sub = event.subscription;
  if (!sub) return null;
  if (sub.planKey) {
    const plan = await prisma.subscriptionPlan.findUnique({
      where: { key: sub.planKey },
      select: { id: true },
    });
    if (plan) return plan.id;
  }
  if (sub.priceRef) {
    const plan = await prisma.subscriptionPlan.findFirst({
      where: {
        OR: [
          { stripePriceMonthlyId: sub.priceRef },
          { stripePriceYearlyId: sub.priceRef },
          { razorpayPlanMonthlyId: sub.priceRef },
          { razorpayPlanYearlyId: sub.priceRef },
        ],
      },
      select: { id: true },
    });
    if (plan) return plan.id;
  }
  return null;
}

async function findSubscription(prisma: PrismaClient, event: BillingEvent): Promise<Subscription | null> {
  if (event.providerSubscriptionId) {
    const byProvider = await prisma.subscription.findFirst({
      where: { provider: event.provider, providerSubscriptionId: event.providerSubscriptionId },
    });
    if (byProvider) return byProvider;
  }
  if (event.workspaceId) return prisma.subscription.findUnique({ where: { workspaceId: event.workspaceId } });
  if (event.providerCustomerId)
    return prisma.subscription.findFirst({
      where: { provider: event.provider, providerCustomerId: event.providerCustomerId },
    });
  return null;
}

/**
 * Records the event (unique per provider + event id) and applies it once. Re-delivered events are
 * acknowledged as duplicates; events whose earlier processing failed are retried.
 */
export async function applyBillingEvent(prisma: PrismaClient, event: BillingEvent): Promise<ApplyResult> {
  const summary = {
    type: event.type,
    workspaceId: event.workspaceId,
    providerSubscriptionId: event.providerSubscriptionId,
    invoiceId: event.invoice?.id ?? null,
    status: event.subscription?.status ?? null,
  };
  let record = await prisma.webhookEvent.findUnique({
    where: { provider_eventId: { provider: event.provider, eventId: event.eventId } },
  });
  if (record && (record.status === 'PROCESSED' || record.status === 'IGNORED')) return 'duplicate';
  if (!record) {
    try {
      record = await prisma.webhookEvent.create({
        data: { provider: event.provider, eventId: event.eventId, type: event.type.slice(0, 120), summary },
      });
    } catch (error) {
      if ((error as { code?: string }).code === 'P2002') return 'duplicate'; // concurrent delivery
      throw error;
    }
  }

  if (event.ignored) {
    await prisma.webhookEvent.update({
      where: { id: record.id },
      data: { status: 'IGNORED', processedAt: new Date() },
    });
    return 'ignored';
  }

  try {
    const subscription = await findSubscription(prisma, event);
    if (!subscription) {
      await prisma.webhookEvent.update({
        where: { id: record.id },
        data: { status: 'IGNORED', error: 'No matching workspace subscription', processedAt: new Date() },
      });
      return 'unmatched';
    }
    const before = subscription.status;
    const updated = await prisma.$transaction(async (tx) => {
      const data: Prisma.SubscriptionUncheckedUpdateInput = { provider: event.provider };
      if (event.providerSubscriptionId) data.providerSubscriptionId = event.providerSubscriptionId;
      if (event.providerCustomerId) data.providerCustomerId = event.providerCustomerId;
      let status: SubscriptionStatus = subscription.status;
      if (event.subscription) {
        const planId = await resolvePlanId(tx, event);
        if (planId) data.planId = planId;
        status = event.subscription.status;
        if (event.subscription.interval) data.interval = event.subscription.interval;
        data.currentPeriodStart = event.subscription.currentPeriodStart ?? undefined;
        data.currentPeriodEnd = event.subscription.currentPeriodEnd ?? undefined;
        data.cancelAtPeriodEnd = event.subscription.cancelAtPeriodEnd;
        data.canceledAt = event.subscription.canceledAt;
      }
      if (event.invoice) {
        await tx.billingInvoice.upsert({
          where: {
            provider_providerInvoiceId: { provider: event.provider, providerInvoiceId: event.invoice.id },
          },
          update: {
            status: event.invoice.status,
            hostedUrl: event.invoice.hostedUrl,
            paidAt: event.invoice.paidAt,
          },
          create: {
            workspaceId: subscription.workspaceId,
            subscriptionId: subscription.id,
            provider: event.provider,
            providerInvoiceId: event.invoice.id,
            amount: event.invoice.amount,
            currency: event.invoice.currency,
            status: event.invoice.status,
            description: event.invoice.description,
            periodStart: event.invoice.periodStart,
            periodEnd: event.invoice.periodEnd,
            hostedUrl: event.invoice.hostedUrl,
            paidAt: event.invoice.paidAt,
          },
        });
        if (event.invoice.status === 'PAID') {
          data.lastPaymentFailedAt = null;
          if (!event.subscription && ['PAST_DUE', 'UNPAID', 'INCOMPLETE'].includes(status)) status = 'ACTIVE';
        }
      }
      if (event.paymentFailed) {
        data.lastPaymentFailedAt = new Date();
        if (status !== 'CANCELED' && !event.subscription) status = 'PAST_DUE';
      }
      data.status = status;
      return tx.subscription.update({ where: { id: subscription.id }, data });
    });
    await prisma.webhookEvent.update({
      where: { id: record.id },
      data: { status: 'PROCESSED', processedAt: new Date(), error: null },
    });
    await notifyBillingChange(prisma, updated, before, event).catch((error) =>
      getLogger('billing').warn({ err: error }, 'Billing notification failed'),
    );
    return 'processed';
  } catch (error) {
    await prisma.webhookEvent.update({
      where: { id: record.id },
      data: { status: 'FAILED', error: error instanceof Error ? error.message.slice(0, 2000) : 'failed' },
    });
    throw error;
  }
}

async function notifyBillingChange(
  prisma: PrismaClient,
  sub: Subscription,
  before: SubscriptionStatus,
  event: BillingEvent,
) {
  let title: string | null = null;
  if (event.paymentFailed)
    title = 'A subscription payment failed. Update your payment method to keep your plan.';
  else if (sub.status === 'CANCELED' && before !== 'CANCELED')
    title = 'Your subscription was cancelled. The workspace now uses the Free plan limits.';
  else if (sub.status === 'ACTIVE' && before !== 'ACTIVE') title = 'Your subscription is active.';
  if (!title) return;
  await notifyWorkspace(prisma, sub.workspaceId, { type: 'billing', title, link: '/app/billing' }, [
    'OWNER',
    'ADMIN',
  ]);
}

/** Development billing mode: switch plans immediately without any payment. */
export async function activateDevSubscription(
  prisma: PrismaClient,
  workspaceId: string,
  planKey: string,
  interval: BillingInterval,
) {
  const plan = await prisma.subscriptionPlan.findUniqueOrThrow({ where: { key: planKey } });
  const now = new Date();
  const isFree = planKey === DEFAULT_PLAN_KEY;
  return prisma.subscription.upsert({
    where: { workspaceId },
    update: {
      planId: plan.id,
      status: 'ACTIVE',
      provider: isFree ? 'NONE' : 'DEV',
      interval,
      currentPeriodStart: isFree ? null : now,
      currentPeriodEnd: isFree ? null : addInterval(now, interval),
      cancelAtPeriodEnd: false,
      canceledAt: null,
      lastPaymentFailedAt: null,
      providerSubscriptionId: isFree ? null : `dev_${workspaceId}`,
    },
    create: {
      workspaceId,
      planId: plan.id,
      status: 'ACTIVE',
      provider: isFree ? 'NONE' : 'DEV',
      interval,
      currentPeriodStart: isFree ? null : now,
      currentPeriodEnd: isFree ? null : addInterval(now, interval),
      providerSubscriptionId: isFree ? null : `dev_${workspaceId}`,
    },
  });
}
