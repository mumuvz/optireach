import {
  idSchema,
  keywordBulkCreateSchema,
  keywordGroupInputSchema,
  keywordImportSchema,
  keywordInputSchema,
  keywordListQuerySchema,
  keywordSuggestSchema,
  keywordUpdateSchema,
} from '@surfaced/shared';
import { z } from 'zod';
import { accepted, created, noContent, ok } from '../lib/http';
import { route, type AnyRoute } from '../lib/router';
import { KeywordService } from '../services/keyword.service';
import type { AppDeps } from '../types';

const projectParams = z.object({ projectId: idSchema });

export function projectKeywordRoutes(deps: AppDeps): AnyRoute[] {
  const service = new KeywordService(deps);
  const tags = ['Keywords'];
  return [
    route({
      method: 'get',
      path: '/:projectId/keywords',
      summary: 'List keywords with filters',
      tags,
      auth: 'user',
      params: projectParams,
      query: keywordListQuerySchema,
      handler: async ({ user, params, query }) => {
        const { items, meta } = await service.list(user, params.projectId, query);
        return ok(items, meta);
      },
    }),
    route({
      method: 'post',
      path: '/:projectId/keywords',
      summary: 'Add a keyword',
      tags,
      auth: 'user',
      params: projectParams,
      body: keywordInputSchema,
      successStatus: 201,
      handler: async ({ user, params, body }) => created(await service.create(user, params.projectId, body)),
    }),
    route({
      method: 'post',
      path: '/:projectId/keywords/bulk',
      summary: 'Add several keywords (e.g. accepted AI ideas); duplicates are skipped',
      tags,
      auth: 'user',
      params: projectParams,
      body: keywordBulkCreateSchema.extend({ source: z.enum(['MANUAL', 'AI_SUGGESTION']).default('MANUAL') }),
      successStatus: 201,
      handler: async ({ user, params, body }) =>
        created(await service.bulkCreate(user, params.projectId, body.keywords, body.source)),
    }),
    route({
      method: 'post',
      path: '/:projectId/keywords/import',
      summary: 'Import keywords from CSV text',
      tags,
      auth: 'user',
      params: projectParams,
      body: keywordImportSchema,
      handler: async ({ user, params, body }) => ok(await service.importCsv(user, params.projectId, body)),
    }),
    route({
      method: 'get',
      path: '/:projectId/keywords/export',
      summary: 'Export keywords as CSV',
      tags,
      auth: 'user',
      params: projectParams,
      produces: 'text/csv',
      handler: async ({ res, user, params }) => {
        const file = await service.exportCsv(user, params.projectId);
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
        res.status(200).send(file.csv);
      },
    }),
    route({
      method: 'post',
      path: '/:projectId/keywords/suggest',
      summary: 'Generate AI keyword ideas (labeled estimates, no measured metrics)',
      tags,
      auth: 'user',
      params: projectParams,
      body: keywordSuggestSchema,
      successStatus: 202,
      handler: async ({ user, params, body }) =>
        accepted(await service.suggest(user, params.projectId, body)),
    }),
    route({
      method: 'get',
      path: '/:projectId/keywords/opportunities',
      summary: 'Keyword opportunity scores (trend, Search Console, measured metrics, relevance, coverage)',
      tags,
      auth: 'user',
      params: projectParams,
      query: z.object({ limit: z.coerce.number().int().min(1).max(500).default(300) }),
      handler: async ({ user, params, query }) =>
        ok(await service.opportunities(user, params.projectId, query.limit)),
    }),
    route({
      method: 'get',
      path: '/:projectId/keyword-groups',
      summary: 'Keyword lists and topic clusters',
      tags,
      auth: 'user',
      params: projectParams,
      handler: async ({ user, params }) => ok(await service.listGroups(user, params.projectId)),
    }),
    route({
      method: 'post',
      path: '/:projectId/keyword-groups/:kind',
      summary: 'Create a keyword list or topic cluster',
      tags,
      auth: 'user',
      params: projectParams.extend({ kind: z.enum(['list', 'cluster']) }),
      body: keywordGroupInputSchema,
      successStatus: 201,
      handler: async ({ user, params, body }) =>
        created(await service.createGroup(user, params.projectId, params.kind, body)),
    }),
    route({
      method: 'delete',
      path: '/:projectId/keyword-groups/:kind/:groupId',
      summary: 'Delete a keyword list or topic cluster (keywords are kept)',
      tags,
      auth: 'user',
      params: projectParams.extend({ kind: z.enum(['list', 'cluster']), groupId: idSchema }),
      handler: async ({ user, params }) => {
        await service.deleteGroup(user, params.projectId, params.kind, params.groupId);
        return noContent();
      },
    }),
  ];
}

export function keywordRoutes(deps: AppDeps): AnyRoute[] {
  const service = new KeywordService(deps);
  const tags = ['Keywords'];
  const params = z.object({ keywordId: idSchema });
  return [
    route({
      method: 'get',
      path: '/provider-status',
      summary: 'Keyword data provider and AI suggestion status',
      tags,
      auth: 'user',
      handler: () => ok(service.providerStatus()),
    }),
    route({
      method: 'patch',
      path: '/:keywordId',
      summary: 'Update a keyword',
      tags,
      auth: 'user',
      params,
      body: keywordUpdateSchema,
      handler: async ({ user, params: p, body }) => ok(await service.update(user, p.keywordId, body)),
    }),
    route({
      method: 'delete',
      path: '/:keywordId',
      summary: 'Delete a keyword',
      tags,
      auth: 'user',
      params,
      handler: async ({ user, params: p }) => {
        await service.remove(user, p.keywordId);
        return noContent();
      },
    }),
  ];
}
