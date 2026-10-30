import type { ErrorCode } from '@surfaced/shared';

/**
 * Application error with an HTTP status and a stable machine-readable code. Services throw these;
 * the API error handler serializes them as { error: { code, message, details, requestId } }.
 * `expose: false` hides the message from clients (used for unexpected internal failures).
 */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown,
    public readonly expose = true,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const Errors = {
  badRequest: (message = 'The request could not be processed.', details?: unknown) =>
    new AppError(400, 'BAD_REQUEST', message, details),
  validation: (details: unknown, message = 'Some fields are invalid.') =>
    new AppError(400, 'VALIDATION_ERROR', message, details),
  unauthenticated: (message = 'Please sign in to continue.') => new AppError(401, 'UNAUTHENTICATED', message),
  forbidden: (message = 'You do not have permission to do that.') => new AppError(403, 'FORBIDDEN', message),
  /** Also used for resources in other workspaces so their existence is not disclosed. */
  notFound: (what = 'Resource') => new AppError(404, 'NOT_FOUND', `${what} not found.`),
  conflict: (message: string, details?: unknown) => new AppError(409, 'CONFLICT', message, details),
  planLimit: (message: string, details?: unknown) =>
    new AppError(402, 'PLAN_LIMIT_REACHED', message, details),
  rateLimited: (message = 'Too many requests. Please try again later.') =>
    new AppError(429, 'RATE_LIMITED', message),
  csrf: () =>
    new AppError(
      403,
      'CSRF_INVALID',
      'Your session token is missing or expired. Refresh the page and try again.',
    ),
  payloadTooLarge: (message = 'The request body is too large.') =>
    new AppError(413, 'PAYLOAD_TOO_LARGE', message),
  emailNotVerified: () =>
    new AppError(403, 'EMAIL_NOT_VERIFIED', 'Verify your email address to use this feature.'),
  accountDisabled: () =>
    new AppError(403, 'ACCOUNT_DISABLED', 'This account has been disabled. Contact support.'),
  providerNotConfigured: (provider: string, details?: unknown) =>
    new AppError(503, 'PROVIDER_NOT_CONFIGURED', `${provider} is not configured on this server.`, details),
  unsupportedTarget: (message: string) => new AppError(422, 'UNSUPPORTED_TARGET', message),
  unavailable: (message = 'A required service is temporarily unavailable.') =>
    new AppError(503, 'SERVICE_UNAVAILABLE', message),
  upstream: (message: string, details?: unknown) => new AppError(502, 'UPSTREAM_ERROR', message, details),
  internal: (message = 'Something went wrong on our side.') =>
    new AppError(500, 'INTERNAL_ERROR', message, undefined, false),
};

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

/** Best-effort message extraction for logs and job records (never includes stack traces). */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return 'Unknown error';
  }
}
