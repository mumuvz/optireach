import { syncMerchantCenter } from '@surfaced/core/commerce';
import { encryptSecret } from '@surfaced/core/crypto';
import { disconnectPrisma, getPrisma } from '@surfaced/core/db';
import type { HttpFetch } from '@surfaced/core/integrations';
import { getLogger } from '@surfaced/core/logger';
import { MemoryQueueGateway } from '@surfaced/core/queue';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { registerClient } from './helpers';

const prisma = getPrisma();
afterAll(async () => {
  await disconnectPrisma();
});

/** Merchant API stand-in: read-only responses; any write would be answered 405 and fail the test. */
const calls: { url: string; method: string }[] = [];
const google = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  const method = init?.method ?? 'GET';
  calls.push({ url, method });
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }); // prettier-ignore
  if (method !== 'GET') return json({ error: { code: 405, message: 'Read-only test' } }, 405);
  const path = url.replace('https://merchantapi.googleapis.com', '');
  if (path.startsWith('/accounts/v1/accounts?')) return json({ accounts: [{ name: 'accounts/777', accountId: '777', accountName: 'Navkar Jewellers' }] }); // prettier-ignore
  if (path === '/accounts/v1/accounts/777')
    return json({ name: 'accounts/777', accountName: 'Navkar Jewellers' });
  if (path === '/accounts/v1/accounts/777/homepage')
    return json({ uri: 'https://navkar.example.in', claimed: false });
  if (path.startsWith('/accounts/v1/accounts/777/issues')) return json({ accountIssues: [] });
  if (path === '/accounts/v1/accounts/777/programs/free-listings') return json({ state: 'ELIGIBLE', activeRegionCodes: [] }); // prettier-ignore
  if (path === '/accounts/v1/accounts/777/shippingSettings') return json({ services: [{}] });
  if (path === '/accounts/v1/accounts/777/onlineReturnPolicies') return json({ onlineReturnPolicies: [{}] });
  if (path.startsWith('/products/v1/accounts/777/products'))
    return json({ products: [{ name: 'accounts/777/products/en~IN~MC-1', offerId: 'MC-1', contentLanguage: 'en', feedLabel: 'IN', productAttributes: { title: 'Navkar Gold Chain', availability: 'IN_STOCK', price: { amountMicros: '45000000000', currencyCode: 'INR' } } }] }); // prettier-ignore
  return json({ error: { code: 404, message: `Unexpected ${url}` } }, 404);
}) as HttpFetch;

const { app } = createApp({ prisma, queues: new MemoryQueueGateway(), redis: null, logger: getLogger('api-test'), rateLimitMultiplier: 100, httpFetch: google }); // prettier-ignore

const HEADER =
  'id,title,description,link,image_link,price,availability,brand,identifier_exists,google_product_category,color,gender,age_group,material';
const row = (i: number, extra = '') =>
  `R-${i},Navkar Gold Ring ${i},A 22k gold ring with a rope pattern and hallmark,https://navkar.example.in/p/r-${i},https://navkar.example.in/i/r-${i}.jpg,${15000 + i}.00 INR,in_stock,Navkar,no,188,yellow,female,adult,22k gold${extra}`;

async function setup(plan: 'FREE' | 'GROWTH', websiteUrl: string | null = 'https://navkar.example.in') {
  const owner = await registerClient(app);
  if (plan !== 'FREE')
    expect((await owner.client.post('/billing/checkout', { workspaceId: owner.workspaceId, planKey: plan, interval: 'MONTH' })).status).toBe(200); // prettier-ignore
  const res = await owner.client.post('/projects', {
    workspaceId: owner.workspaceId,
    name: 'Navkar Jewellers',
    websiteUrl,
    targetCountries: ['IN'],
    targetLanguages: ['en'],
    businessProfile: { types: ['RETAIL_STORE', 'MERCHANT_SELLER'], hasMerchantCenter: true },
  });
  expect(res.status).toBe(201);
  return { ...owner, projectId: res.body.data.id as string };
}

