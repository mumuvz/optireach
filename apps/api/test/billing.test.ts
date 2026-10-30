import { RazorpayBillingAdapter, StripeBillingAdapter, getWorkspacePlan } from '@surfaced/core/billing';
import { disconnectPrisma, getPrisma } from '@surfaced/core/db';
import { getEnv } from '@surfaced/core/env';
import { getLogger } from '@surfaced/core/logger';
import { MemoryQueueGateway } from '@surfaced/core/queue';
import { createHmac } from 'node:crypto';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { API, emailTokenFor, registerClient } from './helpers';

const stripe = new StripeBillingAdapter('sk_test_dummy_key_for_signatures', 'whsec_test_secret');
const razorpay = new RazorpayBillingAdapter({
  ...getEnv(),
  RAZORPAY_KEY_ID: 'rzp_test_key',
  RAZORPAY_KEY_SECRET: 'rzp_test_secret',
  RAZORPAY_WEBHOOK_SECRET: 'rzp_webhook_secret',
});
const queues = new MemoryQueueGateway();
const { app } = createApp({
  prisma: getPrisma(),
  queues,
  redis: null,
  logger: getLogger('api-test'),
  rateLimitMultiplier: 100,
  billingAdapters: { STRIPE: stripe, RAZORPAY: razorpay },
});
const prisma = getPrisma();

afterAll(async () => {
  await disconnectPrisma();
});

let eventSeq = 0;
function stripeEvent(
  type: string,
  object: Record<string, unknown>,
  id = `evt_test_${Date.now()}_${++eventSeq}`,
) {
  return JSON.stringify({
    id,
    object: 'event',
    type,
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    pending_webhooks: 0,
    request: null,
    data: { object },
  });
}

function postStripe(payload: string, signature = stripe.signTestPayload(payload)) {
  return request(app)
    .post(`${API}/billing/webhooks/stripe`)
    .set('Content-Type', 'application/json')
    .set('Stripe-Signature', signature)
    .send(payload);
}

describe('plans and development billing', () => {
  it('lists configurable plans publicly and switches plans in development mode without payment', async () => {
    const plans = await request(app).get(`${API}/billing/plans`);
    expect(plans.body.data.plans.map((p: { key: string }) => p.key)).toEqual([
      'FREE',
      'STARTER',
      'GROWTH',
      'AGENCY',
    ]);
    expect(plans.body.data.billing).toEqual({ provider: 'dev', mode: 'development' });

    const { client, workspaceId } = await registerClient(app);
    const change = await client.post('/billing/checkout', {
      workspaceId,
      planKey: 'GROWTH',
      interval: 'YEAR',
    });
    expect(change.status).toBe(200);
    expect(change.body.data).toMatchObject({
      mode: 'activated',
      development: true,
      plan: { key: 'GROWTH' },
      subscription: { provider: 'DEV', status: 'ACTIVE', interval: 'YEAR' },
    });
    expect(await prisma.billingInvoice.count({ where: { workspaceId } })).toBe(0); // no fabricated invoices

    const usage = await client.get(`/usage?workspaceId=${workspaceId}`);
    expect(usage.body.data.plan.key).toBe('GROWTH');
    expect(usage.body.data.counts.find((c: { kind: string }) => c.kind === 'projects').limit).toBe(5);

    const cancel = await client.post('/billing/cancel', { workspaceId });
    expect(cancel.body.data.subscription.cancelAtPeriodEnd).toBe(true);
    const resume = await client.post('/billing/resume', { workspaceId });
    expect(resume.body.data.subscription.cancelAtPeriodEnd).toBe(false);

    const failed = await client.post('/billing/dev/simulate', { workspaceId, event: 'payment_failed' });
    expect(failed.body.data.subscription).toMatchObject({ status: 'PAST_DUE' });
    expect(failed.body.data.subscription.lastPaymentFailedAt).not.toBeNull();
    const recovered = await client.post('/billing/dev/simulate', { workspaceId, event: 'payment_recovered' });
    expect(recovered.body.data.subscription.status).toBe('ACTIVE');
  });

  it('only lets owners change billing', async () => {
    const owner = await registerClient(app);
    await prisma.user.update({ where: { email: owner.email }, data: { emailVerifiedAt: new Date() } });
    await owner.client.post('/billing/checkout', {
      workspaceId: owner.workspaceId,
      planKey: 'GROWTH',
      interval: 'MONTH',
    });
    const admin = await registerClient(app);
    await owner.client.post(`/workspaces/${owner.workspaceId}/invitations`, {
      email: admin.email,
      role: 'ADMIN',
    });
    await admin.client.post('/workspaces/invitations/accept', {
      token: await emailTokenFor(queues, admin.email, 'workspace_invitation'),
    });
    expect((await admin.client.get(`/billing/subscription?workspaceId=${owner.workspaceId}`)).status).toBe(
      200,
    );
    expect(
      (
        await admin.client.post('/billing/checkout', {
          workspaceId: owner.workspaceId,
          planKey: 'AGENCY',
          interval: 'MONTH',
        })
      ).status,
    ).toBe(403);
    const stranger = await registerClient(app);
    expect((await stranger.client.get(`/billing/subscription?workspaceId=${owner.workspaceId}`)).status).toBe(
      404,
    );
  });
});

