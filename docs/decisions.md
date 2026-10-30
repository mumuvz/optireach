# Decision log

Short architecture decision records. Each entry gives the context, the decision and the consequences.

### D-001 · Brand: "Surfaced"

The brief required an original brand. **Surfaced** ("get surfaced in search results and AI answers") has an
original logo (stacked signal arcs rising from a baseline) and an indigo/cyan palette. No reference assets or copy are used.

### D-002 · Reference site could not be captured

The reference site returns `403` with `X-Vercel-Mitigated: deny` to all automated clients. The block was not
bypassed. Findings and evidence are in `docs/reference/README.md`.

### D-003 · Dependency versions (October 2026)

- **TypeScript 6.0.x**, not 7.0: `typescript-eslint` 8.x supports `typescript <6.1`.
- **Prisma 7.10** (current stable `@prisma/client`). The `prisma` CLI's `latest` dist-tag points to an `8.0.0-rc`,
  so the CLI is pinned to 7.10.x as well. Prisma 7 requires a driver adapter; MySQL uses
  `@prisma/adapter-mariadb` (MariaDB connector, MySQL-compatible). `DATABASE_URL` is parsed once and feeds both
  the CLI (`prisma.config.ts`) and the runtime adapter.
- **React Router 8** in declarative mode (`BrowserRouter`/`StaticRouter` from `react-router`; `react-router-dom` was removed in v8).
- **BullMQ 6** with `ioredis` installed explicitly (it is an optional peer in v6). Repeatable jobs were removed
  in v6, so recurring work uses Job Schedulers.
- **Vitest 5**, **Vite 8**, **Tailwind CSS 4**, **Express 5**, **Zod 4**, **ESLint 10** flat config.

### D-004 · Sessions instead of JWT

Opaque, random 256-bit session tokens in an HTTP-only, `SameSite=Lax`, `Secure`-in-production cookie. Only the
SHA-256 hash is stored in `sessions`. This allows instant revocation (logout, password change, account disable),
avoids JWT key management, and is equivalent to the brief's JWT-or-session requirement. The cost is one indexed
DB read per request.

### D-005 · CSRF: signed double-submit plus Origin check

Cookie-authenticated, state-changing requests must send `X-CSRF-Token` equal to the `sf_csrf` cookie, and the
token must carry a valid HMAC (`SESSION_SECRET`). The `Origin`/`Referer` header must match an allowed origin.
Webhooks and OAuth callbacks are exempt because they carry their own verification.

### D-006 · Internal packages are consumed as TypeScript source

`@surfaced/shared` and `@surfaced/core` export `.ts` files. Vite (web), tsx (dev) and Vitest compile them
directly, and the API and worker are bundled with **esbuild** for production with all npm dependencies external.
This avoids a separate build or watch step for libraries.

### D-007 · Prerendered marketing pages

A client-only SPA is not reliably indexable, so marketing routes are prerendered to static HTML at build time
(React `renderToString` + `StaticRouter`), with per-route metadata and JSON-LD. The dashboard stays a lazy-loaded
SPA served from `app.html` (`noindex`). Pricing and other live data hydrate from the API after load.

### D-008 · Crawler networking

`undici` Agent with a custom DNS `lookup` that validates every resolved address and pins the connection to it.
Manual redirect handling re-validates every hop. Ports are limited to 80/443 (plus `CRAWLER_DEV_ALLOWLIST`, which
is ignored when `NODE_ENV=production`). This is the only safe way to crawl the local E2E fixture site.

### D-009 · Audit score is a documented diagnostic index

Score = weighted mean of eight category scores. Each category score is `100 − penalty`, where page-level issues
contribute `severityPoints × 100 / indexable pages` and site-level issues contribute fixed points, capped at 100.
Weights and points are configuration (`packages/shared/src/audit/scoring-config.ts`), and a snapshot is stored on
each `audit_runs` row. The UI explains that this is **not** a Google ranking score. Details are in `docs/scoring.md`.

### D-010 · AI visibility providers

Only official APIs are used: OpenAI Responses API (`web_search` tool) and Perplexity Sonar. "Model knowledge"
answers without browsing are a separate provider labeled **not a live search result**. A deterministic mock
provider exists for development and E2E, and is labeled as demo data everywhere. Gemini, Claude, Copilot and
Google AI Overviews are **not** claimed. Default model: `gpt-5.4-mini` (configurable via `OPENAI_VISIBILITY_MODEL`;
OpenAI recommends `gpt-5.5` for best web-search quality).

### D-011 · Metrics are computed on read from stored observations

