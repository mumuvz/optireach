import { createRequire } from 'node:module';
import pino, { type Logger, type LoggerOptions } from 'pino';
import { getEnv } from './env';

/**
 * Paths that must never reach log output. Pino replaces them with "[REDACTED]".
 * Covers cookies/auth headers, passwords, tokens, API keys and OAuth/payment secrets.
 */
export const REDACT_PATHS = [
  'req.headers.cookie',
  'req.headers.authorization',
  'req.headers["x-csrf-token"]',
  'req.headers["stripe-signature"]',
  'req.headers["x-razorpay-signature"]',
  'res.headers["set-cookie"]',
  'password',
  'currentPassword',
  'newPassword',
  'token',
  'accessToken',
  'refreshToken',
  'apiKey',
  'secret',
  'clientSecret',
  'authorization',
  '*.password',
  '*.currentPassword',
  '*.newPassword',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.apiKey',
  '*.secret',
  '*.clientSecret',
  '*.authorization',
  '*.cookie',
];

function prettyAvailable(): boolean {
  try {
    createRequire(import.meta.url).resolve('pino-pretty');
    return true;
  } catch {
    return false;
  }
}

const loggers = new Map<string, Logger>();

export function createLogger(service: string, overrides: LoggerOptions = {}): Logger {
  const env = getEnv();
  const format = env.LOG_FORMAT ?? (env.isProduction || env.isTest ? 'json' : 'pretty');
  const options: LoggerOptions = {
    level: env.isTest && !process.env.LOG_LEVEL ? 'silent' : env.LOG_LEVEL,
    base: { service },
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    timestamp: pino.stdTimeFunctions.isoTime,
    ...overrides,
  };
  if (format === 'pretty' && prettyAvailable()) {
    options.transport = {
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname,service' },
    };
  }
  return pino(options);
}

/** Process-wide logger per service name. */
export function getLogger(service = 'surfaced'): Logger {
  let logger = loggers.get(service);
  if (!logger) {
    logger = createLogger(service);
    loggers.set(service, logger);
  }
  return logger;
}

export type { Logger };
