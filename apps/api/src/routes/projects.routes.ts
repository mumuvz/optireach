import {
  competitorInputSchema,
  competitorUpdateSchema,
  idSchema,
  projectCreateSchema,
  projectUpdateSchema,
} from '@surfaced/shared';
import { z } from 'zod';
import { created, noContent, ok } from '../lib/http';
import { route, type AnyRoute } from '../lib/router';
import { ProjectService } from '../services/project.service';
import type { AppDeps } from '../types';

const projectParams = z.object({ projectId: idSchema });
const competitorParams = z.object({ projectId: idSchema, competitorId: idSchema });

export function projectRoutes(deps: AppDeps): AnyRoute[] {
  const service = new ProjectService(deps);
  const tags = ['Projects'];
  const competitorTags = ['Competitors'];

  return [
    route({
      method: 'get',
      path: '/',
      summary: 'List projects in a workspace',
      tags,
      auth: 'user',
      query: z.object({ workspaceId: idSchema }),
      handler: async ({ user, query }) => ok(await service.list(user, query.workspaceId)),
    }),
    route({
      method: 'post',
      path: '/',
      summary: 'Create a project (website, business profile, competitors, primary keywords)',
      tags,
      auth: 'user',
      body: projectCreateSchema.extend({ workspaceId: idSchema }),
      successStatus: 201,
      handler: async ({ req, user, body }) => {
        const { workspaceId, ...input } = body;
        return created(await service.create(user, workspaceId, input, req.clientIp));
      },
    }),
    route({
      method: 'get',
      path: '/:projectId',
      summary: 'Get a project',
      tags,
      auth: 'user',
      params: projectParams,
      handler: async ({ user, params }) => ok(await service.get(user, params.projectId)),
    }),
    route({
      method: 'patch',
      path: '/:projectId',
      summary: 'Update a project',
      tags,
      auth: 'user',
      params: projectParams,
      body: projectUpdateSchema,
      handler: async ({ user, params, body }) => ok(await service.update(user, params.projectId, body)),
    }),
    route({
      method: 'delete',
      path: '/:projectId',
      summary: 'Delete a project and all of its data',
      tags,
      auth: 'user',
      params: projectParams,
      handler: async ({ req, user, params }) => {
        await service.remove(user, params.projectId, req.clientIp);
        return noContent();
      },
    }),
    route({
      method: 'get',
      path: '/:projectId/history',
      summary: 'Project activity history',
      tags,
      auth: 'user',
      params: projectParams,
      handler: async ({ user, params }) => ok(await service.history(user, params.projectId)),
    }),
    route({
      method: 'get',
      path: '/:projectId/competitors',
      summary: 'List competitors',
      tags: competitorTags,
      auth: 'user',
      params: projectParams,
      handler: async ({ user, params }) => ok(await service.listCompetitors(user, params.projectId)),
    }),
    route({
      method: 'post',
      path: '/:projectId/competitors',
      summary: 'Add a competitor',
      tags: competitorTags,
      auth: 'user',
      params: projectParams,
      body: competitorInputSchema,
      successStatus: 201,
      handler: async ({ user, params, body }) =>
        created(await service.addCompetitor(user, params.projectId, body)),
    }),
    route({
      method: 'patch',
      path: '/:projectId/competitors/:competitorId',
      summary: 'Update a competitor',
      tags: competitorTags,
      auth: 'user',
      params: competitorParams,
      body: competitorUpdateSchema,
      handler: async ({ user, params, body }) =>
        ok(await service.updateCompetitor(user, params.projectId, params.competitorId, body)),
    }),
    route({
      method: 'delete',
      path: '/:projectId/competitors/:competitorId',
      summary: 'Remove a competitor',
      tags: competitorTags,
      auth: 'user',
      params: competitorParams,
      handler: async ({ user, params }) => {
        await service.removeCompetitor(user, params.projectId, params.competitorId);
        return noContent();
      },
    }),
  ];
}
