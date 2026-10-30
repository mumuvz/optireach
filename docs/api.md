# API

The REST API is served under `/api/v1`. The machine-readable contract is generated from the route definitions
(the same zod schemas that validate requests):

- **OpenAPI 3.1:** `GET /api/v1/openapi.json`
- **Swagger UI:** `/api/docs`

The endpoint index at the end of this page is generated from the same route table (155 operations).

## Conventions

| Topic               | Rule                                                                                                                                                              |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authentication      | HTTP-only session cookie `sf_session`, set by `POST /auth/register` or `POST /auth/login`                                                                         |
| CSRF                | State-changing requests send `X-CSRF-Token` equal to the `sf_csrf` cookie (from `GET /auth/csrf`, or set after login). Webhooks and the OAuth callback are exempt |
| Success             | `{ "data": … }`, plus `"meta": { page, pageSize, total, totalPages }` on paginated lists                                                                          |
| Errors              | `{ "error": { "code", "message", "details", "requestId" } }`                                                                                                      |
| Pagination          | `?page=1&pageSize=25` (maximum 100)                                                                                                                               |
| Multi-value filters | Comma-separated values, for example `?severity=CRITICAL,HIGH`                                                                                                     |
| Dates               | ISO 8601 strings in UTC                                                                                                                                           |
| Background work     | Long operations return `202 Accepted` with a `jobId`; poll `GET /jobs/:jobId` (or the resource) for progress                                                      |
| Tenancy             | Resources in workspaces you do not belong to return `404`; insufficient roles return `403`                                                                        |
| Request IDs         | Every response has `X-Request-Id`; send your own to correlate logs                                                                                                |

### Error codes

| HTTP | `code`                                                                | Meaning                                                                                      |
| ---- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 400  | `BAD_REQUEST`, `VALIDATION_ERROR`                                     | Invalid input; `details` lists `{ path, message }` per field                                 |
| 401  | `UNAUTHENTICATED`                                                     | Missing or expired session                                                                   |
| 402  | `PLAN_LIMIT_REACHED`                                                  | A plan limit or monthly quota would be exceeded; `details` names the limit                   |
| 403  | `FORBIDDEN`, `CSRF_INVALID`, `EMAIL_NOT_VERIFIED`, `ACCOUNT_DISABLED` | Not allowed                                                                                  |
| 404  | `NOT_FOUND`                                                           | Missing, or in another workspace                                                             |
| 409  | `CONFLICT`                                                            | State conflict, for example an audit already running or a duplicate email                    |
| 413  | `PAYLOAD_TOO_LARGE`                                                   | Body over 1 MB                                                                               |
| 422  | `UNSUPPORTED_TARGET`                                                  | A website the crawler may not fetch (private network, internal host name, non-standard port) |
| 429  | `RATE_LIMITED`                                                        | See `Retry-After` and the `RateLimit` headers                                                |
| 503  | `PROVIDER_NOT_CONFIGURED`, `SERVICE_UNAVAILABLE`                      | An external provider is not configured, or the queue or database is unavailable              |
| 500  | `INTERNAL_ERROR`                                                      | Unexpected; quote the `requestId`                                                            |

## Example: sign in and start an audit

```bash
# 1. Get a CSRF token (sets sf_csrf) and keep cookies in a jar.
TOKEN=$(curl -s -c jar -b jar http://localhost:4000/api/v1/auth/csrf | node -pe "JSON.parse(require('fs').readFileSync(0)).data.csrfToken")

# 2. Sign in. The Origin header must be an allowed origin (APP_URL / CORS_ALLOWED_ORIGINS).
curl -s -c jar -b jar -H "Content-Type: application/json" -H "X-CSRF-Token: $TOKEN" -H "Origin: http://localhost:5173" \
  -d '{"email":"demo@surfaced.test","password":"<SEED_DEMO_PASSWORD>"}' http://localhost:4000/api/v1/auth/login

# 3. Login rotates the CSRF cookie; read the new value from the jar, then call any endpoint.
TOKEN=$(awk '$6=="sf_csrf"{print $7}' jar)
curl -s -b jar -H "X-CSRF-Token: $TOKEN" -H "Origin: http://localhost:5173" -H "Content-Type: application/json" \
  -d '{}' http://localhost:4000/api/v1/projects/<projectId>/audits     # → 202 { data: { jobId, auditRunId, ... } }
```

## Webhooks

| Provider | Endpoint                                 | Verification                                                                                                |
| -------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Stripe   | `POST /api/v1/billing/webhooks/stripe`   | `Stripe-Signature` over the raw body (`STRIPE_WEBHOOK_SECRET`)                                              |
| Razorpay | `POST /api/v1/billing/webhooks/razorpay` | `X-Razorpay-Signature` (HMAC-SHA256 hex, `RAZORPAY_WEBHOOK_SECRET`), de-duplicated by `X-Razorpay-Event-Id` |

Both respond `200` with `{ received: true, result }`, where `result` is one of `processed`, `duplicate`,
`ignored` or `unmatched`. An invalid signature returns `400`.

## Endpoint index

### System

