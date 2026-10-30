import { recordAuditLog } from '@surfaced/core/audit-log';
import { getEnv } from '@surfaced/core/env';
import { Errors, errorMessage } from '@surfaced/core/errors';
import {
  GOOGLE_PROVIDERS,
  completeGoogleOAuth,
  disconnectGoogle,
  googleProviderBySlug,
  integrationCatalog,
  integrationDiagnostics,
  listGscSites,
  searchConsoleMetrics,
  startGoogleOAuth,
} from '@surfaced/core/integrations';
import { createJobRecord, enqueueJobRecord } from '@surfaced/core/jobs';
import { deleteProfileData } from '@surfaced/core/local';
import { dateInputSchema, idSchema } from '@surfaced/shared';
import { z } from 'zod';
import { accepted, iso, noContent, ok } from '../lib/http';
import { route, type AnyRoute } from '../lib/router';
import { requireProjectAccess } from '../services/access';
import type { AppDeps, AuthUser } from '../types';

export function integrationRoutes(deps: AppDeps): { project: AnyRoute[]; integrations: AnyRoute[] } {
  const { prisma } = deps;
  const httpFetch = deps.httpFetch ?? fetch;
  const tags = ['Integrations'];

  async function loadIntegration(
    user: AuthUser,
    integrationId: string,
    permission: 'integration.read' | 'integration.manage',
  ) {
    const integration = await prisma.integration.findUnique({ where: { id: integrationId } });
    if (!integration) throw Errors.notFound('Integration');
    await requireProjectAccess(prisma, user, integration.projectId, permission);
    return integration;
  }

  const project: AnyRoute[] = [
    route({
      method: 'get',
      path: '/:projectId/integrations/diagnostics',
      summary: 'Consolidated health of every data source: connections, AI model, local rank source and jobs',
      tags,
      auth: 'user',
      params: z.object({ projectId: idSchema }),
      handler: async ({ user, params }) => {
        await requireProjectAccess(prisma, user, params.projectId, 'integration.read');
        return ok(
          await integrationDiagnostics(prisma, params.projectId, { redisConnected: deps.redis !== null }),
        );
      },
    }),
    route({
      method: 'get',
      path: '/:projectId/integrations',
      summary: 'Integration catalog with this project’s connection status',
      tags,
      auth: 'user',
      params: z.object({ projectId: idSchema }),
      handler: async ({ user, params }) => {
        await requireProjectAccess(prisma, user, params.projectId, 'integration.read');
        const rows = await prisma.integration.findMany({ where: { projectId: params.projectId } });
        return ok(
          integrationCatalog().map((entry) => {
            const row = rows.find((r) => r.provider === entry.provider);
            return {
              ...entry,
              integration: row
                ? {
                    id: row.id,
                    status: row.status,
                    externalAccount: row.externalAccount,
                    siteUrl: (row.config as { siteUrl?: string } | null)?.siteUrl ?? null,
                    connectedAt: iso(row.connectedAt),
                    lastSyncAt: iso(row.lastSyncAt),
                    lastSyncStatus: row.lastSyncStatus,
                    lastError: row.lastError,
                  }
                : null,
            };
          }),
        );
      },
    }),
    route({
      method: 'post',
      path: '/:projectId/integrations/google-search-console/connect',
      summary: 'Start the Google OAuth consent flow (returns the consent URL)',
      tags,
      auth: 'user',
      params: z.object({ projectId: idSchema }),
      handler: async ({ user, params }) => {
        const { project: p } = await requireProjectAccess(
          prisma,
          user,
          params.projectId,
          'integration.manage',
        );
        return ok(
          await startGoogleOAuth(prisma, { userId: user.id, workspaceId: p.workspaceId, projectId: p.id }),
        );
      },
    }),
    route({
      method: 'post',
      path: '/:projectId/integrations/:provider/connect',
      summary: 'Start the Google OAuth consent flow for an implemented Google integration',
      tags,
      auth: 'user',
      params: z.object({ projectId: idSchema, provider: z.string().regex(/^[a-z0-9-]{3,40}$/) }),
      handler: async ({ user, params }) => {
        const provider = googleProviderBySlug(params.provider);
        const entry = provider ? integrationCatalog().find((e) => e.provider === provider) : undefined;
        if (!provider || entry?.availability !== 'implemented') throw Errors.notFound('Integration');
        const { project: p } = await requireProjectAccess(
          prisma,
          user,
          params.projectId,
          'integration.manage',
        );
        return ok(
          await startGoogleOAuth(prisma, {
            userId: user.id,
            workspaceId: p.workspaceId,
            projectId: p.id,
            provider,
          }),
        );
      },
    }),
    route({
      method: 'get',
      path: '/:projectId/search-console',
      summary: 'Synced Search Console metrics (clicks, impressions, CTR, position)',
      tags,
      auth: 'user',
      params: z.object({ projectId: idSchema }),
      query: z.object({ from: dateInputSchema.optional(), to: dateInputSchema.optional() }),
      handler: async ({ user, params, query }) => {
        await requireProjectAccess(prisma, user, params.projectId, 'project.read');
        const to = query.to ?? new Date();
        const from = query.from ?? new Date(to.getTime() - 90 * 86_400_000);
        return ok(await searchConsoleMetrics(prisma, params.projectId, from, to));
      },
    }),
  ];

  const integrations: AnyRoute[] = [
    route({
      method: 'get',
      path: '/catalog',
      summary: 'Available integrations and whether each is implemented and configured',
      tags,
      auth: 'user',
      handler: () => ok(integrationCatalog()),
    }),
    route({
      method: 'get',
      path: '/google/callback',
      summary: 'OAuth redirect URI for Google (browser redirect; validates state and PKCE)',
      tags,
      auth: 'optional',
      query: z.object({
        code: z.string().max(2000).optional(),
        state: z.string().max(200).optional(),
        error: z.string().max(200).optional(),
      }),
      produces: 'text/html',
      handler: async ({ res, auth, query }) => {
        const appUrl = getEnv().APP_URL;
        const fail = (message: string) =>
          res.redirect(302, `${appUrl}/app/integrations?integrationError=${encodeURIComponent(message)}`);
        if (query.error)
          return fail(
            query.error === 'access_denied'
              ? 'Access was not granted in Google.'
              : `Google returned: ${query.error}`,
          );
        if (!auth) return fail('Your session expired. Sign in and connect again.');
        if (!query.code || !query.state) return fail('The authorization response was incomplete.');
        try {
          const result = await completeGoogleOAuth(
            prisma,
            {
              state: query.state,
              code: query.code,
              sessionUserId: auth.user.id,
            },
            httpFetch,
          );
          await recordAuditLog(prisma, {
            action: 'integration.connected',
            actorUserId: auth.user.id,
            targetType: 'Integration',
            targetId: result.integrationId,
            metadata: { provider: result.provider },
          });
          const landing =
            result.provider === 'GOOGLE_BUSINESS_PROFILE'
              ? 'local/profile'
              : result.provider === 'GOOGLE_MERCHANT_CENTER'
                ? 'local/merchant'
                : 'integrations';
          return res.redirect(
            302,
            `${appUrl}/app/p/${result.projectId}/${landing}?connected=${GOOGLE_PROVIDERS[result.provider].slug}`,
          );
        } catch (error) {
          return fail(errorMessage(error).slice(0, 200));
        }
      },
    }),
    route({
      method: 'get',
      path: '/:integrationId/gsc/sites',
      summary: 'Search Console properties the connected account can access',
      tags,
      auth: 'user',
      params: z.object({ integrationId: idSchema }),
      handler: async ({ user, params }) => {
        const integration = await loadIntegration(user, params.integrationId, 'integration.read');
        if (integration.provider !== 'GOOGLE_SEARCH_CONSOLE')
          throw Errors.badRequest('Properties apply to Search Console only.');
        return ok(await listGscSites(prisma, integration.id, httpFetch));
      },
    }),
    route({
      method: 'patch',
      path: '/:integrationId',
      summary: 'Select the Search Console property to sync',
      tags,
      auth: 'user',
      params: z.object({ integrationId: idSchema }),
      body: z.object({ siteUrl: z.string().min(3).max(2048) }),
      handler: async ({ user, params, body }) => {
        const integration = await loadIntegration(user, params.integrationId, 'integration.manage');
        if (integration.provider !== 'GOOGLE_SEARCH_CONSOLE')
          throw Errors.badRequest(
            'Only Search Console has a property to choose. Link Business Profile locations on the Business Profile page.',
          );
        const sites = await listGscSites(prisma, integration.id, httpFetch);
        if (!sites.some((s) => s.siteUrl === body.siteUrl))
          throw Errors.badRequest('That property is not available to the connected Google account.');
        const updated = await prisma.integration.update({
          where: { id: integration.id },
          data: { config: { siteUrl: body.siteUrl } },
        });
        return ok({ id: updated.id, siteUrl: body.siteUrl });
      },
    }),
    route({
      method: 'post',
      path: '/:integrationId/sync',
      summary: 'Sync now: Search Console metrics, or linked Business Profile locations (background job)',
      tags,
      auth: 'user',
      params: z.object({ integrationId: idSchema }),
      successStatus: 202,
      handler: async ({ user, params }) => {
        const integration = await loadIntegration(user, params.integrationId, 'integration.manage');
        if (integration.status !== 'CONNECTED') throw Errors.conflict('Connect the integration first.');
        if (integration.provider === 'GOOGLE_BUSINESS_PROFILE') {
          const linked = await prisma.businessLocation.count({
            where: { projectId: integration.projectId, archivedAt: null, profileLocationName: { not: null } },
          });
          if (!linked) throw Errors.badRequest('Link a Business Profile location before syncing.');
        } else if (integration.provider === 'GOOGLE_MERCHANT_CENTER') {
          if (!(integration.config as { accountId?: string } | null)?.accountId)
            throw Errors.badRequest('Choose the Merchant Center account before syncing.');
        } else if (!(integration.config as { siteUrl?: string } | null)?.siteUrl)
          throw Errors.badRequest('Choose a property before syncing.');
        const job = await createJobRecord(prisma, {
          type: 'INTEGRATION_SYNC',
          queue: 'integration-sync',
          workspaceId: integration.workspaceId,
          projectId: integration.projectId,
          userId: user.id,
          entityType: 'Integration',
          entityId: integration.id,
          payload: { integrationId: integration.id },
        });
        await enqueueJobRecord(prisma, deps.queues, job, 'integration-sync', {
          backgroundJobId: job.id,
          integrationId: integration.id,
        });
        return accepted({ jobId: job.id, status: 'QUEUED' });
      },
    }),
    route({
      method: 'delete',
      path: '/:integrationId',
      summary: 'Disconnect and revoke access',
      tags,
      auth: 'user',
      params: z.object({ integrationId: idSchema }),
      handler: async ({ user, params }) => {
        const integration = await loadIntegration(user, params.integrationId, 'integration.manage');
        await disconnectGoogle(prisma, integration.id, httpFetch);
        // Business Profile content may only be kept while the business allows access; links are kept for reconnecting.
        if (integration.provider === 'GOOGLE_BUSINESS_PROFILE')
          await deleteProfileData(prisma, { projectId: integration.projectId });
        await recordAuditLog(prisma, {
          action: 'integration.disconnected',
          actorUserId: user.id,
          workspaceId: integration.workspaceId,
          targetType: 'Integration',
          targetId: integration.id,
        });
        return noContent();
      },
    }),
  ];
  return { project, integrations };
}
