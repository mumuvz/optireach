import {
  idSchema,
  manualObservationSchema,
  observationListQuerySchema,
  paginationSchema,
  promptBulkInputSchema,
  promptInputSchema,
  promptListQuerySchema,
  promptUpdateSchema,
  startVisibilityRunSchema,
  visibilityFilterSchema,
  visibilityTrendQuerySchema,
} from '@surfaced/shared';
import { z } from 'zod';
import { accepted, created, noContent, ok } from '../lib/http';
import { route, type AnyRoute } from '../lib/router';
import { VisibilityService } from '../services/visibility.service';
import type { AppDeps } from '../types';

const projectParams = z.object({ projectId: idSchema });

/** Project-scoped prompt and visibility endpoints, mounted under /projects. */
export function projectVisibilityRoutes(deps: AppDeps): AnyRoute[] {
  const service = new VisibilityService(deps);
  const tags = ['AI visibility'];
  return [
    route({
      method: 'get',
      path: '/:projectId/prompts',
      summary: 'List tracked prompts',
      tags: ['Prompts'],
      auth: 'user',
      params: projectParams,
      query: promptListQuerySchema,
      handler: async ({ user, params, query }) => {
        const { items, meta } = await service.listPrompts(user, params.projectId, query);
        return ok(items, meta);
      },
    }),
    route({
      method: 'post',
      path: '/:projectId/prompts',
      summary: 'Create a tracked prompt',
      tags: ['Prompts'],
      auth: 'user',
      params: projectParams,
      body: promptInputSchema,
      successStatus: 201,
      handler: async ({ user, params, body }) =>
        created(await service.createPrompt(user, params.projectId, body)),
    }),
    route({
      method: 'post',
      path: '/:projectId/prompts/bulk',
      summary:
        'Add up to 100 prompts with the same settings (duplicates and short lines are skipped and reported)',
      tags: ['Prompts'],
      auth: 'user',
      params: projectParams,
      body: promptBulkInputSchema,
      successStatus: 201,
      handler: async ({ user, params, body }) =>
        created(await service.createPromptsBulk(user, params.projectId, body)),
    }),
    route({
      method: 'post',
      path: '/:projectId/ai-visibility/runs',
      summary: 'Run visibility checks now for active (or selected) prompts',
      tags,
      auth: 'user',
      params: projectParams,
      body: startVisibilityRunSchema,
      successStatus: 202,
      handler: async ({ user, params, body }) =>
        accepted(await service.startRun(user, params.projectId, body.promptIds)),
    }),
    route({
      method: 'get',
      path: '/:projectId/ai-visibility/runs',
      summary: 'List visibility runs',
      tags,
      auth: 'user',
      params: projectParams,
      query: paginationSchema,
      handler: async ({ user, params, query }) => {
        const { items, meta } = await service.listRuns(user, params.projectId, query.page, query.pageSize);
        return ok(items, meta);
      },
    }),
    route({
      method: 'get',
      path: '/:projectId/ai-visibility/summary',
      summary:
        'Mention rate, citation rate, competitor rates, share of voice and sources for a filtered observation set',
      description:
        'The response includes the composition of the observation set (providers, locales, prompts, period) and notes when providers or locales are mixed.',
      tags,
      auth: 'user',
      params: projectParams,
      query: visibilityFilterSchema,
      handler: async ({ user, params, query }) => ok(await service.summary(user, params.projectId, query)),
    }),
    route({
      method: 'get',
      path: '/:projectId/ai-visibility/trend',
      summary: 'Visibility trend by day, week or month',
      tags,
      auth: 'user',
      params: projectParams,
      query: visibilityTrendQuerySchema,
      handler: async ({ user, params, query }) => {
        const { bucket, ...filter } = query;
        return ok(await service.trend(user, params.projectId, filter, bucket));
      },
    }),
    route({
      method: 'get',
      path: '/:projectId/ai-visibility/observations',
      summary: 'Observations behind the metrics (filterable)',
      tags,
      auth: 'user',
      params: projectParams,
      query: observationListQuerySchema,
      handler: async ({ user, params, query }) => {
        const { items, meta } = await service.observations(user, params.projectId, query);
        return ok(items, meta);
      },
    }),
    route({
      method: 'post',
      path: '/:projectId/ai-visibility/observations/manual',
      summary:
        'Record what a person saw in an AI system without an API (Google AI Mode, AI Overviews, ChatGPT…)',
      tags,
      auth: 'user',
      params: projectParams,
      body: manualObservationSchema,
      successStatus: 201,
      handler: async ({ user, params, body }) =>
        created(await service.recordManualObservation(user, params.projectId, body)),
    }),
    route({
      method: 'get',
      path: '/:projectId/ai-visibility/citations',
      summary: 'Most cited domains with sample URLs',
      tags,
      auth: 'user',
      params: projectParams,
      query: visibilityFilterSchema,
      handler: async ({ user, params, query }) => ok(await service.citations(user, params.projectId, query)),
    }),
  ];
}

export function promptRoutes(deps: AppDeps): AnyRoute[] {
  const service = new VisibilityService(deps);
  const tags = ['Prompts'];
  const params = z.object({ promptId: idSchema });
  return [
    route({
      method: 'get',
      path: '/:promptId',
      summary: 'Get a prompt',
      tags,
      auth: 'user',
      params,
      handler: async ({ user, params: p }) => ok(await service.getPrompt(user, p.promptId)),
    }),
    route({
      method: 'patch',
      path: '/:promptId',
      summary: 'Update a prompt (pause, change providers, frequency, competitors)',
      tags,
      auth: 'user',
      params,
      body: promptUpdateSchema,
      handler: async ({ user, params: p, body }) => ok(await service.updatePrompt(user, p.promptId, body)),
    }),
    route({
      method: 'delete',
      path: '/:promptId',
      summary: 'Delete a prompt and its observations',
      tags,
      auth: 'user',
      params,
      handler: async ({ user, params: p }) => {
        await service.deletePrompt(user, p.promptId);
        return noContent();
      },
    }),
    route({
      method: 'post',
      path: '/:promptId/run',
      summary: 'Run this prompt now',
      tags,
      auth: 'user',
      params,
      successStatus: 202,
      handler: async ({ user, params: p }) => {
        const prompt = await service.getPrompt(user, p.promptId);
        return accepted(await service.startRun(user, prompt.projectId, [p.promptId]));
      },
    }),
  ];
}

export function aiVisibilityRoutes(deps: AppDeps): AnyRoute[] {
  const service = new VisibilityService(deps);
  const tags = ['AI visibility'];
  return [
    route({
      method: 'get',
      path: '/providers',
      summary: 'Provider configuration status (configured, not configured, demo)',
      tags,
      auth: 'user',
      handler: () => ok(service.providers()),
    }),
    route({
      method: 'get',
      path: '/runs/:runId',
      summary: 'Visibility run detail',
      tags,
      auth: 'user',
      params: z.object({ runId: idSchema }),
      handler: async ({ user, params }) => ok(await service.getRun(user, params.runId)),
    }),
    route({
      method: 'get',
      path: '/observations/:observationId',
      summary: 'Full observation: answer, redacted raw response, mentions and citations',
      tags,
      auth: 'user',
      params: z.object({ observationId: idSchema }),
      handler: async ({ user, params }) => ok(await service.observation(user, params.observationId)),
    }),
  ];
}
