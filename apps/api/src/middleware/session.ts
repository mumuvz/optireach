import { hashToken } from '@surfaced/core/crypto';
import type { PrismaClient } from '@surfaced/core/db';
import { getEnv } from '@surfaced/core/env';
import type { CookieOptions, RequestHandler, Response } from 'express';

export const SESSION_COOKIE = 'sf_session';
export const CSRF_COOKIE = 'sf_csrf';

/** Only refresh lastSeenAt this often, to avoid a write on every request. */
const LAST_SEEN_THROTTLE_MS = 5 * 60 * 1000;

export function baseCookieOptions(): CookieOptions {
  const env = getEnv();
  return {
    secure: env.cookieSecure,
    sameSite: 'lax',
    path: '/',
    domain: env.COOKIE_DOMAIN || undefined,
  };
}

export function setSessionCookie(res: Response, token: string, expiresAt: Date): void {
  res.cookie(SESSION_COOKIE, token, { ...baseCookieOptions(), httpOnly: true, expires: expiresAt });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE, { ...baseCookieOptions(), httpOnly: true });
}

/** Attaches req.auth when a valid, unexpired session belongs to an enabled user. Never throws for bad cookies. */
export function sessionMiddleware(prisma: PrismaClient): RequestHandler {
  return async (req, res, next) => {
    const token: unknown = req.cookies?.[SESSION_COOKIE];
    if (typeof token !== 'string' || token.length < 20 || token.length > 200) return next();
    try {
      const session = await prisma.session.findUnique({
        where: { tokenHash: hashToken(token) },
        include: {
          user: {
            select: {
              id: true,
              email: true,
              name: true,
              platformRole: true,
              emailVerifiedAt: true,
              disabledAt: true,
              deletionRequestedAt: true,
            },
          },
        },
      });
      const now = new Date();
      if (!session || session.expiresAt <= now || session.user.disabledAt) {
        if (session && (session.expiresAt <= now || session.user.disabledAt)) {
          await prisma.session.delete({ where: { id: session.id } }).catch(() => undefined);
        }
        clearSessionCookie(res);
        return next();
      }
      const { disabledAt: _disabled, ...user } = session.user;
      req.auth = { sessionId: session.id, user };
      if (now.getTime() - session.lastSeenAt.getTime() > LAST_SEEN_THROTTLE_MS) {
        await prisma.session
          .update({ where: { id: session.id }, data: { lastSeenAt: now } })
          .catch(() => undefined);
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}