Mention rate, citation rate, competitor mention rate, source distribution, trend and share of voice are computed
by `packages/shared/src/metrics` from the filtered observation set, and the response always includes the
composition (providers, countries, languages, prompts, period). Mixing providers requires an explicit choice and
produces a visible note. Formulas are in `docs/metrics.md`.

### D-012 · Billing abstraction with a development mode

`BillingProvider` adapters exist for Stripe and Razorpay. Neither is required: without credentials,
`BILLING_PROVIDER=dev` lets an owner switch plans locally. The UI shows a persistent "Development billing — no
payment is processed" banner, and no invoices are fabricated. Webhooks are verified by signature and stored in
`webhook_events` for idempotency.

### D-013 · PDF rendering through headless Chromium

Reports are rendered to HTML (escaped, no scripts, inline CSS) and printed to PDF with Playwright Chromium
(JavaScript disabled, network blocked). Chromium handles all scripts and languages, unlike PDFKit's standard
fonts. If Chromium is unavailable, the report is still `READY` with `pdfStatus=UNAVAILABLE`, and the UI says so.

### D-014 · Email in development

`EMAIL_PROVIDER=console` writes each message to `var/mail/*.eml` and records `LOGGED_LOCALLY`. It never records
`SENT`. SMTP (nodemailer) is the production provider.

### D-015 · Usage periods

Plan usage is metered per UTC calendar month (`periodKey = YYYY-MM`) with idempotent usage records. The
calendar month is simpler and more predictable than a billing-anchor period, at the cost of not aligning with
mid-month subscription starts.

### D-016 · Local Redis on Windows

Docker is not installed on the development machine. A checksum-verified portable Redis 8.10.2 build was placed in
`.tools/redis` (gitignored) and bound to `127.0.0.1`. `docker-compose.yml` is still provided for other machines.

### D-017 · IDs and enumeration

CUIDs are not sequential, which adds defence in depth against id probing. The real control is the workspace-scoped
authorization check. Cross-tenant ids return `404`, not `403`, so their existence is not disclosed.

### D-018 · Prerendering with React's server renderer instead of a framework

Marketing and auth routes are rendered at build time with `renderToString` and `StaticRouter`
(`apps/web/scripts/prerender.ts`) and hydrated in the browser; the dashboard is a client-side app behind the
same router. This keeps one React app, one router and one design system, and gives crawlers complete HTML with
per-route metadata. A meta-framework (Next.js, React Router framework mode) would add a server runtime that
the product does not otherwise need. Pages whose output depends on the URL query or fragment read it after
hydration, so the prerendered HTML and the first client render always match.

### D-019 · Chart colors from a validated palette

Chart colors come from a documented categorical palette in a fixed order, validated with the dataviz skill's
validator on the dashboard's white surface. Colors are bound to entities: the brand is always slot 1, and
competitors take their project order. Brand-versus-competitor charts use the emphasis form (accent versus gray).
Every chart has a legend for two or more series and a table view, because three slots are below 3:1 contrast.
No chart has two y-axes.

### D-020 · Scheduled work claims items before running them

Scheduled audits, scheduled AI checks and daily syncs advance each item's next-run time with a conditional
update before doing any work. Overlapping ticks, or several workers, therefore cannot start the same item twice.
A failure waits for the next period instead of retrying every tick. Plan features, frequencies, provider
configuration and quotas are re-checked when the work runs, not when it was scheduled.

### D-021 · Admin job retries are limited to self-resetting jobs

Admins can retry failed report, Search Console sync, competitor snapshot and email jobs. These jobs reset their
own entity at the start of each attempt, so BullMQ's `job.retry` with a fresh attempt budget is safe.
Crawls, audits, visibility runs and content generation are started again from the product instead, so that plan
limits and the "one active crawl per project" rule are enforced again.

### D-022 · Account deletion keeps shared data and payments safe

After the 14-day grace period, the account and its solo workspaces are deleted, including report files and
email-delivery records. Shared workspaces keep their data. Deletion is deferred, and the user told, while they
are the sole owner of a shared workspace or a workspace still has an active paid subscription. Cancelling at the
payment provider must remain a deliberate action.

### D-023 · Optional single-origin serving and a production build script

`SERVE_WEB_DIST=true` lets the API serve the built web app, so a small deployment needs one origin: first-party
cookies and a simple CSRF origin check. The web build runs through `apps/web/scripts/build.ts`, which sets
`NODE_ENV=production` before calling Vite. The shared root `.env` sets `NODE_ENV=development` for the API, and
Vite honours `.env` values, which had produced a development React build.

