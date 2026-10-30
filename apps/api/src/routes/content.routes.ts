import {
  briefIdeasSchema,
  contentBriefInputSchema,
  contentBriefUpdateSchema,
  contentDocumentCreateSchema,
  contentDocumentUpdateSchema,
  contentGenerateSchema,
  contentListQuerySchema,
  contentVersionSaveSchema,
  idSchema,
  paginationSchema,
} from '@surfaced/shared';
import { z } from 'zod';
import { accepted, created, noContent, ok } from '../lib/http';
import { route, type AnyRoute } from '../lib/router';
import { ContentService } from '../services/content.service';
import type { AppDeps } from '../types';

const projectParams = z.object({ projectId: idSchema });
const docParams = z.object({ documentId: idSchema });

export function projectContentRoutes(deps: AppDeps): AnyRoute[] {
  const service = new ContentService(deps);
  const tags = ['Content'];
  return [
    route({
      method: 'get',
      path: '/:projectId/content/briefs',
      summary: 'List content briefs',
      tags,
      auth: 'user',
      params: projectParams,
      query: paginationSchema,
      handler: async ({ user, params, query }) => {
        const { items, meta } = await service.listBriefs(user, params.projectId, query.page, query.pageSize);
        return ok(items, meta);
      },
    }),
    route({
      method: 'post',
      path: '/:projectId/content/briefs',
      summary: 'Create a content brief',
      tags,
      auth: 'user',
      params: projectParams,
      body: contentBriefInputSchema,
      successStatus: 201,
      handler: async ({ user, params, body }) =>
        created(await service.createBrief(user, params.projectId, body)),
    }),
    route({
      method: 'get',
      path: '/:projectId/content/brief-providers',
      summary: 'LLM providers available for AI brief/question generation',
      tags,
      auth: 'user',
      params: projectParams,
      handler: async ({ user, params }) => ok(await service.briefProviders(user, params.projectId)),
    }),
    route({
      method: 'post',
      path: '/:projectId/content/briefs/suggest',
      summary: 'Generate an AI content-brief proposal (questions + brief fields) for a topic',
      tags,
      auth: 'user',
      params: projectParams,
      body: briefIdeasSchema,
      successStatus: 202,
      handler: async ({ user, params, body }) =>
        accepted(await service.suggestBrief(user, params.projectId, body)),
    }),
    route({
      method: 'get',
      path: '/:projectId/content/documents',
      summary: 'List content documents',
      tags,
      auth: 'user',
      params: projectParams,
      query: contentListQuerySchema,
      handler: async ({ user, params, query }) => {
        const { items, meta } = await service.listDocuments(user, params.projectId, query);
        return ok(items, meta);
      },
    }),
    route({
      method: 'post',
      path: '/:projectId/content/documents',
      summary: 'Create a content document (optionally from a brief)',
      tags,
      auth: 'user',
      params: projectParams,
      body: contentDocumentCreateSchema,
      successStatus: 201,
      handler: async ({ user, params, body }) =>
        created(await service.createDocument(user, params.projectId, body)),
    }),
  ];
}

export function contentRoutes(deps: AppDeps): AnyRoute[] {
  const service = new ContentService(deps);
  const tags = ['Content'];
  const briefParams = z.object({ briefId: idSchema });
  return [
    route({
      method: 'get',
      path: '/briefs/:briefId',
      summary: 'Get a brief with its documents',
      tags,
      auth: 'user',
      params: briefParams,
      handler: async ({ user, params }) => ok(await service.getBrief(user, params.briefId)),
    }),
    route({
      method: 'patch',
      path: '/briefs/:briefId',
      summary: 'Update a brief',
      tags,
      auth: 'user',
      params: briefParams,
      body: contentBriefUpdateSchema,
      handler: async ({ user, params, body }) => ok(await service.updateBrief(user, params.briefId, body)),
    }),
    route({
      method: 'delete',
      path: '/briefs/:briefId',
      summary: 'Delete a brief (documents are kept)',
      tags,
      auth: 'user',
      params: briefParams,
      handler: async ({ user, params }) => {
        await service.deleteBrief(user, params.briefId);
        return noContent();
      },
    }),
    route({
      method: 'get',
      path: '/documents/:documentId',
      summary: 'Get a document with its latest version and generation status',
      tags,
      auth: 'user',
      params: docParams,
      handler: async ({ user, params }) => ok(await service.getDocument(user, params.documentId)),
    }),
    route({
      method: 'patch',
      path: '/documents/:documentId',
      summary: 'Update title, assignee or workflow status (Draft → In review → Approved → Published)',
      tags,
      auth: 'user',
      params: docParams,
      body: contentDocumentUpdateSchema,
      handler: async ({ user, params, body }) =>
        ok(await service.updateDocument(user, params.documentId, body)),
    }),
    route({
      method: 'delete',
      path: '/documents/:documentId',
      summary: 'Delete a document and its versions',
      tags,
      auth: 'user',
      params: docParams,
      handler: async ({ user, params }) => {
        await service.deleteDocument(user, params.documentId);
        return noContent();
      },
    }),
    route({
      method: 'get',
      path: '/documents/:documentId/versions',
      summary: 'Version history',
      tags,
      auth: 'user',
      params: docParams,
      handler: async ({ user, params }) => ok(await service.listVersions(user, params.documentId)),
    }),
    route({
      method: 'post',
      path: '/documents/:documentId/versions',
      summary: 'Save an edited version',
      tags,
      auth: 'user',
      params: docParams,
      body: contentVersionSaveSchema,
      successStatus: 201,
      handler: async ({ user, params, body }) =>
        created(await service.saveVersion(user, params.documentId, body)),
    }),
    route({
      method: 'get',
      path: '/documents/:documentId/versions/:versionId',
      summary: 'Get a specific version',
      tags,
      auth: 'user',
      params: z.object({ documentId: idSchema, versionId: idSchema }),
      handler: async ({ user, params }) =>
        ok(await service.getVersion(user, params.documentId, params.versionId)),
    }),
    route({
      method: 'post',
      path: '/documents/:documentId/versions/:versionId/restore',
      summary: 'Restore an earlier version (creates a new version)',
      tags,
      auth: 'user',
      params: z.object({ documentId: idSchema, versionId: idSchema }),
      successStatus: 201,
      handler: async ({ user, params }) =>
        created(await service.restoreVersion(user, params.documentId, params.versionId)),
    }),
    route({
      method: 'post',
      path: '/documents/:documentId/generate',
      summary: 'Generate an outline, article, meta tags, FAQs, schema or one section (background job)',
      tags,
      auth: 'user',
      params: docParams,
      body: contentGenerateSchema,
      successStatus: 202,
      handler: async ({ user, params, body }) =>
        accepted(await service.generate(user, params.documentId, body)),
    }),
    route({
      method: 'get',
      path: '/documents/:documentId/internal-links',
      summary: 'Internal link suggestions from the latest crawl',
      tags,
      auth: 'user',
      params: docParams,
      handler: async ({ user, params }) => ok(await service.internalLinks(user, params.documentId)),
    }),
    route({
      method: 'get',
      path: '/documents/:documentId/export',
      summary: 'Download the latest version as Markdown or HTML',
      tags,
      auth: 'user',
      params: docParams,
      query: z.object({ format: z.enum(['md', 'html']).default('md') }),
      produces: 'text/markdown',
      handler: async ({ res, user, params, query }) => {
        const file = await service.export(user, params.documentId, query.format);
        res.setHeader('Content-Type', file.contentType);
        res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
        res.status(200).send(file.body);
      },
    }),
  ];
}
