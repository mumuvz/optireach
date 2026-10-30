// The product catalog of a project: feed imports, product summaries and the Merchant Center eligibility checklist.
import {
  PRODUCT_PROGRAMS,
  type MerchantChecklistItem,
  type MerchantStatusDto,
  type ProductData,
  type ProductDto,
  type ProductFeedImportResultDto,
  type ProductFeedPreviewDto,
  type ProductGoogleStatus,
  type ProductIssue,
  type ProductProgram,
  type ProductSource,
} from '@surfaced/shared';
import type { MerchantProduct, Prisma, PrismaClient } from '../db';
import { getWorkspacePlan } from '../billing';
import { countProductsForLimit } from '../usage';
import { parseProductFeed } from './feed';
import type { MerchantAccountSnapshot } from './merchant-api';
import { summarizeIssues, validateProduct } from './validate';

export function toProductDto(row: MerchantProduct): ProductDto {
  const data = row.data as unknown as ProductData;
  return {
    ...data,
    id: row.id,
    source: row.source as ProductSource,
    contentLanguage: row.contentLanguage,
    feedLabel: row.feedLabel,
    status: row.status as ProductDto['status'],
    errorCount: row.errorCount,
    warningCount: row.warningCount,
    issues: (Array.isArray(row.issues) ? row.issues : []) as unknown as ProductIssue[],
    googleStatus: (row.googleStatus as unknown as ProductGoogleStatus[] | null) ?? null,
    lastSeenAt: row.lastSeenAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function previewProductFeed(
  input: { content: string; country: string },
  project: { websiteUrl: string | null; domain: string | null },
): ProductFeedPreviewDto {
  const parsed = parseProductFeed(input.content, { country: input.country, websiteUrl: project.websiteUrl });
  const checked = parsed.products.map((p) => ({ ...p, issues: validateProduct(p, { country: input.country, websiteDomain: project.domain }) })); // prettier-ignore
  const statuses = checked.map((p) => summarizeIssues(p.issues).status);
  return {
    format: parsed.format,
    rows: parsed.rows,
    products: parsed.products.length,
    columns: parsed.columns,
    ignoredColumns: parsed.ignoredColumns,
    rowErrors: parsed.rowErrors,
    sample: checked.slice(0, 10),
    summary: {
      errors: statuses.filter((s) => s === 'errors').length,
      warnings: statuses.filter((s) => s === 'warnings').length,
      ok: statuses.filter((s) => s === 'ok').length,
    },
    limitations: [
      ...parsed.limitations,
      'These checks follow Google’s product data specification; Merchant Center makes the final decision after it reviews the products and landing pages.',
    ],
  };
}

const CHUNK = 500;

/**
 * Imports a feed file. "replace" treats the file as the whole catalog for that country and language (products not
 * in it are removed); "merge" only adds and updates. Products beyond the plan limit are not imported.
 */
export async function importProductFeed(
  prisma: PrismaClient,
  params: {
    projectId: string;
    workspaceId: string;
    userId: string;
    fileName: string;
    content: string;
    country: string;
    language: string;
    mode: 'replace' | 'merge';
    project: { websiteUrl: string | null; domain: string | null };
  },
): Promise<ProductFeedImportResultDto> {
  const parsed = parseProductFeed(params.content, {
    country: params.country,
    websiteUrl: params.project.websiteUrl,
  });
  const where = { projectId: params.projectId, source: 'FEED_IMPORT', feedLabel: params.country, contentLanguage: params.language }; // prettier-ignore
  const existingRows = await prisma.merchantProduct.findMany({ where, select: { offerId: true } });
  const existing = new Set(existingRows.map((r) => r.offerId));
  const { limits } = await getWorkspacePlan(prisma, params.workspaceId);
  const used = await countProductsForLimit(prisma, params.workspaceId);
  // Products this import replaces free their slots; new ids need room under the limit.
  const freed = params.mode === 'replace' ? existing.size : 0;
  let room = Math.max(0, limits.productsTracked - (used - freed));
  const accepted: ProductData[] = [];
  let skipped = 0;
  for (const p of parsed.products) {
    if (params.mode === 'merge' && existing.has(p.offerId)) accepted.push(p);
    else if (room > 0) {
      accepted.push(p);
      room -= 1;
    } else skipped += 1;
  }
  const now = new Date();
  const record = await prisma.productFeedImport.create({
    data: {
      projectId: params.projectId,
      fileName: params.fileName.slice(0, 200),
      format: parsed.format,
      country: params.country,
      language: params.language,
      mode: params.mode,
      rows: parsed.rows,
      imported: 0,
      updated: 0,
      removed: 0,
      skipped,
      rowErrors: parsed.rowErrors as unknown as Prisma.InputJsonValue,
      limitations: parsed.limitations as unknown as Prisma.InputJsonValue,
      createdById: params.userId,
    },
  });
  const rows = accepted.map((p) => {
    const issues = validateProduct(p, { country: params.country, websiteDomain: params.project.domain });
    return {
      projectId: params.projectId,
      source: 'FEED_IMPORT',
      offerId: p.offerId,
      contentLanguage: params.language,
      feedLabel: params.country,
      title: p.title?.slice(0, 500) ?? null,
      data: p as unknown as Prisma.InputJsonValue,
      issues: issues as unknown as Prisma.InputJsonValue,
      ...summarizeIssues(issues),
      importId: record.id,
      lastSeenAt: now,
    };
  });
  const updatedIds = rows.filter((r) => existing.has(r.offerId)).map((r) => r.offerId);
  let removed = 0;
  await prisma.$transaction(
    async (tx) => {
      // Replace rows in chunks: delete the ones being re-imported (and, in replace mode, all others), then insert.
      if (params.mode === 'replace')
        removed = (await tx.merchantProduct.deleteMany({ where })).count - updatedIds.length;
      else
        for (let i = 0; i < updatedIds.length; i += CHUNK)
          await tx.merchantProduct.deleteMany({
            where: { ...where, offerId: { in: updatedIds.slice(i, i + CHUNK) } },
          });
      for (let i = 0; i < rows.length; i += CHUNK)
        await tx.merchantProduct.createMany({ data: rows.slice(i, i + CHUNK) });
      await tx.productFeedImport.update({
        where: { id: record.id },
        data: {
          imported: rows.length - updatedIds.length,
          updated: updatedIds.length,
          removed: Math.max(0, removed),
        },
      });
    },
    { timeout: 120_000, maxWait: 10_000 },
  );
  return {
    importId: record.id,
    imported: rows.length - updatedIds.length,
    updated: updatedIds.length,
    removed: Math.max(0, removed),
    skipped,
    rowErrors: parsed.rowErrors,
    limitedByPlan: skipped > 0,
  };
}

// ---------------- Status and checklist ----------------

const blocks = (issues: ProductIssue[], program: ProductProgram) =>
  issues.some((i) => i.severity === 'error' && (i.programs.length === 0 || i.programs.includes(program)));

export async function productSummary(
  prisma: PrismaClient,
  projectId: string,
): Promise<MerchantStatusDto['products']> {
  const rows = await prisma.merchantProduct.findMany({
    where: { projectId },
    select: { source: true, status: true, issues: true },
  });
  const blockedByProgram = Object.fromEntries(PRODUCT_PROGRAMS.map((p) => [p, 0])) as Record<
    ProductProgram,
    number
  >;
  const issueCounts = new Map<string, { code: string; message: string; severity: ProductIssue['severity']; products: number }>(); // prettier-ignore
  const bySource: Partial<Record<ProductSource, number>> = {};
  for (const r of rows) {
    bySource[r.source as ProductSource] = (bySource[r.source as ProductSource] ?? 0) + 1;
    const issues = (Array.isArray(r.issues) ? r.issues : []) as unknown as ProductIssue[];
    for (const program of PRODUCT_PROGRAMS) if (blocks(issues, program)) blockedByProgram[program] += 1;
    for (const code of new Set(issues.filter((i) => i.severity !== 'suggestion').map((i) => i.code))) {
      const issue = issues.find((i) => i.code === code)!;
      const entry = issueCounts.get(code) ?? {
        code,
        message: issue.message,
        severity: issue.severity,
        products: 0,
      };
      entry.products += 1;
      issueCounts.set(code, entry);
    }
  }
  return {
    total: rows.length,
    errors: rows.filter((r) => r.status === 'errors').length,
    warnings: rows.filter((r) => r.status === 'warnings').length,
    ok: rows.filter((r) => r.status === 'ok').length,
    bySource,
    blockedByProgram,
    topIssues: [...issueCounts.values()]
      .sort((a, b) => (a.severity === b.severity ? b.products - a.products : a.severity === 'error' ? -1 : 1))
      .slice(0, 8),
  };
}

export interface ChecklistInput {
  hasWebsite: boolean;
  websiteDomain: string | null;
  saysHasMerchantCenter: boolean;
  connected: boolean;
  accountChosen: boolean;
  account: MerchantAccountSnapshot | null;
  products: MerchantStatusDto['products'];
  /** Crawled pages with Product structured data in the latest crawl (null: no crawl yet). */
  productSchemaPages: number | null;
  businessProfileLinked: boolean;
}

const MERCHANT_HOME = 'https://merchants.google.com/';

/** What a business needs for its products to appear on Google, from what is known; unknown items say so. */
export function merchantChecklist(c: ChecklistInput): MerchantChecklistItem[] {
  const items: MerchantChecklistItem[] = [];
  const add = (key: string, title: string, status: MerchantChecklistItem['status'], detail: string, action: MerchantChecklistItem['action'] = null) =>
    items.push({ key, title, status, detail, action }); // prettier-ignore
  add('account', 'Merchant Center account', c.connected && c.accountChosen ? 'done' : 'todo',
    c.connected && c.accountChosen ? `Connected${c.account?.accountName ? `: ${c.account.accountName}` : ''}.` : c.connected ? 'Connected; choose the account to read.' : c.saysHasMerchantCenter ? 'The business has an account: connect it to see Google’s product statuses.' : 'Create a free Merchant Center account, then connect it or import a product feed.',
    c.connected ? null : { label: c.saysHasMerchantCenter ? 'Connect' : 'Open Merchant Center', href: c.saysHasMerchantCenter ? '#connect' : MERCHANT_HOME, external: !c.saysHasMerchantCenter }); // prettier-ignore
  if (!c.hasWebsite)
    add('website', 'Website claimed in Merchant Center', 'not_applicable',
      'No website: online free listings and Shopping ads need product pages on a website you own. In-store products can still appear through free local listings, which need a linked Business Profile and local inventory; where Merchant Center offers it, Google can host a simple storefront page for them.'); // prettier-ignore
  else if (!c.account?.homepage)
    add('website', 'Website claimed in Merchant Center', 'unknown', c.connected ? 'Sync to read the homepage status.' : `Claim ${c.websiteDomain} in Merchant Center (Business info → Website). Connect the account to check it.`); // prettier-ignore
  else
    add('website', 'Website claimed in Merchant Center', c.account.homepage.claimed ? 'done' : 'todo',
      c.account.homepage.claimed ? `${c.account.homepage.uri ?? c.websiteDomain} is verified and claimed.` : `${c.account.homepage.uri ?? c.websiteDomain} is not claimed yet; products cannot show until it is.`); // prettier-ignore
  add('products', 'Products submitted', c.products.total ? 'done' : 'todo',
    c.products.total ? `${c.products.total} products (${Object.entries(c.products.bySource).map(([s, n]) => `${n} ${s === 'MERCHANT_API' ? 'from Merchant Center' : 'from a feed file'}`).join(', ')}).` : 'Import a product feed (CSV or TSV in Google’s format, or a Shopify export), or connect Merchant Center.'); // prettier-ignore
  if (c.products.total)
    add('product_errors', 'No products with blocking errors', c.products.errors ? 'todo' : 'done',
      c.products.errors ? `${c.products.errors} of ${c.products.total} products have an error that is likely to block them. Start with the most common issue below.` : 'No blocking errors found in the product data.'); // prettier-ignore
  const fl = c.account?.freeListings;
  add('free_listings', 'Free listings turned on', !fl ? 'unknown' : fl.state === 'ENABLED' ? 'done' : 'todo',
    !fl ? (c.connected ? 'Sync to read the free listings status.' : 'Connect Merchant Center to check whether free listings are on.') : fl.state === 'ENABLED' ? `On${fl.regions.length ? ` in ${fl.regions.join(', ')}` : ''}.` : fl.state === 'ELIGIBLE' ? 'Eligible but not turned on: turn on free listings in Merchant Center (Growth → Manage programs).' : `Not eligible yet${fl.unmetRequirements.length ? `: ${fl.unmetRequirements.join('; ')}` : ''}.`); // prettier-ignore
  add('shipping_returns', 'Shipping and return policies', !c.account ? 'unknown' : (c.account.shippingServices ?? 0) > 0 && (c.account.returnPolicies ?? 0) > 0 ? 'done' : 'todo',
    !c.account ? 'Set shipping and return policies in Merchant Center (required in some countries). Connect the account to check them.' : `${c.account.shippingServices ?? 0} shipping services and ${c.account.returnPolicies ?? 0} return policies set.`); // prettier-ignore
  if (c.account)
    add('account_issues', 'No account issues', c.account.issues.some((i) => i.severity === 'CRITICAL' || i.severity === 'ERROR') ? 'todo' : 'done',
      c.account.issues.length ? c.account.issues.slice(0, 3).map((i) => i.title).join('; ') : 'Merchant Center reports no account issues.'); // prettier-ignore
  if (c.hasWebsite)
    add('structured_data', 'Product structured data on the website', c.productSchemaPages === null ? 'unknown' : c.productSchemaPages > 0 ? 'done' : 'todo',
      c.productSchemaPages === null ? 'Run a website audit to check product pages for Product structured data.' : c.productSchemaPages > 0 ? `${c.productSchemaPages} crawled pages have Product structured data.` : 'No crawled page has Product structured data. Adding it (with price and availability matching the feed) makes product pages eligible for richer results in Search.'); // prettier-ignore
  add('business_profile', 'Business Profile for local listings', c.businessProfileLinked ? 'done' : 'todo',
    c.businessProfileLinked ? 'A location is linked to its Business Profile in Surfaced. For in-store products, also link the Business Profile in Merchant Center (Settings → Linked accounts).' : 'Link a location to its Business Profile so in-store products can appear in local listings.'); // prettier-ignore
  return items;
}
