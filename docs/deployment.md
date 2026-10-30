# Deployment

This guide describes how to run Surfaced in production. **It has not been deployed to a hosted environment as
part of this work.** The steps reflect how the system was built and verified locally (production build, API
serving the web build, worker, MySQL, Redis). Validate them in a staging environment first.

## 1. Topology

```
            ┌───────────────┐        ┌──────────────┐
 browser ──▶│ TLS proxy/CDN │──/api─▶│ API (N)      │──┐
            │               │──/* ──▶│ or static    │  │   ┌─────────┐
            └───────────────┘        │ web files    │  ├──▶│ MySQL 8 │
                                     └──────────────┘  │   └─────────┘
                                     ┌──────────────┐  │   ┌─────────┐
                                     │ Worker (M)   │──┴──▶│ Redis   │
                                     └──────────────┘      └─────────┘
                                 shared volume: STORAGE_LOCAL_DIR (report files)
```

| Component | Notes                                                                                                                                                                                                                                                            |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API       | Stateless. Run as many replicas as needed. Sessions live in MySQL and rate-limit counters in Redis                                                                                                                                                               |
| Worker    | Runs every queue (crawl, audit, visibility, content, competitor, report, integration sync, email, maintenance). Scale replicas for throughput; scheduled jobs use idempotent BullMQ job schedulers and per-item claims, so several workers do not duplicate work |
| MySQL     | 8.0 or later, `utf8mb4`. Use TLS (`DATABASE_SSL=true`)                                                                                                                                                                                                           |
| Redis     | 6.2 or later with `maxmemory-policy noeviction` (BullMQ requirement) and persistence enabled                                                                                                                                                                     |
| Storage   | Report HTML and PDF files are written by the worker and read by the API, so `STORAGE_LOCAL_DIR` must be a volume shared by both. Object storage is not implemented yet (see known limitations)                                                                   |
| Web app   | Static files in `apps/web/dist`: prerendered marketing pages plus the SPA shell. Serve them from the API (`SERVE_WEB_DIST=true`) or from a CDN                                                                                                                   |

## 2. Build

```bash
npm ci
npm run build
```

- `apps/api/dist/index.js` and `apps/worker/dist/index.js` are esbuild bundles. Internal packages are bundled;
  third-party dependencies stay external, so the runtime image needs `node_modules`. Run `npm ci` in the image,
  and generate the Prisma client with `npm run db:generate` or `npm run build`.
- `apps/web/dist` holds the client bundle, 28 prerendered routes, `404.html`, `app.html`, `sitemap.xml` and
  `robots.txt`.
  - **Build the web app with `VITE_SITE_URL` set to the public origin.** Canonical URLs, Open Graph URLs and the
    sitemap are baked in at build time.
  - Set `VITE_API_URL` to `/api/v1` when the API shares the origin (recommended), or to the API's absolute URL.
- PDF reports need Chromium in the **worker** image: `npx playwright install --with-deps chromium`, or set
  `PDF_CHROMIUM_EXECUTABLE_PATH`. Without it, set `PDF_RENDERER=none`; HTML reports still work.

## 3. Configuration

Start from `.env.example`. The environment is validated at start-up. With `NODE_ENV=production`, the API and
worker **refuse to start** if any of the following is true:

- `BILLING_PROVIDER=dev`, `LLM_PROVIDER=dev`, `AI_DEMO_MODE=true` or `EMAIL_PROVIDER=console`;
- `COOKIE_SECURE=false`;
- a selected provider is missing its credentials.

The crawler development allowlist is ignored in production.