### D-035 · Audits crawl every page by default

(D-024 to D-034 are in [extension-plan.md](extension-plan.md).) A project audit crawls every page reachable
through internal links and sitemaps. The plan's `pagesPerAudit`, the project's page and depth settings and
`CRAWLER_MAX_PAGES_HARD_LIMIT` are optional caps; `null` (or `0` for the server setting) means no cap, and the
smallest cap that is set applies. Migration `20261022180000_crawl_all_pages` clears only the old built-in
defaults, so caps someone chose on purpose stay.

These safeguards stay:

- robots.txt is respected;
- crawlers never log in;
- the per-host delay is unchanged;
- the anonymous free audit keeps its 20-page cap;
- loop protection follows at most 100 query-string variants of one path and skips URLs longer than 2,048
  characters. Both are counted and reported as audit limitations.

Uncapped crawls made three scale changes necessary:

- the crawl queue is a constant-time FIFO;
- the stored crawl is loaded in batches, with shared link objects;
- the duplicate checks no longer sample the first 1,500 pages. They use indexed matching that equals the
  all-pairs comparison (verified against it in tests).

On a synthetic site of 20,000 pages and 1.2 million links, analysis took 1.4 s and about 170 MB of heap. The
audit queue's job lock is 5 minutes, so a long synchronous analysis is not mistaken for a stalled job.

### D-036 · Competitor gaps are explained only with verifiable evidence

The visibility charts show how often tracked brands are named, but not why other brands win or which brands
answers really recommend. A **competitor gap analysis** (a job on the competitor queue, stored in
`visibility_gap_analyses`) answers both questions. The rule is that every statement must be traceable:

- Brands come from stored mention matching, from cited websites the answer names, or from AI extraction. Each
  extracted name and each quoted reason must appear word for word in the stored answer; otherwise it is dropped.
  The extraction prompt asks only for names in the text, and the validation enforces it.
- "On your site" is labeled as a keyword check, not as proof of a feature.
- Third-party pages are checked live with the safe fetcher, and robots.txt is obeyed. A blocked page is reported as
  "open it yourself", never fetched another way.
- Actions come from fixed rules over that evidence, each with its "why". They never claim an outcome, and they
  never suggest fake reviews, undisclosed paid placements, fake accounts or mass posting.
- Demo answers are excluded.
- Starting an analysis needs `competitor.snapshot` and the plan's competitor analysis feature. Only one analysis
  runs at a time, at most 10 a day per project. Provider calls are recorded as provider usage, each run separately.

### D-037 · SEO comparison uses the same sample for every site

The **SEO comparison** (`core/competitors/seo-compare.ts`, a job on the competitor queue, table `seo_comparisons`)
crawls the project's site and up to five competitors with the same crawler and the same page budget. The budget is
`COMPETITOR_CRAWL_MAX_PAGES`, default 250. Each crawl starts at the homepage, follows links first and then sitemap
URLs, respects robots.txt, and stops after 4 minutes. Every site is then checked with the same audit rules.

- **Why a sample.** Competitor sites can have millions of pages, so crawling them completely would be slow and
  impolite. Comparing your whole site with a competitor's first pages would also be unfair. Percentages over equal
  samples compare like with like; the project's own full audit still covers every page.
- **Only observed differences.** "Behind" means a clear gap against the competitors' median: 5 points for
  percentages, 15% for word and link counts, 20% for response times. Rankings, traffic, backlinks and Core Web
  Vitals are listed as not compared, because they need licensed data or the PageSpeed API. Nothing is estimated.
- **Suggestions.** These cover every rule your pages fail, with the competitors' rates for the same rule, plus the
  checks where you are behind that no rule covers. Problems competitors share at the same rate rank lower. Each
  competitor counts as one competitor snapshot against the monthly quota.
- **No promised outcome.** The page states that fixing issues does not guarantee rankings.

### D-038 · Search trends come only from licensed or user-exported Google Trends data

Google has no generally available Trends API (its official API is an invitation-only alpha), and automated access
to trends.google.com conflicts with Google's terms. The **Search trends** module (`core/trends`, table
`trend_reports`, a `trend_report` job on the content queue) therefore takes data from two sources:

- **DataForSEO's Google Trends endpoint.** This is a licensed provider: live data, paid per request, enabled by
  `DATAFORSEO_LOGIN` and `DATAFORSEO_PASSWORD`. It makes one interest-over-time request for up to five terms and
  one related-queries request per term. The requests are recorded as provider usage.
- **CSV files the user exports from trends.google.com** ("Interest over time", "Related queries"). The app builds
  the matching Google Trends link, and the parser returns nothing rather than guessing when a layout is unknown.

