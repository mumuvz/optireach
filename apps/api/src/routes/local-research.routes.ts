import { idSchema, listingSearchSchema, localResearchRunSchema } from '@surfaced/shared';
import { z } from 'zod';
import { ok } from '../lib/http';
import { route, type AnyRoute } from '../lib/router';
import { LocalResearchService } from '../services/local-research.service';
import type { AppDeps } from '../types';

const projectParams = z.object({ projectId: idSchema });
const scanParams = projectParams.extend({ scanId: idSchema });
const researchParams = projectParams.extend({ researchId: idSchema });

/**
 * Business research on collected local rankings, under /projects: find a business by name across collected searches,
 * and research one listing (comparison with the listings above it + an AI action plan). Nothing is published.
 */
export function projectLocalResearchRoutes(deps: AppDeps): AnyRoute[] {
  const service = new LocalResearchService(deps);
  const tags = ['Local SEO'];
  return [
    route({
      method: 'get',
      path: '/:projectId/local/research-providers',
      summary: 'AI models available for business research',
      tags,
      auth: 'user',
      params: projectParams,
      handler: async ({ user, params }) => ok(await service.providers(user, params.projectId)),
    }),
    route({
      method: 'get',
      path: '/:projectId/local/listings',
      summary: 'Find a business by name in the collected searches, with its position in each (latest collection per search)', // prettier-ignore
      tags,
      auth: 'user',
      params: projectParams,
      query: listingSearchSchema,
      handler: async ({ user, params, query }) => ok(await service.search(user, params.projectId, query)),
    }),
    route({
      method: 'get',
      path: '/:projectId/local/scans/:scanId/research',
      summary: 'Research done on listings of a scan, newest first',
      tags,
      auth: 'user',
      params: scanParams,
      handler: async ({ user, params }) => ok(await service.list(user, params.projectId, params.scanId)),
    }),
    route({
      method: 'post',
      path: '/:projectId/local/scans/:scanId/research',
      summary:
        'Research one listing: how it compares with the listings ranked above it, and an AI action plan citing that comparison', // prettier-ignore
      tags,
      auth: 'user',
      params: scanParams,
      body: localResearchRunSchema,
      handler: async ({ user, params, body }) =>
        ok(await service.run(user, params.projectId, params.scanId, body)),
    }),
    route({
      method: 'get',
      path: '/:projectId/local/research/:researchId',
      summary: 'One business research: evidence, findings and action plan',
      tags,
      auth: 'user',
      params: researchParams,
      handler: async ({ user, params }) => ok(await service.get(user, params.projectId, params.researchId)),
    }),
  ];
}
