import {
  SEO_COMPARISON_MAX_COMPETITORS,
  competitorComparisonQuerySchema,
  idSchema,
  recommendationListQuerySchema,
  recommendationUpdateSchema,
} from '@surfaced/shared';
import { z } from 'zod';
import { accepted, ok } from '../lib/http';
import { route, type AnyRoute } from '../lib/router';
import { CompetitorAnalysisService, RecommendationService } from '../services/insights.service';
import type { AppDeps } from '../types';

const projectParams = z.object({ projectId: idSchema });

export function projectInsightRoutes(deps: AppDeps): AnyRoute[] {
  const competitors = new CompetitorAnalysisService(deps);
  const recommendations = new RecommendationService(deps);
  const tags = ['Competitors'];
  return [
    route({
      method: 'get',
      path: '/:projectId/competitors/comparison',
      summary: 'AI mention/citation comparison and shared vs competitor-only cited sources',
      tags,
      auth: 'user',
      params: projectParams,
      query: competitorComparisonQuerySchema,
      handler: async ({ user, params, query }) =>
        ok(await competitors.comparison(user, params.projectId, query)),
    }),
    route({
      method: 'get',
      path: '/:projectId/competitors/topic-gaps',
      summary: 'Prompts where competitors appear in answers and your brand does not',
      tags,
      auth: 'user',
      params: projectParams,
      query: competitorComparisonQuerySchema,
      handler: async ({ user, params, query }) => ok(await competitors.gaps(user, params.projectId, query)),
    }),
    route({
      method: 'get',
      path: '/:projectId/competitors/trend',
      summary: 'Mention-rate trend per entity',
      tags,
      auth: 'user',
      params: projectParams,
      query: competitorComparisonQuerySchema.extend({
        bucket: z.enum(['day', 'week', 'month']).default('week'),
      }),
      handler: async ({ user, params, query }) => {
        const { bucket, ...filter } = query;
        return ok(await competitors.trend(user, params.projectId, filter, bucket));
      },
    }),
    route({
      method: 'get',
      path: '/:projectId/competitors/metadata',
      summary: 'Public on-page metadata comparison (your crawl vs competitor snapshots)',
      tags,
      auth: 'user',
      params: projectParams,
      handler: async ({ user, params }) => ok(await competitors.metadata(user, params.projectId)),
    }),
    route({
      method: 'post',
      path: '/:projectId/competitors/:competitorId/snapshot',
      summary: "Fetch a competitor's public pages (robots.txt respected)",
      tags,
      auth: 'user',
      params: projectParams.extend({ competitorId: idSchema }),
      successStatus: 202,
      handler: async ({ user, params }) =>
        accepted(await competitors.snapshot(user, params.projectId, params.competitorId)),
    }),
    route({
      method: 'get',
      path: '/:projectId/competitors/:competitorId/snapshots/latest',
      summary: 'Latest competitor snapshot',
      tags,
      auth: 'user',
      params: projectParams.extend({ competitorId: idSchema }),
      handler: async ({ user, params }) =>
        ok(await competitors.latestSnapshot(user, params.projectId, params.competitorId)),
    }),
    route({
      method: 'post',
      path: '/:projectId/gap-analyses',
      summary:
        'Analyze why AI answers recommend other brands: brands, reasons, cited sources, live page checks and an action plan',
      tags,
      auth: 'user',
      params: projectParams,
      successStatus: 202,
      handler: async ({ user, params }) =>
        accepted(await competitors.startGapAnalysis(user, params.projectId)),
    }),
    route({
      method: 'get',
      path: '/:projectId/gap-analyses/latest',
      summary: 'Latest competitor gap analysis (null when none has been run)',
      tags,
      auth: 'user',
      params: projectParams,
      handler: async ({ user, params }) => ok(await competitors.latestGapAnalysis(user, params.projectId)),
    }),
    route({
      method: 'post',
      path: '/:projectId/gap-analyses/:analysisId/recommendations',
      summary: 'Save one action of a gap analysis as a recommendation',
      tags,
      auth: 'user',
      params: projectParams.extend({ analysisId: idSchema }),
      body: z.object({ actionKey: z.string().trim().min(1).max(200) }),
      handler: async ({ user, params, body }) =>
        ok(await competitors.saveGapAction(user, params.projectId, params.analysisId, body.actionKey)),
    }),
    route({
      method: 'post',
      path: '/:projectId/seo-comparisons',
      summary:
        'Crawl your site and up to five competitors the same way and compare their SEO (background job; uses competitor snapshot quota)',
      tags,
      auth: 'user',
      params: projectParams,
      body: z
        .object({
          competitorIds: z.array(idSchema).max(SEO_COMPARISON_MAX_COMPETITORS).optional(),
        })
        .optional(),
      successStatus: 202,
      handler: async ({ user, params, body }) =>
        accepted(await competitors.startSeoComparison(user, params.projectId, body?.competitorIds)),
    }),
    route({
      method: 'get',
      path: '/:projectId/seo-comparisons/latest',
      summary: 'Latest SEO comparison (null when none has been run)',
      tags,
      auth: 'user',
      params: projectParams,
      handler: async ({ user, params }) => ok(await competitors.latestSeoComparison(user, params.projectId)),
    }),
    route({
      method: 'post',
      path: '/:projectId/seo-comparisons/:comparisonId/recommendations',
      summary: 'Save one suggestion of an SEO comparison as a recommendation',
      tags,
      auth: 'user',
      params: projectParams.extend({ comparisonId: idSchema }),
      body: z.object({ suggestionKey: z.string().trim().min(1).max(200) }),
      handler: async ({ user, params, body }) =>
        ok(
          await competitors.saveSeoSuggestion(
            user,
            params.projectId,
            params.comparisonId,
            body.suggestionKey,
          ),
        ),
    }),
    route({
      method: 'get',
      path: '/:projectId/recommendations',
      summary: 'Recommendations with filters',
      tags: ['Recommendations'],
      auth: 'user',
      params: projectParams,
      query: recommendationListQuerySchema,
      handler: async ({ user, params, query }) => {
        const { items, meta, byStatus } = await recommendations.list(user, params.projectId, query);
        return { status: 200, data: { items, byStatus }, meta };
      },
    }),
    route({
      method: 'post',
      path: '/:projectId/recommendations/regenerate',
      summary: 'Rebuild recommendations from the latest audit and AI visibility evidence',
      tags: ['Recommendations'],
      auth: 'user',
      params: projectParams,
      handler: async ({ user, params }) => ok(await recommendations.regenerate(user, params.projectId)),
    }),
  ];
}

export function recommendationRoutes(deps: AppDeps): AnyRoute[] {
  const service = new RecommendationService(deps);
  const tags = ['Recommendations'];
  const params = z.object({ recommendationId: idSchema });
  return [
    route({
      method: 'get',
      path: '/:recommendationId',
      summary: 'Recommendation detail with evidence',
      tags,
      auth: 'user',
      params,
      handler: async ({ user, params: p }) => ok(await service.get(user, p.recommendationId)),
    }),
    route({
      method: 'patch',
      path: '/:recommendationId',
      summary: 'Change status (accept/start, await approval, complete, dismiss) or assignee',
      tags,
      auth: 'user',
      params,
      body: recommendationUpdateSchema,
      handler: async ({ user, params: p, body }) => ok(await service.update(user, p.recommendationId, body)),
    }),
  ];
}
