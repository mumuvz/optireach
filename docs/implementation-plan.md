# Implementation plan

Surfaced is a self-service SaaS that helps businesses improve organic search visibility (**SEO**), answer-engine
readiness (**AEO**) and visibility in generative AI answers (**GEO**). This plan turns the master brief into
verifiable increments. Status is tracked in [`progress.md`](progress.md). Decisions are recorded in [`decisions.md`](decisions.md).

## 1. MVP scope

### In scope (built and verified locally)

| Area            | What ships                                                                                                                                                                                                              |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Accounts        | Register, login/logout, email verification, forgot/reset password, profile, change password, account-deletion request, sessions in HTTP-only cookies, CSRF protection, rate limiting                                    |
| Tenancy         | Workspaces with Owner/Admin/Member roles, invitations, backend permission checks, project isolation                                                                                                                     |
| Projects        | Website, business profile, industry, countries, languages, competitors, primary keywords, brand voice, crawl limits, history, deletion                                                                                  |
| Crawler         | SSRF-safe fetcher, robots.txt, sitemaps, internal links, canonicals, metadata, headings, images, JSON-LD, redirects, orphans, response times, cancellation, progress                                                    |
| Audit           | Deterministic rule engine, configurable weights, persistent issues with first/last detection, filters, page detail view                                                                                                 |
| AI visibility   | Prompt management, provider adapters (OpenAI web search, OpenAI model-only, Perplexity, labeled mock), observations, mention and citation extraction, documented metrics, trend, share of voice, observation drill-down |
| Content Studio  | Briefs, outlines, articles, meta, FAQ, internal-link suggestions from crawl data, JSON-LD suggestions, editor and preview, versions, approval workflow, export, section regeneration                                    |
| Keywords        | Lists, clusters, intent, priority, related questions, CSV import/export, AI ideas labeled as unmeasured                                                                                                                 |
| Competitors     | Domain list, AI mention/citation comparison, shared and unique sources, topic gaps, public metadata comparison, trends                                                                                                  |
| Recommendations | Generated from audit and visibility evidence, status workflow, assignees                                                                                                                                                |
| Reports         | HTML and PDF built from stored project data for a date range, with stated limitations, generated in background jobs                                                                                                     |
| Billing         | Configurable plans, usage limits, Stripe and Razorpay adapters with webhook verification and idempotency, labeled development billing mode                                                                              |
| Integrations    | Google Search Console OAuth (PKCE, encrypted tokens, refresh, disconnect) and reporting. GA4, WordPress and Shopify are labeled as planned.                                                                             |
| Notifications   | In-app notifications and an email provider abstraction (console/local file and SMTP)                                                                                                                                    |
| Admin           | Users, workspaces, failed jobs (retry), usage, plan management, account disabling, system health, audit logs                                                                                                            |
| Marketing site  | All public routes, prerendered HTML for indexing, sitemap.xml, robots.txt, Open Graph, JSON-LD, blog                                                                                                                    |
| Quality         | Vitest unit and integration tests (Supertest + real MySQL), RTL component tests, Playwright E2E                                                                                                                         |

### Out of scope for the MVP (interfaces and/or documentation only)

- Automatically publishing content or changing customer websites. The MVP proposes fixes; it never applies them.
- Licensed keyword metrics (volume, difficulty, CPC). There is a provider interface, and nothing is fabricated.
- GA4 reporting and WordPress/Shopify publishing. These are planned, documented interfaces.
- Object storage (S3). Reports are written to a local storage adapter behind an interface.
- Answer engines without official APIs. Gemini, Claude and Copilot adapters are not claimed.

## 2. Phases and acceptance criteria

### Phase A — Discovery and architecture ✅ when docs exist

- Reference inspection (result documented in [`reference/README.md`](reference/README.md)).
- `implementation-plan.md`, `architecture.md`, `database.md`, `decisions.md`, `progress.md`.

### Phase B — Foundation

