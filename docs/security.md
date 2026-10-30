# Security

This document lists the security controls implemented in Surfaced, where they live in the code, and the tests
that cover them. The final section lists known gaps.

## Authentication and sessions

| Control                | Implementation                                                                                                                                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Password hashing       | Argon2id: 19 MiB memory, 2 iterations, parallelism 1 (`core/crypto.ts`)                                                                                                                                            |
| Password policy        | 10 to 128 characters and more than two distinct characters. Login does not apply the policy, so older passwords still work                                                                                         |
| Sessions               | Opaque 256-bit random tokens. Only a SHA-256 hash is stored (`sessions.tokenHash`). The token lives in the `sf_session` cookie: HttpOnly, SameSite=Lax, Secure in production, 30-day lifetime (`SESSION_TTL_DAYS`) |
| Session revocation     | Logout (current session), password change (other sessions), password reset (all sessions), admin disable (all sessions), and per-session sign-out under Settings → Sessions                                        |
| Single-use tokens      | Email verification (24 h), password reset (1 h) and invitations (7 days) are random tokens stored as SHA-256 hashes and marked used on first use                                                                   |
| Enumeration resistance | "Forgot password" responds the same whether or not the account exists                                                                                                                                              |
| Disabled accounts      | Refused at login and at every request (session middleware)                                                                                                                                                         |
| Account deletion       | 14-day grace period. A daily job then deletes the account and its solo workspaces (see `core/accounts.ts`)                                                                                                         |

## Cross-site request forgery

State-changing API requests need the `X-CSRF-Token` header to equal the `sf_csrf` cookie, and the token must
carry a valid HMAC signed with `SESSION_SECRET`. A signed double-submit token cannot be planted by a sibling
subdomain. The `Origin` (or `Referer`) header must also be an allowed origin. Two endpoints are exempt because
they authenticate differently:

- payment webhooks: verified by signature;
- the Google OAuth callback: verified by a single-use state and PKCE.

## Authorization and tenant isolation

- **Roles:** Owner, Admin and Member, defined by one permission matrix (`shared/permissions.ts`). The API checks
  it on every request; the web app uses the same table only to hide controls.
- **Tenant isolation:** every project- or workspace-scoped query goes through `requireProjectAccess` or
  `requireWorkspaceAccess`. These resolve the caller's membership in the same query. Resources in other
  workspaces return **404**, so IDs cannot be probed, and an insufficient role returns **403**.
- **Role rules:**
  - Only owners can grant or remove the owner role.
  - The last owner cannot leave or be demoted.
  - Invitations are bound to the invited email address.
- **Platform administrators** (`users.platformRole = ADMIN`):
  - Admin routes return 404 to everyone else.
  - Admins cannot disable their own account.
  - Every admin change is written to the audit log.
- **Plan limits** (projects, members, prompts, competitors, monthly quotas) are enforced on the server under a
  per-workspace row lock, so concurrent requests cannot exceed them.

## Input and output handling

- Every route validates params, query and body with zod and returns field-level errors. JSON bodies are limited to
  1 MB; webhook routes receive the raw body (also 1 MB).
- **Markdown** (blog posts, AI answers, content drafts) is rendered with raw HTML escaped and unsafe link
  protocols (`javascript:`, `data:` and others) removed (`shared/markdown.ts`).
- **JSON-LD** blocks escape `<` and line separators, so content cannot close the script tag.
- **Report HTML** is served with `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline';
img-src data:; sandbox` and shown in a sandboxed iframe. Report PDFs are rendered with JavaScript disabled and
  every network request blocked.
- **CSV export** prefixes cells that begin with `=`, `+`, `-`, `@`, tab or carriage return, preventing spreadsheet
  formula injection.
- **Content exports** escape raw HTML.

## HTTP security headers

- API responses use helmet with `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`,
  `X-Content-Type-Options: nosniff`, a same-site Cross-Origin-Resource-Policy, and HSTS in production.
- With `SERVE_WEB_DIST=true`, web pages get the following CSP. Styles allow `'unsafe-inline'` because React style
  attributes and charts set inline styles.

  ```
  default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:;
  connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'
  ```

- CORS allows credentials only for the configured origins (`CORS_ALLOWED_ORIGINS` and `APP_URL`).

## Rate limiting

Counters live in Redis (prefixed by `QUEUE_PREFIX`), so limits hold across API replicas. Limited requests get
`429` with `Retry-After`.

| Limiter                 | Limit                                                        |
| ----------------------- | ------------------------------------------------------------ |
| All API requests        | 1,500 per 5 minutes per user (per IP when signed out)        |
| Login                   | 10 per 15 minutes per IP and email, 50 per 15 minutes per IP |
| Registration            | 10 per hour per IP                                           |
| Password reset requests | 5 per hour per IP and email                                  |
| Verification emails     | 10 per hour per IP                                           |
| Free audits             | 5 per hour per IP, 200 per hour globally                     |
| Contact form            | 5 per hour per IP, plus a honeypot field                     |

