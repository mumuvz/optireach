import { DEFAULT_CRAWL_SETTINGS, type ProductData } from '@surfaced/shared';
import { afterAll, describe, expect, it } from 'vitest';
import {
  importProductFeed,
  isValidGtin,
  merchantChecklist,
  parseDelimited,
  parsePrice,
  parseProductFeed,
  productSummary,
  syncMerchantCenter,
  validateProduct,
} from '../src/commerce';
import { encryptSecret, randomToken } from '../src/crypto';
import { disconnectPrisma, getPrisma } from '../src/db';
import type { HttpFetch } from '../src/integrations';

const prisma = getPrisma();
afterAll(async () => {
  await disconnectPrisma();
});

const GOOGLE_FEED = [
  'id,title,description,link,image_link,price,availability,brand,gtin,google_product_category,color,gender,age_group,material,product_detail',
  'R-101,Navkar 22k Gold Ring,"A 22k gold ring with a ""rope"" pattern.',
  'Hallmarked.",https://navkar.example.in/p/r-101,https://navkar.example.in/i/r-101.jpg,"18,500.00 INR",in stock,Navkar,,188,yellow,female,adult,22k gold,Gemstone:Stone:None',
  'R-102,BEST PRICE REPLICA CARTIER RING,Copy,https://other.example.com/r,https://navkar.example.in/i/r-102.jpg,1500 USD,in_stock,,12345678,Apparel & Accessories > Jewelry > Rings,,,,,',
  'R-101,Duplicate,,,,,,,,,,,,,',
].join('\n');

describe('feed parsing', () => {
  it('reads quoted fields with line breaks and doubled quotes, and skips duplicate ids', () => {
    expect(parseDelimited('a,"b,1","c ""q""\nline"\r\n2,3,4\n', ',')).toEqual([['a', 'b,1', 'c "q"\nline'], ['2', '3', '4']]); // prettier-ignore
    const feed = parseProductFeed(GOOGLE_FEED, { country: 'IN', websiteUrl: 'https://navkar.example.in/' });
    expect(feed.format).toBe('GOOGLE_CSV');
    expect(feed.products).toHaveLength(2);
    expect(feed.products[0]).toMatchObject({
      offerId: 'R-101',
      description: 'A 22k gold ring with a "rope" pattern.\nHallmarked.',
      price: { amount: 18500, currency: 'INR' },
      availability: 'in_stock',
      gender: 'female',
      productDetails: [{ section: 'Gemstone', name: 'Stone', value: 'None' }],
    });
    // Rows are records: the quoted line break does not count as a new row.
    expect(feed.rowErrors).toEqual([{ row: 4, message: expect.stringMatching(/Duplicate id "R-101" \(first on row 2\)/) }]); // prettier-ignore
  });

  it('parses prices with symbols and decimal commas, and labels an assumed currency', () => {
    expect(parsePrice('₹1,499', null)).toEqual({
      money: { amount: 1499, currency: 'INR' },
      assumedCurrency: false,
    });
    expect(parsePrice('1.299,50 EUR', null).money).toEqual({ amount: 1299.5, currency: 'EUR' });
    expect(parsePrice('999', 'INR')).toEqual({
      money: { amount: 999, currency: 'INR' },
      assumedCurrency: true,
    });
    const tsv = parseProductFeed('id\ttitle\tprice\nA1\tRing\t999\n', { country: 'IN', websiteUrl: null });
    expect(tsv.format).toBe('GOOGLE_TSV');
    expect(tsv.limitations[0]).toMatch(/1 price has no currency .* INR .* assumed/);
  });

  it('reads a Shopify export: variants inherit the product fields, compare-at price becomes the regular price', () => {
    const shopify = [
      'Handle,Title,Body (HTML),Vendor,Type,Option1 Name,Option1 Value,Variant SKU,Variant Price,Variant Compare At Price,Variant Inventory Qty,Variant Barcode,Image Src,Status',
      'gold-ring,Gold Ring,<p>22k <b>gold</b> ring</p>,Navkar,Rings,Size,12,GR-12,15000,18000,3,,https://cdn.example/r.jpg,active',
      'gold-ring,,,,,,14,GR-14,15000,,0,,,',
      'old-ring,Old Ring,,Navkar,Rings,Title,Default Title,OR-1,100,,1,,,archived',
    ].join('\n');
    const feed = parseProductFeed(shopify, { country: 'IN', websiteUrl: 'https://navkar.example.in' });
    expect(feed.format).toBe('SHOPIFY_CSV');
    expect(feed.products.map((p) => p.offerId)).toEqual(['GR-12', 'GR-14']);
    expect(feed.products[0]).toMatchObject({ title: 'Gold Ring', description: '22k gold ring', brand: 'Navkar', size: '12', itemGroupId: 'gold-ring', price: { amount: 18000 }, salePrice: { amount: 15000 }, availability: 'in_stock', link: 'https://navkar.example.in/products/gold-ring' }); // prettier-ignore
    expect(feed.products[1]).toMatchObject({
      title: 'Gold Ring',
      availability: 'out_of_stock',
      imageLink: 'https://cdn.example/r.jpg',
    });
  });

  it('explains a file without an id column', () => {
    const feed = parseProductFeed('name,cost\nRing,10\n', { country: 'IN', websiteUrl: null });
    expect(feed.products).toHaveLength(0);
    expect(feed.rowErrors[0]!.message).toMatch(/no "id" column/);
  });
});

