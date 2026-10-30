import { recordAuditLog } from '@surfaced/core/audit-log';
import { verifyPassword } from '@surfaced/core/crypto';
import { Errors } from '@surfaced/core/errors';
import {
  accountDeletionSchema,
  changePasswordSchema,
  idSchema,
  updatePreferencesSchema,
  updateProfileSchema,
} from '@surfaced/shared';
import { z } from 'zod';
import { noContent, ok } from '../lib/http';
import { route, type AnyRoute } from '../lib/router';
import { AuthService } from '../services/auth.service';
import { readNotificationPrefs, toUserDto } from '../services/dto';
import type { AppDeps } from '../types';
import { requestMeta } from './auth.routes';

export function userRoutes(deps: AppDeps): AnyRoute[] {
  const { prisma } = deps;
  const auth = new AuthService(deps);
  const tags = ['Users'];

  return [
    route({
      method: 'patch',
      path: '/me',
      summary: 'Update profile',
      tags,
      auth: 'user',
      body: updateProfileSchema,
      handler: async ({ user, body }) => {
        const updated = await prisma.user.update({ where: { id: user.id }, data: { name: body.name } });
        return ok(toUserDto(updated));
      },
    }),
    route({
      method: 'patch',
      path: '/me/preferences',
      summary: 'Update notification preferences',
      tags,
      auth: 'user',
      body: updatePreferencesSchema,
      handler: async ({ user, body }) => {
        const current = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
        const prefs = { ...readNotificationPrefs(current.notificationPrefs), ...body.notificationPrefs };
        const updated = await prisma.user.update({
          where: { id: user.id },
          data: { notificationPrefs: prefs },
        });
        return ok(toUserDto(updated));
      },
    }),
    route({
      method: 'post',
      path: '/me/password',
      summary: 'Change password (signs out other sessions)',
      tags,
      auth: 'user',
      body: changePasswordSchema,
      handler: async ({ req, auth: ctx, body }) => {
        await auth.changePassword(
          ctx!.user.id,
          body.currentPassword,
          body.newPassword,
          ctx!.sessionId,
          requestMeta(req),
        );
        return ok({ message: 'Password updated. Other sessions were signed out.' });
      },
    }),
    route({
      method: 'get',
      path: '/me/sessions',
      summary: 'List active sessions',
      tags,
      auth: 'user',
      handler: async ({ auth: ctx }) => {
        const sessions = await prisma.session.findMany({
          where: { userId: ctx!.user.id, expiresAt: { gt: new Date() } },
          orderBy: { lastSeenAt: 'desc' },
        });
        return ok(
          sessions.map((s) => ({
            id: s.id,
            current: s.id === ctx!.sessionId,
            userAgent: s.userAgent,
            ipAddress: s.ipAddress,
            createdAt: s.createdAt.toISOString(),
            lastSeenAt: s.lastSeenAt.toISOString(),
            expiresAt: s.expiresAt.toISOString(),
          })),
        );
      },
    }),
    route({
      method: 'delete',
      path: '/me/sessions/:sessionId',
      summary: 'Revoke a session',
      tags,
      auth: 'user',
      params: z.object({ sessionId: idSchema }),
      handler: async ({ user, params }) => {
        const result = await prisma.session.deleteMany({ where: { id: params.sessionId, userId: user.id } });
        if (result.count === 0) throw Errors.notFound('Session');
        return noContent();
      },
    }),
    route({
      method: 'post',
      path: '/me/deletion-request',
      summary: 'Request account deletion (14-day grace period)',
      description:
        'Owners of workspaces that have other members must transfer ownership first. Workspaces where the user is the only member are deleted with the account when the grace period ends.',
      tags,
      auth: 'user',
      body: accountDeletionSchema,
      handler: async ({ req, user, body }) => {
        const record = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
        if (!(await verifyPassword(record.passwordHash, body.password))) {
          throw Errors.validation([{ path: 'body.password', message: 'Your password is incorrect.' }]);
        }
        const owned = await prisma.workspaceMember.findMany({
          where: { userId: user.id, role: 'OWNER' },
          select: {
            workspaceId: true,
            workspace: { select: { name: true, _count: { select: { members: true } } } },
          },
        });
        for (const membership of owned) {
          if (membership.workspace._count.members > 1) {
            const owners = await prisma.workspaceMember.count({
              where: { workspaceId: membership.workspaceId, role: 'OWNER' },
            });
            if (owners <= 1) {
              throw Errors.conflict(
                `Transfer ownership of "${membership.workspace.name}" to another member before deleting your account.`,
              );
            }
          }
        }
        const updated = await prisma.user.update({
          where: { id: user.id },
          data: { deletionRequestedAt: new Date() },
        });
        await recordAuditLog(prisma, {
          action: 'user.deletion_requested',
          actorUserId: user.id,
          targetType: 'User',
          targetId: user.id,
          ipAddress: requestMeta(req).ip,
          metadata: { reasonProvided: Boolean(body.reason) },
        });
        return ok(toUserDto(updated));
      },
    }),
    route({
      method: 'delete',
      path: '/me/deletion-request',
      summary: 'Cancel a pending account deletion',
      tags,
      auth: 'user',
      handler: async ({ user }) => {
        const updated = await prisma.user.update({
          where: { id: user.id },
          data: { deletionRequestedAt: null },
        });
        await recordAuditLog(prisma, {
          action: 'user.deletion_cancelled',
          actorUserId: user.id,
          targetType: 'User',
          targetId: user.id,
        });
        return ok(toUserDto(updated));
      },
    }),
  ];
}
