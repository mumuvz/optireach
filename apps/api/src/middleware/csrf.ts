// CSRF protection for cookie-authenticated, state-changing requests:
//  1. Signed double-submit token: the X-CSRF-Token header must equal the sf_csrf cookie, and the token
//     must carry a valid HMAC (so arbitrary values cannot be planted).
//  2. Origin check: browsers send Origin on cross-site POSTs; it must be an allowed origin.
// Webhooks and OAuth callbacks are exempt (they are verified by signature / OAuth state instead).
import { hmacSha256, randomToken, safeEqual } from '@surfaced/core/crypto';
import { getEnv } from '@surfaced/core/env';
import { Errors } from '@surfaced/core/errors';
import type { Request, RequestHandler, Response } from 'express';
import { CSRF_COOKIE, baseCookieOptions } from './session';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function sign(nonce: string): string {
  return hmacSha256(getEnv().SESSION_SECRET, `csrf:${nonce}`);
}

export function createCsrfToken(): string {
  const nonce = randomToken(18);
  return `${nonce}.${sign(nonce)}`;
}

export function isValidCsrfToken(token: string): boolean {
  const [nonce, signature, extra] = token.split('.');
  if (!nonce || !signature || extra !== undefined) return false;
  return safeEqual(signature, sign(nonce));
}

/** Sets a fresh CSRF cookie (readable by the SPA) and returns the token. */
export function issueCsrfToken(res: Response): string {
  const token = createCsrfToken();
  res.cookie(CSRF_COOKIE, token, { ...baseCookieOptions(), httpOnly: false, maxAge: 7 * 24 * 3600 * 1000 });
  return token;
}

function requestOrigin(req: Request): string | null {
  const origin = req.get('origin');
  if (origin) return origin;
  const referer = req.get('referer');
  if (!referer) return null;
  try {
    return new URL(referer).origin;
  } catch {
    return 'invalid';
  }
}

export function csrfProtection(exemptPaths: RegExp[]): RequestHandler {
  return (req, _res, next) => {
    if (SAFE_METHODS.has(req.method)) return next();
    if (exemptPaths.some((re) => re.test(req.path))) return next();

    const env = getEnv();
    const origin = requestOrigin(req);
    if (origin) {
      const allowed = new Set([
        ...env.CORS_ALLOWED_ORIGINS,
        new URL(env.API_URL).origin,
        new URL(env.APP_URL).origin,
      ]);
      if (!allowed.has(origin)) return next(Errors.csrf());
    }

    const header = req.get('x-csrf-token');
    const cookie: unknown = req.cookies?.[CSRF_COOKIE];
    if (!header || typeof cookie !== 'string' || !safeEqual(header, cookie) || !isValidCsrfToken(header)) {
      return next(Errors.csrf());
    }
    next();
  };
}
