// Environment loading and validation shared by the API, worker, seed script and tests.
// Variables already present in process.env always win over values from the .env file.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const booleanString = z
  .enum(['true', 'false', '1', '0', 'yes', 'no'])
  .transform((value) => value === 'true' || value === '1' || value === 'yes');

const csv = z
  .string()
  .default('')
  .transform((value) =>
    value
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean),
  );

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    APP_NAME: z.string().default('Surfaced'),
    APP_URL: z.url(),
    API_URL: z.url(),
    API_PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
    CORS_ALLOWED_ORIGINS: csv,
    TRUST_PROXY: z.string().default('false'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    LOG_FORMAT: z.enum(['pretty', 'json']).optional(),
    SERVE_WEB_DIST: booleanString.default(false),

    DATABASE_URL: z.string().regex(/^mysql:\/\//, 'DATABASE_URL must start with mysql://'),
    DATABASE_CONNECTION_LIMIT: z.coerce.number().int().min(1).max(200).default(10),
    DATABASE_ALLOW_PUBLIC_KEY_RETRIEVAL: booleanString.default(false),
    DATABASE_SSL: booleanString.default(false),

    REDIS_URL: z
      .string()
      .regex(/^rediss?:\/\//, 'REDIS_URL must start with redis:// or rediss://')
      .default('redis://127.0.0.1:6379'),
    QUEUE_PREFIX: z
      .string()
      .regex(/^[a-zA-Z0-9_-]{1,40}$/)
      .default('surfaced'),

    SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
    ENCRYPTION_KEY: z
      .string()
      .refine(
        (value) => Buffer.from(value, 'base64').length === 32,
        'ENCRYPTION_KEY must be 32 bytes, base64-encoded',
      ),
    SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
    COOKIE_DOMAIN: z.string().optional(),
    COOKIE_SECURE: z.enum(['auto', 'true', 'false']).default('auto'),

    LLM_PROVIDER: z.enum(['openai', 'gemini', 'dev', 'none']).default('dev'),
    OPENAI_API_KEY: z.string().optional(),
    OPENAI_BASE_URL: z.url().optional(),
    OPENAI_MODEL: z.string().default('gpt-5.4-mini'),
    OPENAI_VISIBILITY_MODEL: z.string().default('gpt-5.4-mini'),
    OPENAI_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(256).max(32_000).default(6000),
    PERPLEXITY_API_KEY: z.string().optional(),
    PERPLEXITY_MODEL: z.string().default('sonar'),
    /** Gemini API key for the ungrounded Gemini visibility provider (answers without Google Search grounding). */
    GEMINI_API_KEY: z.string().optional(),
    GEMINI_MODEL: z.string().default('gemini-3.8-flash'),
    GEMINI_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(256).max(65_536).default(8192),
    /** Google Maps Platform key with the Places API (New): fills a location from a Google link (server-side only). */
    GOOGLE_MAPS_API_KEY: z.string().optional(),
    /** Address lookup for location map positions: OpenStreetMap Nominatim (light use only) or none. */
    GEOCODER: z.enum(['nominatim', 'none']).default('nominatim'),
    GEOCODER_URL: z.url().default('https://nominatim.openstreetmap.org'),
    AI_DEMO_MODE: booleanString.default(false),

    KEYWORD_DATA_PROVIDER: z.enum(['none']).default('none'),
    /** DataForSEO API login and password: live Google Trends data for Search trends (optional, paid per request). */
    DATAFORSEO_LOGIN: z.string().optional(),
    DATAFORSEO_PASSWORD: z.string().optional(),
    /**
     * Google Programmable Search / Custom Search JSON API: real Google ORGANIC web results for local rank tracking,
     * free up to 100 searches/day. NOT the Maps local pack, and country-level only (not per coordinate). Enabled by
     * the presence of both values. Get a free key at console.cloud.google.com and an engine ID at
     * programmablesearchengine.google.com.
     */
    GOOGLE_CSE_API_KEY: z.string().optional(),
    GOOGLE_CSE_CX: z.string().optional(),
    /**
     * Keyword trends providers the server allows (comma-separated): csv, pytrends, dataforseo, google_trends_api and
     * fixture. A provider also needs its own settings before it can be used; leaving one out hides it everywhere.
     */
    TRENDS_PROVIDERS: z.string().default('csv,pytrends,dataforseo,google_trends_api'),
    /** Address of the optional pytrends service (services/pytrends); unset = pytrends is not configured. */
    PYTRENDS_SERVICE_URL: z.url().optional(),
    PYTRENDS_SERVICE_TOKEN: z.string().optional(),
    /** Per call to the pytrends service; one call may wait for earlier requests to Google first. */
    PYTRENDS_TIMEOUT_MS: z.coerce.number().int().min(5000).max(600_000).default(120_000),
    /** Official Google Trends API (alpha, by application only). Both must be set, and access granted by Google. */
    GOOGLE_TRENDS_API_KEY: z.string().optional(),
    GOOGLE_TRENDS_API_ALPHA_ACCESS: booleanString.default(false),
    /**
     * How long fetched trends data is reused, in hours, by provider and data type, e.g.
     * "default=12,regions=24,pytrends=24,pytrends.interest=6". The most specific entry wins.
     */
    TRENDS_CACHE_TTL_HOURS: z.string().default('default=12'),
    /**
     * Licensed SERP data for local rank grids (Maps, local pack) and Google AI features. Google offers no API for
     * these; "none" leaves them to manual observations. "dataforseo" uses DATAFORSEO_LOGIN/DATAFORSEO_PASSWORD.
     */
    SERP_PROVIDER: z.enum(['none', 'dataforseo', 'osm', 'custom']).default('none'),
    /** Overpass API endpoint for the OpenStreetMap local-business discovery provider (SERP_PROVIDER=osm). */
    OVERPASS_URL: z.url().default('https://overpass-api.de/api/interpreter'),
    /** Operator-hosted local-search collection service for SERP_PROVIDER=custom. The app POSTs each grid point to
     * it and expects normalized results back; the operator builds and is responsible for that service. */
    CUSTOM_SERP_URL: z.url().optional(),
    CUSTOM_SERP_TOKEN: z.string().optional(),
    /** Allow a loopback/localhost CUSTOM_SERP_URL in production. Off by default so the demo mock scraper (which
     * listens on 127.0.0.1) cannot be shipped as the production collector by accident. Set true only when a real
     * collection service genuinely runs on the same host. */
    CUSTOM_SERP_ALLOW_LOOPBACK: booleanString.default(false),
    /** Development and tests only: generated local rank results, labeled as not real. Refused in production. */
    LOCAL_RANK_FIXTURES: booleanString.default(false),
    /** Reports that call a live provider, per workspace per rolling 24 hours (cache hits do not count). */
    TRENDS_LIVE_REPORTS_PER_WORKSPACE_PER_DAY: z.coerce.number().int().min(0).max(10_000).default(30),

    GOOGLE_CLIENT_ID: z.string().optional(),
    GOOGLE_CLIENT_SECRET: z.string().optional(),
    GOOGLE_OAUTH_REDIRECT_URI: z.url().optional(),

    BILLING_PROVIDER: z.enum(['none', 'dev', 'stripe', 'razorpay']).default('none'),
    STRIPE_SECRET_KEY: z.string().optional(),
    STRIPE_WEBHOOK_SECRET: z.string().optional(),
    RAZORPAY_KEY_ID: z.string().optional(),
    RAZORPAY_KEY_SECRET: z.string().optional(),
    RAZORPAY_WEBHOOK_SECRET: z.string().optional(),

    EMAIL_PROVIDER: z.enum(['console', 'smtp']).default('console'),
    EMAIL_FROM: z.string().default('Surfaced <no-reply@surfaced.local>'),
    SALES_EMAIL: z.string().default('hello@surfaced.local'),
    SMTP_HOST: z.string().optional(),
    SMTP_PORT: z.coerce.number().int().min(1).max(65_535).default(587),
    SMTP_SECURE: booleanString.default(false),
    SMTP_USER: z.string().optional(),
    SMTP_PASSWORD: z.string().optional(),

    STORAGE_DRIVER: z.enum(['local']).default('local'),
    STORAGE_LOCAL_DIR: z.string().default('./var/storage'),

    CRAWLER_USER_AGENT: z.string().min(5).default('SurfacedBot/0.1'),
    /** Server-wide page cap per crawl; 0 (default) means no cap, so audits crawl every reachable page. */
    CRAWLER_MAX_PAGES_HARD_LIMIT: z.coerce.number().int().min(0).max(100_000_000).default(0),
    CRAWLER_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(4),
    /**
     * Pages checked per site in an SEO comparison (your site and each competitor alike). Competitor sites can be
     * huge, so comparisons use the same sample size for every site instead of crawling competitors completely.
     */
    COMPETITOR_CRAWL_MAX_PAGES: z.coerce.number().int().min(20).max(5000).default(250),
    CRAWLER_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(15_000),
    CRAWLER_MAX_BODY_BYTES: z.coerce.number().int().min(64_000).max(50_000_000).default(5_242_880),
    CRAWLER_DEV_ALLOWLIST: csv,

    PDF_RENDERER: z.enum(['chromium', 'none']).default('chromium'),
    PDF_CHROMIUM_EXECUTABLE_PATH: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    const issue = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });
    const production = env.NODE_ENV === 'production';

    if (env.LLM_PROVIDER === 'openai' && !env.OPENAI_API_KEY) {
      issue('OPENAI_API_KEY', 'OPENAI_API_KEY is required when LLM_PROVIDER=openai');
    }
    if (env.LLM_PROVIDER === 'gemini' && !env.GEMINI_API_KEY) {
      issue('GEMINI_API_KEY', 'GEMINI_API_KEY is required when LLM_PROVIDER=gemini');
    }
    if (env.BILLING_PROVIDER === 'stripe' && (!env.STRIPE_SECRET_KEY || !env.STRIPE_WEBHOOK_SECRET)) {
      issue(
        'STRIPE_SECRET_KEY',
        'STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET are required when BILLING_PROVIDER=stripe',
      );
    }
    if (
      env.BILLING_PROVIDER === 'razorpay' &&
      (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET || !env.RAZORPAY_WEBHOOK_SECRET)
    ) {
      issue(
        'RAZORPAY_KEY_ID',
        'RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET and RAZORPAY_WEBHOOK_SECRET are required for Razorpay',
      );
    }
    if (env.EMAIL_PROVIDER === 'smtp' && !env.SMTP_HOST)
      issue('SMTP_HOST', 'SMTP_HOST is required when EMAIL_PROVIDER=smtp');
    if (
      (env.GOOGLE_CLIENT_ID && !env.GOOGLE_CLIENT_SECRET) ||
      (!env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET)
    ) {
      issue('GOOGLE_CLIENT_ID', 'Set both GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, or neither');
    }

    if (production) {
      if (env.BILLING_PROVIDER === 'dev')
        issue('BILLING_PROVIDER', 'Development billing mode is not allowed in production');
      if (env.LLM_PROVIDER === 'dev')
        issue('LLM_PROVIDER', 'The development LLM adapter is not allowed in production');
      if (env.AI_DEMO_MODE) issue('AI_DEMO_MODE', 'Demo AI visibility data is not allowed in production');
      if (env.LOCAL_RANK_FIXTURES)
        issue('LOCAL_RANK_FIXTURES', 'Generated local rank results are not allowed in production');
      if (env.SERP_PROVIDER === 'custom' && env.CUSTOM_SERP_URL && !env.CUSTOM_SERP_ALLOW_LOOPBACK) {
        const host = (() => {
          try {
            return new URL(env.CUSTOM_SERP_URL).hostname.toLowerCase();
          } catch {
            return '';
          }
        })();
        if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]')
          issue(
            'CUSTOM_SERP_URL',
            'CUSTOM_SERP_URL points at localhost in production (this is the demo mock pattern). Point it at your real collection service, or set CUSTOM_SERP_ALLOW_LOOPBACK=true if it genuinely runs on this host.',
          );
      }
      if (env.TRENDS_PROVIDERS.split(',').some((key) => key.trim().toLowerCase() === 'fixture'))
        issue('TRENDS_PROVIDERS', 'The trends fixture provider is not allowed in production');
      if (env.COOKIE_SECURE === 'false') issue('COOKIE_SECURE', 'Cookies must be Secure in production');
      if (env.EMAIL_PROVIDER === 'console')
        issue('EMAIL_PROVIDER', 'Configure a real email provider (smtp) in production');
      if (env.CORS_ALLOWED_ORIGINS.length === 0)
        issue('CORS_ALLOWED_ORIGINS', 'Set CORS_ALLOWED_ORIGINS in production');
    }
  });

