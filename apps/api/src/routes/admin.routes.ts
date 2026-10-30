// Platform administration. Every route uses auth mode "admin", so non-admins get 404 and the area
// is not advertised. Every change is recorded in the audit log. Responses never include password
// hashes, tokens or provider credentials; providers are reported only as configured or not.
import { recordAuditLog } from '@surfaced/core/audit-log';
import { toPlanDto } from '@surfaced/core/billing';
import { pingDatabase, type BackgroundJob, type Prisma } from '@surfaced/core/db';
import { getEnv } from '@surfaced/core/env';
import { Errors } from '@surfaced/core/errors';
import { integrationCatalog } from '@surfaced/core/integrations';
import { toJobDto } from '@surfaced/core/jobs';
import type { QueueName } from '@surfaced/core/queue';
import { pingRedis } from '@surfaced/core/redis';
import { getUsageSummary } from '@surfaced/core/usage';
import { listVisibilityProviderStatuses } from '@surfaced/core/visibility';
import {
  DEFAULT_PLAN_KEY,
  USAGE_METRICS,
  USAGE_METRIC_LABELS,
  adminAuditLogListQuerySchema,
  adminJobListQuerySchema,
  adminUsageQuerySchema,
  adminUserListQuerySchema,
  adminUserUpdateSchema,
  adminWorkspaceListQuerySchema,
  idSchema,
  planUpdateSchema,
  usagePeriodKey,
  type BackgroundJobType,
} from '@surfaced/shared';
import type { Request } from 'express';
import { z } from 'zod';
import { iso, ok, pageMeta, paginate } from '../lib/http';
import { route, type AnyRoute } from '../lib/router';
import type { AppDeps } from '../types';

/**
 * Job types whose processors restart cleanly from their persisted entity (the report, snapshot,
 * gap analysis, sync or email delivery is reset at the start of each attempt). Crawls, audits, visibility runs and
 * content generation are started again from the product instead, so plan limits and the
 * "one active crawl per project" rule are re-checked.
 */
export const ADMIN_RETRYABLE_JOB_TYPES: ReadonlySet<BackgroundJobType> = new Set([
  'REPORT',
  'INTEGRATION_SYNC',
  'COMPETITOR_SNAPSHOT',
  'GAP_ANALYSIS',
  'SEO_COMPARISON',
  'TREND_REPORT',
  'EMAIL',
]);

const userParams = z.object({ userId: idSchema });
const workspaceParams = z.object({ workspaceId: idSchema });
const jobParams = z.object({ jobId: idSchema });
const planParams = z.object({ planKey: z.string().regex(/^[A-Z][A-Z0-9_]{1,31}$/) });

function requestMeta(req: Request) {
  return { ipAddress: req.clientIp, userAgent: req.get('user-agent') ?? null };
}

function toAdminJob(job: BackgroundJob) {
  return {
    ...toJobDto(job),
    queueName: job.queueName,
    workspaceId: job.workspaceId,
    projectId: job.projectId,
    userId: job.userId,
    retryable: job.status === 'FAILED' && ADMIN_RETRYABLE_JOB_TYPES.has(job.type),
  };
}

