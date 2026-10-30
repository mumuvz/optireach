// Starts the isolated end-to-end stack and returns a teardown function.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, openSync } from 'node:fs';
import path from 'node:path';
import { Redis } from 'ioredis';
import { startFixtureSite } from '../packages/core/test/fixtures/fixture-site';

const root = path.resolve(import.meta.dirname, '..');
export const FIXTURE_PORT = 4599;
const PORT = 4100;
const QUEUE_PREFIX = 'surfaced-e2e';

async function waitFor(url: string, timeoutMs: number, processes: ChildProcess[]): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (processes.some((p) => p.exitCode !== null))
      throw new Error('A stack process exited during start-up; see var/e2e-logs.');
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  const envFile = path.join(root, '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const databaseUrl = process.env.E2E_DATABASE_URL;
  if (!databaseUrl || !new URL(databaseUrl).pathname.endsWith('_e2e')) {
    throw new Error(
      'E2E_DATABASE_URL must be set to a database whose name ends with "_e2e" (see .env.example).',
    );
  }
  if (!existsSync(path.join(root, 'apps/web/dist/app.html'))) {
    throw new Error(
      'The web app is not built. Run "npm run build -w @surfaced/web" (npm run test:e2e does this).',
    );
  }

  // Non-destructive: creates the database if needed and applies pending migrations.
  execFileSync(
    process.execPath,
    [path.join(root, 'node_modules/prisma/build/index.js'), 'migrate', 'deploy'],
    {
      cwd: root,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
    },
  );

  // The e2e Redis namespace (queues and rate-limit counters) is only used by this suite.
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379', {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });
  await redis.connect();
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', `${QUEUE_PREFIX}:*`, 'COUNT', 500);
    cursor = next;
    if (keys.length) await redis.del(...keys);
  } while (cursor !== '0');
  await redis.quit();

  const site = await startFixtureSite({ port: FIXTURE_PORT });

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'development',
    DATABASE_URL: databaseUrl,
    API_PORT: String(PORT),
    API_URL: `http://localhost:${PORT}`,
    APP_URL: `http://localhost:${PORT}`,
    CORS_ALLOWED_ORIGINS: `http://localhost:${PORT}`,
    SERVE_WEB_DIST: 'true',
    QUEUE_PREFIX,
    LLM_PROVIDER: 'dev',
    AI_DEMO_MODE: 'true',
    // No request may reach a paid or external provider with the developer's own keys from .env.
    OPENAI_API_KEY: '',
    PERPLEXITY_API_KEY: '',
    GEMINI_API_KEY: '',
    GOOGLE_MAPS_API_KEY: '',
    GOOGLE_CSE_API_KEY: '',
    GOOGLE_CSE_CX: '',
    GEOCODER: 'none',
    SERP_PROVIDER: 'none',
    LOCAL_RANK_FIXTURES: 'false',
    BILLING_PROVIDER: 'dev',
    STRIPE_SECRET_KEY: '',
    STRIPE_WEBHOOK_SECRET: '',
    RAZORPAY_KEY_ID: '',
    RAZORPAY_KEY_SECRET: '',
    RAZORPAY_WEBHOOK_SECRET: '',
    GOOGLE_CLIENT_ID: '',
    GOOGLE_CLIENT_SECRET: '',
    // Keyword trends use only CSV and the labeled development fixture: no request reaches Google or DataForSEO.
    TRENDS_PROVIDERS: 'csv,fixture',
    PYTRENDS_SERVICE_URL: '',
    DATAFORSEO_LOGIN: '',
    DATAFORSEO_PASSWORD: '',
    EMAIL_PROVIDER: 'console',
    SMTP_HOST: '',
    PDF_RENDERER: 'none',
    STORAGE_LOCAL_DIR: path.join(root, 'var', 'e2e-storage'),
    CRAWLER_DEV_ALLOWLIST: `127.0.0.1:${FIXTURE_PORT}`,
    LOG_LEVEL: 'warn',
  };
  const logs = path.join(root, 'var', 'e2e-logs');
  mkdirSync(logs, { recursive: true });
  const start = (name: string, entry: string) => {
    const out = openSync(path.join(logs, `${name}.log`), 'w');
    return spawn(process.execPath, ['--import', 'tsx', entry], {
      cwd: root,
      env,
      stdio: ['ignore', out, out],
    });
  };
  const processes = [start('api', 'apps/api/src/index.ts'), start('worker', 'apps/worker/src/index.ts')];

  try {
    await waitFor(`http://localhost:${PORT}/api/v1/health`, 90_000, processes);
  } catch (error) {
    processes.forEach((p) => p.kill());
    await site.close();
    throw error;
  }

  return async () => {
    for (const p of processes) p.kill();
    await site.close();
  };
}
