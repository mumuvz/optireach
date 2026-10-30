import {
  COLLECTION_ACTIONS,
  LOCAL_RANK_SOURCES,
  localCollectionStartSchema,
  googleCaptureAppendSchema,
  googleCaptureSchema,
  idSchema,
  localImportSchema,
  localRankQueryInputSchema,
  locationInputSchema,
  manualPointSchema,
} from '@surfaced/shared';
import { z } from 'zod';
import { accepted, created, noContent, ok } from '../lib/http';
import { route, type AnyRoute } from '../lib/router';
import { LocalService, localRankQueryUpdateSchema } from '../services/local.service';
import type { AppDeps } from '../types';

const projectParams = z.object({ projectId: idSchema });
const locationParams = projectParams.extend({ locationId: idSchema });
const queryParams = projectParams.extend({ queryId: idSchema });
const scanParams = projectParams.extend({ scanId: idSchema });

/** Local SEO: business locations, local rank grids and local competitors, under /projects. */
export function projectLocalRoutes(deps: AppDeps): AnyRoute[] {
  const service = new LocalService(deps);
  const tags = ['Local SEO'];
  return [
    route({
      method: 'get',
      path: '/:projectId/local/status',
      summary: 'Local rank sources (licensed, manual), grid point usage, location limits and compliance note',
      tags,
      auth: 'user',
      params: projectParams,
      handler: async ({ user, params }) => ok(await service.status(user, params.projectId)),
    }),
    route({
      method: 'get',
      path: '/:projectId/local/overview',
      summary: 'Local Search & AI Visibility: one card per surface, with source, freshness and limitations',
      tags,
      auth: 'user',
      params: projectParams,
      query: z.object({
        locationId: idSchema.optional(),
        days: z.coerce.number().int().min(7).max(90).default(28),
      }),
      handler: async ({ user, params, query }) =>
        ok(await service.overview(user, params.projectId, query.locationId, query.days)),
    }),
    route({
      method: 'get',
      path: '/:projectId/locations',
      summary: 'Business locations of the project',
      tags,
      auth: 'user',
      params: projectParams,
      handler: async ({ user, params }) => ok(await service.listLocations(user, params.projectId)),
    }),
    route({
      method: 'post',
      path: '/:projectId/locations',
      summary: 'Add a business location (counts against the plan location limit)',
      tags,
      auth: 'user',
      params: projectParams,
      body: locationInputSchema,
      successStatus: 201,
      handler: async ({ user, params, body }) =>
        created(await service.createLocation(user, params.projectId, body)),
    }),
    route({
      method: 'put',
      path: '/:projectId/locations/:locationId',
      summary: 'Replace the details of a business location',
      tags,
      auth: 'user',
      params: locationParams,
      body: locationInputSchema,
      handler: async ({ user, params, body }) =>
        ok(await service.updateLocation(user, params.projectId, params.locationId, body)),
    }),
    route({
      method: 'delete',
      path: '/:projectId/locations/:locationId',
      summary: 'Archive a location (history kept, tracked queries paused)',
      tags,
      auth: 'user',
      params: locationParams,
      handler: async ({ user, params }) => {
        await service.archiveLocation(user, params.projectId, params.locationId);
        return noContent();
      },
    }),
    route({
      method: 'get',
      path: '/:projectId/local/queries',
      summary: 'Tracked local queries with their latest scan',
      tags,
      auth: 'user',
      params: projectParams,
      query: z.object({ locationId: idSchema.optional() }),
      handler: async ({ user, params, query }) =>
        ok(await service.listQueries(user, params.projectId, query.locationId)),
    }),
    route({
      method: 'post',
      path: '/:projectId/local/queries',
      summary: 'Track a search query on a geographic grid around a location',
      tags,
      auth: 'user',
      params: projectParams,
      body: localRankQueryInputSchema,
      successStatus: 201,
      handler: async ({ user, params, body }) =>
        created(await service.createQuery(user, params.projectId, body)),
    }),
    route({
      method: 'patch',
      path: '/:projectId/local/queries/:queryId',
      summary: 'Change the schedule of a tracked query or pause it',
      tags,
      auth: 'user',
      params: queryParams,
      body: localRankQueryUpdateSchema,
      handler: async ({ user, params, body }) =>
        ok(await service.updateQuery(user, params.projectId, params.queryId, body)),
    }),
    route({
      method: 'delete',
      path: '/:projectId/local/queries/:queryId',
      summary: 'Stop tracking a query (deletes its scans)',
      tags,
      auth: 'user',
      params: queryParams,
      handler: async ({ user, params }) => {
        await service.deleteQuery(user, params.projectId, params.queryId);
        return noContent();
      },
    }),
    route({
      method: 'post',
      path: '/:projectId/local/queries/:queryId/scans',
      summary:
        'Scan the grid now: a licensed provider (background job, uses grid point quota) or a manual scan',
      tags,
      auth: 'user',
      params: queryParams,
      body: z.object({ source: z.enum(LOCAL_RANK_SOURCES) }),
      successStatus: 202,
      handler: async ({ user, params, body }) =>
        accepted(await service.startScan(user, params.projectId, params.queryId, body.source)),
    }),
    route({
      method: 'get',
      path: '/:projectId/local/queries/:queryId/scans',
      summary: 'Scan history of a query (grid visibility over time)',
      tags,
      auth: 'user',
      params: queryParams,
      handler: async ({ user, params }) =>
        ok(await service.listScans(user, params.projectId, params.queryId)),
    }),
    route({
      method: 'post',
      path: '/:projectId/local/queries/:queryId/import',
      summary:
        'Import local observations from a CSV (row, col, business, optional rank/ratings) as an import scan',
      tags,
      auth: 'user',
      params: queryParams,
      body: localImportSchema,
      successStatus: 201,
      handler: async ({ user, params, body }) =>
        created(await service.importObservations(user, params.projectId, params.queryId, body)),
    }),
    route({
      method: 'post',
      path: '/:projectId/local/queries/:queryId/google-capture',
      summary:
        'Store Google results pages you saved in your browser (address + saved HTML per page). OptiReach reads the files only and never requests Google.',
      tags,
      auth: 'user',
      params: queryParams,
      body: googleCaptureSchema,
      handler: async ({ user, params, body }) =>
        ok(await service.captureGooglePage(user, params.projectId, params.queryId, body)),
    }),
    route({
      method: 'post',
      path: '/:projectId/local/queries/:queryId/collections',
      summary:
        'Start an automatic collection of the query from a configured, batch-capable source (batches until the target or the end of the source)',
      tags,
      auth: 'user',
      params: queryParams,
      body: localCollectionStartSchema,
      successStatus: 202,
      handler: async ({ user, params, body }) =>
        accepted(await service.startCollection(user, params.projectId, params.queryId, body)),
    }),
    route({
      method: 'post',
      path: '/:projectId/local/scans/:scanId/collection/:action',
      summary: 'Pause, resume, retry or cancel an automatic collection (collected listings are always kept)',
      tags,
      auth: 'user',
      params: scanParams.extend({ action: z.enum(COLLECTION_ACTIONS) }),
      handler: async ({ user, params }) =>
        ok(await service.controlCollection(user, params.projectId, params.scanId, params.action)),
    }),
    route({
      method: 'post',
      path: '/:projectId/local/scans/:scanId/google-capture/pages',
      summary:
        'Add the next saved Google results page(s) to an unfinished collection (resumes it). Read from the files only.',
      tags,
      auth: 'user',
      params: scanParams,
      body: googleCaptureAppendSchema,
      handler: async ({ user, params, body }) =>
        ok(await service.appendGoogleCapture(user, params.projectId, params.scanId, body)),
    }),
    route({
      method: 'post',
      path: '/:projectId/local/scans/:scanId/google-capture/finish',
      summary: 'Stop a Google page collection before its target, keeping everything collected (PARTIAL)',
      tags,
      auth: 'user',
      params: scanParams,
      handler: async ({ user, params }) =>
        ok(await service.finishGoogleCapture(user, params.projectId, params.scanId)),
    }),
    route({
      method: 'get',
      path: '/:projectId/local/queries/:queryId/comparison',
      summary:
        'Businesses listed in the latest scan: appearances, top-3 counts, public ratings and review growth',
      tags,
      auth: 'user',
      params: queryParams,
      handler: async ({ user, params }) =>
        ok(await service.comparison(user, params.projectId, params.queryId)),
    }),
    route({
      method: 'get',
      path: '/:projectId/local/scans/:scanId',
      summary: 'One scan with every grid point and the businesses listed there',
      tags,
      auth: 'user',
      params: scanParams,
      handler: async ({ user, params }) => ok(await service.getScan(user, params.projectId, params.scanId)),
    }),
    route({
      method: 'post',
      path: '/:projectId/local/scans/:scanId/points',
      summary: 'Enter what you saw at one grid point of a manual scan',
      tags,
      auth: 'user',
      params: scanParams,
      body: manualPointSchema,
      handler: async ({ user, params, body }) =>
        ok(await service.enterManualPoint(user, params.projectId, params.scanId, body)),
    }),
    route({
      method: 'post',
      path: '/:projectId/local/scans/:scanId/finish',
      summary: 'Finish a manual scan (points not entered stay unmeasured)',
      tags,
      auth: 'user',
      params: scanParams,
      handler: async ({ user, params }) =>
        ok(await service.finishManualScan(user, params.projectId, params.scanId)),
    }),
    route({
      method: 'get',
      path: '/:projectId/local/scans/:scanId/export',
      summary: 'Export a scan as CSV (one row per business listed at each point)',
      tags,
      auth: 'user',
      params: scanParams,
      produces: 'text/csv',
      handler: async ({ res, user, params }) => {
        const file = await service.exportScan(user, params.projectId, params.scanId);
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
        res.status(200).send(file.csv);
      },
    }),
    route({
      method: 'get',
      path: '/:projectId/local/competitors',
      summary: 'Local competitors: suggested from scans, confirmed and dismissed',
      tags,
      auth: 'user',
      params: projectParams,
      handler: async ({ user, params }) => ok(await service.listLocalCompetitors(user, params.projectId)),
    }),
    route({
      method: 'patch',
      path: '/:projectId/local/competitors/:competitorId',
      summary: 'Confirm or dismiss a suggested local competitor',
      tags,
      auth: 'user',
      params: projectParams.extend({ competitorId: idSchema }),
      body: z.object({ status: z.enum(['CONFIRMED', 'DISMISSED']) }),
      handler: async ({ user, params, body }) =>
        ok(await service.setCompetitorStatus(user, params.projectId, params.competitorId, body.status)),
    }),
  ];
}
