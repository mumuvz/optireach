import {
  idSchema,
  merchantAccountSelectSchema,
  productFeedSchema,
  productListQuerySchema,
} from '@surfaced/shared';
import { z } from 'zod';
import { accepted, ok, pageMeta } from '../lib/http';
import { route, type AnyRoute } from '../lib/router';
import { MerchantService } from '../services/merchant.service';
import type { AppDeps } from '../types';

const projectParams = z.object({ projectId: idSchema });

/** Merchant Center and product feeds under /projects. Read-only towards Google. */
export function projectMerchantRoutes(deps: AppDeps): AnyRoute[] {
  const service = new MerchantService(deps);
  const tags = ['Merchant Center'];
  return [
    route({
      method: 'get',
      path: '/:projectId/merchant',
      summary: 'Merchant Center status, product health by program, and the eligibility checklist',
      tags,
      auth: 'user',
      params: projectParams,
      handler: async ({ user, params }) => ok(await service.status(user, params.projectId)),
    }),
    route({
      method: 'get',
      path: '/:projectId/merchant/accounts',
      summary: 'Merchant Center accounts the connected Google account can access (read live)',
      tags,
      auth: 'user',
      params: projectParams,
      handler: async ({ user, params }) => ok(await service.accounts(user, params.projectId)),
    }),
    route({
      method: 'put',
      path: '/:projectId/merchant/account',
      summary: 'Choose the Merchant Center account to read, then sync it (background job)',
      tags,
      auth: 'user',
      params: projectParams,
      body: merchantAccountSelectSchema,
      successStatus: 202,
      handler: async ({ user, params, body }) =>
        accepted(await service.selectAccount(user, params.projectId, body)),
    }),
    route({
      method: 'post',
      path: '/:projectId/merchant/sync',
      summary: 'Read the account and its products from Merchant Center now (background job)',
      tags,
      auth: 'user',
      params: projectParams,
      successStatus: 202,
      handler: async ({ user, params }) => accepted(await service.sync(user, params.projectId)),
    }),
    route({
      method: 'post',
      path: '/:projectId/merchant/import/preview',
      summary: 'Read a product feed file without saving it: format, columns, checks on the first products',
      tags,
      auth: 'user',
      params: projectParams,
      body: productFeedSchema,
      handler: async ({ user, params, body }) => ok(await service.previewFeed(user, params.projectId, body)),
    }),
    route({
      method: 'post',
      path: '/:projectId/merchant/import',
      summary: 'Import a product feed file (Google CSV/TSV or Shopify export); replace or merge',
      tags,
      auth: 'user',
      params: projectParams,
      body: productFeedSchema,
      handler: async ({ user, params, body }) => ok(await service.importFeed(user, params.projectId, body)),
    }),
    route({
      method: 'delete',
      path: '/:projectId/merchant/feed-products',
      summary: 'Remove the products imported from feed files',
      tags,
      auth: 'user',
      params: projectParams,
      handler: async ({ user, params }) => ok(await service.clearFeedProducts(user, params.projectId)),
    }),
    route({
      method: 'get',
      path: '/:projectId/merchant/products',
      summary: 'Products with their issues (filter: errors, warnings, ok; search by title or id)',
      tags,
      auth: 'user',
      params: projectParams,
      query: productListQuerySchema,
      handler: async ({ user, params, query }) => {
        const result = await service.listProducts(user, params.projectId, query);
        return ok(result.items, pageMeta(result.page, result.pageSize, result.total));
      },
    }),
    route({
      method: 'get',
      path: '/:projectId/merchant/products/:productId',
      summary: 'One product with every check and Google’s statuses',
      tags,
      auth: 'user',
      params: projectParams.extend({ productId: idSchema }),
      handler: async ({ user, params }) =>
        ok(await service.product(user, params.projectId, params.productId)),
    }),
  ];
}