describe('product feeds', () => {
  it('previews on any plan, imports on plans with ecommerce, and refuses clients', async () => {
    const free = await setup('FREE');
    const content = [HEADER, row(1), row(2)].join('\n');
    const preview = await free.client.post(`/projects/${free.projectId}/merchant/import/preview`, { fileName: 'feed.csv', content, country: 'IN', language: 'en' }); // prettier-ignore
    expect(preview.status).toBe(200);
    expect(preview.body.data).toMatchObject({ format: 'GOOGLE_CSV', products: 2, summary: { errors: 0 } });
    const blocked = await free.client.post(`/projects/${free.projectId}/merchant/import`, { fileName: 'feed.csv', content, country: 'IN', language: 'en' }); // prettier-ignore
    expect(blocked.status).toBe(402);

    const shop = await setup('GROWTH');
    const client = await registerClient(app);
    await prisma.workspaceMember.create({ data: { workspaceId: shop.workspaceId, userId: client.me.user.id, role: 'CLIENT' } }); // prettier-ignore
    expect((await client.client.post(`/projects/${shop.projectId}/merchant/import`, { fileName: 'feed.csv', content, country: 'IN', language: 'en' })).status).toBe(403); // prettier-ignore
    expect((await client.client.get(`/projects/${shop.projectId}/merchant`)).status).toBe(200);
  });

  it('imports a feed larger than the normal 1 MB request limit and lists products by status', async () => {
    const { client, projectId } = await setup('GROWTH');
    const rows = Array.from({ length: 4900 }, (_, i) => row(i + 1));
    rows[1] = rows[1]!.replace('15002.00 INR', '15002.00 USD');
    const content = [HEADER, ...rows].join('\n');
    expect(content.length).toBeGreaterThan(1_000_000);
    const res = await client.post(`/projects/${projectId}/merchant/import`, { fileName: 'catalog.csv', content, country: 'IN', language: 'en' }); // prettier-ignore
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ imported: 4900, updated: 0, skipped: 0, limitedByPlan: false });

    const errors = await client.get(`/projects/${projectId}/merchant/products?filter=errors`);
    expect(errors.body.meta).toMatchObject({ total: 1 });
    expect(errors.body.data[0]).toMatchObject({ offerId: 'R-2', status: 'errors' });
    expect(errors.body.data[0].issues.map((i: { code: string }) => i.code)).toContain('currency_mismatch');
    const search = await client.get(`/projects/${projectId}/merchant/products?q=Ring%2012&pageSize=5`);
    expect(search.body.data.map((p: { offerId: string }) => p.offerId)).toEqual(
      expect.arrayContaining(['R-12']),
    );
    const detail = await client.get(`/projects/${projectId}/merchant/products/${errors.body.data[0].id}`);
    expect(detail.body.data.price).toEqual({ amount: 15002, currency: 'USD' });

    const status = (await client.get(`/projects/${projectId}/merchant`)).body.data;
    expect(status.products).toMatchObject({ total: 4900, errors: 1, bySource: { FEED_IMPORT: 4900 } });
    expect(status.plan).toMatchObject({ ecommerce: true, productsTracked: 5000, productsUsed: 4900 });
    expect(status.checklist.find((i: { key: string }) => i.key === 'products').status).toBe('done');
    expect(status.checklist.find((i: { key: string }) => i.key === 'website').status).toBe('unknown');

    const overview = (await client.get(`/projects/${projectId}/local/overview`)).body.data;
    const health = overview.cards.find((c: { key: string }) => c.key === 'product_health');
    expect(health).toMatchObject({ state: 'ok', value: '4,899 of 4,900 pass all checks' });

    // Another workspace sees nothing.
    const stranger = await registerClient(app);
    expect((await stranger.client.get(`/projects/${projectId}/merchant/products`)).status).toBe(404);
    expect((await client.delete(`/projects/${projectId}/merchant/feed-products`)).body.data).toEqual({
      removed: 4900,
    });
  });

  it('stops at the plan limit and says so', async () => {
    const { client, projectId, workspaceId } = await setup('GROWTH');
    await prisma.merchantProduct.createMany({
      data: Array.from({ length: 4999 }, (_, i) => ({ projectId, source: 'MERCHANT_API', offerId: `X-${i}`, contentLanguage: 'en', feedLabel: 'IN', data: {}, issues: [], status: 'ok', lastSeenAt: new Date() })), // prettier-ignore
    });
    const res = await client.post(`/projects/${projectId}/merchant/import`, { fileName: 'feed.csv', content: [HEADER, row(1), row(2), row(3)].join('\n'), country: 'IN', language: 'en' }); // prettier-ignore
    expect(res.body.data).toMatchObject({ imported: 1, skipped: 2, limitedByPlan: true });
    const usage = (await client.get(`/usage?workspaceId=${workspaceId}`)).body.data;
    expect(usage.counts.find((c: { kind: string }) => c.kind === 'productsTracked')).toMatchObject({ used: 5000, limit: 5000 }); // prettier-ignore
  });
});