Every report is a dated observation that names its source and links to the same comparison on Google Trends.
Values are relative interest (100 = peak), never search volumes.

The comparison with the site uses the latest crawl. A term counts as **targeted** only when it appears as a
phrase (at most one extra word in between) in a page's title, main heading or address. Terms only in sub-headings
or descriptions, or whose words are scattered, are **not targeted**. Body text is not stored, and the report says
so.

AI placement suggestions may name only candidate pages from the crawl and only headings that exist on those
pages. Anything else is dropped and counted in the notes. The suggested wording uses placeholders instead of
invented facts and is labeled for review. Each report counts as one AI keyword run against the monthly quota; at
most 20 reports a day per project, one at a time.

Bulk prompt entry (`POST /projects/:id/prompts/bulk`) adds up to 100 prompts with one set of settings. It skips,
and reports, lines that are too short, repeated, or already tracked for the same country and language. The plan's
prompt limit applies to the whole batch. Keywords can be turned into questions with fixed templates before adding;
the preview can be edited.

### D-039 · Keyword trends: one provider per report, pytrends only as an opt-in experiment

Extends D-038. **Keyword trends** (formerly Search trends) now has a provider registry (`core/trends/providers.ts`)
with five sources. The `TRENDS_PROVIDERS` setting turns each on or off, and the UI follows the status endpoint, so
no UI change is needed:

- CSV import is always free. It now reads all four Google Trends exports and shows a preview before saving.
- **pytrends**, added at the product owner's request, is a separate Python service (`services/pytrends`).
- DataForSEO (paid).
- The official Google Trends API alpha, reported as unavailable: its request format is not public, so it is not
  implemented.
- A labeled development fixture, refused in production.

Search Console figures appear next to Trends but are a different measure and are never combined with it.

**pytrends.** D-038 avoided automated access to trends.google.com. pytrends is unofficial and archived (April 2025),
and Google's terms restrict automated access. It is therefore opt-in: nothing runs until an operator starts the
service and sets `PYTRENDS_SERVICE_URL`. It is labeled experimental everywhere and is deliberately conservative:

- robots.txt is checked, and requests stop if it disallows them;
- one request at a time, spaced 8 s apart;
- a 15-minute pause after any 429;
- no proxies, identity rotation, retries or CAPTCHA handling;
- explicit errors, and missing data is listed as a limitation (the report is then "partial"), never filled in.

**Data.** Reports store their data in normalized tables (`trend_observations`, `trend_regional_interest`,
`trend_related_items`) with source, retrieval time, expiry, partial flag and limitations; reports created before
this change keep their JSON data and still load. Identical requests (same source, terms, place, period, category,
data types) reuse unexpired data by copying rows, keeping the original retrieval time; another tenant's report is
never exposed. Cache lifetimes are configurable by provider and data type. Live lookups are limited per workspace
per day; cache hits and imports do not count. Reports run on a dedicated `trends` queue; saved comparisons can
refresh weekly or monthly without AI suggestions (so without AI quota).

**Opportunity scores** (Keyword research → Opportunities) rank keywords from trend direction, Search Console
demand, provider volume and difficulty, relevance and the site's coverage. A score uses only the signals the keyword
has, lists the missing ones, and never estimates volume or competition. The newest trends report that mentions a
keyword supplies its trend signal, so values from different providers are never mixed.

**Term grouping.** The site comparison now treats only word order, filler words and plurals as the same search.
Before, stopword stripping merged "free wedding invitation" and "how to make wedding invitation" into "wedding
invitation", although they are different searches.

### D-040 · Local SEO: the website is optional, and local rankings come only from measurements

Request: the OptiReach local SEO, Maps, Merchant Center and AI search specification (plan and status in
[local-seo-plan.md](local-seo-plan.md)). It extends the existing product instead of rebuilding it.

- **Website optional.** `projects.websiteUrl` and `domain` are nullable. Website features (audits, crawls, SEO
  comparison, gap analysis) call `requireWebsite` and answer 400 "… needs a website …"; everything local works from
  the business name, profile and locations.
- **Locations** are their own table (`business_locations`): storefront, service area or both, with coordinates,
  categories and hours. They count against the plan's `businessLocations` limit and are archived, never deleted.
- **Rank grids.** Google has no API for Maps or local-pack rankings, so a grid point comes from one of: a licensed
  provider (DataForSEO, opt-in with `SERP_PROVIDER=dataforseo`, one `LOCAL_RANK_POINT` of quota per point), a
  manual observation (labeled manual everywhere and never shown as a live ranking), or a development fixture
  (refused in production). No scraping of Google, no CAPTCHA handling.
