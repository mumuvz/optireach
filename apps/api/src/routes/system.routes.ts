import { resolveMembership } from '@surfaced/core/access';
import { pingDatabase } from '@surfaced/core/db';
import { getEnv } from '@surfaced/core/env';
import { Errors } from '@surfaced/core/errors';
import { requestJobCancellation, toJobDto } from '@surfaced/core/jobs';
import { pingRedis } from '@surfaced/core/redis';
import { can, idSchema, paginationSchema } from '@surfaced/shared';
import { z } from 'zod';
import { noContent, ok, pageMeta, paginate } from '../lib/http';
import { route, type AnyRoute } from '../lib/router';
import type { AppDeps, AuthUser } from '../types';

export function healthRoutes(deps: AppDeps): AnyRoute[] {
  return [
    route({
      method: 'get',
      path: '/',
      summary: 'Liveness and dependency health',
      tags: ['System'],
      auth: 'public',
      handler: async () => {
        const [database, queue, redis] = await Promise.all([
          pingDatabase(),
          deps.queues.ping(),
          deps.redis ? pingRedis(deps.redis) : Promise.resolve(null),
        ]);
        const healthy = database && queue && redis !== false;
        return {
          status: healthy ? 200 : 503,
          data: { status: healthy ? 'ok' : 'degraded', checks: { database, queue, redis } },
        };
      },
    }),
  ];
}

export function metaRoutes(): AnyRoute[] {
  return [
    route({
      method: 'get',
      path: '/config',
      summary: 'Public runtime configuration (feature modes, never secrets)',
      tags: ['System'],
      auth: 'public',
      handler: () => {
        const env = getEnv();
        return ok({
          appName: env.APP_NAME,
          billing: {
            provider: env.BILLING_PROVIDER,
            mode:
              env.BILLING_PROVIDER === 'dev'
                ? 'development'
                : env.BILLING_PROVIDER === 'none'
                  ? 'disabled'
                  : 'live',
          },
          ai: {
            llmProvider: env.LLM_PROVIDER,
            contentGeneration:
              env.LLM_PROVIDER === 'none'
                ? 'disabled'
                : env.LLM_PROVIDER === 'dev'
                  ? 'development_adapter'
                  : 'configured',
            demoMode: env.AI_DEMO_MODE,
          },
          email: { mode: env.EMAIL_PROVIDER === 'console' ? 'local_log' : 'smtp' },
          integrations: { googleSearchConsole: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) },
          keywordData: { provider: env.KEYWORD_DATA_PROVIDER },
        });
      },
    }),
  ];
}

async function loadAuthorizedJob(deps: AppDeps, user: AuthUser, jobId: string) {
  const job = await deps.prisma.backgroundJob.findUnique({ where: { id: jobId } });
  if (!job) throw Errors.notFound('Job');
  if (job.workspaceId) {
    const member = await resolveMembership(deps.prisma, user.id, job.workspaceId);
    if (!member) throw Errors.notFound('Job');
    return { job, role: member.role };
  }
  if (job.userId !== user.id) throw Errors.notFound('Job');
  return { job, role: null };
}

export function jobRoutes(deps: AppDeps): AnyRoute[] {
  const tags = ['Jobs'];
  const params = z.object({ jobId: idSchema });
  return [
    route({
      method: 'get',
      path: '/:jobId',
      summary: 'Background job status and progress',
      tags,
      auth: 'user',
      params,
      handler: async ({ user, params: p }) =>
        ok(toJobDto((await loadAuthorizedJob(deps, user, p.jobId)).job)),
    }),
    route({
      method: 'post',
      path: '/:jobId/cancel',
      summary: 'Request cancellation of a queued or running job',
      tags,
      auth: 'user',
      params,
      handler: async ({ user, params: p }) => {
        const { job, role } = await loadAuthorizedJob(deps, user, p.jobId);
        if (role && !can(role, 'audit.cancel')) throw Errors.forbidden();
        const updated = await requestJobCancellation(deps.prisma, deps.queues, job);
        if (job.type === 'CRAWL' && job.entityId) {
          await deps.prisma.crawlJob.updateMany({
            where: { id: job.entityId },
            data: { cancelRequestedAt: new Date() },
          });
        }
        return ok(toJobDto(updated));
      },
    }),
  ];
}

export function notificationRoutes(deps: AppDeps): AnyRoute[] {
  const { prisma } = deps;
  const tags = ['Notifications'];
  return [
    route({
      method: 'get',
      path: '/',
      summary: 'List notifications',
      tags,
      auth: 'user',
      query: paginationSchema.extend({ unread: z.enum(['true', 'false']).optional() }),
      handler: async ({ user, query }) => {
        const where = { userId: user.id, ...(query.unread === 'true' ? { readAt: null } : {}) };
        const [total, unread, items] = await Promise.all([
          prisma.notification.count({ where }),
          prisma.notification.count({ where: { userId: user.id, readAt: null } }),
          prisma.notification.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            ...paginate(query.page, query.pageSize),
          }),
        ]);
        return ok(
          {
            unread,
            items: items.map((n) => ({
              id: n.id,
              type: n.type,
              title: n.title,
              body: n.body,
              link: n.link,
              read: Boolean(n.readAt),
              createdAt: n.createdAt.toISOString(),
            })),
          },
          pageMeta(query.page, query.pageSize, total),
        );
      },
    }),
    route({
      method: 'post',
      path: '/:notificationId/read',
      summary: 'Mark one notification as read',
      tags,
      auth: 'user',
      params: z.object({ notificationId: idSchema }),
      handler: async ({ user, params }) => {
        const result = await prisma.notification.updateMany({
          where: { id: params.notificationId, userId: user.id, readAt: null },
          data: { readAt: new Date() },
        });
        if (result.count === 0) {
          const exists = await prisma.notification.count({
            where: { id: params.notificationId, userId: user.id },
          });
          if (!exists) throw Errors.notFound('Notification');
        }
        return noContent();
      },
    }),
    route({
      method: 'post',
      path: '/read-all',
      summary: 'Mark all notifications as read',
      tags,
      auth: 'user',
      handler: async ({ user }) => {
        await prisma.notification.updateMany({
          where: { userId: user.id, readAt: null },
          data: { readAt: new Date() },
        });
        return noContent();
      },
    }),
  ];
}
