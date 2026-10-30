import {
  forgotPasswordSchema,
  loginSchema,
  registerSchema,
  resetPasswordSchema,
  verifyEmailSchema,
} from '@surfaced/shared';
import type { Request } from 'express';
import { accepted, created, noContent, ok } from '../lib/http';
import { route, type AnyRoute } from '../lib/router';
import { issueCsrfToken } from '../middleware/csrf';
import { authLimiters } from '../middleware/rate-limit';
import { clearSessionCookie, setSessionCookie } from '../middleware/session';
import { AuthService, type RequestMeta } from '../services/auth.service';
import type { AppDeps } from '../types';

export function requestMeta(req: Request): RequestMeta {
  return { ip: req.clientIp, userAgent: req.get('user-agent') ?? undefined };
}

export function authRoutes(deps: AppDeps): AnyRoute[] {
  const auth = new AuthService(deps);
  const limit = authLimiters(deps);
  const tags = ['Auth'];

  return [
    route({
      method: 'get',
      path: '/csrf',
      summary: 'Issue a CSRF token cookie',
      description:
        'Sets the sf_csrf cookie. Send its value in the X-CSRF-Token header on state-changing requests.',
      tags,
      auth: 'public',
      handler: ({ res }) => ok({ csrfToken: issueCsrfToken(res) }),
    }),
    route({
      method: 'post',
      path: '/register',
      summary: 'Create an account, workspace and session',
      tags,
      auth: 'public',
      body: registerSchema,
      middleware: [limit.register],
      successStatus: 201,
      handler: async ({ req, res, body }) => {
        const { user, session } = await auth.register(body, requestMeta(req));
        setSessionCookie(res, session.token, session.expiresAt);
        issueCsrfToken(res);
        return created(await auth.me(user.id));
      },
    }),
    route({
      method: 'post',
      path: '/login',
      summary: 'Sign in with email and password',
      tags,
      auth: 'public',
      body: loginSchema,
      middleware: [limit.loginByIp, limit.loginByAccount],
      handler: async ({ req, res, body }) => {
        const { user, session } = await auth.login(body.email, body.password, requestMeta(req));
        setSessionCookie(res, session.token, session.expiresAt);
        issueCsrfToken(res);
        return ok(await auth.me(user.id));
      },
    }),
    route({
      method: 'post',
      path: '/logout',
      summary: 'Sign out and revoke the current session',
      tags,
      auth: 'optional',
      handler: async ({ res, auth: ctx }) => {
        if (ctx) await auth.logout(ctx.sessionId);
        clearSessionCookie(res);
        issueCsrfToken(res);
        return noContent();
      },
    }),
    route({
      method: 'get',
      path: '/me',
      summary: 'Current user, memberships and current workspace',
      tags,
      auth: 'user',
      handler: async ({ user }) => ok(await auth.me(user.id)),
    }),
    route({
      method: 'post',
      path: '/verify-email',
      summary: 'Confirm an email address with a verification token',
      tags,
      auth: 'public',
      body: verifyEmailSchema,
      middleware: [limit.verification],
      handler: async ({ body }) => {
        await auth.verifyEmail(body.token);
        return ok({ verified: true });
      },
    }),
    route({
      method: 'post',
      path: '/resend-verification',
      summary: 'Send a new verification email',
      tags,
      auth: 'user',
      middleware: [limit.verification],
      successStatus: 202,
      handler: async ({ user }) => {
        const record = await deps.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
        await auth.sendVerificationEmail(record);
        return accepted({ queued: !record.emailVerifiedAt });
      },
    }),
    route({
      method: 'post',
      path: '/forgot-password',
      summary: 'Request a password reset email',
      description: 'Always returns 202 so the response does not reveal whether an account exists.',
      tags,
      auth: 'public',
      body: forgotPasswordSchema,
      middleware: [limit.passwordReset],
      successStatus: 202,
      handler: async ({ req, body }) => {
        await auth.forgotPassword(body.email, requestMeta(req));
        return accepted({ message: 'If an account exists for that email, a reset link is on its way.' });
      },
    }),
    route({
      method: 'post',
      path: '/reset-password',
      summary: 'Set a new password with a reset token (signs out all sessions)',
      tags,
      auth: 'public',
      body: resetPasswordSchema,
      middleware: [limit.passwordReset],
      handler: async ({ req, res, body }) => {
        await auth.resetPassword(body.token, body.password, requestMeta(req));
        clearSessionCookie(res);
        return ok({ message: 'Your password has been updated. Sign in with your new password.' });
      },
    }),
  ];
}