| Setting                                                                 | Production value                                                                                                                                                                                        |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                                                              | `production`                                                                                                                                                                                            |
| `APP_URL`, `API_URL`                                                    | Public HTTPS URLs (the same origin when the API serves the web app)                                                                                                                                     |
| `CORS_ALLOWED_ORIGINS`                                                  | The web origin(s)                                                                                                                                                                                       |
| `TRUST_PROXY`                                                           | Number of trusted proxy hops (for example `1`) so client IPs, rate limits and audit logs are correct                                                                                                    |
| `SESSION_SECRET`, `ENCRYPTION_KEY`                                      | New random values per environment. **Changing `ENCRYPTION_KEY` makes stored OAuth tokens unreadable**                                                                                                   |
| `COOKIE_SECURE`                                                         | `auto` (Secure in production) or `true`                                                                                                                                                                 |
| `DATABASE_SSL`                                                          | `true`; keep `DATABASE_ALLOW_PUBLIC_KEY_RETRIEVAL=false`                                                                                                                                                |
| `BILLING_PROVIDER`                                                      | `stripe`, `razorpay` or `none`                                                                                                                                                                          |
| `EMAIL_PROVIDER`                                                        | `smtp`, with `SMTP_*` and a verified `EMAIL_FROM`                                                                                                                                                       |
| `LLM_PROVIDER`                                                          | `openai` (with `OPENAI_API_KEY`) or `none`                                                                                                                                                              |
| `STORAGE_LOCAL_DIR`                                                     | Path on the shared volume                                                                                                                                                                               |
| `TRENDS_PROVIDERS`                                                      | Keyword trends sources the server allows (`csv,pytrends,dataforseo,google_trends_api`; `fixture` is refused in production). A source left out is hidden everywhere                                      |
| `PYTRENDS_SERVICE_URL`, `PYTRENDS_SERVICE_TOKEN`, `PYTRENDS_TIMEOUT_MS` | Optional, free, **experimental**: the pytrends service (see section 5 and [providers/keyword-trends.md](providers/keyword-trends.md)). A token is required if it listens beyond localhost               |
| `DATAFORSEO_LOGIN`, `DATAFORSEO_PASSWORD`                               | Optional: licensed Google Trends data (paid per request). Without any live source, users import CSV files exported from Google Trends                                                                   |
| `TRENDS_CACHE_TTL_HOURS`, `TRENDS_LIVE_REPORTS_PER_WORKSPACE_PER_DAY`   | How long fetched trends data is reused (by provider and data type) and live lookups per workspace per day (default 30)                                                                                  |
| `COMPETITOR_CRAWL_MAX_PAGES`                                            | Pages checked per site in an SEO comparison (default 250, 20–5000). Every site in a comparison uses the same budget, and each site crawl also stops after 4 minutes                                     |
| `CRAWLER_MAX_PAGES_HARD_LIMIT`                                          | `0` (no server cap: audits crawl every reachable page) or a server-wide page cap per crawl. Size worker memory at about 1 GB per 100,000 pages per concurrent audit (the audit queue runs 2 per worker) |
| `LOG_FORMAT`                                                            | `json` (the default in production)                                                                                                                                                                      |

Secrets belong in the platform's secret store. Never put them in `VITE_*` variables, the image or the
repository.

## 4. Database migrations

Apply migrations before starting a new release:

```bash
npm run db:deploy        # prisma migrate deploy — applies pending migrations, never resets
npm run db:seed          # production: only ensures the default plans exist (no demo data)
```

Prefer additive migrations (expand, deploy, then contract) so old and new versions can run side by side during
a rollout.

**First platform administrator:** register normally, verify the email address, then promote the account
directly in the database:

```sql
UPDATE users SET platformRole = 'ADMIN' WHERE email = 'you@your-company.com';
```

Admins see the Admin area (users, workspaces, failed jobs, plans, usage, system status, audit log). Plan
prices, limits and provider price IDs can be edited there.

## 5. Processes

```bash
node apps/api/dist/index.js       # listens on API_PORT; health: GET /api/v1/health
node apps/worker/dist/index.js    # no port; logs "Worker started"
```

Optional third process, only if you enable pytrends (Python 3.10+):

```bash
npm run trends:setup     # once: creates services/pytrends/.venv
npm run trends:start     # listens on PYTRENDS_SERVICE_URL (default http://127.0.0.1:4410)
```