describe('product checks', () => {
  const base = (over: Partial<ProductData>): ProductData => ({
    ...parseProductFeed(GOOGLE_FEED, { country: 'IN', websiteUrl: null }).products[0]!,
    ...over,
  });
  const codes = (p: ProductData, country = 'IN', websiteDomain: string | null = 'navkar.example.in') =>
    validateProduct(p, { country, websiteDomain }).map((i) => `${i.severity}:${i.code}`);

  it('passes a complete jewellery product', () => {
    // A store's own design has no GTIN or MPN: identifier_exists is no.
    expect(codes(base({ identifierExists: false })).filter((c) => !c.startsWith('suggestion'))).toEqual([]);
  });

  it('checks the GTIN check digit', () => {
    expect(isValidGtin('4006381333931')).toBe(true);
    expect(isValidGtin('4006381333932')).toBe(false);
    expect(isValidGtin('12345678')).toBe(false);
  });

  it('flags counterfeit wording, currency, landing page domain, promotional caps and invalid GTINs', () => {
    const bad = parseProductFeed(GOOGLE_FEED, { country: 'IN', websiteUrl: null }).products[1]!;
    const found = codes(bad);
    expect(found).toEqual(expect.arrayContaining(['error:counterfeit_wording', 'error:currency_mismatch', 'warning:link_other_domain', 'warning:title_promotional', 'warning:title_all_caps', 'error:invalid_gtin', 'warning:missing_brand'])); // prettier-ignore
  });

  it('applies the apparel rules by country', () => {
    const ring = base({ color: null, gender: null, ageGroup: null });
    const inIndia = validateProduct(ring, { country: 'IN', websiteDomain: null }).find((i) => i.code === 'apparel_attributes')!; // prettier-ignore
    expect(inIndia).toMatchObject({ severity: 'suggestion' });
    const ringUs = { ...ring, price: { amount: 200, currency: 'USD' } };
    const inUs = validateProduct(ringUs, { country: 'US', websiteDomain: null }).find((i) => i.code === 'apparel_attributes')!; // prettier-ignore
    expect(inUs).toMatchObject({
      severity: 'error',
      countries: ['US'],
      message: 'Apparel without color, gender, age_group.',
    });
  });

  it('without a website, a missing link blocks online listings only', () => {
    const issue = validateProduct(base({ link: null }), { country: 'IN', websiteDomain: null }).find((i) => i.code === 'missing_link')!; // prettier-ignore
    expect(issue.programs).toEqual(['FREE_LISTINGS', 'SHOPPING_ADS']);
    expect(issue.fix).toMatch(/free local listings/);
  });
});

