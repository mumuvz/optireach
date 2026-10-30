import { hashIp, hashToken, randomToken, safeEqual } from '@surfaced/core/crypto';
import { queueEmail } from '@surfaced/core/email';
import { getEnv } from '@surfaced/core/env';
import { Errors } from '@surfaced/core/errors';
import { createJobRecord, enqueueJobRecord } from '@surfaced/core/jobs';
import { contactSchema, idSchema, normalizeWebsiteUrl, publicAuditSchema } from '@surfaced/shared';
import { z } from 'zod';
import { accepted, ok } from '../lib/http';
import { route, type AnyRoute } from '../lib/router';
import { authLimiters } from '../middleware/rate-limit';
import { assertWebsiteAllowed } from '../services/project.service';
import type { AppDeps } from '../types';

/** Small, fixed budget for anonymous audits. */
export const PUBLIC_AUDIT_SETTINGS = {
  maxPages: 20,
  maxDepth: 3,
  includeSubdomains: false,
  crawlDelayMs: 500,
};
const PUBLIC_AUDIT_TTL_MS = 7 * 24 * 3600 * 1000;
const PUBLIC_AUDITS_PER_HOUR_GLOBAL = 200;

export function publicRoutes(deps: AppDeps): AnyRoute[] {
  const { prisma } = deps;
  const limit = authLimiters(deps);
  const tags = ['Public'];

  return [
    route({
      method: 'post',
      path: '/audits',
      summary: 'Start a free website audit (no account needed)',
      description: `Crawls up to ${PUBLIC_AUDIT_SETTINGS.maxPages} pages. Returns an id and an access token needed to read the results.`,
      tags,
      auth: 'public',
      body: publicAuditSchema,
      middleware: [limit.publicAudit],
      successStatus: 202,
      handler: async ({ req, body }) => {
        assertWebsiteAllowed(body.url);
        const recent = await prisma.publicAudit.count({
          where: { createdAt: { gt: new Date(Date.now() - 3600 * 1000) } },
        });
        if (recent >= PUBLIC_AUDITS_PER_HOUR_GLOBAL)
          throw Errors.rateLimited(
            'Free audits are busy right now. Please try again shortly or create a free account.',
          );

        const site = normalizeWebsiteUrl(body.url);
        const token = randomToken(24);
        const crawl = await prisma.crawlJob.create({
          data: { startUrl: site.url, settings: PUBLIC_AUDIT_SETTINGS, trigger: 'PUBLIC' },
        });
        const audit = await prisma.publicAudit.create({
          data: {
            url: site.url,
            domain: site.domain,
            ipHash: hashIp(req.clientIp),
            accessTokenHash: hashToken(token),
            crawlJobId: crawl.id,
            expiresAt: new Date(Date.now() + PUBLIC_AUDIT_TTL_MS),
          },
        });
        const job = await createJobRecord(prisma, {
          type: 'CRAWL',
          queue: 'crawl',
          entityType: 'CrawlJob',
          entityId: crawl.id,
          payload: { crawlJobId: crawl.id, publicAuditId: audit.id },
          maxAttempts: 2,
        });
        await enqueueJobRecord(prisma, deps.queues, job, 'crawl', {
          backgroundJobId: job.id,
          crawlJobId: crawl.id,
        });
        return accepted({
          id: audit.id,
          token,
          status: audit.status,
          url: site.url,
          maxPages: PUBLIC_AUDIT_SETTINGS.maxPages,
        });
      },
    }),
    route({
      method: 'get',
      path: '/audits/:auditId',
      summary: 'Free audit progress and results',
      tags,
      auth: 'public',
      params: z.object({ auditId: idSchema }),
      query: z.object({ token: z.string().min(20).max(100) }),
      handler: async ({ params, query }) => {
        const audit = await prisma.publicAudit.findUnique({
          where: { id: params.auditId },
          include: { crawlJob: true },
        });
        if (
          !audit ||
          !safeEqual(audit.accessTokenHash, hashToken(query.token)) ||
          audit.expiresAt <= new Date()
        ) {
          throw Errors.notFound('Audit');
        }
        return ok({
          id: audit.id,
          url: audit.url,
          domain: audit.domain,
          status: audit.status,
          progress: audit.crawlJob?.progress ?? 0,
          pagesCrawled: audit.crawlJob?.pagesCrawled ?? 0,
          maxPages: PUBLIC_AUDIT_SETTINGS.maxPages,
          result: audit.result,
          errorMessage: audit.errorMessage,
          createdAt: audit.createdAt.toISOString(),
          expiresAt: audit.expiresAt.toISOString(),
        });
      },
    }),
    route({
      method: 'post',
      path: '/contact',
      summary: 'Send a message to the team',
      tags,
      auth: 'public',
      body: contactSchema,
      middleware: [limit.contact],
      successStatus: 202,
      handler: async ({ req, body }) => {
        if (body.website) throw Errors.badRequest('Invalid submission.');
        const message = await prisma.contactMessage.create({
          data: {
            name: body.name,
            email: body.email,
            company: body.company,
            topic: body.topic,
            message: body.message,
            ipHash: hashIp(req.clientIp),
          },
        });
        await queueEmail(prisma, deps.queues, {
          to: getEnv().SALES_EMAIL,
          template: 'contact_message',
          data: {
            name: body.name,
            email: body.email,
            company: body.company,
            topic: body.topic,
            message: body.message,
          },
        });
        return accepted({
          id: message.id,
          message: 'Thanks — we received your message and will reply by email.',
        });
      },
    }),
  ];
}
