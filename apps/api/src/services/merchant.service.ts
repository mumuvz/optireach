// Merchant Center and product feeds for a project: status and checklist, account selection, sync, feed preview and
// import, and the product list. Read-only towards Google.
import {
  importProductFeed,
  listMerchantAccounts,
  merchantChecklist,
  previewProductFeed,
  productSummary,
  toProductDto,
  type MerchantAccountSnapshot,
} from '@surfaced/core/commerce';
import { recordAuditLog } from '@surfaced/core/audit-log';
import type { Integration, Prisma, PrismaClient } from '@surfaced/core/db';
import { Errors } from '@surfaced/core/errors';
import {
  GoogleApiError,
  IntegrationAuthError,
  googleOAuthConfigured,
  integrationCatalog,
  type HttpFetch,
} from '@surfaced/core/integrations';
import { createJobRecord, enqueueJobRecord } from '@surfaced/core/jobs';
import { assertPlanFeature, countProductsForLimit } from '@surfaced/core/usage';
import { getWorkspacePlan } from '@surfaced/core/billing';
import {
  businessProfileSchema,
  merchantAccountSelectSchema,
  productFeedSchema,
  productListQuerySchema,
  type MerchantAccountDto,
  type MerchantStatusDto,
  type ProductDto,
  type ProductFeedImportResultDto,
  type ProductFeedInput,
  type ProductFeedPreviewDto,
} from '@surfaced/shared';
import type { z } from 'zod';
import type { AppDeps, AuthUser } from '../types';
import { requireProjectAccess } from './access';

async function google<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof GoogleApiError)
      throw Errors.upstream(error.message, { provider: 'GOOGLE_MERCHANT_CENTER', httpStatus: error.httpStatus, googleStatus: error.googleStatus }); // prettier-ignore
    if (error instanceof IntegrationAuthError)
      throw Errors.conflict(error.message, { reason: 'NEEDS_REAUTH' });
    throw error;
  }
}

type MerchantConfig = { accountId?: string; accountName?: string | null; account?: MerchantAccountSnapshot };

export class MerchantService {
  constructor(private readonly deps: AppDeps) {}

  private get prisma(): PrismaClient {
    return this.deps.prisma;
  }

  private get http(): HttpFetch {
    return this.deps.httpFetch ?? fetch;
  }

  private integration(projectId: string): Promise<Integration | null> {
    return this.prisma.integration.findUnique({
      where: { projectId_provider: { projectId, provider: 'GOOGLE_MERCHANT_CENTER' } },
    });
  }

  private async connected(projectId: string): Promise<Integration> {
    const integration = await this.integration(projectId);
    if (!integration || integration.status === 'DISCONNECTED')
      throw Errors.conflict('Connect Google Merchant Center first.');
    if (integration.status === 'NEEDS_REAUTH')
      throw Errors.conflict('Google access expired or was revoked. Reconnect Merchant Center.');
    return integration;
  }