export function adminRoutes(deps: AppDeps): AnyRoute[] {
  const { prisma } = deps;
  const tags = ['Admin'];

  return [
    route({
      method: 'get',
      path: '/overview',
      summary: 'Platform totals: users, workspaces, plans, jobs, usage and email delivery',
      tags,
      auth: 'admin',
      handler: async () => {
        const now = new Date();
        const dayAgo = new Date(now.getTime() - 24 * 3600 * 1000);
        const weekAgo = new Date(now.getTime() - 7 * 24 * 3600 * 1000);
        const periodKey = usagePeriodKey(now);
        const [
          users,
          verifiedUsers,
          disabledUsers,
          workspaces,
          projects,
          plans,
          subscriptions,
          jobs,
          activeJobs,
          usage,
          emails,
        ] = await Promise.all([
          prisma.user.count(),
          prisma.user.count({ where: { emailVerifiedAt: { not: null } } }),
          prisma.user.count({ where: { disabledAt: { not: null } } }),
          prisma.workspace.count(),
          prisma.project.count(),
          prisma.subscriptionPlan.findMany({
            select: { id: true, key: true, name: true },
            orderBy: { sortOrder: 'asc' },
          }),
          prisma.subscription.groupBy({ by: ['planId', 'status'], _count: { _all: true } }),
          prisma.backgroundJob.groupBy({
            by: ['status'],
            where: { createdAt: { gte: dayAgo } },
            _count: { _all: true },
          }),
          prisma.backgroundJob.count({ where: { status: { in: ['QUEUED', 'RUNNING'] } } }),
          prisma.usageRecord.groupBy({ by: ['metric'], where: { periodKey }, _sum: { quantity: true } }),
          prisma.emailDelivery.groupBy({
            by: ['status'],
            where: { createdAt: { gte: weekAgo } },
            _count: { _all: true },
          }),
        ]);
        const usageByMetric = new Map(usage.map((u) => [u.metric, u._sum.quantity ?? 0]));
        return ok({
          users: { total: users, verified: verifiedUsers, disabled: disabledUsers },
          workspaces,
          projects,
          subscriptions: plans.map((plan) => {
            const rows = subscriptions.filter((s) => s.planId === plan.id);
            return {
              planKey: plan.key,
              planName: plan.name,
              total: rows.reduce((sum, r) => sum + r._count._all, 0),
              byStatus: Object.fromEntries(rows.map((r) => [r.status, r._count._all])),
            };
          }),
          jobs: {
            active: activeJobs,
            last24hByStatus: Object.fromEntries(jobs.map((j) => [j.status, j._count._all])),
          },
          usage: {
            periodKey,
            metrics: USAGE_METRICS.map((metric) => ({
              metric,
              label: USAGE_METRIC_LABELS[metric],
              used: usageByMetric.get(metric) ?? 0,
            })),
          },
          emails: { last7dByStatus: Object.fromEntries(emails.map((e) => [e.status, e._count._all])) },
        });
      },
    }),

    route({
      method: 'get',
      path: '/users',
      summary: 'Search users',
      tags,
      auth: 'admin',
      query: adminUserListQuerySchema,
      handler: async ({ query }) => {
        const where: Prisma.UserWhereInput = {
          ...(query.q ? { OR: [{ email: { contains: query.q } }, { name: { contains: query.q } }] } : {}),
          ...(query.status === 'active' ? { disabledAt: null } : {}),
          ...(query.status === 'disabled' ? { disabledAt: { not: null } } : {}),
          ...(query.status === 'deletion_requested' ? { deletionRequestedAt: { not: null } } : {}),
        };
        const [total, users] = await Promise.all([
          prisma.user.count({ where }),
          prisma.user.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            include: { _count: { select: { memberships: true } } },
            ...paginate(query.page, query.pageSize),
          }),
        ]);
        return ok(
          users.map((u) => ({
            id: u.id,
            email: u.email,
            name: u.name,
            platformRole: u.platformRole,
            emailVerified: Boolean(u.emailVerifiedAt),
            disabledAt: iso(u.disabledAt),
            disabledReason: u.disabledReason,
            deletionRequestedAt: iso(u.deletionRequestedAt),
            lastLoginAt: iso(u.lastLoginAt),
            createdAt: u.createdAt.toISOString(),
            workspaceCount: u._count.memberships,
          })),
          pageMeta(query.page, query.pageSize, total),
        );
      },
    }),

    route({
      method: 'get',
      path: '/users/:userId',
      summary: 'User detail with memberships and session count',
      tags,
      auth: 'admin',
      params: userParams,
      handler: async ({ params }) => {
        const u = await prisma.user.findUnique({
          where: { id: params.userId },
          include: {
            memberships: {
              include: { workspace: { select: { id: true, name: true, slug: true } } },
              orderBy: { createdAt: 'asc' },
            },
          },
        });
        if (!u) throw Errors.notFound('User');
        const activeSessions = await prisma.session.count({
          where: { userId: u.id, expiresAt: { gt: new Date() } },
        });
        return ok({
          id: u.id,
          email: u.email,
          name: u.name,
          platformRole: u.platformRole,
          emailVerified: Boolean(u.emailVerifiedAt),
          disabledAt: iso(u.disabledAt),
          disabledReason: u.disabledReason,
          deletionRequestedAt: iso(u.deletionRequestedAt),
          lastLoginAt: iso(u.lastLoginAt),
          createdAt: u.createdAt.toISOString(),
          activeSessions,
          memberships: u.memberships.map((m) => ({
            workspaceId: m.workspace.id,
            workspaceName: m.workspace.name,
            workspaceSlug: m.workspace.slug,
            role: m.role,
          })),
        });
      },
    }),

    route({
      method: 'patch',
      path: '/users/:userId',
      summary: 'Disable (and sign out) or re-enable a user',
      tags,
      auth: 'admin',
      params: userParams,
      body: adminUserUpdateSchema,
      handler: async ({ req, user, params, body }) => {
        if (params.userId === user.id)
          throw Errors.conflict('You cannot disable or re-enable your own account.');
        const target = await prisma.user.findUnique({ where: { id: params.userId } });
        if (!target) throw Errors.notFound('User');
        let revokedSessions = 0;
        if (body.disabled) {
          const [, revoked] = await prisma.$transaction([
            prisma.user.update({
              where: { id: target.id },
              data: { disabledAt: target.disabledAt ?? new Date(), disabledReason: body.reason ?? null },
            }),
            prisma.session.deleteMany({ where: { userId: target.id } }),
          ]);
          revokedSessions = revoked.count;
        } else {
          await prisma.user.update({
            where: { id: target.id },
            data: { disabledAt: null, disabledReason: null },
          });
        }
        await recordAuditLog(prisma, {
          action: body.disabled ? 'admin.user_disabled' : 'admin.user_enabled',
          actorUserId: user.id,
          targetType: 'User',
          targetId: target.id,
          ...requestMeta(req),
          metadata: body.disabled ? { reason: body.reason ?? null, revokedSessions } : {},
        });
        return ok({ id: target.id, disabled: body.disabled, revokedSessions });
      },
    }),

    route({
      method: 'get',
      path: '/workspaces',
      summary: 'Search workspaces with plan, owners and counts',
      tags,
      auth: 'admin',
      query: adminWorkspaceListQuerySchema,
      handler: async ({ query }) => {
        const where: Prisma.WorkspaceWhereInput = query.q
          ? { OR: [{ name: { contains: query.q } }, { slug: { contains: query.q } }] }
          : {};
        const [total, workspaces] = await Promise.all([
          prisma.workspace.count({ where }),
          prisma.workspace.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            include: {
              subscription: { include: { plan: { select: { key: true, name: true } } } },
              members: {
                where: { role: 'OWNER' },
                select: { user: { select: { id: true, email: true, name: true } } },
                take: 3,
              },
              _count: { select: { members: true, projects: true } },
            },
            ...paginate(query.page, query.pageSize),
          }),
        ]);
        return ok(
          workspaces.map((w) => ({
            id: w.id,
            name: w.name,
            slug: w.slug,
            createdAt: w.createdAt.toISOString(),
            plan: w.subscription ? { key: w.subscription.plan.key, name: w.subscription.plan.name } : null,
            subscriptionStatus: w.subscription?.status ?? null,
            billingProvider: w.subscription?.provider ?? null,
            owners: w.members.map((m) => m.user),
            memberCount: w._count.members,
            projectCount: w._count.projects,
            isServiceProvider: w.isServiceProvider,
          })),
          pageMeta(query.page, query.pageSize, total),
        );
      },
    }),

    route({
      method: 'get',
      path: '/workspaces/:workspaceId',
      summary: 'Workspace detail with projects and current-month usage',
      tags,
      auth: 'admin',
      params: workspaceParams,
      handler: async ({ params }) => {
        const w = await prisma.workspace.findUnique({
          where: { id: params.workspaceId },
          include: {
            members: {
              include: { user: { select: { id: true, email: true, name: true } } },
              orderBy: { createdAt: 'asc' },
            },
            projects: {
              select: { id: true, name: true, domain: true, createdAt: true },
              orderBy: { createdAt: 'asc' },
            },
          },
        });
        if (!w) throw Errors.notFound('Workspace');
        const usage = await getUsageSummary(prisma, w.id);
        return ok({
          id: w.id,
          name: w.name,
          slug: w.slug,
          createdAt: w.createdAt.toISOString(),
          members: w.members.map((m) => ({ ...m.user, role: m.role })),
          projects: w.projects.map((p) => ({ ...p, createdAt: p.createdAt.toISOString() })),
          usage,
        });
      },
    }),

    route({
      method: 'get',
      path: '/jobs',
      summary: 'Background jobs across all workspaces (newest first)',
      tags,
      auth: 'admin',
      query: adminJobListQuerySchema,
      handler: async ({ query }) => {
        const where: Prisma.BackgroundJobWhereInput = {
          ...(query.status ? { status: query.status } : {}),
          ...(query.type ? { type: query.type } : {}),
        };
        const [total, jobs] = await Promise.all([
          prisma.backgroundJob.count({ where }),
          prisma.backgroundJob.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            ...paginate(query.page, query.pageSize),
          }),
        ]);
        return ok(jobs.map(toAdminJob), pageMeta(query.page, query.pageSize, total));
      },
    }),

    route({
      method: 'post',
      path: '/jobs/:jobId/retry',
      summary: 'Retry a failed job that is still held by the queue',
      description:
        'Only report, integration sync, competitor snapshot and email jobs can be retried here. The job keeps its id and input and gets a fresh attempt budget. Failed jobs stay in the queue for 14 days.',
      tags,
      auth: 'admin',
      params: jobParams,
      successStatus: 202,
      handler: async ({ req, user, params }) => {
        const job = await prisma.backgroundJob.findUnique({ where: { id: params.jobId } });
        if (!job) throw Errors.notFound('Job');
        if (job.status !== 'FAILED') throw Errors.conflict('Only failed jobs can be retried.');
        if (!ADMIN_RETRYABLE_JOB_TYPES.has(job.type)) {
          throw Errors.conflict(
            'This job type cannot be retried from the admin area. Start the action again from the project so plan limits are re-checked.',
          );
        }
        // Reset the record before touching the queue: a worker that picks the job up immediately
        // must find it QUEUED, not FAILED.
        const previous = {
          status: job.status,
          error: job.error,
          message: job.message,
          attempts: job.attempts,
          progress: job.progress,
          finishedAt: job.finishedAt,
        };
        await prisma.backgroundJob.update({
          where: { id: job.id },
          data: {
            status: 'QUEUED',
            error: null,
            message: 'Retry requested by an administrator',
            attempts: 0,
            progress: 0,
            finishedAt: null,
            cancelRequestedAt: null,
          },
        });
        const retried = await deps.queues.retry(job.queueName as QueueName, job.id).catch(() => false);
        if (!retried) {
          await prisma.backgroundJob.update({ where: { id: job.id }, data: previous });
          throw Errors.conflict(
            'This job is no longer held by the queue, so it cannot be retried. Start the action again from the project.',
          );
        }
        await recordAuditLog(prisma, {
          action: 'admin.job_retried',
          actorUserId: user.id,
          workspaceId: job.workspaceId,
          targetType: 'BackgroundJob',
          targetId: job.id,
          ...requestMeta(req),
          metadata: { type: job.type, queue: job.queueName },
        });
        const updated = await prisma.backgroundJob.findUniqueOrThrow({ where: { id: job.id } });
        return { status: 202, data: toAdminJob(updated) };
      },
    }),

    route({
      method: 'get',
      path: '/plans',
      summary: 'All plans, including inactive ones and provider price ids',
      tags,
      auth: 'admin',
      handler: async () => {
        const plans = await prisma.subscriptionPlan.findMany({
          orderBy: { sortOrder: 'asc' },
          include: { _count: { select: { subscriptions: true } } },
        });
        return ok(
          plans.map((p) => ({
            ...toPlanDto(p),
            stripePriceMonthlyId: p.stripePriceMonthlyId,
            stripePriceYearlyId: p.stripePriceYearlyId,
            razorpayPlanMonthlyId: p.razorpayPlanMonthlyId,
            razorpayPlanYearlyId: p.razorpayPlanYearlyId,
            subscriptionCount: p._count.subscriptions,
            updatedAt: p.updatedAt.toISOString(),
          })),
        );
      },
    }),

    route({
      method: 'patch',
      path: '/plans/:planKey',
      summary: 'Edit a plan (prices, limits, features, provider ids)',
      description:
        'Limit changes apply immediately to every workspace on the plan. Prices shown to customers change on the next checkout; existing provider subscriptions keep their price.',
      tags,
      auth: 'admin',
      params: planParams,
      body: planUpdateSchema,
      handler: async ({ req, user, params, body }) => {
        const plan = await prisma.subscriptionPlan.findUnique({ where: { key: params.planKey } });
        if (!plan) throw Errors.notFound('Plan');
        if (body.isActive === false && plan.key === DEFAULT_PLAN_KEY) {
          throw Errors.conflict('The Free plan cannot be deactivated because new workspaces start on it.');
        }
        const { priceMonthly, priceYearly, limits, features, ...rest } = body;
        const data: Prisma.SubscriptionPlanUpdateInput = {
          ...rest,
          ...(priceMonthly !== undefined ? { priceMonthly: priceMonthly.toFixed(2) } : {}),
          ...(priceYearly !== undefined ? { priceYearly: priceYearly.toFixed(2) } : {}),
          ...(limits !== undefined ? { limits } : {}),
          ...(features !== undefined ? { features } : {}),
        };
        const updated = await prisma.subscriptionPlan.update({ where: { id: plan.id }, data });
        await recordAuditLog(prisma, {
          action: 'admin.plan_updated',
          actorUserId: user.id,
          targetType: 'SubscriptionPlan',
          targetId: plan.id,
          ...requestMeta(req),
          metadata: { planKey: plan.key, fields: Object.keys(body) },
        });
        return ok(toPlanDto(updated));
      },
    }),

    route({
      method: 'get',
      path: '/usage',
      summary: 'Usage for a month: totals per metric and per workspace',
      description: 'Workspaces are ordered by number of billable events in the month (at most 100 rows).',
      tags,
      auth: 'admin',
      query: adminUsageQuerySchema,
      handler: async ({ query }) => {
        const periodKey = query.period ?? usagePeriodKey();
        const rows = await prisma.usageRecord.groupBy({
          by: ['workspaceId', 'metric'],
          where: { periodKey },
          _sum: { quantity: true },
          _count: { _all: true },
        });
        const totals = new Map<string, number>();
        const perWorkspace = new Map<string, { events: number; metrics: Record<string, number> }>();
        for (const row of rows) {
          const quantity = row._sum.quantity ?? 0;
          totals.set(row.metric, (totals.get(row.metric) ?? 0) + quantity);
          const entry = perWorkspace.get(row.workspaceId) ?? { events: 0, metrics: {} };
          entry.events += row._count._all;
          entry.metrics[row.metric] = quantity;
          perWorkspace.set(row.workspaceId, entry);
        }
        const top = [...perWorkspace.entries()].sort((a, b) => b[1].events - a[1].events).slice(0, 100);
        const names = await prisma.workspace.findMany({
          where: { id: { in: top.map(([id]) => id) } },
          select: { id: true, name: true },
        });
        const nameById = new Map(names.map((n) => [n.id, n.name]));
        return ok({
          periodKey,
          totals: USAGE_METRICS.map((metric) => ({
            metric,
            label: USAGE_METRIC_LABELS[metric],
            used: totals.get(metric) ?? 0,
          })),
          workspaces: top.map(([workspaceId, entry]) => ({
            workspaceId,
            workspaceName: nameById.get(workspaceId) ?? null,
            billableEvents: entry.events,
            metrics: entry.metrics,
          })),
        });
      },
    }),

    route({
      method: 'get',
      path: '/system',
      summary: 'Dependency health and provider configuration (never secrets)',
      tags,
      auth: 'admin',
      handler: async () => {
        const env = getEnv();
        const dayAgo = new Date(Date.now() - 24 * 3600 * 1000);
        const [database, queue, redis, active, failedRecent] = await Promise.all([
          pingDatabase(),
          deps.queues.ping(),
          deps.redis ? pingRedis(deps.redis) : Promise.resolve(null),
          prisma.backgroundJob.groupBy({
            by: ['queueName', 'status'],
            where: { status: { in: ['QUEUED', 'RUNNING'] } },
            _count: { _all: true },
          }),
          prisma.backgroundJob.groupBy({
            by: ['queueName'],
            where: { status: 'FAILED', finishedAt: { gte: dayAgo } },
            _count: { _all: true },
          }),
        ]);
        const queues = new Map<string, { queued: number; running: number; failedLast24h: number }>();
        const entry = (name: string) =>
          queues.get(name) ?? queues.set(name, { queued: 0, running: 0, failedLast24h: 0 }).get(name)!;
        for (const row of active)
          entry(row.queueName)[row.status === 'RUNNING' ? 'running' : 'queued'] = row._count._all;
        for (const row of failedRecent) entry(row.queueName).failedLast24h = row._count._all;
        return ok({
          environment: env.NODE_ENV,
          checks: { database, queue, redis },
          queues: Object.fromEntries(queues),
          providers: {
            llm: {
              provider: env.LLM_PROVIDER,
              configured: env.LLM_PROVIDER === 'openai' ? Boolean(env.OPENAI_API_KEY) : true,
              model: env.OPENAI_MODEL,
            },
            visibility: listVisibilityProviderStatuses(),
            demoMode: env.AI_DEMO_MODE,
            keywordData: { provider: env.KEYWORD_DATA_PROVIDER },
            billing: {
              provider: env.BILLING_PROVIDER,
              stripeConfigured: Boolean(env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET),
              razorpayConfigured: Boolean(
                env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET && env.RAZORPAY_WEBHOOK_SECRET,
              ),
            },
            email: { provider: env.EMAIL_PROVIDER, smtpConfigured: Boolean(env.SMTP_HOST) },
            pdf: { renderer: env.PDF_RENDERER },
            storage: { driver: env.STORAGE_DRIVER },
            integrations: integrationCatalog().map(({ provider, name, availability, configured }) => ({
              provider,
              name,
              availability,
              configured,
            })),
          },
        });
      },
    }),

    route({
      method: 'get',
      path: '/audit-logs',
      summary: 'Platform-wide audit log',
      tags,
      auth: 'admin',
      query: adminAuditLogListQuerySchema,
      handler: async ({ query }) => {
        const where: Prisma.AuditLogWhereInput = {
          ...(query.action ? { action: { startsWith: query.action } } : {}),
          ...(query.actorUserId ? { actorUserId: query.actorUserId } : {}),
          ...(query.workspaceId ? { workspaceId: query.workspaceId } : {}),
        };
        const [total, logs] = await Promise.all([
          prisma.auditLog.count({ where }),
          prisma.auditLog.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            include: {
              actor: { select: { id: true, name: true, email: true } },
              workspace: { select: { id: true, name: true } },
            },
            ...paginate(query.page, query.pageSize),
          }),
        ]);
        return ok(
          logs.map((l) => ({
            id: l.id,
            action: l.action,
            actor: l.actor,
            workspace: l.workspace,
            targetType: l.targetType,
            targetId: l.targetId,
            ipAddress: l.ipAddress,
            metadata: l.metadata,
            createdAt: l.createdAt.toISOString(),
          })),
          pageMeta(query.page, query.pageSize, total),
        );
      },
    }),
  ];
}
