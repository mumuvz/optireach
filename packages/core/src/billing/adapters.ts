// Billing provider adapters. Payment state is only ever changed by verified provider webhooks
// (or, in local development only, by the clearly labeled dev adapter) — never by a browser callback.
import type { BillingInterval, InvoiceStatus, SubscriptionStatus } from '@surfaced/shared';
import { createHmac } from 'node:crypto';
import Stripe from 'stripe';
import { safeEqual } from '../crypto';
import { getEnv } from '../env';
import { Errors } from '../errors';
import type { PlanDto } from './plans';

export type BillingProviderName = 'DEV' | 'STRIPE' | 'RAZORPAY';

export interface PlanPriceRefs {
  stripePriceMonthlyId: string | null;
  stripePriceYearlyId: string | null;
  razorpayPlanMonthlyId: string | null;
  razorpayPlanYearlyId: string | null;
}

export interface CheckoutRequest {
  workspaceId: string;
  plan: PlanDto & PlanPriceRefs;
  interval: BillingInterval;
  customerEmail: string;
  existingCustomerId: string | null;
  successUrl: string;
  cancelUrl: string;
}

export interface CheckoutResult {
  /** Hosted payment page to redirect the customer to (null when activated immediately). */
  url: string | null;
  mode: 'redirect' | 'activated';
}

/** Provider-independent view of one webhook event. */
export interface BillingEvent {
  provider: BillingProviderName;
  eventId: string;
  type: string;
  workspaceId: string | null;
  providerSubscriptionId: string | null;
  providerCustomerId: string | null;
  subscription?: {
    status: SubscriptionStatus;
    planKey: string | null;
    priceRef: string | null;
    interval: BillingInterval | null;
    currentPeriodStart: Date | null;
    currentPeriodEnd: Date | null;
    cancelAtPeriodEnd: boolean;
    canceledAt: Date | null;
  };
  invoice?: {
    id: string;
    amount: number;
    currency: string;
    status: InvoiceStatus;
    hostedUrl: string | null;
    periodStart: Date | null;
    periodEnd: Date | null;
    paidAt: Date | null;
    description: string | null;
  };
  /** Marks a failed payment attempt (moves the subscription to PAST_DUE). */
  paymentFailed?: boolean;
  /** Ignored event types are recorded but change nothing. */
  ignored?: boolean;
}

export interface BillingAdapter {
  readonly name: BillingProviderName;
  createCheckout(request: CheckoutRequest): Promise<CheckoutResult>;
  createPortal(customerId: string, returnUrl: string): Promise<{ url: string }>;
  setCancelAtPeriodEnd(providerSubscriptionId: string, cancel: boolean): Promise<void>;
  /** Verifies the signature over the raw body and normalizes the event; throws on invalid signatures. */
  parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): BillingEvent;
}

export class WebhookSignatureError extends Error {
  constructor(message = 'Invalid webhook signature') {
    super(message);
    this.name = 'WebhookSignatureError';
  }
}

const fromUnix = (seconds: number | null | undefined) =>
  typeof seconds === 'number' && seconds > 0 ? new Date(seconds * 1000) : null;
const header = (headers: Record<string, string | string[] | undefined>, name: string) => {
  const value = headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
};

// ---------------- Stripe ----------------

const STRIPE_STATUS: Record<string, SubscriptionStatus> = {
  active: 'ACTIVE',
  trialing: 'TRIALING',
  past_due: 'PAST_DUE',
  canceled: 'CANCELED',
  incomplete: 'INCOMPLETE',
  incomplete_expired: 'CANCELED',
  unpaid: 'UNPAID',
  paused: 'UNPAID',
};

const STRIPE_INVOICE_STATUS: Record<string, InvoiceStatus> = {
  paid: 'PAID',
  open: 'OPEN',
  void: 'VOID',
  uncollectible: 'FAILED',
  draft: 'OPEN',
};

export class StripeBillingAdapter implements BillingAdapter {
  readonly name = 'STRIPE' as const;
  private readonly stripe: Stripe;
  private readonly webhookSecret: string;

  constructor(secretKey = getEnv().STRIPE_SECRET_KEY, webhookSecret = getEnv().STRIPE_WEBHOOK_SECRET) {
    if (!secretKey || !webhookSecret) throw Errors.providerNotConfigured('Stripe');
    this.stripe = new Stripe(secretKey);
    this.webhookSecret = webhookSecret;
  }