describe('checklist', () => {
  const products = { total: 0, errors: 0, warnings: 0, ok: 0, bySource: {}, blockedByProgram: { FREE_LISTINGS: 0, SHOPPING_ADS: 0, FREE_LOCAL_LISTINGS: 0 }, topIssues: [] }; // prettier-ignore
  it('gives a merchant without a website the local path instead of a failing website item', () => {
    const items = merchantChecklist({ hasWebsite: false, websiteDomain: null, saysHasMerchantCenter: false, connected: false, accountChosen: false, account: null, products, productSchemaPages: null, businessProfileLinked: false }); // prettier-ignore
    const website = items.find((i) => i.key === 'website')!;
    expect(website.status).toBe('not_applicable');
    expect(website.detail).toMatch(/free local listings/);
    expect(items.find((i) => i.key === 'structured_data')).toBeUndefined();
    expect(items.find((i) => i.key === 'free_listings')!.status).toBe('unknown');
  });
});

async function setupProject() {
  const workspace = await prisma.workspace.create({
    data: { name: 'Shop WS', slug: `shop-${randomToken(6).toLowerCase()}` },
  });
  const growth = await prisma.subscriptionPlan.findFirst({ where: { key: 'GROWTH' } });
  if (growth)
    await prisma.subscription.create({
      data: { workspaceId: workspace.id, planId: growth.id, status: 'ACTIVE', provider: 'DEV', interval: 'MONTH', currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000) }, // prettier-ignore
    });
  const project = await prisma.project.create({
    data: { workspaceId: workspace.id, name: 'Navkar', websiteUrl: 'https://navkar.example.in/', domain: 'navkar.example.in', targetCountries: ['IN'], targetLanguages: ['en'], crawlSettings: DEFAULT_CRAWL_SETTINGS }, // prettier-ignore
  });
  return { workspace, project };
}

describe('feed import', () => {
  it('replaces or merges the catalog for a country and language', async () => {
    const { workspace, project } = await setupProject();
    const params = { projectId: project.id, workspaceId: workspace.id, userId: 'u', fileName: 'feed.csv', country: 'IN', language: 'en', project }; // prettier-ignore
    const first = await importProductFeed(prisma, { ...params, content: GOOGLE_FEED, mode: 'replace' });
    expect(first).toMatchObject({ imported: 2, updated: 0, removed: 0, skipped: 0 });
    const summary = await productSummary(prisma, project.id);
    expect(summary).toMatchObject({ total: 2, errors: 1 });
    expect(summary.blockedByProgram.FREE_LISTINGS).toBe(1);
    expect(summary.topIssues[0]!.severity).toBe('error');

    const one =
      'id,title,description,link,image_link,price,availability,brand\nR-103,Ring,A ring,https://navkar.example.in/p/r-103,https://navkar.example.in/i.jpg,999 INR,in_stock,Navkar\n';
    const merged = await importProductFeed(prisma, { ...params, content: one, mode: 'merge' });
    expect(merged).toMatchObject({ imported: 1, updated: 0, removed: 0 });
    expect(await prisma.merchantProduct.count({ where: { projectId: project.id } })).toBe(3);
    const replaced = await importProductFeed(prisma, { ...params, content: one, mode: 'replace' });
    expect(replaced).toMatchObject({ imported: 0, updated: 1, removed: 2 });
    expect(await prisma.merchantProduct.count({ where: { projectId: project.id } })).toBe(1);
    expect(await prisma.productFeedImport.count({ where: { projectId: project.id } })).toBe(3);
  });
});