describe('Stripe webhooks', () => {
  it('rejects invalid or missing signatures and needs no CSRF token', async () => {
    const payload = stripeEvent('customer.subscription.updated', { id: 'sub_x', object: 'subscription' });
    expect((await postStripe(payload, 't=1,v1=deadbeef')).status).toBe(400);
    expect(
      (
        await request(app)
          .post(`${API}/billing/webhooks/stripe`)
          .set('Content-Type', 'application/json')
          .send(payload)
      ).status,
    ).toBe(400);
    const tampered = await postStripe(payload.replace('sub_x', 'sub_y'), stripe.signTestPayload(payload));
    expect(tampered.status).toBe(400);
    expect((await postStripe(payload)).status).toBe(200); // valid signature; unmatched subscription is acknowledged
  });

  it('drives subscription state from verified events, idempotently', async () => {
    const { workspaceId } = await registerClient(app);
    const now = Math.floor(Date.now() / 1000);
    const completed = await postStripe(
      stripeEvent('checkout.session.completed', {
        id: 'cs_1',
        object: 'checkout.session',
        client_reference_id: workspaceId,
        subscription: `sub_${workspaceId}`,
        customer: `cus_${workspaceId}`,
        metadata: { workspaceId },
      }),
    );
    expect(completed.body.data.result).toBe('processed');

    const subscription = (status: string, extra: Record<string, unknown> = {}) => ({
      id: `sub_${workspaceId}`,
      object: 'subscription',
      status,
      customer: `cus_${workspaceId}`,
      cancel_at_period_end: false,
      canceled_at: null,
      metadata: { workspaceId, planKey: 'GROWTH' },
      items: {
        data: [
          {
            id: 'si_1',
            current_period_start: now,
            current_period_end: now + 30 * 86400,
            price: { id: 'price_growth_m', recurring: { interval: 'month' } },
          },
        ],
      },
      ...extra,
    });
    const activeEvent = stripeEvent(
      'customer.subscription.updated',
      subscription('active'),
      `evt_active_${workspaceId}`,
    );
    expect((await postStripe(activeEvent)).body.data.result).toBe('processed');
    let sub = await prisma.subscription.findUniqueOrThrow({
      where: { workspaceId },
      include: { plan: true },
    });
    expect(sub).toMatchObject({
      status: 'ACTIVE',
      provider: 'STRIPE',
      providerSubscriptionId: `sub_${workspaceId}`,
      interval: 'MONTH',
    });
    expect(sub.plan.key).toBe('GROWTH');
    expect(sub.currentPeriodEnd?.getTime()).toBe((now + 30 * 86400) * 1000);

    // Duplicate delivery is acknowledged but not re-applied.
    const duplicate = await postStripe(activeEvent);
    expect(duplicate.body.data.result).toBe('duplicate');
    expect(await prisma.webhookEvent.count({ where: { eventId: `evt_active_${workspaceId}` } })).toBe(1);

    const invoice = (status: string, amount: number) => ({
      id: `in_${workspaceId}`,
      object: 'invoice',
      status,
      amount_due: amount,
      amount_paid: status === 'paid' ? amount : 0,
      currency: 'usd',
      customer: `cus_${workspaceId}`,
      hosted_invoice_url: 'https://invoice.stripe.com/i/test',
      period_start: now,
      period_end: now + 30 * 86400,
      status_transitions: { paid_at: status === 'paid' ? now : null },
      parent: {
        type: 'subscription_details',
        subscription_details: { subscription: `sub_${workspaceId}`, metadata: { workspaceId } },
      },
    });
    await postStripe(stripeEvent('invoice.payment_failed', invoice('open', 14900)));
    sub = await prisma.subscription.findUniqueOrThrow({ where: { workspaceId }, include: { plan: true } });
    expect(sub.status).toBe('PAST_DUE');
    expect(sub.lastPaymentFailedAt).not.toBeNull();
    expect(await prisma.notification.count({ where: { workspaceId, type: 'billing' } })).toBeGreaterThan(0);

    await postStripe(stripeEvent('invoice.paid', invoice('paid', 14900)));
    sub = await prisma.subscription.findUniqueOrThrow({ where: { workspaceId }, include: { plan: true } });
    expect(sub.status).toBe('ACTIVE');
    const invoices = await prisma.billingInvoice.findMany({ where: { workspaceId } });
    expect(invoices).toHaveLength(1); // same provider invoice id is upserted, never duplicated
    expect(invoices[0]).toMatchObject({ status: 'PAID', currency: 'USD' });
    expect(invoices[0]!.amount.toString()).toBe('149');

    await postStripe(
      stripeEvent('customer.subscription.deleted', subscription('canceled', { canceled_at: now })),
    );
    expect((await prisma.subscription.findUniqueOrThrow({ where: { workspaceId } })).status).toBe('CANCELED');
    expect((await getWorkspacePlan(prisma, workspaceId)).plan.key).toBe('FREE');
  });
});

