import { getEnv } from '@surfaced/core/env';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express, type Router } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import swaggerUi from 'swagger-ui-express';
import { buildRouter, OpenApiRegistry, type AnyRoute } from './lib/router';
import { csrfProtection } from './middleware/csrf';
import { apiNotFound, errorHandler } from './middleware/error-handler';
import { createRateLimiter } from './middleware/rate-limit';
import { requestContext } from './middleware/request-context';
import { sessionMiddleware } from './middleware/session';
import { adminOpsRoutes } from './routes/admin-ops.routes';
import { adminRoutes } from './routes/admin.routes';
import { agencyRoutes } from './routes/agency.routes';
import { approvalRoutes } from './routes/approvals.routes';
import { answerabilityRoutes, projectAnswerabilityRoutes } from './routes/answerability.routes';
import { auditRoutes, crawlRoutes, issueRoutes, projectAuditRoutes } from './routes/audits.routes';
import { projectExportRoutes } from './routes/export.routes';
import { billingRoutes } from './routes/billing.routes';
import { authRoutes } from './routes/auth.routes';
import { contentRoutes, projectContentRoutes } from './routes/content.routes';
import { projectInsightRoutes, recommendationRoutes } from './routes/insights.routes';
import { projectTrendRoutes } from './routes/trends.routes';
import { projectLocalRoutes } from './routes/local.routes';
import { projectBusinessProfileRoutes } from './routes/business-profile.routes';
import { projectLocalPostRoutes } from './routes/local-posts.routes';
import { projectLocalResearchRoutes } from './routes/local-research.routes';
import { projectMerchantRoutes } from './routes/merchant.routes';
import { workspacePlaceRoutes } from './routes/places.routes';
import { integrationRoutes } from './routes/integrations.routes';
import { keywordRoutes, projectKeywordRoutes } from './routes/keywords.routes';
import { projectRoutes } from './routes/projects.routes';
import { publicRoutes } from './routes/public.routes';
import { reportRoutes } from './routes/reports.routes';
import { taskRoutes } from './routes/tasks.routes';
import { aiVisibilityRoutes, projectVisibilityRoutes, promptRoutes } from './routes/visibility.routes';
import { healthRoutes, jobRoutes, metaRoutes, notificationRoutes } from './routes/system.routes';
import { userRoutes } from './routes/users.routes';
import { workspaceRoutes } from './routes/workspaces.routes';
import type { AppDeps } from './types';
import { mountWebApp } from './web-static';

export const API_PREFIX = '/api/v1';

