import {
  TREND_EXPORT_PARTS,
  idSchema,
  trendBriefSchema,
  trendImportSchema,
  trendSaveKeywordsSchema,
  trendSavedQuerySchema,
  trendSavedQueryUpdateSchema,
  trendSettingsSchema,
} from '@surfaced/shared';
import { z } from 'zod';
import { accepted, created, noContent, ok } from '../lib/http';
import { route, type AnyRoute } from '../lib/router';
import { TrendsService } from '../services/trends.service';
import type { AppDeps } from '../types';

const projectParams = z.object({ projectId: idSchema });
const reportParams = projectParams.extend({ reportId: idSchema });
const savedParams = projectParams.extend({ savedId: idSchema });

/** Keyword trends (Google Trends data from a configured provider or CSV, compared with the site), under /projects. */
export function projectTrendRoutes(deps: AppDeps): AnyRoute[] {
  const service = new TrendsService(deps);
  const tags = ['Keyword trends'];
  return [
    route({
      method: 'get',
      path: '/:projectId/trends/status',
      summary: 'Trends providers (enabled, configured, health, last error), Search Console, AI and limits',
      tags,
      auth: 'user',
      params: projectParams,
      handler: async ({ user, params }) => ok(await service.status(user, params.projectId)),
    }),
    route({
      method: 'get',
      path: '/:projectId/trends/categories',
      summary: 'Google Trends categories (id, name, parent path)',
      tags,
      auth: 'user',
      params: projectParams,
      handler: async ({ user, params }) => ok(await service.categories(user, params.projectId)),
    }),
    route({
      method: 'get',
      path: '/:projectId/trends/latest',
      summary: 'Latest trends report with its data and comparison (null when none)',
      tags,
      auth: 'user',
      params: projectParams,
      handler: async ({ user, params }) => ok(await service.latest(user, params.projectId)),
    }),
    route({
      method: 'get',
      path: '/:projectId/trends/reports',
      summary: 'Recent trends reports (history)',
      tags,
      auth: 'user',
      params: projectParams,
      handler: async ({ user, params }) => ok(await service.list(user, params.projectId)),
    }),
    route({
      method: 'get',
      path: '/:projectId/trends/reports/:reportId',
      summary: 'One trends report with its data, status and comparison',
      tags,
      auth: 'user',
      params: reportParams,
      handler: async ({ user, params }) => ok(await service.get(user, params.projectId, params.reportId)),
    }),
    route({
      method: 'post',
      path: '/:projectId/trends',
      summary: 'Fetch live Google Trends data from a provider and compare it with the site (background job)',
      tags,
      auth: 'user',
      params: projectParams,
      body: trendSettingsSchema,
      successStatus: 202,
      handler: async ({ user, params, body }) =>
        accepted(await service.fetchLive(user, params.projectId, body)),
    }),
    route({
      method: 'post',
      path: '/:projectId/trends/import/preview',
      summary: 'Read Google Trends CSV exports without saving them (what each file contains)',
      tags,
      auth: 'user',
      params: projectParams,
      body: trendImportSchema,
      handler: async ({ user, params, body }) =>
        ok(await service.previewImport(user, params.projectId, body)),
    }),
    route({
      method: 'post',
      path: '/:projectId/trends/import',
      summary: 'Import Google Trends CSV exports and compare them with the site (background job)',
      tags,
      auth: 'user',
      params: projectParams,
      body: trendImportSchema,
      successStatus: 202,
      handler: async ({ user, params, body }) =>
        accepted(await service.importCsv(user, params.projectId, body)),
    }),
    route({
      method: 'get',
      path: '/:projectId/trends/reports/:reportId/export',
      summary: 'Export one part of a report as CSV, with its source and retrieval time on every row',
      tags,
      auth: 'user',
      params: reportParams,
      query: z.object({ part: z.enum(TREND_EXPORT_PARTS).default('interest') }),
      produces: 'text/csv',
      handler: async ({ res, user, params, query }) => {
        const file = await service.exportCsv(user, params.projectId, params.reportId, query.part);
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
        res.status(200).send(file.csv);
      },
    }),
    route({
      method: 'post',
      path: '/:projectId/trends/reports/:reportId/keywords',
      summary: 'Save report terms to the project keywords, optionally in a keyword list',
      tags,
      auth: 'user',
      params: reportParams,
      body: trendSaveKeywordsSchema,
      handler: async ({ user, params, body }) =>
        ok(await service.saveKeywords(user, params.projectId, params.reportId, body)),
    }),
    route({
      method: 'post',
      path: '/:projectId/trends/reports/:reportId/briefs',
      summary: 'Plan content for a term: a content brief, plus a task when a due date is given',
      tags,
      auth: 'user',
      params: reportParams,
      body: trendBriefSchema,
      successStatus: 201,
      handler: async ({ user, params, body }) =>
        created(await service.createBrief(user, params.projectId, params.reportId, body)),
    }),
    route({
      method: 'post',
      path: '/:projectId/trends/reports/:reportId/recommendations',
      summary: 'Save one placement suggestion as a recommendation',
      tags,
      auth: 'user',
      params: reportParams,
      body: z.object({ term: z.string().trim().min(1).max(200) }),
      handler: async ({ user, params, body }) =>
        ok(await service.savePlacement(user, params.projectId, params.reportId, body.term)),
    }),
    route({
      method: 'get',
      path: '/:projectId/trends/saved',
      summary: 'Saved comparisons (with refresh schedules)',
      tags,
      auth: 'user',
      params: projectParams,
      handler: async ({ user, params }) => ok(await service.listSaved(user, params.projectId)),
    }),
    route({
      method: 'post',
      path: '/:projectId/trends/saved',
      summary: 'Save a comparison, optionally refreshed weekly or monthly',
      tags,
      auth: 'user',
      params: projectParams,
      body: trendSavedQuerySchema,
      successStatus: 201,
      handler: async ({ user, params, body }) =>
        created(await service.createSaved(user, params.projectId, body)),
    }),
    route({
      method: 'patch',
      path: '/:projectId/trends/saved/:savedId',
      summary: 'Rename a saved comparison or change its schedule',
      tags,
      auth: 'user',
      params: savedParams,
      body: trendSavedQueryUpdateSchema,
      handler: async ({ user, params, body }) =>
        ok(await service.updateSaved(user, params.projectId, params.savedId, body)),
    }),
    route({
      method: 'delete',
      path: '/:projectId/trends/saved/:savedId',
      summary: 'Delete a saved comparison (its reports are kept)',
      tags,
      auth: 'user',
      params: savedParams,
      handler: async ({ user, params }) => {
        await service.deleteSaved(user, params.projectId, params.savedId);
        return noContent();
      },
    }),
    route({
      method: 'post',
      path: '/:projectId/trends/saved/:savedId/run',
      summary: 'Run a saved comparison now (background job)',
      tags,
      auth: 'user',
      params: savedParams,
      successStatus: 202,
      handler: async ({ user, params }) =>
        accepted(await service.runSaved(user, params.projectId, params.savedId)),
    }),
  ];
}