describe('Merchant Center connection', () => {
  it('chooses an account, syncs read-only, and builds the checklist from Google’s answers', async () => {
    const { client, projectId, workspaceId } = await setup('GROWTH');
    const integration = await prisma.integration.create({
      data: { workspaceId, projectId, provider: 'GOOGLE_MERCHANT_CENTER', status: 'CONNECTED', token: { create: { accessTokenEnc: encryptSecret('ya29.mc'), expiresAt: new Date(Date.now() + 3600_000) } } }, // prettier-ignore
    });
    expect((await client.post(`/projects/${projectId}/merchant/sync`)).status).toBe(400);
    const accounts = (await client.get(`/projects/${projectId}/merchant/accounts`)).body.data;
    expect(accounts).toEqual([{ accountId: '777', accountName: 'Navkar Jewellers', homepageUri: null }]);
    expect((await client.put(`/projects/${projectId}/merchant/account`, { accountId: '999' })).status).toBe(
      400,
    );
    const chosen = await client.put(`/projects/${projectId}/merchant/account`, { accountId: '777' });
    expect(chosen.status).toBe(202);
    expect(chosen.body.data.jobId).toBeTruthy();

    await syncMerchantCenter(prisma, integration.id, google);
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
    const status = (await client.get(`/projects/${projectId}/merchant`)).body.data;
    expect(status.integration).toMatchObject({ accountId: '777', accountName: 'Navkar Jewellers', lastSyncStatus: 'SUCCEEDED' }); // prettier-ignore
    const item = (key: string) => status.checklist.find((i: { key: string }) => i.key === key);
    expect(item('account').status).toBe('done');
    expect(item('website')).toMatchObject({ status: 'todo', detail: expect.stringMatching(/not claimed/) });
    expect(item('free_listings')).toMatchObject({ status: 'todo', detail: expect.stringMatching(/Eligible but not turned on/) }); // prettier-ignore
    expect(item('shipping_returns').status).toBe('done');
    expect(status.products).toMatchObject({ total: 1, bySource: { MERCHANT_API: 1 } });
    const overview = (await client.get(`/projects/${projectId}/local/overview`)).body.data;
    expect(overview.cards.find((c: { key: string }) => c.key === 'merchant')).toMatchObject({ state: 'ok', value: 'Free listings eligible, not on' }); // prettier-ignore
  });

  it('gives a business without a website the local listings path', async () => {
    const { client, projectId } = await setup('GROWTH', null);
    const status = (await client.get(`/projects/${projectId}/merchant`)).body.data;
    expect(status.hasWebsite).toBe(false);
    expect(status.checklist.find((i: { key: string }) => i.key === 'website')).toMatchObject({
      status: 'not_applicable',
    });
    const preview = await client.post(`/projects/${projectId}/merchant/import/preview`, { fileName: 'f.csv', content: 'id,title,price\nA,Ring,999 INR\n', country: 'IN', language: 'en' }); // prettier-ignore
    const missingLink = preview.body.data.sample[0].issues.find(
      (i: { code: string }) => i.code === 'missing_link',
    );
    expect(missingLink.programs).toEqual(['FREE_LISTINGS', 'SHOPPING_ADS']);
  });
});
