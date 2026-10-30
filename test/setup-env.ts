// Vitest setupFile for server-side projects: runs in every test worker before test modules load.
// Points all database access at TEST_DATABASE_URL and switches providers to safe local modes.
import { existsSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const envFile = path.join(root, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl || !/_test(\?|$)/.test(testUrl)) {
  throw new Error('TEST_DATABASE_URL must be set and point to a database whose name ends with "_test".');
}

Object.assign(process.env, {
  NODE_ENV: 'test',
  DATABASE_URL: testUrl,
  QUEUE_PREFIX: 'surfaced-test',
  LLM_PROVIDER: 'dev',
  AI_DEMO_MODE: 'true',
  BILLING_PROVIDER: 'dev',
  EMAIL_PROVIDER: 'console',
  STORAGE_LOCAL_DIR: path.join(root, 'var', 'test-storage'),
  APP_URL: 'http://localhost:5173',
  API_URL: 'http://localhost:4000',
  CORS_ALLOWED_ORIGINS: 'http://localhost:5173',
  PDF_RENDERER: 'none',
  // Only the fixture site's fixed port is reachable despite SSRF rules (never 127.0.0.1 in general).
  CRAWLER_DEV_ALLOWLIST: '127.0.0.1:4599',
  CRAWLER_CONCURRENCY: '2',
  // Trends providers as shipped; tests that need the fixture or a fake pytrends service set them explicitly.
  TRENDS_PROVIDERS: 'csv,pytrends,dataforseo,google_trends_api',
  TRENDS_CACHE_TTL_HOURS: 'default=12',
  // Local rank grids: no licensed provider and no fixture unless a test enables one.
  SERP_PROVIDER: 'none',
  LOCAL_RANK_FIXTURES: 'false',
  // Map lookups never reach OpenStreetMap from tests.
  GEOCODER: 'none',
  // Quiet test output; set TEST_LOG_LEVEL=debug to see API/worker logs while debugging.
  LOG_LEVEL: process.env.TEST_LOG_LEVEL ?? 'silent',
  LOG_FORMAT: 'json',
});
// Never call real third-party APIs from automated tests. Keys are blanked (not deleted) and the
// core env loader is told not to read .env again, so a later reload cannot restore them.
for (const key of [
  'OPENAI_API_KEY',
  'PERPLEXITY_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_MAPS_API_KEY',
  'GOOGLE_CSE_API_KEY',
  'GOOGLE_CSE_CX',
  'DATAFORSEO_LOGIN',
  'DATAFORSEO_PASSWORD',
  'PYTRENDS_SERVICE_URL',
  'PYTRENDS_SERVICE_TOKEN',
  'GOOGLE_TRENDS_API_KEY',
  'GOOGLE_TRENDS_API_ALPHA_ACCESS',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'RAZORPAY_KEY_ID',
  'RAZORPAY_KEY_SECRET',
  'RAZORPAY_WEBHOOK_SECRET',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'SMTP_HOST',
  'SMTP_USER',
  'SMTP_PASSWORD',
]) {
  process.env[key] = '';
}
process.env.SURFACED_SKIP_ENV_FILE = 'true';
