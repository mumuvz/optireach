import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';

const REQUEST_ID_RE = /^[A-Za-z0-9._-]{8,100}$/;

/** Assigns a correlation id (honouring a well-formed incoming X-Request-Id) and resolves the client IP. */
export const requestContext: RequestHandler = (req, res, next) => {
  const incoming = req.get('x-request-id');
  req.id = incoming && REQUEST_ID_RE.test(incoming) ? incoming : randomUUID();
  res.setHeader('X-Request-Id', req.id);
  // req.ip respects the configured `trust proxy` setting.
  req.clientIp = req.ip ?? req.socket.remoteAddress ?? 'unknown';
  next();
};
