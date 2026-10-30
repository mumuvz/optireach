import {
  agencyLinkRequestSchema,
  agencyLinkUpdateSchema,
  clientWorkspaceCreateSchema,
  idSchema,
} from '@surfaced/shared';
import { z } from 'zod';
import { created, noContent, ok } from '../lib/http';
import { route, type AnyRoute } from '../lib/router';
import { AgencyService } from '../services/agency.service';
import type { AppDeps } from '../types';

export function agencyRoutes(deps: AppDeps): { agency: AnyRoute[]; workspace: AnyRoute[] } {
  const service = new AgencyService(deps);
  const tags = ['Agency'];
  const agencyParams = z.object({ workspaceId: idSchema });

  const agency: AnyRoute[] = [
    route({
      method: 'get',
      path: '/:workspaceId/clients',
      summary: 'Client workspaces this agency manages, with eligibility and the agency code',
      tags,
      auth: 'user',
      params: agencyParams,
      handler: async ({ user, params }) => ok(await service.listClients(user, params.workspaceId)),
    }),
    route({
      method: 'post',
      path: '/:workspaceId/clients',
      summary: 'Create a client workspace managed by this agency (optionally inviting the client)',
      tags,
      auth: 'user',
      params: agencyParams,
      body: clientWorkspaceCreateSchema,
      successStatus: 201,
      handler: async ({ user, params, body, req }) =>
        created(await service.createClient(user, params.workspaceId, body, req.clientIp)),
    }),
    route({
      method: 'post',
      path: '/:workspaceId/links/:linkId/accept',
      summary: "Accept a client's request to be managed by this agency",
      tags,
      auth: 'user',
      params: z.object({ workspaceId: idSchema, linkId: idSchema }),
      handler: async ({ user, params }) =>
        ok(await service.acceptLink(user, params.workspaceId, params.linkId)),
    }),
    route({
      method: 'delete',
      path: '/:workspaceId/links/:linkId',
      summary: "End the agency's access to a client workspace (or decline a request)",
      tags,
      auth: 'user',
      params: z.object({ workspaceId: idSchema, linkId: idSchema }),
      handler: async ({ user, params }) => ok(await service.endLink(user, params.workspaceId, params.linkId)),
    }),
    route({
      method: 'delete',
      path: '/:workspaceId/clients/:clientWorkspaceId',
      summary: 'Delete a client workspace the agency created and never handed over to a client owner',
      tags,
      auth: 'user',
      params: z.object({ workspaceId: idSchema, clientWorkspaceId: idSchema }),
      handler: async ({ user, params }) => {
        await service.deleteClient(user, params.workspaceId, params.clientWorkspaceId);
        return noContent();
      },
    }),
  ];

  const workspace: AnyRoute[] = [
    route({
      method: 'get',
      path: '/:workspaceId/agency',
      summary: 'The agency managing this workspace (or a pending request), if any',
      tags,
      auth: 'user',
      params: agencyParams,
      handler: async ({ user, params }) => ok(await service.clientLink(user, params.workspaceId)),
    }),
    route({
      method: 'post',
      path: '/:workspaceId/agency',
      summary: 'Ask an agency (by its code) to manage this workspace (owners only)',
      tags,
      auth: 'user',
      params: agencyParams,
      body: agencyLinkRequestSchema,
      successStatus: 201,
      handler: async ({ user, params, body }) =>
        created(await service.requestLink(user, params.workspaceId, body)),
    }),
    route({
      method: 'patch',
      path: '/:workspaceId/agency',
      summary: "Change the agency's access level or approval delegation (owners only)",
      tags,
      auth: 'user',
      params: agencyParams,
      body: agencyLinkUpdateSchema,
      handler: async ({ user, params, body }) => ok(await service.updateLink(user, params.workspaceId, body)),
    }),
    route({
      method: 'delete',
      path: '/:workspaceId/agency',
      summary: 'Revoke agency access immediately (owners and admins)',
      tags,
      auth: 'user',
      params: agencyParams,
      handler: async ({ user, params }) => ok(await service.revokeLink(user, params.workspaceId)),
    }),
  ];

  return { agency, workspace };
}