describe('Razorpay webhooks', () => {
  it('verifies the HMAC signature and activates the subscription', async () => {
    const { workspaceId } = await registerClient(app);
    const body = JSON.stringify({
      event: 'subscription.activated',
      created_at: Math.floor(Date.now() / 1000),
      payload: {
        subscription: {
          entity: {
            id: `rzp_sub_${workspaceId}`,
            plan_id: 'plan_x',
            status: 'active',
            current_start: 1_790_000_000,
            current_end: 1_792_600_000,
            notes: { workspaceId, planKey: 'STARTER', interval: 'MONTH' },
          },
        },
      },
    });
    const sign = (payload: string) =>
      createHmac('sha256', 'rzp_webhook_secret').update(payload).digest('hex');
    const send = (payload: string, signature: string, eventId: string) =>
      request(app)
        .post(`${API}/billing/webhooks/razorpay`)
        .set('Content-Type', 'application/json')
        .set('X-Razorpay-Signature', signature)
        .set('X-Razorpay-Event-Id', eventId)
        .send(payload);

    expect((await send(body, 'invalid', 'evt_rzp_bad')).status).toBe(400);
    const ok = await send(body, sign(body), `evt_rzp_${workspaceId}`);
    expect(ok.status).toBe(200);
    expect(ok.body.data.result).toBe('processed');
    const sub = await prisma.subscription.findUniqueOrThrow({
      where: { workspaceId },
      include: { plan: true },
    });
    expect(sub).toMatchObject({
      status: 'ACTIVE',
      provider: 'RAZORPAY',
      providerSubscriptionId: `rzp_sub_${workspaceId}`,
    });
    expect(sub.plan.key).toBe('STARTER');
    expect((await send(body, sign(body), `evt_rzp_${workspaceId}`)).body.data.result).toBe('duplicate');
  });
});