- **Grid visibility** is the share of measured points where the business is in the top 3. Failed and unmeasured
  points are left out of the denominator and the coverage is shown next to it. Surfaces (Maps, local pack, organic)
  are never merged into one number.
- **Local competitors** are suggested from the businesses listed in scans and become competitors only when a user
  confirms them.

### D-041 · Google Business Profile: 30-day storage, approval before every reply

- **Storage.** Google's policy allows Business Profile content to be stored for at most 30 days and not aggregated.
  Surfaced stores only the latest sync (profile, 56 days of daily metrics, the 200 newest reviews), replaces it at
  each sync and deletes anything fetched more than 30 days ago. Unlinking, archiving the location or disconnecting
  deletes it at once. Averages and totals are shown as Google reports them, not computed. Surfaced keeps its own
  records (links, reply drafts, approvals, audit results computed on request).
- **Linking** stores the profile's resource name, account and place ID. Creating a location from a profile copies
  the details once, at the user's request, as the business's own record.
- **Replies.** A reply is published only through `publish`, which needs `local.publish` (owners and admins) and an
  approved approval request whose snapshot hash matches the current text. Editing withdraws the pending approval.
  The snapshot holds the reply and its target, not the review text. AI drafts use the configured model, count as one
  content generation and are labeled; the development adapter is labeled as a template.
- **Errors.** Google's refusals (for example quota 0 before the project is approved) are returned as 502
  `UPSTREAM_ERROR` with Google's reason instead of a generic error, and a failing location does not stop the sync of
  the others (status `PARTIAL`).
- **No indirect access.** Business Profile data is served only to the business's own signed-in users; there is no
  public API.
- **Not built yet:** profile edits, attributes, local posts, keyword impressions and reply deletion (each will need
  its own approval type), and Google's Pub/Sub notifications.

### D-042 · Products: Surfaced's checks next to Google's decisions, read-only towards Merchant Center

- **Two sources, one table.** Products come from an imported feed file (Google's CSV/TSV format or a Shopify export)
  or from the connected Merchant Center account (Merchant API v1). Both are stored in `merchant_products` with their
  source; a product present in both counts once against `productsTracked`.
- **Checks are labeled predictions.** Surfaced checks the data against Google's product data specification and names
  the programs each issue affects (free listings, Shopping ads, free local listings) and, where rules differ, the
  country (for example colour, gender and age group are required for apparel only in BR, FR, DE, JP, GB and US).
  Google's own item issues are kept separately and labeled "Reported by Google". No single "approved" number merges
  programs or sources.
- **No website.** Products without a landing page are marked as blocked for online listings only; the checklist
  explains the local listings path instead of failing the business.
- **Read-only.** Surfaced never writes to Merchant Center. Changing product data later will go through a supplemental
  API data source and an approval of the exact change set (`PRODUCT_CHANGE_SET`), like review replies.
- **Large files.** Feeds are uploaded as JSON text with a 25 MB limit on the import paths only (20 MB, 50,000 rows),
  checked in a preview before anything is saved, and imported in one transaction in 500-row chunks.

### D-043 · AI search: one surface per card line, and every answer says how it was captured

- **Capture method on every observation** (`captureMethod`: API, LICENSED_PROVIDER, MANUAL, DEMO) with its
  `limitations` (location applied or not, approximation of the consumer product). Existing demo rows were migrated
  to DEMO; all others are API.
- **Surfaces are never merged.** Manual observations are stored per surface (`manual_google_ai_mode`,
  `manual_google_ai_overview`, `manual_chatgpt`…), so AI Mode and AI Overviews, and an API answer and what a person
  saw in the app, are separate sources. Dashboard cards show one line per source with mention and citation rates;
  the headline names its source.
- **Locality.** A prompt may have a city. It is passed only where a provider supports it (OpenAI's approximate user
  location; AI Mode coordinates of a business location in that city) and otherwise stated as a limitation.
- **Gemini without grounding only.** Google's terms forbid storing and analyzing grounded results, so the Gemini
  adapter never sends grounding tools; its answers are labeled "model knowledge", not the Gemini app.
- **Google AI Mode through a licensed provider is opt-in** (`SERP_PROVIDER=dataforseo`) and labeled as licensed data;
  a SERP without an AI answer is an error ("no AI Mode answer"), not a "not mentioned" result.
- **Manual entries are free** (no visibility-check quota), require `prompt.manage`, and record who entered them.