| Method | Path                  | Access | Purpose                                                     |
| ------ | --------------------- | ------ | ----------------------------------------------------------- |
| GET    | `/api/v1/health`      | Public | Liveness and dependency health                              |
| GET    | `/api/v1/meta/config` | Public | Public runtime configuration (feature modes, never secrets) |

### Authentication

| Method | Path                               | Access    | Purpose                                                        |
| ------ | ---------------------------------- | --------- | -------------------------------------------------------------- |
| GET    | `/api/v1/auth/csrf`                | Public    | Issue a CSRF token cookie                                      |
| POST   | `/api/v1/auth/register`            | Public    | Create an account, workspace and session                       |
| POST   | `/api/v1/auth/login`               | Public    | Sign in with email and password                                |
| POST   | `/api/v1/auth/logout`              | Public    | Sign out and revoke the current session                        |
| GET    | `/api/v1/auth/me`                  | Signed in | Current user, memberships and current workspace                |
| POST   | `/api/v1/auth/verify-email`        | Public    | Confirm an email address with a verification token             |
| POST   | `/api/v1/auth/resend-verification` | Signed in | Send a new verification email                                  |
| POST   | `/api/v1/auth/forgot-password`     | Public    | Request a password reset email                                 |
| POST   | `/api/v1/auth/reset-password`      | Public    | Set a new password with a reset token (signs out all sessions) |

### Account

| Method | Path                                   | Access    | Purpose                                        |
| ------ | -------------------------------------- | --------- | ---------------------------------------------- |
| PATCH  | `/api/v1/users/me`                     | Signed in | Update profile                                 |
| PATCH  | `/api/v1/users/me/preferences`         | Signed in | Update notification preferences                |
| POST   | `/api/v1/users/me/password`            | Signed in | Change password (signs out other sessions)     |
| GET    | `/api/v1/users/me/sessions`            | Signed in | List active sessions                           |
| DELETE | `/api/v1/users/me/sessions/:sessionId` | Signed in | Revoke a session                               |
| POST   | `/api/v1/users/me/deletion-request`    | Signed in | Request account deletion (14-day grace period) |
| DELETE | `/api/v1/users/me/deletion-request`    | Signed in | Cancel a pending account deletion              |

### Workspaces and members

| Method | Path                                                        | Access    | Purpose                                       |
| ------ | ----------------------------------------------------------- | --------- | --------------------------------------------- |
| GET    | `/api/v1/workspaces`                                        | Signed in | List workspaces the current user belongs to   |
| POST   | `/api/v1/workspaces`                                        | Signed in | Create a workspace (starts on the Free plan)  |
| POST   | `/api/v1/workspaces/invitations/accept`                     | Signed in | Accept a workspace invitation                 |
| GET    | `/api/v1/workspaces/:workspaceId`                           | Signed in | Get a workspace                               |
| PATCH  | `/api/v1/workspaces/:workspaceId`                           | Signed in | Update workspace name or white-label settings |
| POST   | `/api/v1/workspaces/:workspaceId/switch`                    | Signed in | Make this the current workspace               |
| GET    | `/api/v1/workspaces/:workspaceId/members`                   | Signed in | List members                                  |
| PATCH  | `/api/v1/workspaces/:workspaceId/members/:memberId`         | Signed in | Change a member's role                        |
| DELETE | `/api/v1/workspaces/:workspaceId/members/:memberId`         | Signed in | Remove a member (or leave the workspace)      |
| GET    | `/api/v1/workspaces/:workspaceId/invitations`               | Signed in | List pending invitations                      |
| POST   | `/api/v1/workspaces/:workspaceId/invitations`               | Signed in | Invite someone by email                       |
| DELETE | `/api/v1/workspaces/:workspaceId/invitations/:invitationId` | Signed in | Revoke an invitation                          |
| GET    | `/api/v1/workspaces/:workspaceId/audit-logs`                | Signed in | Workspace audit log (owners and admins)       |

### Projects (and project-scoped modules)

