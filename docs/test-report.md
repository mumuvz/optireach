# Test report

Every result below comes from a command that was actually executed, on 2026-10-22, on the development machine.
Nothing was run in CI or on a hosted environment.

## Environment

| Item         | Version                                       |
| ------------ | --------------------------------------------- |
| OS           | Windows 11 Pro                                |
| Node.js, npm | 24.16.0, 10.8.2                               |
| MySQL        | 8.0.46 (local service)                        |
| Redis        | 8.10.2 (local)                                |
| Test tooling | Vitest 5.0.5, Playwright 1.64.1 with Chromium |

Automated tests use their own databases, `surfaced_test` (Vitest) and `surfaced_e2e` (Playwright), and never call
external providers:

- `test/setup-env.ts` blanks every provider key and stops `.env` from being re-read. A test asserts that no provider
  credential is visible.
- Email uses console mode; billing uses development mode or signed test payloads.
- The crawler fetches only local fixture sites.

## Final verification run

Run from the repository root in the order listed, except that `npm audit` ran while the E2E suite was running.
All of them ran after the last code change: a `npm run format` pass over 230 files that had never been formatted
with Prettier. Four of those files needed a second pass.

| #   | Command                | Result                                                                                                                                             |
| --- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `npm run format:check` | All files use Prettier code style                                                                                                                  |
| 2   | `npm run lint`         | Exit 0, no findings                                                                                                                                |
| 3   | `npm run typecheck`    | Exit 0: the root project (test setup, seed, E2E, configs) and every workspace                                                                      |
| 4   | `npm run test`         | **33 files, 299 tests passed**; none failed or skipped (216.8 s)                                                                                   |
| 5   | `npm run build`        | Exit 0: API and worker bundles, web client and SSR builds, 28 prerendered routes, `404.html`, `app.html`, `sitemap.xml` (24 URLs) and `robots.txt` |
| 6   | `npm run db:deploy`    | 2 migrations found, none pending                                                                                                                   |
| 7   | `npm run db:seed`      | Exit 0. Idempotent: plans present and unmodified; both accounts and the demo workspace left unchanged                                              |
| 8   | Built app (below)      | Passed                                                                                                                                             |
| 9   | `npm run dev` (below)  | Passed                                                                                                                                             |
| 10  | `npm run test:e2e`     | Web build, then **4 Playwright tests passed** in Chromium (40.9 s). Teardown left no processes or listeners                                        |
| 11  | `npm audit`            | 0 vulnerabilities, for all dependencies and with `--omit=dev`                                                                                      |

**Built app (row 8).** `SERVE_WEB_DIST=true node apps/api/dist/index.js` and `node apps/worker/dist/index.js` were
started, then requested at `http://localhost:4000`:

- `/api/v1/health`: 200, with the database, queue and Redis healthy.
- `/` and `/pricing`: 200, prerendered HTML with a Content-Security-Policy and a canonical URL.
- `/app` and `/app/projects`: 200, the `noindex` app shell.
- An unknown path: 404, with the `noindex` 404 page.
- `/sitemap.xml` (24 URLs) and `/robots.txt` (with its `Sitemap:` line): 200.
- `/api/v1/billing/plans`: 200. `/api/v1/auth/me` while signed out: 401.
- A hashed asset: 200 with `Cache-Control: public, max-age=31536000, immutable`.
- The worker logged "Worker started". Both processes were stopped afterwards, and no listener was left.

Canonical URLs pointed at `http://localhost:5173` because `VITE_SITE_URL` was not set for this build (see
[known limitations](known-limitations.md)).

**Development stack (row 9).** `npm run dev` started the API on port 4000, the worker and the Vite dev server on
port 5173.

- API health was green, and Vite served `/` and `/src/entry-client.tsx`.
- Through the Vite proxy, `/api/v1/billing/plans` returned the 4 plans in development billing mode.
- The worker logged "Worker started", and no log line reported an error.
- The process tree was then stopped, with no processes left.

## Unit and integration tests by workspace

