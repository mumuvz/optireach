import { AppError, Errors } from '@surfaced/core/errors';
import type { Logger } from '@surfaced/core/logger';
import type { ErrorRequestHandler, RequestHandler } from 'express';

interface BodyParserError {
  type?: string;
  status?: number;
}

interface PrismaKnownError {
  code?: string;
  meta?: unknown;
}

/** Maps any thrown error to the standard error envelope without leaking internals. */
export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (error: unknown, req, res, next) => {
    if (res.headersSent) return next(error);

    let appError: AppError;
    const bodyError = error as BodyParserError;
    const prismaError = error as PrismaKnownError;
    if (error instanceof AppError) {
      appError = error;
    } else if (bodyError?.type === 'entity.too.large') {
      appError = Errors.payloadTooLarge();
    } else if (bodyError?.type === 'entity.parse.failed') {
      appError = Errors.badRequest('The request body is not valid JSON.');
    } else if (prismaError?.code === 'P2002') {
      appError = Errors.conflict('A record with these details already exists.');
    } else if (prismaError?.code === 'P2025') {
      appError = Errors.notFound();
    } else {
      appError = Errors.internal();
    }

    if (appError.status >= 500) {
      logger.error({ err: error, requestId: req.id, path: req.path, method: req.method }, 'Request failed');
    } else if (appError.status !== 401 && appError.status !== 404) {
      logger.info({ requestId: req.id, code: appError.code, path: req.path }, appError.message);
    }

    res.status(appError.status).json({
      error: {
        code: appError.code,
        message: appError.expose ? appError.message : 'Something went wrong on our side.',
        ...(appError.details !== undefined ? { details: appError.details } : {}),
        requestId: req.id,
      },
    });
  };
}

export const apiNotFound: RequestHandler = (req, _res, next) => {
  next(Errors.notFound(`Endpoint ${req.method} ${req.path}`));
};
