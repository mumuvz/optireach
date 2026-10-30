import { disconnectPrisma, getPrisma } from '@surfaced/core/db';
import { getEnv } from '@surfaced/core/env';
import { getLogger } from '@surfaced/core/logger';
import { BullQueueGateway } from '@surfaced/core/queue';
import { createRedisConnection } from '@surfaced/core/redis';
import { createApp } from './app';

const env = getEnv();
const logger = getLogger('api');
const prisma = getPrisma();
const redis = createRedisConnection('general');
const queues = new BullQueueGateway();

redis.on('error', (error) => logger.warn({ err: error }, 'Redis connection error'));

const { app, registry } = createApp({ prisma, queues, redis, logger });

const server = app.listen(env.API_PORT, () => {
  logger.info(
    { port: env.API_PORT, routes: registry.size, billing: env.BILLING_PROVIDER, llm: env.LLM_PROVIDER },
    `API listening on http://localhost:${env.API_PORT} (docs at /api/docs)`,
  );
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Shutting down API');
  const force = setTimeout(() => process.exit(1), 10_000);
  force.unref();
  server.close();
  await Promise.allSettled([queues.close(), redis.quit(), disconnectPrisma()]);
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => logger.error({ err: reason }, 'Unhandled promise rejection'));
