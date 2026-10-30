import { workspaceParticipants } from '@surfaced/core/access';
import { recordAuditLog } from '@surfaced/core/audit-log';
import { Errors } from '@surfaced/core/errors';
import { getWorkspacePlan } from '@surfaced/core/billing';
import {
  auditLogListQuerySchema,
  idSchema,
  invitationAcceptSchema,
  invitationCreateSchema,
  memberRoleUpdateSchema,
  workspaceCreateSchema,
  workspaceUpdateSchema,
} from '@surfaced/shared';
import { z } from 'zod';
import { created, noContent, ok, pageMeta, paginate } from '../lib/http';
import { route, type AnyRoute } from '../lib/router';
import { requireWorkspaceAccess } from '../services/access';
import { toWorkspaceDto } from '../services/dto';
import { WorkspaceService } from '../services/workspace.service';
import type { AppDeps } from '../types';

const workspaceParams = z.object({ workspaceId: idSchema });

export function workspaceRoutes(deps: AppDeps): AnyRoute[] {
  const { prisma } = deps;
  const service = new WorkspaceService(deps);
  const tags = ['Workspaces'];

  return [
    route({
      method: 'get',
      path: '/',
      summary: 'List workspaces the current user belongs to',
      tags,
      auth: 'user',
      handler: async ({ user }) => ok(await service.list(user)),
    }),
    route({
      method: 'post',
      path: '/',
      summary: 'Create a workspace (starts on the Free plan)',
      tags,
      auth: 'user',
      body: workspaceCreateSchema,
      successStatus: 201,
      handler: async ({ user, body }) => created(await service.create(user, body.name)),
    }),
    route({
      method: 'post',
      path: '/invitations/accept',
      summary: 'Accept a workspace invitation',
      tags,
      auth: 'user',
      body: invitationAcceptSchema,
      handler: async ({ user, body }) => ok(await service.acceptInvitation(user, body.token)),
    }),
    route({
      method: 'get',
      path: '/:workspaceId',
      summary: 'Get a workspace',
      tags,
      auth: 'user',
      params: workspaceParams,
      handler: async ({ user, params }) => {
        const { workspace, role, via } = await requireWorkspaceAccess(
          prisma,
          user,
          params.workspaceId,
          'workspace.read',
        );
        const { plan } = await getWorkspacePlan(prisma, workspace.id);
        return ok({ ...toWorkspaceDto(workspace, role, via), plan: { key: plan.key, name: plan.name } });
      },
    }),
    route({
      method: 'patch',
      path: '/:workspaceId',
      summary: 'Update workspace name or white-label settings',
      tags,
      auth: 'user',
      params: workspaceParams,
      body: workspaceUpdateSchema,
      handler: async ({ user, params, body }) => {
        const { role, via } = await requireWorkspaceAccess(
          prisma,
          user,
          params.workspaceId,
          'workspace.update',
        );
        if (body.whiteLabel?.enabled) {
          const { limits, plan } = await getWorkspacePlan(prisma, params.workspaceId);
          if (!limits.whiteLabelReports)
            throw Errors.planLimit(`White-label reports are not included in the ${plan.name} plan.`);
        }
        const updated = await prisma.workspace.update({
          where: { id: params.workspaceId },
          data: { name: body.name, whiteLabel: body.whiteLabel },
        });
        await recordAuditLog(prisma, {
          action: 'workspace.updated',
          actorUserId: user.id,
          workspaceId: updated.id,
          targetType: 'Workspace',
          targetId: updated.id,
          metadata: { fields: Object.keys(body) },
        });
        return ok(toWorkspaceDto(updated, role, via));
      },
    }),
    route({
      method: 'get',
      path: '/:workspaceId/participants',
      summary:
        'People who can work in this workspace: members plus the managing agency team (assignee pickers)',
      tags,
      auth: 'user',
      params: workspaceParams,
      handler: async ({ user, params }) => {
        await requireWorkspaceAccess(prisma, user, params.workspaceId, 'members.read');
        const participants = await workspaceParticipants(prisma, params.workspaceId);
        const users = await prisma.user.findMany({
          where: { id: { in: participants.map((p) => p.userId) } },
          select: { id: true, name: true, email: true },
        });
        const byId = new Map(users.map((u) => [u.id, u]));
        return ok(
          participants
            .map((p) => ({
              userId: p.userId,
              name: byId.get(p.userId)?.name ?? 'Unknown',
              email: byId.get(p.userId)?.email ?? '',
              role: p.role,
              via: p.via,
            }))
            .sort((a, b) => (a.via === b.via ? a.name.localeCompare(b.name) : a.via === 'DIRECT' ? -1 : 1)),
        );
      },
    }),
    route({
      method: 'post',
      path: '/:workspaceId/switch',
      summary: 'Make this the current workspace',
      tags,
      auth: 'user',
      params: workspaceParams,
      handler: async ({ user, params }) => {
        const { workspace, role, via } = await requireWorkspaceAccess(
          prisma,
          user,
          params.workspaceId,
          'workspace.read',
        );
        await prisma.user.update({ where: { id: user.id }, data: { lastWorkspaceId: workspace.id } });
        return ok(toWorkspaceDto(workspace, role, via));
      },
    }),
    route({
      method: 'get',
      path: '/:workspaceId/members',
      summary: 'List members',
      tags,
      auth: 'user',
      params: workspaceParams,
      handler: async ({ user, params }) => ok(await service.members(user, params.workspaceId)),
    }),
    route({
      method: 'patch',
      path: '/:workspaceId/members/:memberId',
      summary: "Change a member's role",
      tags,
      auth: 'user',
      params: z.object({ workspaceId: idSchema, memberId: idSchema }),
      body: memberRoleUpdateSchema,
      handler: async ({ user, params, body }) => {
        const member = await service.changeRole(user, params.workspaceId, params.memberId, body.role);
        return ok({ id: member.id, role: member.role });
      },
    }),
    route({
      method: 'delete',
      path: '/:workspaceId/members/:memberId',
      summary: 'Remove a member (or leave the workspace)',
      tags,
      auth: 'user',
      params: z.object({ workspaceId: idSchema, memberId: idSchema }),
      handler: async ({ user, params }) => {
        await service.removeMember(user, params.workspaceId, params.memberId);
        return noContent();
      },
    }),
    route({
      method: 'get',
      path: '/:workspaceId/invitations',
      summary: 'List pending invitations',
      tags,
      auth: 'user',
      params: workspaceParams,
      handler: async ({ user, params }) => ok(await service.invitations(user, params.workspaceId)),
    }),
    route({
      method: 'post',
      path: '/:workspaceId/invitations',
      summary: 'Invite someone by email',
      tags,
      auth: 'user',
      params: workspaceParams,
      body: invitationCreateSchema,
      successStatus: 201,
      handler: async ({ req, user, params, body }) => {
        const invitation = await service.invite(
          user,
          params.workspaceId,
          body.email,
          body.role,
          req.clientIp,
        );
        return created({
          id: invitation.id,
          email: invitation.email,
          role: invitation.role,
          expiresAt: invitation.expiresAt.toISOString(),
        });
      },
    }),
    route({
      method: 'delete',
      path: '/:workspaceId/invitations/:invitationId',
      summary: 'Revoke an invitation',
      tags,
      auth: 'user',
      params: z.object({ workspaceId: idSchema, invitationId: idSchema }),
      handler: async ({ user, params }) => {
        await service.revokeInvitation(user, params.workspaceId, params.invitationId);
        return noContent();
      },
    }),
    route({
      method: 'get',
      path: '/:workspaceId/audit-logs',
      summary: 'Workspace audit log (owners and admins)',
      tags,
      auth: 'user',
      params: workspaceParams,
      query: auditLogListQuerySchema,
      handler: async ({ user, params, query }) => {
        await requireWorkspaceAccess(prisma, user, params.workspaceId, 'auditlog.read');
        const where = {
          workspaceId: params.workspaceId,
          ...(query.action ? { action: { startsWith: query.action } } : {}),
          ...(query.actorUserId ? { actorUserId: query.actorUserId } : {}),
        };
        const [total, logs] = await Promise.all([
          prisma.auditLog.count({ where }),
          prisma.auditLog.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            include: { actor: { select: { name: true, email: true } } },
            ...paginate(query.page, query.pageSize),
          }),
        ]);
        return ok(
          logs.map((l) => ({
            id: l.id,
            action: l.action,
            actor: l.actor ? { name: l.actor.name, email: l.actor.email } : null,
            targetType: l.targetType,
            targetId: l.targetId,
            metadata: l.metadata,
            createdAt: l.createdAt.toISOString(),
          })),
          pageMeta(query.page, query.pageSize, total),
        );
      },
    }),
  ];
}