| Method | Path                                                                        | Access    | Purpose                                                                                                                                                                                                                                            |
| ------ | --------------------------------------------------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/v1/projects`                                                          | Signed in | List projects in a workspace                                                                                                                                                                                                                       |
| POST   | `/api/v1/projects`                                                          | Signed in | Create a project (website, business profile, competitors, primary keywords)                                                                                                                                                                        |
| GET    | `/api/v1/projects/:projectId`                                               | Signed in | Get a project                                                                                                                                                                                                                                      |
| PATCH  | `/api/v1/projects/:projectId`                                               | Signed in | Update a project                                                                                                                                                                                                                                   |
| DELETE | `/api/v1/projects/:projectId`                                               | Signed in | Delete a project and all of its data                                                                                                                                                                                                               |
| GET    | `/api/v1/projects/:projectId/history`                                       | Signed in | Project activity history                                                                                                                                                                                                                           |
| GET    | `/api/v1/projects/:projectId/competitors`                                   | Signed in | List competitors                                                                                                                                                                                                                                   |
| POST   | `/api/v1/projects/:projectId/competitors`                                   | Signed in | Add a competitor                                                                                                                                                                                                                                   |
| PATCH  | `/api/v1/projects/:projectId/competitors/:competitorId`                     | Signed in | Update a competitor                                                                                                                                                                                                                                |
| DELETE | `/api/v1/projects/:projectId/competitors/:competitorId`                     | Signed in | Remove a competitor                                                                                                                                                                                                                                |
| POST   | `/api/v1/projects/:projectId/audits`                                        | Signed in | Start a website crawl and technical audit                                                                                                                                                                                                          |
| GET    | `/api/v1/projects/:projectId/audits`                                        | Signed in | List audit runs                                                                                                                                                                                                                                    |
| GET    | `/api/v1/projects/:projectId/issues`                                        | Signed in | Current issues (open by default) with filters, sorting and pagination                                                                                                                                                                              |
| GET    | `/api/v1/projects/:projectId/issues/summary`                                | Signed in | Open issue counts by severity, category, status and rule                                                                                                                                                                                           |
| GET    | `/api/v1/projects/:projectId/prompts`                                       | Signed in | List tracked prompts                                                                                                                                                                                                                               |
| POST   | `/api/v1/projects/:projectId/prompts`                                       | Signed in | Create a tracked prompt                                                                                                                                                                                                                            |
| POST   | `/api/v1/projects/:projectId/ai-visibility/runs`                            | Signed in | Run visibility checks now for active (or selected) prompts                                                                                                                                                                                         |
| GET    | `/api/v1/projects/:projectId/ai-visibility/runs`                            | Signed in | List visibility runs                                                                                                                                                                                                                               |
| GET    | `/api/v1/projects/:projectId/ai-visibility/summary`                         | Signed in | Mention rate, citation rate, competitor rates, share of voice and sources for a filtered observation set                                                                                                                                           |
| GET    | `/api/v1/projects/:projectId/ai-visibility/trend`                           | Signed in | Visibility trend by day, week or month                                                                                                                                                                                                             |
| GET    | `/api/v1/projects/:projectId/ai-visibility/observations`                    | Signed in | Observations behind the metrics (filterable)                                                                                                                                                                                                       |
| POST   | `/api/v1/projects/:projectId/ai-visibility/observations/manual`             | Signed in | Record what a person saw in an AI system without an API (`surface`: GOOGLE_AI_MODE, GOOGLE_AI_OVERVIEW, CHATGPT, GEMINI, …), with the answer, source links, time and city; labeled manual, no quota                                                |
| GET    | `/api/v1/projects/:projectId/ai-visibility/citations`                       | Signed in | Most cited domains with sample URLs                                                                                                                                                                                                                |
| GET    | `/api/v1/projects/:projectId/content/briefs`                                | Signed in | List content briefs                                                                                                                                                                                                                                |
| POST   | `/api/v1/projects/:projectId/content/briefs`                                | Signed in | Create a content brief                                                                                                                                                                                                                             |
| GET    | `/api/v1/projects/:projectId/content/documents`                             | Signed in | List content documents                                                                                                                                                                                                                             |
| POST   | `/api/v1/projects/:projectId/content/documents`                             | Signed in | Create a content document (optionally from a brief)                                                                                                                                                                                                |
| GET    | `/api/v1/projects/:projectId/keywords`                                      | Signed in | List keywords with filters                                                                                                                                                                                                                         |
| POST   | `/api/v1/projects/:projectId/keywords`                                      | Signed in | Add a keyword                                                                                                                                                                                                                                      |
| POST   | `/api/v1/projects/:projectId/keywords/bulk`                                 | Signed in | Add several keywords (e.g. accepted AI ideas); duplicates are skipped                                                                                                                                                                              |
| POST   | `/api/v1/projects/:projectId/keywords/import`                               | Signed in | Import keywords from CSV text                                                                                                                                                                                                                      |
| GET    | `/api/v1/projects/:projectId/keywords/export`                               | Signed in | Export keywords as CSV                                                                                                                                                                                                                             |
| POST   | `/api/v1/projects/:projectId/keywords/suggest`                              | Signed in | Generate AI keyword ideas (labeled estimates, no measured metrics)                                                                                                                                                                                 |
| GET    | `/api/v1/projects/:projectId/keywords/opportunities`                        | Signed in | Keyword opportunity scores (`?limit=`): each signal with its points, source and explanation, the missing signals, and next steps                                                                                                                   |
| GET    | `/api/v1/projects/:projectId/keyword-groups`                                | Signed in | Keyword lists and topic clusters                                                                                                                                                                                                                   |
| POST   | `/api/v1/projects/:projectId/keyword-groups/:kind`                          | Signed in | Create a keyword list or topic cluster                                                                                                                                                                                                             |
| DELETE | `/api/v1/projects/:projectId/keyword-groups/:kind/:groupId`                 | Signed in | Delete a keyword list or topic cluster (keywords are kept)                                                                                                                                                                                         |
| GET    | `/api/v1/projects/:projectId/competitors/comparison`                        | Signed in | AI mention/citation comparison and shared vs competitor-only cited sources                                                                                                                                                                         |
| GET    | `/api/v1/projects/:projectId/competitors/topic-gaps`                        | Signed in | Prompts where competitors appear in answers and your brand does not                                                                                                                                                                                |
| GET    | `/api/v1/projects/:projectId/competitors/trend`                             | Signed in | Mention-rate trend per entity                                                                                                                                                                                                                      |
| GET    | `/api/v1/projects/:projectId/competitors/metadata`                          | Signed in | Public on-page metadata comparison (your crawl vs competitor snapshots)                                                                                                                                                                            |
| POST   | `/api/v1/projects/:projectId/competitors/:competitorId/snapshot`            | Signed in | Fetch a competitor's public pages (robots.txt respected)                                                                                                                                                                                           |
| GET    | `/api/v1/projects/:projectId/competitors/:competitorId/snapshots/latest`    | Signed in | Latest competitor snapshot                                                                                                                                                                                                                         |
| POST   | `/api/v1/projects/:projectId/gap-analyses`                                  | Signed in | Start a competitor gap analysis (background job; one at a time, 10 a day; needs real AI answers)                                                                                                                                                   |
| GET    | `/api/v1/projects/:projectId/gap-analyses/latest`                           | Signed in | Latest gap analysis with its report, or `null`                                                                                                                                                                                                     |
| POST   | `/api/v1/projects/:projectId/gap-analyses/:analysisId/recommendations`      | Signed in | Save one action of the report as a recommendation (`{ actionKey }`, idempotent)                                                                                                                                                                    |
| POST   | `/api/v1/projects/:projectId/seo-comparisons`                               | Signed in | Crawl your site and up to 5 competitors the same way and compare them (`{ competitorIds? }`; background job; one competitor snapshot per competitor)                                                                                               |
| GET    | `/api/v1/projects/:projectId/seo-comparisons/latest`                        | Signed in | Latest SEO comparison with its result, or `null`                                                                                                                                                                                                   |
| POST   | `/api/v1/projects/:projectId/seo-comparisons/:comparisonId/recommendations` | Signed in | Save one suggestion as a recommendation (`{ suggestionKey }`, idempotent)                                                                                                                                                                          |
| POST   | `/api/v1/projects/:projectId/prompts/bulk`                                  | Signed in | Add up to 100 prompts with the same settings; duplicates, short lines and prompts already tracked are skipped and reported                                                                                                                         |
| GET    | `/api/v1/projects/:projectId/trends/status`                                 | Signed in | Trends sources the server allows (configured, available, health, last success and failure), Search Console, Keyword Planner, AI and limits                                                                                                         |
| GET    | `/api/v1/projects/:projectId/trends/categories`                             | Signed in | Google Trends categories (id, name, parent path)                                                                                                                                                                                                   |
| GET    | `/api/v1/projects/:projectId/trends/latest`                                 | Signed in | Latest keyword trends report (data, source, freshness, limitations, comparison with the site, placements), or `null`                                                                                                                               |
| GET    | `/api/v1/projects/:projectId/trends/reports`                                | Signed in | Report history (source, place, period, cached, partial, scheduled)                                                                                                                                                                                 |
| GET    | `/api/v1/projects/:projectId/trends/reports/:reportId`                      | Signed in | One trends report                                                                                                                                                                                                                                  |
| POST   | `/api/v1/projects/:projectId/trends`                                        | Signed in | Fetch live data from a provider (`provider` optional; `region`, `include`, `suggestPlacements`) and compare it with the site (background job on the `trends` queue; reuses cached data for identical requests; one AI keyword run with placements) |
| POST   | `/api/v1/projects/:projectId/trends/import/preview`                         | Signed in | Read Google Trends CSV exports without saving them: kind, terms, rows and first rows of each file                                                                                                                                                  |
| POST   | `/api/v1/projects/:projectId/trends/import`                                 | Signed in | Import Google Trends CSV exports (interest over time, by region, related queries and topics) and compare them with the site (background job)                                                                                                       |
| GET    | `/api/v1/projects/:projectId/trends/reports/:reportId/export`               | Signed in | One part as CSV (`?part=interest                                                                                                                                                                                                                   | regions | related | terms`), with source and retrieval time on every row |
| POST   | `/api/v1/projects/:projectId/trends/reports/:reportId/keywords`             | Signed in | Save report terms to the project keywords (`{ terms, listId? or listName?, priority }`); unknown terms are reported                                                                                                                                |
| POST   | `/api/v1/projects/:projectId/trends/reports/:reportId/briefs`               | Signed in | Plan content for a term: a content brief with the trend evidence, plus a content task when `dueDate` is given                                                                                                                                      |
| POST   | `/api/v1/projects/:projectId/trends/reports/:reportId/recommendations`      | Signed in | Save one placement suggestion as a recommendation (`{ term }`)                                                                                                                                                                                     |
| GET    | `/api/v1/projects/:projectId/trends/saved`                                  | Signed in | Saved comparisons                                                                                                                                                                                                                                  |
| POST   | `/api/v1/projects/:projectId/trends/saved`                                  | Signed in | Save a comparison (`schedule`: `NONE`, `WEEKLY` or `MONTHLY`)                                                                                                                                                                                      |
| PATCH  | `/api/v1/projects/:projectId/trends/saved/:savedId`                         | Signed in | Rename a saved comparison or change its schedule                                                                                                                                                                                                   |
| DELETE | `/api/v1/projects/:projectId/trends/saved/:savedId`                         | Signed in | Delete a saved comparison (its reports are kept)                                                                                                                                                                                                   |
| POST   | `/api/v1/projects/:projectId/trends/saved/:savedId/run`                     | Signed in | Run a saved comparison now (background job)                                                                                                                                                                                                        |
| GET    | `/api/v1/projects/:projectId/recommendations`                               | Signed in | Recommendations with filters                                                                                                                                                                                                                       |
| POST   | `/api/v1/projects/:projectId/recommendations/regenerate`                    | Signed in | Rebuild recommendations from the latest audit and AI visibility evidence                                                                                                                                                                           |
| POST   | `/api/v1/projects/:projectId/reports`                                       | Signed in | Generate a report from stored project data for a date range (background job)                                                                                                                                                                       |
| GET    | `/api/v1/projects/:projectId/reports`                                       | Signed in | List reports                                                                                                                                                                                                                                       |
| GET    | `/api/v1/projects/:projectId/integrations`                                  | Signed in | Integration catalog with this project’s connection status                                                                                                                                                                                          |
| POST   | `/api/v1/projects/:projectId/integrations/google-search-console/connect`    | Signed in | Start the Google OAuth consent flow (returns the consent URL)                                                                                                                                                                                      |
| GET    | `/api/v1/projects/:projectId/search-console`                                | Signed in | Synced Search Console metrics (clicks, impressions, CTR, position)                                                                                                                                                                                 |

### Prompts

| Method | Path                            | Access    | Purpose                                                           |
| ------ | ------------------------------- | --------- | ----------------------------------------------------------------- |
| GET    | `/api/v1/prompts/:promptId`     | Signed in | Get a prompt                                                      |
| PATCH  | `/api/v1/prompts/:promptId`     | Signed in | Update a prompt (pause, change providers, frequency, competitors) |
| DELETE | `/api/v1/prompts/:promptId`     | Signed in | Delete a prompt and its observations                              |
| POST   | `/api/v1/prompts/:promptId/run` | Signed in | Run this prompt now                                               |

### Content Studio

| Method | Path                                                                | Access    | Purpose                                                                               |
| ------ | ------------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------- |
| GET    | `/api/v1/content/briefs/:briefId`                                   | Signed in | Get a brief with its documents                                                        |
| PATCH  | `/api/v1/content/briefs/:briefId`                                   | Signed in | Update a brief                                                                        |
| DELETE | `/api/v1/content/briefs/:briefId`                                   | Signed in | Delete a brief (documents are kept)                                                   |
| GET    | `/api/v1/content/documents/:documentId`                             | Signed in | Get a document with its latest version and generation status                          |
| PATCH  | `/api/v1/content/documents/:documentId`                             | Signed in | Update title, assignee or workflow status (Draft → In review → Approved → Published)  |
| DELETE | `/api/v1/content/documents/:documentId`                             | Signed in | Delete a document and its versions                                                    |
| GET    | `/api/v1/content/documents/:documentId/versions`                    | Signed in | Version history                                                                       |
| POST   | `/api/v1/content/documents/:documentId/versions`                    | Signed in | Save an edited version                                                                |
| GET    | `/api/v1/content/documents/:documentId/versions/:versionId`         | Signed in | Get a specific version                                                                |
| POST   | `/api/v1/content/documents/:documentId/versions/:versionId/restore` | Signed in | Restore an earlier version (creates a new version)                                    |
| POST   | `/api/v1/content/documents/:documentId/generate`                    | Signed in | Generate an outline, article, meta tags, FAQs, schema or one section (background job) |
| GET    | `/api/v1/content/documents/:documentId/internal-links`              | Signed in | Internal link suggestions from the latest crawl                                       |
| GET    | `/api/v1/content/documents/:documentId/export`                      | Signed in | Download the latest version as Markdown or HTML                                       |

### Keywords

| Method | Path                               | Access    | Purpose                                        |
| ------ | ---------------------------------- | --------- | ---------------------------------------------- |
| GET    | `/api/v1/keywords/provider-status` | Signed in | Keyword data provider and AI suggestion status |
| PATCH  | `/api/v1/keywords/:keywordId`      | Signed in | Update a keyword                               |
| DELETE | `/api/v1/keywords/:keywordId`      | Signed in | Delete a keyword                               |

### Recommendations

| Method | Path                                        | Access    | Purpose                                                                     |
| ------ | ------------------------------------------- | --------- | --------------------------------------------------------------------------- |
| GET    | `/api/v1/recommendations/:recommendationId` | Signed in | Recommendation detail with evidence                                         |
| PATCH  | `/api/v1/recommendations/:recommendationId` | Signed in | Change status (accept/start, await approval, complete, dismiss) or assignee |

### Reports

| Method | Path                             | Access    | Purpose                                                                |
| ------ | -------------------------------- | --------- | ---------------------------------------------------------------------- |
| GET    | `/api/v1/reports/:reportId`      | Signed in | Report metadata and generation status                                  |
| GET    | `/api/v1/reports/:reportId/html` | Signed in | Report HTML (static; served with a sandboxing Content-Security-Policy) |
| GET    | `/api/v1/reports/:reportId/pdf`  | Signed in | Download the report PDF (when the PDF renderer is available)           |
| DELETE | `/api/v1/reports/:reportId`      | Signed in | Delete a report and its files                                          |

### Billing

| Method | Path                                | Access    | Purpose                                                                                                 |
| ------ | ----------------------------------- | --------- | ------------------------------------------------------------------------------------------------------- |
| GET    | `/api/v1/billing/plans`             | Public    | Active subscription plans (public)                                                                      |
| GET    | `/api/v1/billing/subscription`      | Signed in | Current plan and subscription status for a workspace                                                    |
| POST   | `/api/v1/billing/checkout`          | Signed in | Start a plan change. Paid providers return a hosted checkout URL; payment is confirmed only by webhook. |
| POST   | `/api/v1/billing/portal`            | Signed in | Open the Stripe customer portal                                                                         |
| POST   | `/api/v1/billing/cancel`            | Signed in | Cancel at the end of the current billing period                                                         |
| POST   | `/api/v1/billing/resume`            | Signed in | Undo a scheduled cancellation                                                                           |
| GET    | `/api/v1/billing/invoices`          | Signed in | Billing history                                                                                         |
| POST   | `/api/v1/billing/webhooks/stripe`   | Public    | Stripe webhook endpoint (signature-verified, idempotent)                                                |
| POST   | `/api/v1/billing/webhooks/razorpay` | Public    | Razorpay webhook endpoint (signature-verified, idempotent)                                              |
| POST   | `/api/v1/billing/dev/simulate`      | Signed in | Development only: simulate billing events to exercise UI states (no real payments)                      |
| GET    | `/api/v1/usage`                     | Signed in | Usage for the current UTC month against plan limits                                                     |

### Integrations

| Method | Path                                            | Access    | Purpose                                                                    |
| ------ | ----------------------------------------------- | --------- | -------------------------------------------------------------------------- |
| GET    | `/api/v1/integrations/catalog`                  | Signed in | Available integrations and whether each is implemented and configured      |
| GET    | `/api/v1/integrations/google/callback`          | Public    | OAuth redirect URI for Google (browser redirect; validates state and PKCE) |
| GET    | `/api/v1/integrations/:integrationId/gsc/sites` | Signed in | Search Console properties the connected account can access                 |
| PATCH  | `/api/v1/integrations/:integrationId`           | Signed in | Select the Search Console property to sync (Search Console only)           |
| POST   | `/api/v1/integrations/:integrationId/sync`      | Signed in | Sync now: Search Console, or the linked Business Profile locations (job)   |
| DELETE | `/api/v1/integrations/:integrationId`           | Signed in | Disconnect and revoke access (Business Profile: stored data is deleted)    |

Connect with `POST /api/v1/projects/:projectId/integrations/:provider/connect`, where `:provider` is
`google-search-console` or `google-business-profile`. The callback returns to the Integrations page, or to the
Business Profile page for Business Profile.

### Local SEO and Business Profile

Locations, local rank grids, local competitors and Google Business Profile. Grid points come from a licensed provider
(`SERP_PROVIDER=dataforseo`), manual observations or, in development only, a labeled fixture. Business Profile data
is served only to the business's own signed-in users and is kept for at most 30 days. A review reply reaches Google
only through `…/publish`, which needs the `local.publish` permission (owners and admins) and an approved approval
request for exactly the current text (otherwise 409 with `details.reason = APPROVAL_REQUIRED`). When Google refuses
a request (for example API access not yet approved, quota 0), the response is 502 `UPSTREAM_ERROR` with Google's
reason.

| Method | Path                                                                   | Access    | Purpose                                                                                           |
| ------ | ---------------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------- |
| GET    | `/api/v1/projects/:projectId/local/status`                             | Signed in | Local rank sources (licensed, manual), grid point usage, location limits and compliance note      |
| GET    | `/api/v1/projects/:projectId/local/overview`                           | Signed in | Local Search & AI Visibility: one card per surface, with source, freshness and limitations        |
| GET    | `/api/v1/projects/:projectId/locations`                                | Signed in | Business locations of the project                                                                 |
| POST   | `/api/v1/projects/:projectId/locations`                                | Signed in | Add a business location (counts against the plan location limit)                                  |
| PUT    | `/api/v1/projects/:projectId/locations/:locationId`                    | Signed in | Replace the details of a business location                                                        |
| DELETE | `/api/v1/projects/:projectId/locations/:locationId`                    | Signed in | Archive a location (history kept, tracked queries paused)                                         |
| GET    | `/api/v1/projects/:projectId/local/queries`                            | Signed in | Tracked local queries with their latest scan                                                      |
| POST   | `/api/v1/projects/:projectId/local/queries`                            | Signed in | Track a search query on a geographic grid around a location                                       |
| PATCH  | `/api/v1/projects/:projectId/local/queries/:queryId`                   | Signed in | Change the schedule of a tracked query or pause it                                                |
| DELETE | `/api/v1/projects/:projectId/local/queries/:queryId`                   | Signed in | Stop tracking a query (deletes its scans)                                                         |
| POST   | `/api/v1/projects/:projectId/local/queries/:queryId/scans`             | Signed in | Scan the grid now: a licensed provider (background job, uses grid point quota) or a manual scan   |
| GET    | `/api/v1/projects/:projectId/local/queries/:queryId/scans`             | Signed in | Scan history of a query (grid visibility over time)                                               |
| GET    | `/api/v1/projects/:projectId/local/queries/:queryId/comparison`        | Signed in | Businesses listed in the latest scan: appearances, top-3 counts, public ratings and review growth |
| GET    | `/api/v1/projects/:projectId/local/scans/:scanId`                      | Signed in | One scan with every grid point and the businesses listed there                                    |
| POST   | `/api/v1/projects/:projectId/local/scans/:scanId/points`               | Signed in | Enter what you saw at one grid point of a manual scan                                             |
| POST   | `/api/v1/projects/:projectId/local/scans/:scanId/finish`               | Signed in | Finish a manual scan (points not entered stay unmeasured)                                         |
| GET    | `/api/v1/projects/:projectId/local/scans/:scanId/export`               | Signed in | Export a scan as CSV (one row per business listed at each point)                                  |
| GET    | `/api/v1/projects/:projectId/local/competitors`                        | Signed in | Local competitors: suggested from scans, confirmed and dismissed                                  |
| PATCH  | `/api/v1/projects/:projectId/local/competitors/:competitorId`          | Signed in | Confirm or dismiss a suggested local competitor                                                   |
| GET    | `/api/v1/projects/:projectId/business-profile`                         | Signed in | Connection status and the locations linked to Business Profile                                    |
| GET    | `/api/v1/projects/:projectId/business-profile/accounts`                | Signed in | Business Profile accounts the connected Google account can manage (read live)                     |
| GET    | `/api/v1/projects/:projectId/business-profile/locations`               | Signed in | Profile locations in one account (read live, not stored)                                          |
| POST   | `/api/v1/projects/:projectId/business-profile/links`                   | Signed in | Link a profile location to a business location (or create one from it), then sync                 |
| DELETE | `/api/v1/projects/:projectId/locations/:locationId/business-profile`   | Signed in | Unlink the profile and delete the Business Profile data stored for the location                   |
| POST   | `/api/v1/projects/:projectId/business-profile/sync`                    | Signed in | Sync linked profiles now: profile, metrics and reviews (background job)                           |
| GET    | `/api/v1/projects/:projectId/locations/:locationId/business-profile`   | Signed in | Profile, audit, performance metrics and reviews of one location                                   |
| POST   | `/api/v1/projects/:projectId/reviews/:reviewId/replies`                | Signed in | Create a reply draft, written or drafted by the AI model (never published without approval)       |
| PATCH  | `/api/v1/projects/:projectId/review-replies/:replyId`                  | Signed in | Edit a reply draft (withdraws a pending approval)                                                 |
| POST   | `/api/v1/projects/:projectId/review-replies/:replyId/request-approval` | Signed in | Ask an approver to approve the exact reply text                                                   |
| POST   | `/api/v1/projects/:projectId/review-replies/:replyId/publish`          | Signed in | Publish an approved reply to Google (needs local.publish and an approval for this text)           |
| DELETE | `/api/v1/projects/:projectId/review-replies/:replyId`                  | Signed in | Discard a reply draft                                                                             |

### Merchant Center and product feeds

Read-only towards Google. Product feeds are uploaded as JSON (`{ fileName, content, country, language, mode }`) with
a 25 MB request limit on the two import paths (the file itself up to 20 MB and 50,000 rows). Importing and syncing
need a plan with `ecommerce` (402 otherwise) and the `commerce.manage` permission; products count against
`productsTracked`, and products beyond it are not imported (`limitedByPlan`). The product list returns
`meta` for pagination.

| Method | Path                                                       | Access    | Purpose                                                                                   |
| ------ | ---------------------------------------------------------- | --------- | ----------------------------------------------------------------------------------------- |
| GET    | `/api/v1/projects/:projectId/merchant`                     | Signed in | Merchant Center status, product health by program, and the eligibility checklist          |
| GET    | `/api/v1/projects/:projectId/merchant/accounts`            | Signed in | Merchant Center accounts the connected Google account can access (read live)              |
| PUT    | `/api/v1/projects/:projectId/merchant/account`             | Signed in | Choose the Merchant Center account to read, then sync it (background job)                 |
| POST   | `/api/v1/projects/:projectId/merchant/sync`                | Signed in | Read the account and its products from Merchant Center now (background job)               |
| POST   | `/api/v1/projects/:projectId/merchant/import/preview`      | Signed in | Read a product feed file without saving it: format, columns, checks on the first products |
| POST   | `/api/v1/projects/:projectId/merchant/import`              | Signed in | Import a product feed file (Google CSV/TSV or Shopify export); replace or merge           |
| DELETE | `/api/v1/projects/:projectId/merchant/feed-products`       | Signed in | Remove the products imported from feed files                                              |
| GET    | `/api/v1/projects/:projectId/merchant/products`            | Signed in | Products with their issues (filter: errors, warnings, ok; search by title or id)          |
| GET    | `/api/v1/projects/:projectId/merchant/products/:productId` | Signed in | One product with every check and Google’s statuses                                        |

### AI visibility

| Method | Path                                                | Access    | Purpose                                                                 |
| ------ | --------------------------------------------------- | --------- | ----------------------------------------------------------------------- |
| GET    | `/api/v1/ai-visibility/providers`                   | Signed in | Provider configuration status (configured, not configured, demo)        |
| GET    | `/api/v1/ai-visibility/runs/:runId`                 | Signed in | Visibility run detail                                                   |
| GET    | `/api/v1/ai-visibility/observations/:observationId` | Signed in | Full observation: answer, redacted raw response, mentions and citations |

### Audits

| Method | Path                                    | Access    | Purpose                                                          |
| ------ | --------------------------------------- | --------- | ---------------------------------------------------------------- |
| GET    | `/api/v1/audits/:auditId`               | Signed in | Audit run detail: status, crawl progress, scores and limitations |
| POST   | `/api/v1/audits/:auditId/cancel`        | Signed in | Cancel a queued or running audit                                 |
| POST   | `/api/v1/audits/:auditId/rescore`       | Signed in | Re-apply the current rules and weights to the stored crawl       |
| GET    | `/api/v1/audits/:auditId/pages`         | Signed in | Crawled pages with filters and sorting                           |
| GET    | `/api/v1/audits/:auditId/pages/:pageId` | Signed in | Page-level detail: fetched data, issues, inlinks and outlinks    |
| GET    | `/api/v1/audits/:auditId/issues`        | Signed in | Issues detected in this audit run                                |
| GET    | `/api/v1/issues/:issueId`               | Signed in | Issue detail with detection history                              |
| PATCH  | `/api/v1/issues/:issueId`               | Signed in | Ignore or re-open an issue                                       |
| GET    | `/api/v1/crawl/jobs/:crawlJobId`        | Signed in | Crawl job status and counters                                    |

### Public (no account)

| Method | Path                             | Access | Purpose                                        |
| ------ | -------------------------------- | ------ | ---------------------------------------------- |
| POST   | `/api/v1/public/audits`          | Public | Start a free website audit (no account needed) |
| GET    | `/api/v1/public/audits/:auditId` | Public | Free audit progress and results                |
| POST   | `/api/v1/public/contact`         | Public | Send a message to the team                     |

### Jobs and notifications

| Method | Path                                         | Access    | Purpose                                         |
| ------ | -------------------------------------------- | --------- | ----------------------------------------------- |
| GET    | `/api/v1/jobs/:jobId`                        | Signed in | Background job status and progress              |
| POST   | `/api/v1/jobs/:jobId/cancel`                 | Signed in | Request cancellation of a queued or running job |
| GET    | `/api/v1/notifications`                      | Signed in | List notifications                              |
| POST   | `/api/v1/notifications/:notificationId/read` | Signed in | Mark one notification as read                   |
| POST   | `/api/v1/notifications/read-all`             | Signed in | Mark all notifications as read                  |

### Platform admin

| Method | Path                                    | Access         | Purpose                                                                   |
| ------ | --------------------------------------- | -------------- | ------------------------------------------------------------------------- |
| GET    | `/api/v1/admin/overview`                | Platform admin | Platform totals: users, workspaces, plans, jobs, usage and email delivery |
| GET    | `/api/v1/admin/users`                   | Platform admin | Search users                                                              |
| GET    | `/api/v1/admin/users/:userId`           | Platform admin | User detail with memberships and session count                            |
| PATCH  | `/api/v1/admin/users/:userId`           | Platform admin | Disable (and sign out) or re-enable a user                                |
| GET    | `/api/v1/admin/workspaces`              | Platform admin | Search workspaces with plan, owners and counts                            |
| GET    | `/api/v1/admin/workspaces/:workspaceId` | Platform admin | Workspace detail with projects and current-month usage                    |
| GET    | `/api/v1/admin/jobs`                    | Platform admin | Background jobs across all workspaces (newest first)                      |
| POST   | `/api/v1/admin/jobs/:jobId/retry`       | Platform admin | Retry a failed job that is still held by the queue                        |
| GET    | `/api/v1/admin/plans`                   | Platform admin | All plans, including inactive ones and provider price ids                 |
| PATCH  | `/api/v1/admin/plans/:planKey`          | Platform admin | Edit a plan (prices, limits, features, provider ids)                      |
| GET    | `/api/v1/admin/usage`                   | Platform admin | Usage for a month: totals per metric and per workspace                    |
| GET    | `/api/v1/admin/system`                  | Platform admin | Dependency health and provider configuration (never secrets)              |
| GET    | `/api/v1/admin/audit-logs`              | Platform admin | Platform-wide audit log                                                   |
