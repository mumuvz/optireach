import { idSchema, localPostCreateSchema, localPostUpdateSchema } from '@surfaced/shared';
import { z } from 'zod';
import { created, noContent, ok } from '../lib/http';
import { route, type AnyRoute } from '../lib/router';
import { LocalPostService } from '../services/local-posts.service';
import type { AppDeps } from '../types';

const projectParams = z.object({ projectId: idSchema });
const postParams = projectParams.extend({ postId: idSchema });
const listQuery = z.object({ locationId: idSchema.optional(), status: z.string().trim().max(20).optional() });

/**
 * Google Business Profile posts under /projects. Served to the business's own signed-in users only; a post reaches
 * Google only through publish, which requires local.publish and an approval for the exact content.
 */
export function projectLocalPostRoutes(deps: AppDeps): AnyRoute[] {
  const service = new LocalPostService(deps);
  const tags = ['Business Profile'];
  return [
    route({
      method: 'get',
      path: '/:projectId/local/post-providers',
      summary: 'LLM providers available for AI post generation',
      tags,
      auth: 'user',
      params: projectParams,
      handler: async ({ user, params }) => ok(await service.providers(user, params.projectId)),
    }),
    route({
      method: 'get',
      path: '/:projectId/local/posts',
      summary: 'List Business Profile posts',
      tags,
      auth: 'user',
      params: projectParams,
      query: listQuery,
      handler: async ({ user, params, query }) => ok(await service.list(user, params.projectId, query)),
    }),
    route({
      method: 'post',
      path: '/:projectId/local/posts',
      summary: 'Create a Business Profile post draft (written or AI-generated)',
      tags,
      auth: 'user',
      params: projectParams,
      body: localPostCreateSchema,
      successStatus: 201,
      handler: async ({ user, params, body }) => created(await service.create(user, params.projectId, body)),
    }),
    route({
      method: 'patch',
      path: '/:projectId/local/posts/:postId',
      summary: 'Edit an unpublished post draft',
      tags,
      auth: 'user',
      params: postParams,
      body: localPostUpdateSchema,
      handler: async ({ user, params, body }) =>
        ok(await service.update(user, params.projectId, params.postId, body)),
    }),
    route({
      method: 'post',
      path: '/:projectId/local/posts/:postId/request-approval',
      summary: 'Send a post for approval before publishing',
      tags,
      auth: 'user',
      params: postParams,
      handler: async ({ user, params }) =>
        ok(await service.requestApproval(user, params.projectId, params.postId)),
    }),
    route({
      method: 'post',
      path: '/:projectId/local/posts/:postId/publish',
      summary: 'Publish an approved post to Google now',
      tags,
      auth: 'user',
      params: postParams,
      handler: async ({ user, params }) => ok(await service.publish(user, params.projectId, params.postId)),
    }),
    route({
      method: 'delete',
      path: '/:projectId/local/posts/:postId',
      summary: 'Discard an unpublished post',
      tags,
      auth: 'user',
      params: postParams,
      successStatus: 204,
      handler: async ({ user, params }) => {
        await service.discard(user, params.projectId, params.postId);
        return noContent();
      },
    }),
  ];
}