  async status(user: AuthUser, projectId: string): Promise<MerchantStatusDto> {
    const { project } = await requireProjectAccess(this.prisma, user, projectId, 'project.read');
    const [integration, products, lastImport, linkedProfiles, latestCrawl, plan, used] = await Promise.all([
      this.integration(projectId),
      productSummary(this.prisma, projectId),
      this.prisma.productFeedImport.findFirst({ where: { projectId }, orderBy: { createdAt: 'desc' } }),
      this.prisma.businessLocation.count({
        where: { projectId, archivedAt: null, profileLocationName: { not: null } },
      }),
      this.prisma.crawlJob.findFirst({ where: { projectId, status: 'SUCCEEDED' }, orderBy: { createdAt: 'desc' }, select: { id: true } }), // prettier-ignore
      getWorkspacePlan(this.prisma, project.workspaceId),
      countProductsForLimit(this.prisma, project.workspaceId),
    ]);
    let productSchemaPages: number | null = null;
    if (latestCrawl) {
      const rows = await this.prisma.$queryRaw<{ n: bigint | number }[]>`
        SELECT COUNT(*) AS n FROM crawled_pages
        WHERE crawlJobId = ${latestCrawl.id} AND JSON_CONTAINS(JSON_EXTRACT(structuredData, '$.types'), '"Product"')`;
      productSchemaPages = Number(rows[0]?.n ?? 0);
    }
    const live = integration && integration.status !== 'DISCONNECTED' ? integration : null;
    const config = (live?.config ?? {}) as MerchantConfig;
    const businessProfile = businessProfileSchema.safeParse(project.businessProfile ?? {});
    const entry = integrationCatalog().find((e) => e.provider === 'GOOGLE_MERCHANT_CENTER')!;
    const hasWebsite = Boolean(project.websiteUrl);
    return {
      configured: googleOAuthConfigured(),
      setup: entry.setup,
      plan: {
        ecommerce: plan.limits.ecommerce,
        productsTracked: plan.limits.productsTracked,
        productsUsed: used,
      },
      integration: live
        ? {
            id: live.id,
            status: live.status,
            externalAccount: live.externalAccount,
            accountId: config.accountId ?? null,
            accountName: config.accountName ?? null,
            lastSyncAt: live.lastSyncAt?.toISOString() ?? null,
            lastSyncStatus: live.lastSyncStatus,
            lastError: live.lastError,
          }
        : null,
      account: config.account
        ? { homepage: config.account.homepage, freeListings: config.account.freeListings, issues: config.account.issues, syncedAt: config.account.syncedAt } // prettier-ignore
        : null,
      products,
      lastImport: lastImport
        ? { id: lastImport.id, fileName: lastImport.fileName, createdAt: lastImport.createdAt.toISOString(), products: lastImport.imported + lastImport.updated } // prettier-ignore
        : null,
      hasWebsite,
      checklist: merchantChecklist({
        hasWebsite,
        websiteDomain: project.domain,
        saysHasMerchantCenter: businessProfile.success ? businessProfile.data.hasMerchantCenter : false,
        connected: Boolean(live && live.status !== 'NEEDS_REAUTH'),
        accountChosen: Boolean(config.accountId),
        account: config.account ?? null,
        products,
        productSchemaPages,
        businessProfileLinked: linkedProfiles > 0,
      }),
      limitations: [
        'Surfaced’s checks follow Google’s product data specification and predict likely problems; Merchant Center decides after reviewing products and landing pages. Google’s own item issues are labeled “Google”.',
        'Free listings, Shopping ads and free local listings are checked separately.',
      ],
    };
  }

  async accounts(user: AuthUser, projectId: string): Promise<MerchantAccountDto[]> {
    await requireProjectAccess(this.prisma, user, projectId, 'commerce.manage');
    const integration = await this.connected(projectId);
    return google(() => listMerchantAccounts(this.prisma, integration.id, this.http));
  }

  async selectAccount(user: AuthUser, projectId: string, input: { accountId: string }) {
    const { project } = await requireProjectAccess(this.prisma, user, projectId, 'commerce.manage');
    const { accountId } = merchantAccountSelectSchema.parse(input);
    const integration = await this.connected(projectId);
    const accounts = await google(() => listMerchantAccounts(this.prisma, integration.id, this.http));
    const account = accounts.find((a) => a.accountId === accountId);
    if (!account)
      throw Errors.badRequest(
        'That Merchant Center account is not available to the connected Google account.',
      );
    await this.prisma.integration.update({
      where: { id: integration.id },
      data: { config: { accountId, accountName: account.accountName } as Prisma.InputJsonValue },
    });
    await recordAuditLog(this.prisma, { action: 'merchant.account_selected', actorUserId: user.id, workspaceId: project.workspaceId, targetType: 'Integration', targetId: integration.id, metadata: { accountId } }); // prettier-ignore
    return this.queueSync({ ...integration, config: { accountId } }, user.id);
  }

  async sync(user: AuthUser, projectId: string) {
    const { project } = await requireProjectAccess(this.prisma, user, projectId, 'commerce.manage');
    await assertPlanFeature(
      this.prisma,
      project.workspaceId,
      'ecommerce',
      'Merchant Center and product feeds',
    );
    const integration = await this.connected(projectId);
    if (!(integration.config as MerchantConfig | null)?.accountId)
      throw Errors.badRequest('Choose the Merchant Center account before syncing.');
    return this.queueSync(integration, user.id);
  }