| Workspace         | Files  | Tests   | What runs                                                                                                                                                                                                                                                                                          |
| ----------------- | ------ | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared` | 5      | 67      | Unit tests: plans and limits, permissions and approval rules, countries and languages, URL normalization, request schemas, the audit rule catalog and scoring, visibility metrics, safe Markdown                                                                                                   |
| `packages/core`   | 11     | 136     | Unit tests and MySQL integration tests: SSRF policy, crawler against a local HTTP fixture, audit rules and the crawl → audit pipeline, job records, visibility runs, usage metering, email, Search Console OAuth and sync (mocked HTTP), scheduling, account deletion, Prisma ↔ shared enum parity |
| `apps/api`        | 13     | 75      | HTTP tests with Supertest against the Express app and MySQL, with an in-memory queue                                                                                                                                                                                                               |
| `apps/worker`     | 1      | 3       | Maintenance task dispatch and permanent-error classification                                                                                                                                                                                                                                       |
| `apps/web`        | 3      | 18      | React Testing Library (jsdom) and server rendering of the public pages                                                                                                                                                                                                                             |
| **Total**         | **33** | **299** |                                                                                                                                                                                                                                                                                                    |

## Required tests from the brief

Each requirement maps to the tests that cover it. File names are relative to the workspace's `test/` folder.

**Authentication**

| Requirement             | Covered by                                                                                                                     |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Successful registration | api `auth.test.ts`: creates the user, an owned workspace on the Free plan, a session and a verification email                  |
| Duplicate registration  | api `auth.test.ts`: rejects a duplicate email with 409                                                                         |
| Login and logout        | api `auth.test.ts`: logs in, logs out and revokes the session; rejects disabled accounts; locks out repeated failures with 429 |
| Password reset          | api `auth.test.ts`: does not reveal whether an account exists; resets, revokes sessions and rejects token reuse                |
| Unauthorized API access | api `auth.test.ts`: five endpoints without a session, forged session cookies, CSRF rejection                                   |

**Tenant isolation**

| Requirement                           | Covered by                                                                                                                               |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| User A cannot access User B's project | api `projects.test.ts`: read or modify by id; members cannot delete                                                                      |
| User A cannot read User B's audit     | api `audits.test.ts`: audit, pages, issues and crawl job                                                                                 |
| Another workspace's reports           | api `reports.test.ts`: 404 for the report, its HTML, PDF, the project's list and delete                                                  |
| Also covered                          | api `workspaces.test.ts` (every workspace operation, background jobs), and the isolation tests in `content`, `keywords` and `visibility` |

**Website audit**

| Requirement                      | Covered by                                                                                                                                                                                                                                              |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Valid URL validation             | shared `url-and-schemas.test.ts` (10 cases, including `javascript:`, credentials, internal hosts, IDN); api `projects.test.ts` rejects private websites; web `components.test.tsx` validates before calling the API                                     |
| Crawl job creation               | api `audits.test.ts`: starts, runs and exposes an audit; core `db-and-jobs.test.ts`: creates, enqueues, tracks and completes a job                                                                                                                      |
| URL extraction and normalization | core `crawler.test.ts`: links with `<base href>`, crawl URL normalization                                                                                                                                                                               |
| Missing title detection          | core `audit.test.ts`: missing titles and metadata problems                                                                                                                                                                                              |
| Broken link detection            | core `audit.test.ts`: HTTP errors, broken internal links and redirects                                                                                                                                                                                  |
| Duplicate metadata detection     | core `audit.test.ts`: duplicate titles across pages, with evidence                                                                                                                                                                                      |
| Sitemap parsing                  | core `crawler.test.ts`: sitemap documents                                                                                                                                                                                                               |
| SSRF protections                 | core `ssrf.test.ts` (38: private, reserved and mapped IPv4/IPv6 ranges, DNS answers with private addresses, protocols, ports, credentials); `crawler.test.ts` (private targets, also through a redirect); api `insights.test.ts` (competitor snapshots) |
| Crawl timeout and cancellation   | core `crawler.test.ts`: slow responses time out, body size cap, page limit, cancellation between pages; `db-and-jobs.test.ts`: queued jobs cancel immediately, running jobs cooperatively; api `audits.test.ts`: cancel before start                    |

**AI visibility**

| Requirement                   | Covered by                                                                                                                                                                                                                 |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prompt creation               | api `visibility.test.ts`: creates prompts; validates providers, frequency and the tracked-prompt limit                                                                                                                     |
| Provider configuration checks | core `visibility.test.ts`: reports configuration honestly; api `visibility.test.ts`: provider status endpoint                                                                                                              |
| Mock-provider response        | core `visibility.test.ts`: deterministic, labeled demo answers; api `visibility.test.ts`: demo run, then metrics, observations and citations                                                                               |
| Mention and citation math     | core `visibility.test.ts`: whole-word, alias and domain matching, citation de-duplication and attribution; shared `audit-and-metrics.test.ts`: rates, share of voice, source distribution, null instead of NaN             |
| Provider error handling       | core `visibility.test.ts`: failed observations are stored when a provider fails or is not configured                                                                                                                       |
| Retry handling                | core `visibility.test.ts`: retries are idempotent; `db-and-jobs.test.ts`: failed attempts stay queued until the last attempt; worker `runtime.test.ts`: permanent errors are not retried; api `admin.test.ts`: retry rules |

**Content**

| Requirement                 | Covered by                                                                                                                                    |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Draft creation              | api `content.test.ts`: creates a draft and generates every mode with the labeled development adapter                                          |
| Editing and version history | api `content.test.ts`: manual saves create versions, list and restore                                                                         |
| Invalid generation input    | api `content.test.ts`; shared `url-and-schemas.test.ts` (section regeneration needs a heading)                                                |
| Provider failure            | api `content.test.ts`: no version is written                                                                                                  |
| Approval workflow           | api `content.test.ts`: only owners and admins approve; approved content is locked; shared `permissions.test.ts`: allowed transitions per role |

**Billing**

| Requirement                    | Covered by                                                                                                                                                                                      |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Plan limits                    | shared `plans.test.ts` (10); core `billing-usage-email.test.ts` (quotas return 402, count limits); api tests for projects, competitors, audits, generations, prompts, team size and white label |
| Webhook signature validation   | api `billing.test.ts`: Stripe rejects invalid or missing signatures; Razorpay HMAC                                                                                                              |
| Idempotent webhook handling    | api `billing.test.ts`: replayed Stripe events change nothing                                                                                                                                    |
| Subscription state transitions | api `billing.test.ts`: state driven by verified events; core: canceled or missing subscriptions fall back to Free                                                                               |

**End-to-end** (`e2e/journey.spec.ts`): register, create a project, start an audit of the local fixture site, view
the completed audit with its issues and pages, create an AI visibility prompt, run a development demo observation
and open it, generate a content draft, generate and view a report, change the profile, log out and log back in.
`e2e/public.spec.ts` covers prerendered HTML, `robots.txt`, the sitemap and a real 404, the free audit and the
pricing page.

## Live checks made during development

These used real services and were run once each, by hand, not as part of the automated suites.

- **OpenAI** (with the provided key): a web search visibility observation with `gpt-5.4-mini-2026-03-17` returned
  a 2,715-character answer with 67 citations (9 inline and 58 consulted sources). A structured output call returned
  valid JSON.
- **Chromium PDF**: a report PDF with Japanese and Hindi text; an external image in the HTML was blocked, as
  intended.
- **Seeded demo audit**: the audit of the bundled fictional site found 17 issues, each one a problem planted in it
  on purpose. Site health index 95.
- **Browser smoke test**: 25 pages, at desktop and mobile widths, against the built app and the demo workspace. No
  page errors and no failed API requests; the only console entries were the expected 401s of the signed-out
  session check on the login page.

## Incident

In one Vitest run during the AI visibility work, **2 real OpenAI web search requests** were made. The test setup
deleted `OPENAI_API_KEY`, but `getEnv()` re-read `.env` and restored it. Since the fix, provider keys are blanked
rather than deleted and `SURFACED_SKIP_ENV_FILE=true` stops the reload. The regression test is core
`env-and-crypto.test.ts`, "never exposes real provider credentials to automated tests".

## Not verified

- **Live providers without credentials:** Perplexity, Google Search Console, Stripe, Razorpay and SMTP. They are
  covered only by tests with mocked HTTP or signed payloads.
- **Deployment:** nothing was deployed to a hosted environment.
- **Docker:** Docker is not installed on this machine, so `docker-compose.yml` was never run. MySQL and Redis were
  local installs.
- **Other platforms and browsers:** only Windows and Chromium were tested.
- **Load, security and accessibility testing:** no load test, penetration test or formal WCAG audit was performed.
- **Database reset:** Prisma blocks `migrate reset` when an AI agent runs it, so test setup uses
  `migrate deploy` with unique test data instead.

## Reproducing

Prerequisites and environment variables are in [setup.md](setup.md#6-tests). The commands in the final
verification table can then be run as listed.