  async createCheckout(request: CheckoutRequest): Promise<CheckoutResult> {
    const price =
      request.interval === 'YEAR' ? request.plan.stripePriceYearlyId : request.plan.stripePriceMonthlyId;
    if (!price)
      throw Errors.providerNotConfigured('Stripe price', {
        plan: request.plan.key,
        interval: request.interval,
      });
    const metadata = {
      workspaceId: request.workspaceId,
      planKey: request.plan.key,
      interval: request.interval,
    };
    const session = await this.stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price, quantity: 1 }],
      client_reference_id: request.workspaceId,
      ...(request.existingCustomerId
        ? { customer: request.existingCustomerId }
        : { customer_email: request.customerEmail }),
      metadata,
      subscription_data: { metadata },
      success_url: request.successUrl,
      cancel_url: request.cancelUrl,
    });
    return { url: session.url, mode: 'redirect' };
  }

  async createPortal(customerId: string, returnUrl: string) {
    const session = await this.stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: returnUrl,
    });
    return { url: session.url };
  }

  async setCancelAtPeriodEnd(providerSubscriptionId: string, cancel: boolean) {
    await this.stripe.subscriptions.update(providerSubscriptionId, { cancel_at_period_end: cancel });
  }

  parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): BillingEvent {
    const signature = header(headers, 'stripe-signature');
    if (!signature) throw new WebhookSignatureError('Missing Stripe-Signature header');
    let event: Stripe.Event;
    try {
      event = this.stripe.webhooks.constructEvent(rawBody, signature, this.webhookSecret);
    } catch {
      throw new WebhookSignatureError();
    }
    return normalizeStripeEvent(event);
  }

  /** Test helper: produce a valid signature header for a payload. */
  signTestPayload(payload: string): string {
    return this.stripe.webhooks.generateTestHeaderString({ payload, secret: this.webhookSecret });
  }
}

export function normalizeStripeEvent(event: Stripe.Event): BillingEvent {
  const base = { provider: 'STRIPE' as const, eventId: event.id, type: event.type };
  const asId = (value: unknown) =>
    typeof value === 'string'
      ? value
      : value && typeof value === 'object' && 'id' in value
        ? String((value as { id: string }).id)
        : null;
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session;
      return {
        ...base,
        workspaceId: session.client_reference_id ?? session.metadata?.workspaceId ?? null,
        providerSubscriptionId: asId(session.subscription),
        providerCustomerId: asId(session.customer),
      };
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const sub = event.data.object as Stripe.Subscription;
      const item = sub.items?.data?.[0];
      const recurring = item?.price?.recurring?.interval;
      return {
        ...base,
        workspaceId: sub.metadata?.workspaceId ?? null,
        providerSubscriptionId: sub.id,
        providerCustomerId: asId(sub.customer),
        subscription: {
          status:
            event.type === 'customer.subscription.deleted'
              ? 'CANCELED'
              : (STRIPE_STATUS[sub.status] ?? 'INCOMPLETE'),
          planKey: sub.metadata?.planKey ?? null,
          priceRef: item?.price?.id ?? null,
          interval: recurring === 'year' ? 'YEAR' : recurring === 'month' ? 'MONTH' : null,
          // API 2025-03-31.basil+: billing periods live on subscription items.
          currentPeriodStart: fromUnix(item?.current_period_start),
          currentPeriodEnd: fromUnix(item?.current_period_end),
          cancelAtPeriodEnd: Boolean(sub.cancel_at_period_end),
          canceledAt: fromUnix(sub.canceled_at),
        },
      };
    }
    case 'invoice.paid':
    case 'invoice.payment_failed': {
      const invoice = event.data.object as Stripe.Invoice;
      const subscriptionRef = invoice.parent?.subscription_details?.subscription ?? null;
      const failed = event.type === 'invoice.payment_failed';
      return {
        ...base,
        workspaceId: invoice.parent?.subscription_details?.metadata?.workspaceId ?? null,
        providerSubscriptionId: asId(subscriptionRef),
        providerCustomerId: asId(invoice.customer),
        paymentFailed: failed,
        invoice: {
          id: invoice.id ?? `${event.id}-invoice`,
          amount: (failed ? invoice.amount_due : invoice.amount_paid) / 100,
          currency: (invoice.currency ?? 'usd').toUpperCase(),
          status: failed ? 'FAILED' : (STRIPE_INVOICE_STATUS[invoice.status ?? 'paid'] ?? 'PAID'),
          hostedUrl: invoice.hosted_invoice_url ?? null,
          periodStart: fromUnix(invoice.period_start),
          periodEnd: fromUnix(invoice.period_end),
          paidAt: failed
            ? null
            : (fromUnix(invoice.status_transitions?.paid_at) ?? new Date(event.created * 1000)),
          description: invoice.description ?? null,
        },
      };
    }
    default:
      return {
        ...base,
        workspaceId: null,
        providerSubscriptionId: null,
        providerCustomerId: null,
        ignored: true,
      };
  }
}