## Crawler safety (SSRF and good citizenship)

`core/crawler/ssrf.ts` and `fetcher.ts`:

- **URL policy:** only `http` and `https`, no credentials in URLs, and ports 80 and 443 only.
- **Blocked addresses:** internal host names (`localhost`, `.local`, `.internal` and similar) and every private,
  loopback, link-local, CGNAT, multicast and reserved range, for both IPv4 and IPv6.
- **Embedded IPv4 is checked too:** IPv4 hidden inside IPv4-mapped, NAT64 and 6to4 IPv6 addresses.
- **DNS pinning:** a custom `lookup` resolves the host, rejects it unless every address is public, and connects to
  exactly the validated address. There is no DNS-rebinding window.
- **Redirects** are followed manually, and each hop is re-validated against the URL policy and robots.txt.
- **Limits:** response bodies are capped after decompression, and headers, body and total time all have
  timeouts.
- **Behavior:** the crawler respects robots.txt (RFC 9309: a 5xx response means "disallow all") and its
  `Crawl-delay`, and uses small page budgets. It never logs in, submits forms or bypasses paywalls. Competitor
  snapshots follow the same rules.
- **Development allowlist:** `CRAWLER_DEV_ALLOWLIST` (for example the local fixture site) is ignored when
  `NODE_ENV=production`.

## Secrets and sensitive data

- Secrets come only from environment variables, validated at start-up. Production refuses development providers,
  console email, demo AI data and insecure cookies.
- The browser bundle contains only `VITE_*` values: the API base URL, site URL and contact email.
- Logs (pino) redact cookies, authorization headers, CSRF tokens, webhook signatures, passwords, tokens, API keys
  and secrets. The audit log also strips sensitive-looking keys from its metadata.
- **Google OAuth:**
  - Tokens are encrypted at rest with AES-256-GCM (`ENCRYPTION_KEY`).
  - The OAuth state is random, stored hashed, single-use, bound to the user and valid for 10 minutes.
  - PKCE uses S256.
  - Disconnecting revokes the token at Google and deletes it.
- **Email:**
  - Rendered messages, which may contain single-use links, travel AES-GCM-encrypted in the job queue and are
    never stored in MySQL.
  - Delivery records store only the recipient, template, subject and status.
  - The console provider (development) writes `.eml` files locally and records `LOGGED_LOCALLY`, never `SENT`.
- **AI providers** receive the prompts and project context needed for a request. Stored raw responses have
  secrets removed and long fields truncated.

## Payments

- **Card data:** card details are entered only on the provider's hosted pages (Stripe Checkout, Razorpay); the
  API never handles them.
- **Webhooks:** Stripe signatures are verified with `stripe.webhooks.constructEvent`. Razorpay webhooks are
  verified with HMAC-SHA256 over the raw body, compared in constant time.
- **Idempotency:** events are processed at most once per provider event ID (unique constraint).
- **Plan changes** are applied only from verified webhooks. Checkout never marks a plan as paid.
- **Development billing** (immediate plan changes without payment) is labeled in the UI and refused in
  production.

## Data retention

| Data                                                   | Retention                                                                                            |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| Expired sessions, used or expired tokens, OAuth states | Deleted by the hourly cleanup (tokens one week after use or expiry)                                  |
| Free (anonymous) audits                                | 7 days, then deleted with their crawl data                                                           |
| Accounts with a deletion request                       | Deleted 14 days after the request (deferred if still the sole owner of a shared workspace or paying) |
| Report files                                           | Deleted with the report, the project or the workspace                                                |
| Audit log                                              | Kept for accountability; the actor is set to null when a user is deleted                             |

## Tests that cover these controls

These run in the API and core suites:

- Session cookie flags; CSRF (missing, forged and cross-origin); login and registration rate limits with
  `Retry-After`.
- Disabled accounts; non-enumerating password reset that revokes sessions; single-use tokens.
- Cross-tenant 404s for workspaces, projects, audits, jobs, reports and integrations.
- Role rules; plan limits (402).
- SSRF policy: private ranges, embedded IPv4, ports, redirects, DNS pinning.
- Webhook signatures and idempotency.
- OAuth state replay, expiry and user binding; encrypted tokens.
- Report CSP; CSV formula escaping; Markdown escaping; static-file path traversal.
- Admin access (404 for non-admins), no secrets in system status, session revocation on disable.
- A regression test that no provider credentials are visible to tests.

## Known gaps

- No multi-factor authentication and no account lockout beyond rate limiting.
- No CAPTCHA (the contact form uses a honeypot; free audits are rate limited).
- `ENCRYPTION_KEY` rotation needs a re-encryption script, which is not included.
- Dependency audits are not automated. Run `npm audit` in CI. A web application firewall and DDoS protection
  belong in front of the deployment.
- Legal pages (privacy, terms) describe the implemented data handling but have not been reviewed by a lawyer.
