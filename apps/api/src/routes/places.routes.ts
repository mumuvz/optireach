import { fillFromGoogleLink, geocodeLocation } from '@surfaced/core/local';
import { countryCodeSchema, idSchema } from '@surfaced/shared';
import { z } from 'zod';
import { ok } from '../lib/http';
import { route, type AnyRoute } from '../lib/router';
import { createRateLimiter } from '../middleware/rate-limit';
import { requireWorkspaceAccess } from '../services/access';
import type { AppDeps } from '../types';

const params = z.object({ workspaceId: idSchema });
const text = (max: number) => z.string().trim().max(max).nullable().optional();

/**
 * Helpers for filling a location: a Google link (resolved by redirect headers, then the official Places API when a
 * key is configured) and an address lookup (OpenStreetMap Nominatim). Workspace-scoped so the new-project wizard can
 * use them before a project exists; limited per user because both call external services.
 */
export function workspacePlaceRoutes(deps: AppDeps): AnyRoute[] {
  const { prisma } = deps;
  const tags = ['Local SEO'];
  const limiter = createRateLimiter(deps, { name: 'place-lookup', windowMs: 60_000, limit: 20, key: 'user' });
  return [
    route({
      method: 'post',
      path: '/:workspaceId/places/from-google-link',
      summary: 'Location details from a Google Maps or Google Search link (Places API when configured)',
      tags,
      auth: 'user',
      params,
      body: z.object({
        url: z.url().max(2048),
        city: text(120),
        country: countryCodeSchema.nullable().optional(),
      }),
      middleware: [limiter],
      handler: async ({ user, params: p, body }) => {
        await requireWorkspaceAccess(prisma, user, p.workspaceId, 'local.manage');
        return ok(
          await fillFromGoogleLink(
            body.url,
            { city: body.city, country: body.country },
            deps.httpFetch ?? fetch,
          ),
        );
      },
    }),
    route({
      method: 'post',
      path: '/:workspaceId/places/geocode',
      summary:
        'Map position candidates for an address (OpenStreetMap Nominatim; approximate when only the area is found)',
      tags,
      auth: 'user',
      params,
      body: z.object({
        addressLine1: text(200),
        locality: text(120),
        city: z.string().trim().min(2).max(120),
        region: text(120),
        postalCode: text(20),
        country: countryCodeSchema,
      }),
      middleware: [limiter],
      handler: async ({ user, params: p, body }) => {
        await requireWorkspaceAccess(prisma, user, p.workspaceId, 'local.manage');
        return ok({ candidates: await geocodeLocation(body, deps.httpFetch ?? fetch) });
      },
    }),
  ];
}