// ---------------- Razorpay (Subscriptions API) ----------------

const RAZORPAY_EVENT_STATUS: Record<string, SubscriptionStatus> = {
  'subscription.authenticated': 'INCOMPLETE',
  'subscription.activated': 'ACTIVE',
  'subscription.charged': 'ACTIVE',
  'subscription.resumed': 'ACTIVE',
  'subscription.updated': 'ACTIVE',
  'subscription.pending': 'PAST_DUE',
  'subscription.halted': 'UNPAID',
  'subscription.paused': 'UNPAID',
  'subscription.cancelled': 'CANCELED',
  'subscription.completed': 'CANCELED',
};

interface RazorpaySubscription {
  id: string;
  plan_id?: string;
  customer_id?: string | null;
  status?: string;
  current_start?: number | null;
  current_end?: number | null;
  ended_at?: number | null;
  notes?: Record<string, string> | unknown[];
}

interface RazorpayPayment {
  id: string;
  amount: number;
  currency: string;
  status?: string;
  invoice_id?: string | null;
  description?: string | null;
  created_at?: number;
  subscription_id?: string | null;
  notes?: Record<string, string> | unknown[];
}

export class RazorpayBillingAdapter implements BillingAdapter {
  readonly name = 'RAZORPAY' as const;
  private readonly keyId: string;
  private readonly keySecret: string;
  private readonly webhookSecret: string;

