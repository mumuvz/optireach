import { Redis, type RedisOptions } from 'ioredis';
import { getEnv } from './env';

export type RedisPurpose = 'producer' | 'worker' | 'general';

/**
 * Creates an ioredis connection from REDIS_URL.
 * - worker: maxRetriesPerRequest must be null (BullMQ requirement for blocking commands).
 * - producer: fail fast so HTTP requests surface queue outages instead of hanging.
 */
export function createRedisConnection(
  purpose: RedisPurpose = 'general',
  overrides: RedisOptions = {},
): Redis {
  const env = getEnv();
  const base: RedisOptions = {
    lazyConnect: false,
    enableReadyCheck: true,
    connectionName: `surfaced:${purpose}`,
    maxRetriesPerRequest: purpose === 'worker' ? null : purpose === 'producer' ? 2 : 3,
    retryStrategy: (times) => Math.min(times * 200, 5000),
  };
  return new Redis(env.REDIS_URL, { ...base, ...overrides });
}

let shared: Redis | null = null;

/** Shared general-purpose connection (rate limiting, health checks). */
export function getSharedRedis(): Redis {
  shared ??= createRedisConnection('general');
  return shared;
}

export async function closeSharedRedis(): Promise<void> {
  if (shared) {
    const current = shared;
    shared = null;
    await current.quit().catch(() => current.disconnect());
  }
}

export async function pingRedis(connection: Redis = getSharedRedis()): Promise<boolean> {
  try {
    return (await connection.ping()) === 'PONG';
  } catch {
    return false;
  }
}

export type { Redis };