export type Env = z.infer<typeof envSchema> & {
  isProduction: boolean;
  isTest: boolean;
  cookieSecure: boolean;
  /** host:port pairs the crawler may reach despite SSRF rules. Always empty in production. */
  crawlerDevAllowlist: string[];
  trustProxy: boolean | number;
};

export class EnvValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid environment configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'EnvValidationError';
  }
}

/** Finds the monorepo root (the directory whose package.json declares workspaces). */
export function findRepoRoot(start = process.cwd()): string {
  let dir = path.resolve(start);
  for (let i = 0; i < 8; i++) {
    const pkg = path.join(dir, 'package.json');
    if (existsSync(pkg)) {
      try {
        const json = JSON.parse(readFileSync(pkg, 'utf8')) as { workspaces?: unknown };
        if (json.workspaces) return dir;
      } catch {
        // ignore unreadable package.json and keep walking up
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(start);
}

let envFileLoaded = false;

/**
 * Loads ENV_FILE or <repo root>/.env once. Existing process.env values are never overwritten.
 * SURFACED_SKIP_ENV_FILE=true disables file loading entirely (used by the test setup so that
 * secrets removed for tests can never be re-introduced from the developer's .env).
 */
export function loadEnvFile(): void {
  if (envFileLoaded) return;
  envFileLoaded = true;
  if (process.env.SURFACED_SKIP_ENV_FILE === 'true') return;
  const file = process.env.ENV_FILE ? path.resolve(process.env.ENV_FILE) : path.join(findRepoRoot(), '.env');
  if (existsSync(file)) process.loadEnvFile(file);
}

export function parseEnv(source: NodeJS.ProcessEnv): Env {
  // Treat empty strings ("KEY=") as unset so defaults and optional checks behave predictably.
  const cleaned: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && value !== '') cleaned[key] = value;
  }
  const result = envSchema.safeParse(cleaned);
  if (!result.success) {
    throw new EnvValidationError(
      result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    );
  }
  const env = result.data;
  const isProduction = env.NODE_ENV === 'production';
  const trustProxy =
    env.TRUST_PROXY === 'true'
      ? true
      : env.TRUST_PROXY === 'false'
        ? false
        : Number.parseInt(env.TRUST_PROXY, 10) || false;
  return {
    ...env,
    isProduction,
    isTest: env.NODE_ENV === 'test',
    cookieSecure: env.COOKIE_SECURE === 'auto' ? isProduction : env.COOKIE_SECURE === 'true',
    crawlerDevAllowlist: isProduction ? [] : env.CRAWLER_DEV_ALLOWLIST.map((entry) => entry.toLowerCase()),
    trustProxy,
  };
}

let cached: Env | null = null;

export function getEnv(): Env {
  if (!cached) {
    loadEnvFile();
    cached = parseEnv(process.env);
  }
  return cached;
}

/** Test helper: forget the cached configuration so the next getEnv() re-reads process.env. */
export function resetEnvCache(): void {
  cached = null;
}
