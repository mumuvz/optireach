// Declarative routes: validation, auth mode, response envelope and OpenAPI metadata in one place.
import { Errors } from '@surfaced/core/errors';
import type { ValidationIssue } from '@surfaced/shared';
import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import type { AuthContext, AuthUser } from '../types';
import type { HandlerResult } from './http';

export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';
export type AuthMode = 'public' | 'optional' | 'user' | 'admin';

type Infer<S> = S extends z.ZodType ? z.output<S> : undefined;

export interface RouteContext<P, Q, B, U> {
  req: Request;
  res: Response;
  params: P;
  query: Q;
  body: B;
  auth: AuthContext | undefined;
  /** Present for auth modes "user" and "admin". */
  user: U;
}

export interface RouteDef<PS, QS, BS, M extends AuthMode> {
  method: HttpMethod;
  path: string;
  summary: string;
  description?: string;
  tags: string[];
  auth: M;
  params?: PS;
  query?: QS;
  body?: BS;
  /** Extra middleware run before validation (e.g. rate limiters). */
  middleware?: RequestHandler[];
  /** Documented success status (default 200). */
  successStatus?: number;
  /** Non-JSON responses (files, HTML) for the OpenAPI document. */
  produces?: string;
  handler: (
    ctx: RouteContext<
      Infer<PS>,
      Infer<QS>,
      Infer<BS>,
      M extends 'user' | 'admin' ? AuthUser : AuthUser | undefined
    >,
  ) => Promise<HandlerResult | void> | HandlerResult | void;
}

export interface AnyRoute {
  method: HttpMethod;
  path: string;
  summary: string;
  description?: string;
  tags: string[];
  auth: AuthMode;
  params?: z.ZodType;
  query?: z.ZodType;
  body?: z.ZodType;
  middleware?: RequestHandler[];
  successStatus?: number;
  produces?: string;
  handler: (
    ctx: RouteContext<unknown, unknown, unknown, unknown>,
  ) => Promise<HandlerResult | void> | HandlerResult | void;
}

export function route<
  PS extends z.ZodType | undefined = undefined,
  QS extends z.ZodType | undefined = undefined,
  BS extends z.ZodType | undefined = undefined,
  M extends AuthMode = 'user',
>(def: RouteDef<PS, QS, BS, M>): AnyRoute {
  return def as unknown as AnyRoute;
}

export function toValidationIssues(error: z.ZodError, prefix?: string): ValidationIssue[] {
  return error.issues.map((issue) => ({
    path: [prefix, ...issue.path.map(String)].filter(Boolean).join('.'),
    message: issue.message,
  }));
}

function parsePart(schema: z.ZodType, value: unknown, part: string): unknown {
  const result = schema.safeParse(value);
  if (!result.success) throw Errors.validation(toValidationIssues(result.error, part));
  return result.data;
}

function wrap(def: AnyRoute): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (def.auth === 'user' || def.auth === 'admin') {
        if (!req.auth) throw Errors.unauthenticated();
        if (def.auth === 'admin' && req.auth.user.platformRole !== 'ADMIN') throw Errors.notFound('Page');
      }
      const params = def.params ? parsePart(def.params, req.params, 'params') : req.params;
      const query = def.query ? parsePart(def.query, req.query, 'query') : {};
      const body = def.body ? parsePart(def.body, req.body ?? {}, 'body') : undefined;
      const result = await def.handler({
        req,
        res,
        params,
        query,
        body,
        auth: req.auth,
        user: req.auth?.user,
      });
      // Handlers that write the response themselves (files, streams) must finish before returning.
      if (res.headersSent || res.writableEnded) return;
      if (!result || result.status === 204) {
        res.status(204).end();
        return;
      }
      const payload = result.meta
        ? { data: result.data ?? null, meta: result.meta }
        : { data: result.data ?? null };
      res.status(result.status ?? 200).json(payload);
    } catch (error) {
      next(error);
    }
  };
}

// ---------------- OpenAPI ----------------

interface RegisteredOperation {
  method: HttpMethod;
  path: string;
  route: AnyRoute;
}

function jsonSchema(schema: z.ZodType): unknown {
  try {
    return z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' });
  } catch {
    return {};
  }
}

