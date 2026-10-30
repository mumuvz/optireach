# Local setup

This guide gets the full stack running on a development machine: the API, the worker, the web app, MySQL and
Redis. Every step below has been run on Windows 11 with Node.js 24, MySQL 8.0 and a portable Redis 8 build. The
same commands work on macOS and Linux.

## 1. Prerequisites

| Tool     | Version        | Notes                                                                                 |
| -------- | -------------- | ------------------------------------------------------------------------------------- |
| Node.js  | 22.22 or later | npm 10 or later comes with it                                                         |
| MySQL    | 8.0 or later   | Local install, or `docker compose up -d mysql`                                        |
| Redis    | 6.2 or later   | `docker compose up -d redis`, a system package, or the portable Windows build (below) |
| Chromium | optional       | For PDF reports and the E2E suite: `npx playwright install chromium`                  |

### Redis on Windows without Docker

`npm run redis:start` starts a portable Redis if no server is listening on port 6379. It looks for
`redis-server.exe` under `.tools/redis/<version>/`. Download a Windows build from a source you trust, verify its
checksum and unpack it there. The script never downloads or installs anything itself.

## 2. Database

Create a database and a user. Use any names you like; the URLs in `.env` must match.

```sql
CREATE DATABASE surfaced CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE USER 'surfaced'@'localhost' IDENTIFIED BY 'choose-a-password';
GRANT ALL PRIVILEGES ON surfaced.* TO 'surfaced'@'localhost';
-- Automated tests use separate databases whose names end in _test and _e2e:
GRANT ALL PRIVILEGES ON surfaced_test.* TO 'surfaced'@'localhost';
GRANT ALL PRIVILEGES ON surfaced_e2e.* TO 'surfaced'@'localhost';
```

`prisma migrate dev` also needs permission to create a temporary _shadow database_. Use an account that can
create databases in development, or point `shadowDatabaseUrl` at a dedicated database.

## 3. Environment

```bash
cp .env.example .env
```

Then edit `.env`:

1. Set `DATABASE_URL`, `TEST_DATABASE_URL` and `E2E_DATABASE_URL`. Percent-encode special characters in
   passwords; for example, `@` becomes `%40`.
2. Generate the secrets with the commands at the top of `.env.example` and paste them into `SESSION_SECRET` and
   `ENCRYPTION_KEY`.
3. If MySQL uses `caching_sha2_password` without TLS (the MySQL 8 default on a local install), set
   `DATABASE_ALLOW_PUBLIC_KEY_RETRIEVAL=true`. Use this for local development only.
4. Set `SEED_DEMO_PASSWORD` (at least 10 characters). It is the password of the seeded demo and admin accounts.
5. Optional: set `OPENAI_API_KEY` with `LLM_PROVIDER=openai` to get real AI-generated content and real AI
   visibility checks. Without a key, use `LLM_PROVIDER=dev` (labeled template text) and `AI_DEMO_MODE=true`
   (labeled demo observations).

Development defaults need no external accounts:

| Variable                       | Development value    | Effect                                                                                                            |
| ------------------------------ | -------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `BILLING_PROVIDER`             | `dev`                | Plan changes apply immediately; no payment, clearly labeled in the UI                                             |
| `EMAIL_PROVIDER`               | `console`            | Emails are written to `var/mail/*.eml` and recorded as `LOGGED_LOCALLY`, never as sent                            |
| `AI_DEMO_MODE`                 | `true`               | Enables the labeled demo visibility provider                                                                      |
| `PDF_RENDERER`                 | `chromium` or `none` | PDF reports need Chromium; HTML reports always work                                                               |
| `CRAWLER_MAX_PAGES_HARD_LIMIT` | `0`                  | No server page cap: audits crawl every page reachable through links and sitemaps. Set a number to cap every crawl |

`.env` is shared by the API, the worker, the seed and the web build. Only variables that start with `VITE_` are
included in the browser bundle, so never give a secret a `VITE_` name.

## 4. Install, migrate and seed

```bash
npm install
npm run db:migrate        # creates the schema in DATABASE_URL (development)
npm run db:seed           # plans, admin and demo accounts, demo workspace
```

The seed:

- Creates the default plans (Free, Starter, Growth, Agency). Existing plans are never overwritten.
- Creates `admin@surfaced.test` (platform admin) and `demo@surfaced.test`. Both use `SEED_DEMO_PASSWORD`, and
  existing accounts are left unchanged. Set `SEED_ADMIN_EMAIL` or `SEED_DEMO_EMAIL` to use other addresses.