  private async queueSync(integration: Integration, userId: string) {
    const pending = await this.prisma.backgroundJob.findFirst({
      where: { type: 'INTEGRATION_SYNC', entityId: integration.id, status: { in: ['QUEUED', 'RUNNING'] } },
      select: { id: true, status: true },
    });
    if (pending) return { jobId: pending.id, status: pending.status };
    const job = await createJobRecord(this.prisma, {
      type: 'INTEGRATION_SYNC',
      queue: 'integration-sync',
      workspaceId: integration.workspaceId,
      projectId: integration.projectId,
      userId,
      entityType: 'Integration',
      entityId: integration.id,
      payload: { integrationId: integration.id },
    });
    await enqueueJobRecord(this.prisma, this.deps.queues, job, 'integration-sync', {
      backgroundJobId: job.id,
      integrationId: integration.id,
    });
    return { jobId: job.id, status: 'QUEUED' as const };
  }

  // ---------------- Feeds ----------------

  async previewFeed(
    user: AuthUser,
    projectId: string,
    input: ProductFeedInput,
  ): Promise<ProductFeedPreviewDto> {
    const { project } = await requireProjectAccess(this.prisma, user, projectId, 'project.read');
    const data = productFeedSchema.parse(input);
    return previewProductFeed({ content: data.content, country: data.country }, project);
  }

  async importFeed(
    user: AuthUser,
    projectId: string,
    input: ProductFeedInput,
  ): Promise<ProductFeedImportResultDto> {
    const { project } = await requireProjectAccess(this.prisma, user, projectId, 'commerce.manage');
    await assertPlanFeature(this.prisma, project.workspaceId, 'ecommerce', 'Product feeds');
    const data = productFeedSchema.parse(input);
    const result = await importProductFeed(this.prisma, {
      projectId,
      workspaceId: project.workspaceId,
      userId: user.id,
      fileName: data.fileName,
      content: data.content,
      country: data.country,
      language: data.language,
      mode: data.mode,
      project,
    });
    await recordAuditLog(this.prisma, { action: 'merchant.feed_imported', actorUserId: user.id, workspaceId: project.workspaceId, targetType: 'ProductFeedImport', targetId: result.importId, metadata: { imported: result.imported, updated: result.updated, removed: result.removed, skipped: result.skipped } }); // prettier-ignore
    return result;
  }

  /** Removes the products imported from feed files (Merchant Center products are left alone). */
  async clearFeedProducts(user: AuthUser, projectId: string): Promise<{ removed: number }> {
    await requireProjectAccess(this.prisma, user, projectId, 'commerce.manage');
    const { count } = await this.prisma.merchantProduct.deleteMany({
      where: { projectId, source: 'FEED_IMPORT' },
    });
    return { removed: count };
  }

  // ---------------- Products ----------------

  async listProducts(user: AuthUser, projectId: string, query: z.input<typeof productListQuerySchema>) {
    await requireProjectAccess(this.prisma, user, projectId, 'project.read');
    const q = productListQuerySchema.parse(query);
    const where: Prisma.MerchantProductWhereInput = {
      projectId,
      ...(q.filter === 'all' ? {} : { status: q.filter }),
      ...(q.q ? { OR: [{ title: { contains: q.q } }, { offerId: { contains: q.q } }] } : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.merchantProduct.count({ where }),
      this.prisma.merchantProduct.findMany({
        where,
        orderBy: [{ errorCount: 'desc' }, { warningCount: 'desc' }, { title: 'asc' }],
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
    ]);
    return { items: rows.map(toProductDto) as ProductDto[], total, page: q.page, pageSize: q.pageSize };
  }

  async product(user: AuthUser, projectId: string, productId: string): Promise<ProductDto> {
    await requireProjectAccess(this.prisma, user, projectId, 'project.read');
    const row = await this.prisma.merchantProduct.findFirst({ where: { id: productId, projectId } });
    if (!row) throw Errors.notFound('Product');
    return toProductDto(row);
  }
}