/** Paths (relative to /api) that authenticate by signature or OAuth state instead of CSRF tokens. */
const CSRF_EXEMPT = [/^\/v1\/billing\/webhooks\//, /^\/v1\/integrations\/google\/callback$/];

export interface RouteGroup {
  path: string;
  routes: AnyRoute[];
}

export function routeGroups(deps: AppDeps): RouteGroup[] {
  const reports = reportRoutes(deps);
  const billing = billingRoutes(deps);
  const integrations = integrationRoutes(deps);
  const tasks = taskRoutes(deps);
  const agency = agencyRoutes(deps);
  return [
    { path: '/health', routes: healthRoutes(deps) },
    { path: '/meta', routes: metaRoutes() },
    { path: '/auth', routes: authRoutes(deps) },
    { path: '/users', routes: userRoutes(deps) },
    { path: '/workspaces', routes: workspaceRoutes(deps) },
    { path: '/workspaces', routes: workspacePlaceRoutes(deps) },
    { path: '/projects', routes: projectRoutes(deps) },
    { path: '/projects', routes: projectAuditRoutes(deps) },
    { path: '/projects', routes: projectVisibilityRoutes(deps) },
    { path: '/prompts', routes: promptRoutes(deps) },
    { path: '/projects', routes: projectContentRoutes(deps) },
    { path: '/content', routes: contentRoutes(deps) },
    { path: '/projects', routes: projectAnswerabilityRoutes(deps) },
    { path: '/answerability', routes: answerabilityRoutes(deps) },
    { path: '/projects', routes: projectExportRoutes(deps) },
    { path: '/projects', routes: projectKeywordRoutes(deps) },
    { path: '/keywords', routes: keywordRoutes(deps) },
    { path: '/projects', routes: projectInsightRoutes(deps) },
    { path: '/projects', routes: projectTrendRoutes(deps) },
    { path: '/projects', routes: projectLocalRoutes(deps) },
    { path: '/projects', routes: projectBusinessProfileRoutes(deps) },
    { path: '/projects', routes: projectLocalPostRoutes(deps) },
    { path: '/projects', routes: projectLocalResearchRoutes(deps) },
    { path: '/projects', routes: projectMerchantRoutes(deps) },
    { path: '/recommendations', routes: recommendationRoutes(deps) },
    { path: '/projects', routes: reports.project },
    { path: '/reports', routes: reports.reports },
    { path: '/billing', routes: billing.billing },
    { path: '/usage', routes: billing.usage },
    { path: '/projects', routes: integrations.project },
    { path: '/integrations', routes: integrations.integrations },
    { path: '/ai-visibility', routes: aiVisibilityRoutes(deps) },
    { path: '/audits', routes: auditRoutes(deps) },
    { path: '/issues', routes: issueRoutes(deps) },
    { path: '/crawl', routes: crawlRoutes(deps) },
    { path: '/public', routes: publicRoutes(deps) },
    { path: '/jobs', routes: jobRoutes(deps) },
    { path: '/notifications', routes: notificationRoutes(deps) },
    { path: '/admin', routes: adminRoutes(deps) },
    { path: '/admin', routes: adminOpsRoutes(deps) },
    { path: '/approvals', routes: approvalRoutes(deps) },
    { path: '/projects', routes: tasks.project },
    { path: '/workspaces', routes: tasks.workspace },
    { path: '/tasks', routes: tasks.tasks },
    { path: '/agency', routes: agency.agency },
    { path: '/workspaces', routes: agency.workspace },
  ];
}

export function createApp(deps: AppDeps): { app: Express; registry: OpenApiRegistry } {
  const env = getEnv();
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', env.trustProxy);

  app.use(requestContext);
  app.use(
    pinoHttp({
      logger: deps.logger,
      genReqId: (req) => (req as express.Request).id,
      autoLogging: { ignore: (req) => req.url === `${API_PREFIX}/health` },
      customLogLevel: (_req, res, error) =>
        error || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
    }),
  );

  // Strict defaults for JSON API responses; the docs UI gets its own policy below.
  const apiHelmet = helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
    },
    crossOriginResourcePolicy: { policy: 'same-site' },
    hsts: env.isProduction ? { maxAge: 31_536_000, includeSubDomains: true } : false,
  });

  const allowedOrigins = new Set([...env.CORS_ALLOWED_ORIGINS, new URL(env.APP_URL).origin]);
  const corsMiddleware = cors({
    origin: (origin, callback) => callback(null, !origin || allowedOrigins.has(origin)),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-CSRF-Token', 'X-Request-Id'],
    exposedHeaders: ['X-Request-Id', 'RateLimit', 'RateLimit-Policy', 'Retry-After', 'Content-Disposition'],
    maxAge: 600,
  });

  app.use('/api', corsMiddleware);

  // Webhook signatures are computed over the raw body, so these routes skip JSON parsing.
  app.use(`${API_PREFIX}/billing/webhooks`, express.raw({ type: '*/*', limit: '1mb' }));
  // Product feed files are uploaded as JSON text and can be up to 20 MB (PRODUCT_FEED_MAX_CHARS).
  app.use(/^\/api\/v1\/projects\/[^/]+\/merchant\/import(\/preview)?$/, express.json({ limit: '25mb' }));
  // Local observation CSVs (up to 2 MB) and saved Google results pages (a few MB each, up to 10 pages).
  app.use(/^\/api\/v1\/projects\/[^/]+\/local\/queries\/[^/]+\/import$/, express.json({ limit: '3mb' }));
  app.use(
    /^\/api\/v1\/projects\/[^/]+\/local\/(queries\/[^/]+\/google-capture|scans\/[^/]+\/google-capture\/pages)$/,
    express.json({ limit: '40mb' }),
  );
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());
  // Sessions are only needed by API routes (static web assets must not trigger session lookups).
  app.use('/api', sessionMiddleware(deps.prisma));

  const registry = new OpenApiRegistry();
  const docsHelmet = helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        frameAncestors: ["'none'"],
      },
    },
  });
  app.get(`${API_PREFIX}/openapi.json`, apiHelmet, (_req, res) => {
    res.json(openApiDocument(registry));
  });
  app.use(
    '/api/docs',
    docsHelmet,
    swaggerUi.serve,
    swaggerUi.setup(undefined, {
      customSiteTitle: `${env.APP_NAME} API`,
      swaggerOptions: { url: `${API_PREFIX}/openapi.json`, withCredentials: true },
    }),
  );

  app.use('/api', apiHelmet);
  app.use('/api', csrfProtection(CSRF_EXEMPT));
  app.use(
    '/api',
    createRateLimiter(deps, { name: 'api', windowMs: 5 * 60 * 1000, limit: 1500, key: 'user' }),
  );

  const v1: Router = express.Router();
  for (const group of routeGroups(deps)) {
    v1.use(group.path, buildRouter(group.routes, registry, `${API_PREFIX}${group.path}`));
  }
  app.use(API_PREFIX, v1);
  app.use('/api', apiNotFound);
  if (env.SERVE_WEB_DIST) mountWebApp(app);

  app.use(errorHandler(deps.logger));
  return { app, registry };
}

export function openApiDocument(registry: OpenApiRegistry): Record<string, unknown> {
  const env = getEnv();
  return registry.document({
    title: `${env.APP_NAME} API`,
    version: '1.0.0',
    description:
      'REST API for the Surfaced SEO, AEO and GEO platform. Authentication uses an HTTP-only session cookie; state-changing requests require the X-CSRF-Token header. Responses use { data, meta } on success and { error: { code, message, details, requestId } } on failure.',
    serverUrl: env.API_URL,
  });
}