- Creates a **demo workspace** on the Growth plan in development billing mode, with a project flagged as demo
  data:
  - Its audit is produced by the real crawler and audit engine, analyzing a fictional in-memory website.
  - Its AI visibility observations come from the labeled demo provider.
  - The seed makes no network requests.
- Refuses to create demo accounts or data when `NODE_ENV=production`.

`npm run db:seed:reset-demo` rebuilds the demo workspace. It refuses if the workspace contains a project that is
not demo data.

## 5. Run

```bash
npm run redis:start       # only if Redis is not already running
npm run dev
```

| URL                                   | What                                                    |
| ------------------------------------- | ------------------------------------------------------- |
| <http://localhost:5173>               | Web app (Vite dev server; `/api` is proxied to the API) |
| <http://localhost:4000/api/v1/health> | API health (database, queue, Redis)                     |
| <http://localhost:4000/api/docs>      | Swagger UI for the REST API                             |

**Optional: live Google Trends with pytrends** (free, unofficial, experimental). Needs Python 3.10+:

```bash
npm run trends:setup      # once
npm run trends:start      # keep running in its own terminal
```

Then add `PYTRENDS_SERVICE_URL=http://127.0.0.1:4410` to `.env` and restart `npm run dev`. Without it, Keyword
trends works with CSV files exported from Google Trends. See [providers/keyword-trends.md](providers/keyword-trends.md).

Sign in at <http://localhost:5173/login> with a seeded account. The demo project is reachable from the project
selector. Its pages carry a "Demo data" banner.

### Single-process mode

To serve the built web app from the API (as in a simple production deployment):

```bash
npm run build
SERVE_WEB_DIST=true npm run start:api   # plus `npm run start:worker` in another terminal
# Windows PowerShell: $env:SERVE_WEB_DIST='true'; npm run start:api
```

Then open <http://localhost:4000>. Set `APP_URL` and `CORS_ALLOWED_ORIGINS` to `http://localhost:4000` so emails,
OAuth return URLs and the CSRF origin check use the same origin.

## 6. Tests

| Command                        | Needs                                                                      |
| ------------------------------ | -------------------------------------------------------------------------- |
| `npm run test`                 | MySQL (`TEST_DATABASE_URL`, name must end in `_test`). No Redis or network |
| `npx vitest run --project web` | Nothing external (jsdom)                                                   |
| `npm run test:e2e`             | MySQL (`E2E_DATABASE_URL`, name must end in `_e2e`), Redis, Chromium       |
| `npm run trends:test`          | The pytrends virtual environment (`npm run trends:setup`). No network      |

The test setup applies migrations with `prisma migrate deploy`, which is non-destructive. Tests use unique data
instead of wiping the database.

- **Provider keys are blanked in tests.** `test/setup-env.ts` blanks every provider key and stops `.env` from
  being re-read, so automated tests never call OpenAI, Perplexity, Stripe, Razorpay or Google.
- **The E2E suite runs an isolated stack.** It starts a local fixture website, the API serving the built web app,
  and the worker. They use the `surfaced-e2e` Redis namespace (cleared at the start of every run) and only
  development and demo providers.
- **To wipe a test database**, run `npx prisma migrate reset` yourself with `DATABASE_URL` pointing at it. Prisma
  blocks that command when an AI agent invokes it without your consent.

## 7. Troubleshooting

| Symptom                           | Fix                                                                                                                                             |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `prisma migrate dev` is very slow | The shadow database replays every migration; on some Windows setups each `ALTER TABLE` is slow. Use `npm run db:deploy` for existing migrations |
| `RSA public key is not available` | Set `DATABASE_ALLOW_PUBLIC_KEY_RETRIEVAL=true` (development) or connect with TLS                                                                |
| Health shows `redis: false`       | Start Redis (`npm run redis:start` or `docker compose up -d redis`)                                                                             |
| Audits stay "Queued"              | The worker is not running, or it uses a different `REDIS_URL` or `QUEUE_PREFIX` from the API                                                    |
| PDF shows "unavailable"           | Install Chromium (`npx playwright install chromium`) or set `PDF_CHROMIUM_EXECUTABLE_PATH`                                                      |
| AI visibility "not configured"    | Set `OPENAI_API_KEY` (and `LLM_PROVIDER=openai`), or use `AI_DEMO_MODE=true` for labeled demo data                                              |
| Emails never arrive               | In development they are written to `var/mail/`; configure SMTP for real delivery                                                                |