describe('Merchant Center sync', () => {
  it('reads the account and products with Google’s statuses, read-only, and removes products deleted in Merchant Center', async () => {
    const { workspace, project } = await setupProject();
    const integration = await prisma.integration.create({
      data: { workspaceId: workspace.id, projectId: project.id, provider: 'GOOGLE_MERCHANT_CENTER', status: 'CONNECTED', config: { accountId: '555' }, token: { create: { accessTokenEnc: encryptSecret('ya29.mc'), expiresAt: new Date(Date.now() + 3600_000) } } }, // prettier-ignore
    });
    let pass = 0;
    const calls: { url: string; method: string }[] = [];
    const product = (offerId: string, extra: Record<string, unknown> = {}) => ({
      name: `accounts/555/products/en~IN~${offerId}`,
      offerId,
      contentLanguage: 'en',
      feedLabel: 'IN',
      productAttributes: { title: `Navkar ring ${offerId}`, description: 'A gold ring', link: `https://navkar.example.in/p/${offerId}`, imageLink: 'https://navkar.example.in/i.jpg', additionalImageLinks: ['https://navkar.example.in/i2.jpg'], price: { amountMicros: '18500000000', currencyCode: 'INR' }, availability: 'IN_STOCK', condition: 'NEW', brand: 'Navkar', identifierExists: false, googleProductCategory: '188', color: 'yellow', gender: 'FEMALE', ageGroup: 'ADULT', material: '22k gold' }, // prettier-ignore
      ...extra,
    });
    const google = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? 'GET' });
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }); // prettier-ignore
      const path = url.replace('https://merchantapi.googleapis.com', '');
      if (path === '/accounts/v1/accounts/555')
        return json({ name: 'accounts/555', accountName: 'Navkar Jewellers' });
      if (path === '/accounts/v1/accounts/555/homepage')
        return json({ uri: 'https://navkar.example.in', claimed: true });
      if (path.startsWith('/accounts/v1/accounts/555/issues')) return json({ accountIssues: [{ title: 'Missing return policy', severity: 'ERROR' }] }); // prettier-ignore
      if (path === '/accounts/v1/accounts/555/programs/free-listings') return json({ state: 'ENABLED', activeRegionCodes: ['IN'] }); // prettier-ignore
      if (path === '/accounts/v1/accounts/555/shippingSettings') return json({ error: { code: 404, status: 'NOT_FOUND', message: 'none' } }, 404); // prettier-ignore
      if (path === '/accounts/v1/accounts/555/onlineReturnPolicies') return json({});
      if (path.startsWith('/products/v1/accounts/555/products')) {
        if (pass === 0 && !url.includes('pageToken'))
          return json({
            products: [product('R-1', { productStatus: { destinationStatuses: [{ reportingContext: 'FREE_LISTINGS', approvedCountries: ['IN'] }] } }), product('R-2', { productStatus: { itemLevelIssues: [{ code: 'image_too_small', severity: 'DISAPPROVED', reportingContext: 'FREE_LISTINGS', description: 'Image too small', resolution: 'merchant_action', applicableCountries: ['IN'] }] } })], // prettier-ignore
            nextPageToken: 'p2',
          });
        if (pass === 0) return json({ products: [product('R-3')] });
        return json({ products: [product('R-1')] });
      }
      return json({ error: { code: 404, message: `Unexpected ${url}` } }, 404);
    }) as HttpFetch;

    const first = await syncMerchantCenter(prisma, integration.id, google);
    expect(first).toMatchObject({ products: 3, removed: 0, limitedByPlan: false });
    expect(first.account).toMatchObject({ accountName: 'Navkar Jewellers', homepage: { claimed: true }, freeListings: { state: 'ENABLED', regions: ['IN'] }, shippingServices: 0, returnPolicies: 0 }); // prettier-ignore
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
    const r2 = await prisma.merchantProduct.findFirstOrThrow({
      where: { projectId: project.id, offerId: 'R-2' },
    });
    expect(r2).toMatchObject({ status: 'errors', source: 'MERCHANT_API' });
    expect(r2.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'google:image_too_small', source: 'GOOGLE', severity: 'error', programs: ['FREE_LISTINGS'] })])); // prettier-ignore
    const r1 = await prisma.merchantProduct.findFirstOrThrow({
      where: { projectId: project.id, offerId: 'R-1' },
    });
    expect(r1.data).toMatchObject({ price: { amount: 18500, currency: 'INR' }, availability: 'in_stock', gender: 'female', ageGroup: 'adult', condition: 'new' }); // prettier-ignore
    expect(r1.googleStatus).toEqual([{ context: 'FREE_LISTINGS', approvedCountries: ['IN'], pendingCountries: [], disapprovedCountries: [] }]); // prettier-ignore

    pass = 1;
    const second = await syncMerchantCenter(prisma, integration.id, google);
    expect(second).toMatchObject({ products: 1, removed: 2 });
    const config = (await prisma.integration.findUniqueOrThrow({ where: { id: integration.id } })).config as { accountId: string; account: { issues: unknown[] } }; // prettier-ignore
    expect(config.accountId).toBe('555');
    expect(config.account.issues).toHaveLength(1);
  });
});
