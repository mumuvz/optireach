import type { BillingAdapter } from '@surfaced/core/billing';
import type { PrismaClient } from '@surfaced/core/db';
import type { Logger } from '@surfaced/core/logger';
import type { QueueGateway } from '@surfaced/core/queue';
import type { Redis } from '@surfaced/core/redis';
import type { PlatformRole } from '@surfaced/shared';

/** Everything the HTTP layer needs, injected so tests can swap Redis/queues for in-memory versions. */
export interface AppDeps {
  prisma: PrismaClient;
  queues: QueueGateway;
  /** Used for distributed rate limiting; null falls back to per-process memory stores. */
  redis: Redis | null;
  logger: Logger;
  /** Scales every rate limit (default 1). Tests that exercise many accounts raise it. */
  rateLimitMultiplier?: number;
  /** Webhook adapters override (tests); defaults to the configured provider. */
  billingAdapters?: Partial<Record<'STRIPE' | 'RAZORPAY', BillingAdapter>>;
  /** Outbound HTTP for provider APIs such as Google Business Profile (tests pass a fake; defaults to fetch). */
  httpFetch?: typeof fetch;
}

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  platformRole: PlatformRole;
  emailVerifiedAt: Date | null;
  deletionRequestedAt: Date | null;
}

export interface AuthContext {
  user: AuthUser;
  sessionId: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Correlation id (X-Request-Id). */
      id: string;
      /** Client IP after trusted-proxy resolution. */
      clientIp: string;
      auth?: AuthContext;
    }
  }
}