Run one instance, keep it on a private network (it binds to 127.0.0.1 by default and requires
`PYTRENDS_SERVICE_TOKEN` otherwise), and do not put it behind proxy pools: it is designed to stay slow and to stop
when Google rate-limits it. The worker reports it as unavailable when it is down; CSV import keeps working.

Both handle `SIGTERM` gracefully. The API stops accepting connections; the worker waits up to 30 seconds for
active jobs. Use `/api/v1/health` for liveness and readiness checks: it returns 503 when MySQL or the queue is
unavailable.

## 6. Serving the web app

**Option A — from the API (single origin).** Set `SERVE_WEB_DIST=true`:

- Prerendered pages and `robots.txt`/`sitemap.xml` are served as-is.
- `/app/*`, `/verify-email` and `/invite/*` get the SPA shell.
- Unknown paths get `404.html` with status 404.
- Hashed assets are cached for a year; HTML is `no-cache`; pages carry a restrictive Content-Security-Policy.

**Option B — CDN or static host.** Upload `apps/web/dist` and configure:

| Request                                        | Response                                                                                  |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `/assets/*`                                    | File, `Cache-Control: public, max-age=31536000, immutable`                                |
| `/<path>` with `dist/<path>/index.html`        | That file, `Cache-Control: no-cache`                                                      |
| `/app`, `/app/*`, `/verify-email`, `/invite/*` | `dist/app.html`                                                                           |
| `/api/*`                                       | Proxy to the API (same origin keeps cookies first-party and the CSRF origin check simple) |
| anything else                                  | `dist/404.html` with status 404                                                           |

Add the same security headers the API uses for pages; see `apps/api/src/web-static.ts`.

## 7. Reverse proxy

- Terminate TLS. Enable HSTS (the API sends it in production) and redirect HTTP to HTTPS.
- Forward `X-Forwarded-For` and `X-Forwarded-Proto`, and set `TRUST_PROXY` accordingly.
- Allow request bodies of at least 1 MB (the API's JSON limit; CSV imports go up to 1 MB).
- No WebSockets are used. Long-running work happens in the worker, and the browser polls job status.

## 8. External services

Configure webhooks and OAuth with your production URLs. Full steps are in
[integrations.md](integrations.md).

| Service                   | Endpoint                                                                                                                                                                 |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Stripe webhook            | `https://<api>/api/v1/billing/webhooks/stripe` — `checkout.session.completed`, `customer.subscription.created/updated/deleted`, `invoice.paid`, `invoice.payment_failed` |
| Razorpay webhook          | `https://<api>/api/v1/billing/webhooks/razorpay` — `subscription.*` (activated, charged, pending, halted, paused, resumed, cancelled, completed), `payment.failed`       |
| Google OAuth redirect URI | `https://<api>/api/v1/integrations/google/callback` (or `GOOGLE_OAUTH_REDIRECT_URI`)                                                                                     |

Webhooks are verified by signature over the raw body and de-duplicated by provider event ID, so provider retries
are safe.

## 9. Operations

- **Backups:** back up MySQL daily and test restores. Back up the report storage volume too, or treat reports as
  re-generatable.
- **Logs:** JSON (pino) with request IDs. Cookies, authorization headers, CSRF tokens, passwords, tokens, API keys
  and webhook signatures are redacted.
- **Jobs:** failed jobs appear in Admin → Jobs. Report, Search Console sync, competitor snapshot and email jobs
  can be retried there for 14 days. A maintenance task marks jobs failed when their worker stopped responding.
- **Scheduled tasks** (UTC, registered by the worker):

  | Task                           | Schedule         |
  | ------------------------------ | ---------------- |
  | Stuck-job reconciliation       | Every 5 minutes  |
  | Expiry cleanup                 | Hourly at :15    |
  | Scheduled audits and AI checks | Every 15 minutes |
  | Search Console sync            | Daily at 03:30   |
  | Account deletions              | Daily at 04:00   |
  | Weekly summary emails          | Mondays at 08:00 |

- **Upgrades:** run migrations, deploy the worker and API, then confirm `/api/v1/health` and Admin → System.