  constructor(env = getEnv()) {
    if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET || !env.RAZORPAY_WEBHOOK_SECRET)
      throw Errors.providerNotConfigured('Razorpay');
    this.keyId = env.RAZORPAY_KEY_ID;
    this.keySecret = env.RAZORPAY_KEY_SECRET;
    this.webhookSecret = env.RAZORPAY_WEBHOOK_SECRET;
  }

  private async api<T>(path: string, body: unknown): Promise<T> {
    const response = await fetch(`https://api.razorpay.com/v1${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${Buffer.from(`${this.keyId}:${this.keySecret}`).toString('base64')}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw Errors.unavailable(`Razorpay request failed (HTTP ${response.status}).`);
    return (await response.json()) as T;
  }

  async createCheckout(request: CheckoutRequest): Promise<CheckoutResult> {
    const planId =
      request.interval === 'YEAR' ? request.plan.razorpayPlanYearlyId : request.plan.razorpayPlanMonthlyId;
    if (!planId)
      throw Errors.providerNotConfigured('Razorpay plan', {
        plan: request.plan.key,
        interval: request.interval,
      });
    const subscription = await this.api<{ id: string; short_url: string }>('/subscriptions', {
      plan_id: planId,
      total_count: request.interval === 'YEAR' ? 10 : 120,
      customer_notify: 1,
      notes: { workspaceId: request.workspaceId, planKey: request.plan.key, interval: request.interval },
    });
    return { url: subscription.short_url, mode: 'redirect' };
  }

  async createPortal(): Promise<{ url: string }> {
    throw Errors.badRequest(
      'Razorpay does not provide a hosted billing portal. Use the cancel and resume actions.',
    );
  }

  async setCancelAtPeriodEnd(providerSubscriptionId: string, cancel: boolean) {
    if (!cancel)
      throw Errors.badRequest(
        'Razorpay subscriptions cannot be resumed after cancellation; start a new subscription instead.',
      );
    await this.api(`/subscriptions/${encodeURIComponent(providerSubscriptionId)}/cancel`, {
      cancel_at_cycle_end: 1,
    });
  }

  /** Razorpay signs the raw body with HMAC-SHA256 (hex) using the webhook secret. */
  verifySignature(rawBody: Buffer, signature: string | undefined): boolean {
    if (!signature) return false;
    const expected = createHmac('sha256', this.webhookSecret).update(rawBody).digest('hex');
    return safeEqual(expected, signature);
  }

  parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): BillingEvent {
    if (!this.verifySignature(rawBody, header(headers, 'x-razorpay-signature')))
      throw new WebhookSignatureError();
    const payload = JSON.parse(rawBody.toString('utf8')) as {
      event: string;
      created_at?: number;
      payload?: { subscription?: { entity: RazorpaySubscription }; payment?: { entity: RazorpayPayment } };
    };
    const eventId =
      header(headers, 'x-razorpay-event-id') ??
      `${payload.event}:${payload.created_at ?? ''}:${payload.payload?.payment?.entity.id ?? payload.payload?.subscription?.entity.id ?? ''}`;
    const sub = payload.payload?.subscription?.entity;
    const payment = payload.payload?.payment?.entity;
    const notes = (value: unknown) =>
      value && !Array.isArray(value) && typeof value === 'object' ? (value as Record<string, string>) : {};
    const subNotes = notes(sub?.notes);
    const base = {
      provider: 'RAZORPAY' as const,
      eventId,
      type: payload.event,
      workspaceId: subNotes.workspaceId ?? notes(payment?.notes).workspaceId ?? null,
      providerSubscriptionId: sub?.id ?? payment?.subscription_id ?? null,
      providerCustomerId: sub?.customer_id ?? null,
    };
    const status = RAZORPAY_EVENT_STATUS[payload.event];
    if (status && sub) {
      const interval = subNotes.interval === 'YEAR' ? 'YEAR' : subNotes.interval === 'MONTH' ? 'MONTH' : null;
      return {
        ...base,
        subscription: {
          status,
          planKey: subNotes.planKey ?? null,
          priceRef: sub.plan_id ?? null,
          interval,
          currentPeriodStart: fromUnix(sub.current_start),
          currentPeriodEnd: fromUnix(sub.current_end),
          cancelAtPeriodEnd: false,
          canceledAt: status === 'CANCELED' ? (fromUnix(sub.ended_at) ?? new Date()) : null,
        },
        ...(payload.event === 'subscription.charged' && payment
          ? {
              invoice: {
                id: payment.invoice_id ?? payment.id,
                amount: payment.amount / 100,
                currency: payment.currency.toUpperCase(),
                status: 'PAID' as const,
                hostedUrl: null,
                periodStart: fromUnix(sub.current_start),
                periodEnd: fromUnix(sub.current_end),
                paidAt: fromUnix(payment.created_at) ?? new Date(),
                description: payment.description ?? null,
              },
            }
          : {}),
        paymentFailed: payload.event === 'subscription.pending',
      };
    }
    if (payload.event === 'payment.failed' && payment) {
      return {
        ...base,
        paymentFailed: true,
        invoice: {
          id: payment.invoice_id ?? payment.id,
          amount: payment.amount / 100,
          currency: payment.currency.toUpperCase(),
          status: 'FAILED',
          hostedUrl: null,
          periodStart: null,
          periodEnd: null,
          paidAt: null,
          description: payment.description ?? null,
        },
      };
    }
    return { ...base, ignored: true };
  }
}

// ---------------- Development (no payments) ----------------

/** Local development only: switches plans immediately WITHOUT taking any payment. */
export class DevBillingAdapter implements BillingAdapter {
  readonly name = 'DEV' as const;

  async createCheckout(): Promise<CheckoutResult> {
    return { url: null, mode: 'activated' };
  }

  async createPortal(): Promise<{ url: string }> {
    throw Errors.badRequest('There is no billing portal in development billing mode.');
  }

  async setCancelAtPeriodEnd(): Promise<void> {
    // Handled locally by the billing service in development mode.
  }

  parseWebhook(): BillingEvent {
    throw new WebhookSignatureError('Development billing mode does not accept webhooks.');
  }
}

export function getBillingAdapter(): BillingAdapter | null {
  const env = getEnv();
  if (env.BILLING_PROVIDER === 'stripe') return new StripeBillingAdapter();
  if (env.BILLING_PROVIDER === 'razorpay') return new RazorpayBillingAdapter();
  if (env.BILLING_PROVIDER === 'dev') return new DevBillingAdapter();
  return null;
}