- npm-workspaces monorepo: `packages/shared`, `packages/core`, `apps/api`, `apps/worker`, `apps/web`.
- TypeScript 6.0, ESLint 10 flat config, Prettier, Vitest projects, Playwright.
- Prisma 7 + MySQL (MariaDB driver adapter), first migration, seed script.
- Redis + BullMQ queue definitions and a persistent `BackgroundJob` record service.
- Environment validation (zod) shared by API, worker and scripts.
- Express app factory, error handling, logging, security middleware, OpenAPI registry.
- Auth, sessions, CSRF, rate limits, workspaces, roles, tenant guards.
- **Accept:** `npm run typecheck`, `npm run lint` and the auth/tenancy tests pass against MySQL.

### Phase C — Core application

- Design system and UI primitives (shadcn-style, Tailwind 4).
- Marketing site with prerendering. Dashboard shell with sidebar, project selector and notifications.
- Projects CRUD and settings. Crawler, audit engine, issue management, progress polling.
- **Accept:** a real public website and the local fixture site can both be crawled. Issues persist and are
  filterable. Cancellation works.

### Phase D — AI modules

- LLM adapter (OpenAI, dev adapter). Visibility providers (OpenAI web search, OpenAI model-only,
  Perplexity, mock).
- Content Studio with generation jobs and versions. Keyword module. Competitors. Recommendations.
- **Accept:** a mock observation and a real OpenAI observation are both stored with mentions and citations.
  Metrics match the formulas in `docs/metrics.md`. Content drafts are generated and versioned.

### Phase E — Business functionality

- Reports (HTML + PDF), usage metering and limits, billing adapters and webhooks, GSC integration,
  email notifications, admin area, scheduled jobs.
- **Accept:** webhook signature and idempotency tests pass. Plan limits are enforced. A report renders from
  stored data.

### Phase F — Verification

- Migrations, seed, lint, typecheck, unit, integration and E2E tests, builds, local run, responsive checks.
- Final docs: setup, deployment, security checklist, API, known limitations, credentials checklist and test report.

## 3. External dependencies

| Dependency          | Needed for                                                            | Status in this environment                                         |
| ------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------ |
| MySQL 8             | All data                                                              | Local MySQL 8.0.46 (service `MySQL80`)                             |
| Redis ≥ 6.2         | BullMQ queues, rate limits                                            | Portable Redis 8.10.2 (`.tools/redis`, localhost only)             |
| OpenAI API          | Content generation, web-search visibility, entity matching, sentiment | Key provided by the owner (kept in `.env`)                         |
| Perplexity API      | Sonar visibility provider                                             | Not configured. Shows "Provider not configured"                    |
| Google OAuth client | Search Console                                                        | Not configured. Integration shows setup instructions               |
| Stripe / Razorpay   | Payments                                                              | Not configured. Labeled development billing mode                   |
| SMTP                | Email delivery                                                        | Not configured. Console/local `.eml` mode, status `LOGGED_LOCALLY` |
| Chromium            | PDF rendering                                                         | Playwright Chromium installed locally                              |

## 4. Risks and mitigations

| Risk                                                                              | Mitigation                                                                                                                                  |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Crawler abused for SSRF                                                           | DNS-pinned connections with IP classification, revalidation on every redirect hop, port allowlist, protocol allowlist, size and time limits |
| AI output presented as fact                                                       | Every AI-derived field is labeled (sentiment estimate, AI keyword ideas, dev adapter output); raw observations can be inspected             |
| Fake metrics                                                                      | Metrics are always computed from stored rows. Seeded data is flagged `isDemo` and shown with a banner                                       |
| Job retries duplicating data                                                      | Idempotency keys on observations, usage records, content versions, webhook events; crawl retries reset partial pages                        |
| New major versions of dependencies (React Router 8, Prisma 7, BullMQ 6, Vitest 5) | Upgrade guides were read before use; versions are pinned in `package-lock.json`                                                             |
| SEO of a React SPA                                                                | Marketing routes are prerendered to static HTML at build time; the dashboard stays a SPA                                                    |
