import { answerabilityRunSchema, idSchema, paginationSchema } from '@surfaced/shared';
import { z } from 'zod';
import { accepted, ok } from '../lib/http';
import { route, type AnyRoute } from '../lib/router';
import { AnswerabilityService } from '../services/answerability.service';
import type { AppDeps } from '../types';

const projectParams = z.object({ projectId: idSchema });
const runParams = z.object({ runId: idSchema });

/** Project-scoped answerability endpoints, mounted under /projects. */
export function projectAnswerabilityRoutes(deps: AppDeps): AnyRoute[] {
  const service = new AnswerabilityService(deps);
  const tags = ['Answerability'];
  return [
    route({
      method: 'get',
      path: '/:projectId/answerability/providers',
      summary: 'LLM providers available for the answerability audit',
      tags,
      auth: 'user',
      params: projectParams,
      handler: async ({ user, params }) => ok(await service.providers(user, params.projectId)),
    }),
    route({
      method: 'get',
      path: '/:projectId/answerability/latest',
      summary: 'The latest answerability run with its assessment and job progress',
      tags,
      auth: 'user',
      params: projectParams,
      handler: async ({ user, params }) => ok(await service.latest(user, params.projectId)),
    }),
    route({
      method: 'get',
      path: '/:projectId/answerability/runs',
      summary: 'List answerability runs',
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
      method: 'post',
      path: '/:projectId/answerability/run',
      summary: 'Run an AEO answerability analysis on the chosen LLM provider',
      description: 'Returns 202 with the run and background job id. Assesses from page structure, not full text.',
      tags,
      auth: 'user',
      params: projectParams,
      body: answerabilityRunSchema,
      successStatus: 202,
      handler: async ({ user, params, body }) =>
        accepted(await service.run(user, params.projectId, body)),
    }),
  ];
}

/** Run-scoped answerability endpoints, mounted under /answerability. */
export function answerabilityRoutes(deps: AppDeps): AnyRoute[] {
  const service = new AnswerabilityService(deps);
  const tags = ['Answerability'];
  return [
    route({
      method: 'get',
      path: '/runs/:runId',
      summary: 'An answerability run with its assessment',
      tags,
      auth: 'user',
      params: runParams,
      handler: async ({ user, params }) => ok(await service.detail(user, params.runId)),
    }),
  ];
}
