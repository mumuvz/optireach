import {
  idSchema,
  issueListQuerySchema,
  issueUpdateSchema,
  pageListQuerySchema,
  paginationSchema,
  startAuditSchema,
} from '@surfaced/shared';
import { z } from 'zod';
import { accepted, ok } from '../lib/http';
import { route, type AnyRoute } from '../lib/router';
import { AuditService } from '../services/audit.service';
import type { AppDeps } from '../types';

const projectParams = z.object({ projectId: idSchema });
const auditParams = z.object({ auditId: idSchema });

/** Project-scoped audit endpoints, mounted under /projects. */
export function projectAuditRoutes(deps: AppDeps): AnyRoute[] {
  const service = new AuditService(deps);
  const tags = ['Audits'];
  return [
    route({
      method: 'post',
      path: '/:projectId/audits',
      summary: 'Start a website crawl and technical audit',
      description: 'Returns 202 with the background job id. Counts toward the monthly audit allowance.',
      tags,
      auth: 'user',
      params: projectParams,
      body: startAuditSchema,
      successStatus: 202,
      handler: async ({ req, user, params, body }) =>
        accepted(await service.start(user, params.projectId, body, req.clientIp)),
    }),
    route({
      method: 'get',
      path: '/:projectId/audits',
      summary: 'List audit runs',
      tags,
      auth: 'user',
      params: projectParams,
      query: paginationSchema,
      handler: async ({ user, params, query }) => {
        const { items, meta } = await service.list(user, params.projectId, query.page, query.pageSize);
        return ok(items, meta);
      },
    }),
    route({
      method: 'get',
      path: '/:projectId/issues',
      summary: 'Current issues (open by default) with filters, sorting and pagination',
      tags: ['Issues'],
      auth: 'user',
      params: projectParams,
      query: issueListQuerySchema,
      handler: async ({ user, params, query }) => {
        const { items, meta } = await service.projectIssues(user, params.projectId, query);
        return ok(items, meta);
      },
    }),
    route({
      method: 'get',
      path: '/:projectId/issues/summary',
      summary: 'Open issue counts by severity, category, status and rule',
      tags: ['Issues'],
      auth: 'user',
      params: projectParams,
      handler: async ({ user, params }) => ok(await service.issueSummary(user, params.projectId)),
    }),
  ];
}

export function auditRoutes(deps: AppDeps): AnyRoute[] {
  const service = new AuditService(deps);
  const tags = ['Audits'];
  return [
    route({
      method: 'get',
      path: '/:auditId',
      summary: 'Audit run detail: status, crawl progress, scores and limitations',
      tags,
      auth: 'user',
      params: auditParams,
      handler: async ({ user, params }) => ok(await service.detail(user, params.auditId)),
    }),
    route({
      method: 'post',
      path: '/:auditId/cancel',
      summary: 'Cancel a queued or running audit',
      tags,
      auth: 'user',
      params: auditParams,
      handler: async ({ user, params }) => ok(await service.cancel(user, params.auditId)),
    }),
    route({
      method: 'post',
      path: '/:auditId/rescore',
      summary: 'Re-apply the current rules and weights to the stored crawl',
      tags,
      auth: 'user',
      params: auditParams,
      successStatus: 202,
      handler: async ({ user, params }) => accepted(await service.rescore(user, params.auditId)),
    }),
    route({
      method: 'get',
      path: '/:auditId/pages',
      summary: 'Crawled pages with filters and sorting',
      tags,
      auth: 'user',
      params: auditParams,
      query: pageListQuerySchema,
      handler: async ({ user, params, query }) => {
        const { items, meta } = await service.pages(user, params.auditId, query);
        return ok(items, meta);
      },
    }),
    route({
      method: 'get',
      path: '/:auditId/pages/:pageId',
      summary: 'Page-level detail: fetched data, issues, inlinks and outlinks',
      tags,
      auth: 'user',
      params: z.object({ auditId: idSchema, pageId: idSchema }),
      handler: async ({ user, params }) => ok(await service.pageDetail(user, params.auditId, params.pageId)),
    }),
    route({
      method: 'get',
      path: '/:auditId/issues',
      summary: 'Issues detected in this audit run',
      tags: ['Issues'],
      auth: 'user',
      params: auditParams,
      query: issueListQuerySchema,
      handler: async ({ user, params, query }) => {
        const { items, meta } = await service.runIssues(user, params.auditId, query);
        return ok(items, meta);
      },
    }),
  ];
}

export function issueRoutes(deps: AppDeps): AnyRoute[] {
  const service = new AuditService(deps);
  const tags = ['Issues'];
  const params = z.object({ issueId: idSchema });
  return [
    route({
      method: 'get',
      path: '/:issueId',
      summary: 'Issue detail with detection history',
      tags,
      auth: 'user',
      params,
      handler: async ({ user, params: p }) => ok(await service.issueDetail(user, p.issueId)),
    }),
    route({
      method: 'patch',
      path: '/:issueId',
      summary: 'Ignore or re-open an issue',
      tags,
      auth: 'user',
      params,
      body: issueUpdateSchema,
      handler: async ({ user, params: p, body }) =>
        ok(await service.updateIssue(user, p.issueId, body.status)),
    }),
  ];
}

export function crawlRoutes(deps: AppDeps): AnyRoute[] {
  const service = new AuditService(deps);
  return [
    route({
      method: 'get',
      path: '/jobs/:crawlJobId',
      summary: 'Crawl job status and counters',
      tags: ['Crawl'],
      auth: 'user',
      params: z.object({ crawlJobId: idSchema }),
      handler: async ({ user, params }) => ok(await service.crawlJob(user, params.crawlJobId)),
    }),
  ];
}
