// Google Merchant API v1 (docs/providers/google-merchant-center.md): accounts, homepage, account issues, the free
// listings program, shipping and return policies, and products with their statuses and item issues. Read-only:
// Surfaced does not change Merchant Center data. Products are the merchant's own data and are kept like a feed.
import type {
  MerchantAccountDto,
  ProductData,
  ProductGoogleStatus,
  ProductIssue,
  ProductProgram,
} from '@surfaced/shared';
import type { Prisma, PrismaClient } from '../db';
import { Errors } from '../errors';
import { googleApiRequest, type HttpFetch } from '../integrations/google';
import { getWorkspacePlan } from '../billing';
import { countProductsForLimit } from '../usage';
import { summarizeIssues, validateProduct } from './validate';

const API = 'https://merchantapi.googleapis.com';
const SERVICE = 'Google Merchant Center';
const MAX_PAGES = 60;

function merchantRequest<T>(
  prisma: PrismaClient,
  integrationId: string,
  path: string,
  httpFetch: HttpFetch,
): Promise<T> {
  return googleApiRequest<T>(prisma, integrationId, `${API}${path}`, { method: 'GET' }, httpFetch, SERVICE);
}

export async function listMerchantAccounts(
  prisma: PrismaClient,
  integrationId: string,
  httpFetch: HttpFetch = fetch,
): Promise<MerchantAccountDto[]> {
  const out: MerchantAccountDto[] = [];
  let token: string | null = null;
  for (let page = 0; page < 10; page++) {
    const data: { accounts?: { accountId?: string; name: string; accountName?: string; homePageUri?: string }[]; nextPageToken?: string } =
      await merchantRequest(prisma, integrationId, `/accounts/v1/accounts?pageSize=500${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`, httpFetch); // prettier-ignore
    for (const a of data.accounts ?? [])
      out.push({
        accountId: a.accountId ?? a.name.replace(/^accounts\//, ''),
        accountName: a.accountName ?? a.name,
        homepageUri: a.homePageUri ?? null,
      });
    if (!data.nextPageToken) break;
    token = data.nextPageToken;
  }
  return out;
}

export interface MerchantAccountSnapshot {
  accountId: string;
  accountName: string | null;
  homepage: { uri: string | null; claimed: boolean | null } | null;
  freeListings: { state: string; regions: string[]; unmetRequirements: string[] } | null;
  issues: { title: string; severity: string; detail: string | null; documentation: string | null }[];
  shippingServices: number | null;
  returnPolicies: number | null;
  syncedAt: string;
}

/** A request whose 404 means "not set up" rather than an error. */
async function optional<T>(call: () => Promise<T>): Promise<T | null> {
  try {
    return await call();
  } catch (error) {
    if ((error as { httpStatus?: number }).httpStatus === 404) return null;
    throw error;
  }
}

export async function fetchMerchantAccountSnapshot(
  prisma: PrismaClient,
  integrationId: string,
  accountId: string,
  httpFetch: HttpFetch = fetch,
): Promise<MerchantAccountSnapshot> {
  const base = `/accounts/v1/accounts/${accountId}`;
  const [account, homepage, issues, program, shipping, returns] = await Promise.all([
    merchantRequest<{ accountName?: string }>(prisma, integrationId, base, httpFetch),
    optional(() =>
      merchantRequest<{ uri?: string; claimed?: boolean }>(
        prisma,
        integrationId,
        `${base}/homepage`,
        httpFetch,
      ),
    ),
    merchantRequest<{ accountIssues?: { title?: string; severity?: string; detail?: string; documentationUri?: string }[] }>(prisma, integrationId, `${base}/issues?pageSize=100&languageCode=en-US`, httpFetch), // prettier-ignore
    optional(() => merchantRequest<{ state?: string; activeRegionCodes?: string[]; unmetRequirements?: { title?: string }[] }>(prisma, integrationId, `${base}/programs/free-listings`, httpFetch)), // prettier-ignore
    optional(() =>
      merchantRequest<{ services?: unknown[] }>(prisma, integrationId, `${base}/shippingSettings`, httpFetch),
    ),
    optional(() => merchantRequest<{ onlineReturnPolicies?: unknown[] }>(prisma, integrationId, `${base}/onlineReturnPolicies`, httpFetch)), // prettier-ignore
  ]);
  return {
    accountId,
    accountName: account.accountName ?? null,
    homepage: homepage ? { uri: homepage.uri ?? null, claimed: typeof homepage.claimed === 'boolean' ? homepage.claimed : null } : null, // prettier-ignore
    freeListings: program
      ? {
          state: program.state ?? 'STATE_UNSPECIFIED',
          regions: program.activeRegionCodes ?? [],
          unmetRequirements: (program.unmetRequirements ?? []).map((r) => r.title ?? '').filter(Boolean),
        }
      : null,
    issues: (issues.accountIssues ?? []).slice(0, 50).map((i) => ({
      title: i.title ?? 'Account issue',
      severity: i.severity ?? 'SEVERITY_UNSPECIFIED',
      detail: i.detail ?? null,
      documentation: i.documentationUri ?? null,
    })),
    shippingServices: shipping ? (shipping.services?.length ?? 0) : 0,
    returnPolicies: returns ? (returns.onlineReturnPolicies?.length ?? 0) : 0,
    syncedAt: new Date().toISOString(),
  };
}

// ---------------- Products ----------------

interface ApiPrice {
  amountMicros?: string;
  currencyCode?: string;
}
export interface ApiProduct {
  name: string;
  offerId: string;
  contentLanguage: string;
  feedLabel: string;
  productAttributes?: {
    title?: string;
    description?: string;
    link?: string;
    imageLink?: string;
    additionalImageLinks?: string[];
    price?: ApiPrice;
    salePrice?: ApiPrice;
    availability?: string;
    condition?: string;
    brand?: string;
    gtins?: string[];
    mpn?: string;
    identifierExists?: boolean;
    googleProductCategory?: string;
    productTypes?: string[];
    itemGroupId?: string;
    color?: string;
    material?: string;
    pattern?: string;
    size?: string;
    gender?: string;
    ageGroup?: string;
    productDetails?: { sectionName?: string; attributeName?: string; attributeValue?: string }[];
  };
  productStatus?: {
    destinationStatuses?: { reportingContext?: string; approvedCountries?: string[]; pendingCountries?: string[]; disapprovedCountries?: string[] }[]; // prettier-ignore
    itemLevelIssues?: { code?: string; severity?: string; resolution?: string; attribute?: string; reportingContext?: string; description?: string; detail?: string; documentation?: string; applicableCountries?: string[] }[]; // prettier-ignore
  };
}

const money = (p: ApiPrice | undefined) =>
  p?.amountMicros && p.currencyCode
    ? { amount: Math.round(Number(p.amountMicros) / 10_000) / 100, currency: p.currencyCode }
    : null;
/** Merchant API enums (IN_STOCK, NEW, MALE) to the feed values used everywhere else (in_stock, new, male). */
const lower = (v: string | undefined) => (v && !v.endsWith('_UNSPECIFIED') ? v.toLowerCase() : null);

export function productFromApi(p: ApiProduct): ProductData {
  const a = p.productAttributes ?? {};
  return {
    offerId: p.offerId.slice(0, 50),
    title: a.title ?? null,
    description: a.description ?? null,
    link: a.link ?? null,
    imageLink: a.imageLink ?? null,
    additionalImageLinks: a.additionalImageLinks ?? [],
    price: money(a.price),
    salePrice: money(a.salePrice),
    availability: lower(a.availability),
    condition: lower(a.condition),
    brand: a.brand ?? null,
    gtins: a.gtins ?? [],
    mpn: a.mpn ?? null,
    identifierExists: typeof a.identifierExists === 'boolean' ? a.identifierExists : null,
    googleProductCategory: a.googleProductCategory ?? null,
    productTypes: a.productTypes ?? [],
    itemGroupId: a.itemGroupId ?? null,
    color: a.color ?? null,
    material: a.material ?? null,
    pattern: a.pattern ?? null,
    size: a.size ?? null,
    gender: lower(a.gender),
    ageGroup: lower(a.ageGroup),
    productDetails: (a.productDetails ?? [])
      .map((d) => ({
        section: d.sectionName ?? null,
        name: d.attributeName ?? '',
        value: d.attributeValue ?? '',
      }))
      .filter((d) => d.name && d.value),
  };
}

const CONTEXT_PROGRAM: Record<string, ProductProgram> = {
  FREE_LISTINGS: 'FREE_LISTINGS',
  SHOPPING_ADS: 'SHOPPING_ADS',
  FREE_LOCAL_LISTINGS: 'FREE_LOCAL_LISTINGS',
  LOCAL_INVENTORY_ADS: 'FREE_LOCAL_LISTINGS',
};

/** Google's item issues, as reported (DISAPPROVED → error, DEMOTED → warning, NOT_IMPACTED → suggestion). */
export function googleIssues(p: ApiProduct): ProductIssue[] {
  return (p.productStatus?.itemLevelIssues ?? []).map((i) => ({
    code: `google:${i.code ?? 'issue'}`,
    severity: i.severity === 'DISAPPROVED' ? 'error' : i.severity === 'DEMOTED' ? 'warning' : 'suggestion',
    attribute: i.attribute ?? null,
    message: [i.description, i.detail].filter(Boolean).join(' — ') || 'Issue reported by Merchant Center.',
    fix: i.resolution === 'merchant_action' ? 'Fix the product data or the landing page, then wait for Google to re-check it.' : i.resolution === 'pending_processing' ? 'Google is still processing the product.' : null, // prettier-ignore
    programs:
      i.reportingContext && CONTEXT_PROGRAM[i.reportingContext] ? [CONTEXT_PROGRAM[i.reportingContext]!] : [],
    source: 'GOOGLE',
    countries: i.applicableCountries ?? [],
    documentation: i.documentation ?? null,
  }));
}

export function googleStatusOf(p: ApiProduct): ProductGoogleStatus[] {
  return (p.productStatus?.destinationStatuses ?? []).map((d) => ({
    context: d.reportingContext ?? 'UNKNOWN',
    approvedCountries: d.approvedCountries ?? [],
    pendingCountries: d.pendingCountries ?? [],
    disapprovedCountries: d.disapprovedCountries ?? [],
  }));
}

export interface MerchantSyncResult {
  products: number;
  removed: number;
  limitedByPlan: boolean;
  account: MerchantAccountSnapshot;
}

/** Reads the selected account and its products into the project (read-only towards Google). */
export async function syncMerchantCenter(
  prisma: PrismaClient,
  integrationId: string,
  httpFetch: HttpFetch = fetch,
): Promise<MerchantSyncResult> {
  const integration = await prisma.integration.findUniqueOrThrow({
    where: { id: integrationId },
    include: { project: true },
  });
  if (integration.provider !== 'GOOGLE_MERCHANT_CENTER')
    throw Errors.badRequest('Not a Merchant Center integration.');
  const config = (integration.config ?? {}) as { accountId?: string };
  if (!config.accountId) throw Errors.badRequest('Choose the Merchant Center account before syncing.');
  const project = integration.project;
  const account = await fetchMerchantAccountSnapshot(prisma, integrationId, config.accountId, httpFetch);
  const { limits } = await getWorkspacePlan(prisma, project.workspaceId);
  const existing = await prisma.merchantProduct.count({
    where: { projectId: project.id, source: 'MERCHANT_API' },
  });
  const room = Math.max(
    0,
    limits.productsTracked - ((await countProductsForLimit(prisma, project.workspaceId)) - existing),
  );
  const websiteDomain = project.domain;
  const syncStart = new Date();
  let token: string | null = null;
  let stored = 0;
  let limitedByPlan = false;
  let complete = false;
  for (let page = 0; page < MAX_PAGES; page++) {
    const data: { products?: ApiProduct[]; nextPageToken?: string } = await merchantRequest(
      prisma,
      integrationId,
      `/products/v1/accounts/${config.accountId}/products?pageSize=1000${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`,
      httpFetch,
    );
    const batch = data.products ?? [];
    const take = batch.slice(0, Math.max(0, room - stored));
    if (take.length < batch.length) limitedByPlan = true;
    for (const raw of take) {
      const product = productFromApi(raw);
      const country = raw.feedLabel.toUpperCase().slice(0, 2);
      const issues = [...googleIssues(raw), ...validateProduct(product, { country, websiteDomain })];
      const summary = summarizeIssues(issues);
      const row = {
        title: product.title?.slice(0, 500) ?? null,
        data: product as unknown as Prisma.InputJsonValue,
        googleName: raw.name.slice(0, 500),
        googleStatus: googleStatusOf(raw) as unknown as Prisma.InputJsonValue,
        issues: issues as unknown as Prisma.InputJsonValue,
        ...summary,
        lastSeenAt: new Date(),
      };
      const where = {
        projectId_source_feedLabel_contentLanguage_offerId: {
          projectId: project.id,
          source: 'MERCHANT_API',
          feedLabel: raw.feedLabel.slice(0, 20),
          contentLanguage: raw.contentLanguage.slice(0, 10),
          offerId: product.offerId,
        },
      };
      await prisma.merchantProduct.upsert({
        where,
        create: { projectId: project.id, source: 'MERCHANT_API', feedLabel: where.projectId_source_feedLabel_contentLanguage_offerId.feedLabel, contentLanguage: where.projectId_source_feedLabel_contentLanguage_offerId.contentLanguage, offerId: product.offerId, ...row }, // prettier-ignore
        update: row,
      });
      stored += 1;
    }
    if (limitedByPlan) break;
    if (!data.nextPageToken) {
      complete = true;
      break;
    }
    token = data.nextPageToken;
  }
  // Products deleted in Merchant Center are removed here too (only known after reading every page).
  const removed = complete
    ? (await prisma.merchantProduct.deleteMany({ where: { projectId: project.id, source: 'MERCHANT_API', lastSeenAt: { lt: syncStart } } })).count // prettier-ignore
    : 0;
  await prisma.integration.update({
    where: { id: integrationId },
    data: {
      config: { ...config, accountName: account.accountName, account } as unknown as Prisma.InputJsonValue,
      lastSyncAt: new Date(),
      lastSyncStatus: limitedByPlan ? 'PARTIAL' : 'SUCCEEDED',
      lastError: limitedByPlan ? `Only ${stored} products were read: the plan allows ${limits.productsTracked} tracked products.` : null, // prettier-ignore
      status: 'CONNECTED',
    },
  });
  return { products: stored, removed, limitedByPlan, account };
}