function objectShape(schema: z.ZodType | undefined): Record<string, z.ZodType> {
  if (!schema) return {};
  const candidate = schema as unknown as { shape?: Record<string, z.ZodType> };
  return candidate.shape ?? {};
}

export class OpenApiRegistry {
  private readonly operations: RegisteredOperation[] = [];

  add(method: HttpMethod, path: string, route: AnyRoute): void {
    this.operations.push({ method, path, route });
  }

  get size(): number {
    return this.operations.length;
  }

  document(info: {
    title: string;
    version: string;
    description: string;
    serverUrl: string;
  }): Record<string, unknown> {
    const paths: Record<string, Record<string, unknown>> = {};
    for (const { method, path, route } of this.operations) {
      const openApiPath = path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
      const parameters = [
        ...Object.entries(objectShape(route.params)).map(([name, schema]) => ({
          name,
          in: 'path',
          required: true,
          schema: jsonSchema(schema),
        })),
        ...Object.entries(objectShape(route.query)).map(([name, schema]) => ({
          name,
          in: 'query',
          required: !schema.safeParse(undefined).success,
          schema: jsonSchema(schema),
        })),
      ];
      const success = String(route.successStatus ?? 200);
      const responses: Record<string, unknown> = {
        [success]: route.produces
          ? { description: 'Success', content: { [route.produces]: {} } }
          : {
              description: 'Success',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Success' } } },
            },
        '400': { $ref: '#/components/responses/Error' },
        '429': { $ref: '#/components/responses/Error' },
        '500': { $ref: '#/components/responses/Error' },
      };
      if (route.auth === 'user' || route.auth === 'admin') {
        responses['401'] = { $ref: '#/components/responses/Error' };
        responses['403'] = { $ref: '#/components/responses/Error' };
        responses['404'] = { $ref: '#/components/responses/Error' };
      }
      const mutating = method !== 'get';
      paths[openApiPath] ??= {};
      paths[openApiPath][method] = {
        summary: route.summary,
        description: route.description,
        tags: route.tags,
        parameters: parameters.length ? parameters : undefined,
        requestBody: route.body
          ? { required: true, content: { 'application/json': { schema: jsonSchema(route.body) } } }
          : undefined,
        security:
          route.auth === 'public'
            ? []
            : mutating
              ? [{ sessionCookie: [], csrfHeader: [] }]
              : [{ sessionCookie: [] }],
        responses,
      };
    }
    return {
      openapi: '3.1.0',
      info: { title: info.title, version: info.version, description: info.description },
      servers: [{ url: info.serverUrl }],
      paths,
      components: {
        securitySchemes: {
          sessionCookie: {
            type: 'apiKey',
            in: 'cookie',
            name: 'sf_session',
            description: 'HTTP-only session cookie set by /auth/login.',
          },
          csrfHeader: {
            type: 'apiKey',
            in: 'header',
            name: 'X-CSRF-Token',
            description:
              'Must equal the sf_csrf cookie (obtain via GET /auth/csrf). Required on state-changing requests.',
          },
        },
        schemas: {
          Success: {
            type: 'object',
            properties: { data: {}, meta: { $ref: '#/components/schemas/PageMeta' } },
            required: ['data'],
          },
          PageMeta: {
            type: 'object',
            properties: {
              page: { type: 'integer' },
              pageSize: { type: 'integer' },
              total: { type: 'integer' },
              totalPages: { type: 'integer' },
            },
          },
          Error: {
            type: 'object',
            properties: {
              error: {
                type: 'object',
                properties: {
                  code: { type: 'string' },
                  message: { type: 'string' },
                  details: {},
                  requestId: { type: 'string' },
                },
                required: ['code', 'message'],
              },
            },
          },
        },
        responses: {
          Error: {
            description: 'Error',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
          },
        },
      },
    };
  }
}

/** Builds an Express router for a group of routes and records them in the OpenAPI registry. */
export function buildRouter(routes: AnyRoute[], registry: OpenApiRegistry, mountPath: string): Router {
  const router = Router();
  for (const def of routes) {
    router[def.method](def.path, ...(def.middleware ?? []), wrap(def));
    const fullPath = `${mountPath}${def.path === '/' ? '' : def.path}`;
    registry.add(def.method, fullPath, def);
  }
  return router;
}
