import { getEnv } from '@surfaced/core/env';
import { Errors } from '@surfaced/core/errors';
import type { Request, RequestHandler } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import { RedisStore, type RedisReply } from 'rate-limit-redis';
import type { AppDeps } from '../types';

export type RateLimitKey = 'ip' | 'ip+email' | 'user';

export interface RateLimitOptions {
  name: string;
  windowMs: number;
  limit: number;
  key?: RateLimitKey;
  message?: string;
}

function keyFor(req: Request, key: RateLimitKey): string {
  const ip = ipKeyGenerator(req.clientIp || req.ip || 'unknown');
  if (key === 'ip+email') {
    const email =
      typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase().slice(0, 254) : '';
    return `${ip}|${email}`;
  }
  if (key === 'user') return req.auth ? `u:${req.auth.user.id}` : ip;
  return ip;
}

/**
 * Rate limiter backed by Redis when available (shared across API replicas), otherwise by memory.
 * Exceeding the limit produces the standard RATE_LIMITED error envelope.
 */
export function createRateLimiter(
  deps: Pick<AppDeps, 'redis' | 'rateLimitMultiplier'>,
  options: RateLimitOptions,
): RequestHandler {
  const env = getEnv();
  const redis = deps.redis;
  return rateLimit({
    windowMs: options.windowMs,
    limit: Math.max(1, Math.round(options.limit * (deps.rateLimitMultiplier ?? 1))),
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    keyGenerator: (req) => keyFor(req, options.key ?? 'ip'),
    store: redis
      ? new RedisStore({
          prefix: `${env.QUEUE_PREFIX}:rl:${options.name}:`,
          sendCommand: (command: string, ...args: string[]) =>
            redis.call(command, ...args) as Promise<RedisReply>,
        })
      : undefined,
    handler: (_req, _res, next) => next(Errors.rateLimited(options.message)),
  });
}

/** Limits applied to sensitive endpoints. */
export function authLimiters(deps: Pick<AppDeps, 'redis' | 'rateLimitMultiplier'>) {
  const minutes = (n: number) => n * 60 * 1000;
  return {
    loginByAccount: createRateLimiter(deps, {
      name: 'login-account',
      windowMs: minutes(15),
      limit: 10,
      key: 'ip+email',
      message: 'Too many sign-in attempts. Please wait 15 minutes and try again.',
    }),
    loginByIp: createRateLimiter(deps, { name: 'login-ip', windowMs: minutes(15), limit: 50 }),
    register: createRateLimiter(deps, { name: 'register', windowMs: minutes(60), limit: 10 }),
    passwordReset: createRateLimiter(deps, {
      name: 'password-reset',
      windowMs: minutes(60),
      limit: 5,
      key: 'ip+email',
    }),
    verification: createRateLimiter(deps, { name: 'verification', windowMs: minutes(60), limit: 10 }),
    publicAudit: createRateLimiter(deps, {
      name: 'public-audit',
      windowMs: minutes(60),
      limit: 5,
      message: 'You have reached the free audit limit for now. Create a free account to run more audits.',
    }),
    contact: createRateLimiter(deps, { name: 'contact', windowMs: minutes(60), limit: 5 }),
  };
}
