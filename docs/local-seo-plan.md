# Local SEO, Maps, Merchant Center and AI search visibility: audit and plan

Request: the "OptiReach — Complete Local SEO, Google Maps, Merchant Center & AI Search Visibility Module"
specification (2026-10-23). The product is called Surfaced in code (`APP_NAME`); OptiReach is the same codebase.
This page is the audit, the plan and the status checklist; the work log is in [progress.md](progress.md).

## Audit (2026-10-23, before this module)

Baseline before any change: `npm run typecheck` 0, `eslint .` 0, `npm test` 48 files / 420+ tests passed.

| Capability                         | Status before                    | What exists                                                                                                                                                                                                          |
| ---------------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Onboarding                         | Partial                          | Project wizard (name, website, countries, languages, competitors, keywords). **Website is required** (`projects.websiteUrl`/`domain` NOT NULL). No business type, location, hours                                    |
| Business locations, multi-location | Missing (placeholders)           | Plan limit `businessLocations`; approval labels LOCATION_CHANGE, LOCAL_POST, REVIEW_REPLY; no model, routes or pages                                                                                                 |
| Google Business Profile            | Missing (placeholders)           | OAuth scope `business.manage` in `GOOGLE_PROVIDERS`; not in the integration catalog, so connect returns 404                                                                                                          |
| Local rank tracking and grid       | Missing                          | Plan limit `localRankPointsPerMonth`, usage metric `LOCAL_RANK_POINT`; no provider, model or map                                                                                                                     |
| Organic rank tracking              | Missing                          | Plan limits only                                                                                                                                                                                                     |
| Local competitors                  | Missing                          | Website competitors only (`project_competitors`: name, domain); gap analysis and SEO comparison are real                                                                                                             |
| Merchant Center, products, feeds   | Missing (placeholders)           | OAuth scope `content`; plan keys `ecommerce`, `productsTracked`                                                                                                                                                      |
| AI visibility                      | Partial                          | OpenAI web search (verified live), OpenAI model knowledge, Perplexity (not verified), demo. Country only (no city), no capture method or limitations, no manual observations, no Gemini, no Google AI Mode/Overviews |
| Citations and brand mentions       | Missing                          | AI-answer citations and mentions only                                                                                                                                                                                |
| Reviews                            | Missing                          | —                                                                                                                                                                                                                    |
| Recommendations / action center    | Partial                          | Recommendations with evidence and benefit; statuses OPEN, IN_PROGRESS, AWAITING_APPROVAL, COMPLETED, DISMISSED (no PLANNED, VERIFIED, BLOCKED), no effort, due date or recheck                                       |
| Tasks, approvals, agency           | Implemented                      | Tasks with time, approval requests with snapshot hash (no production caller yet), agency client workspaces                                                                                                           |
| Reports                            | Partial                          | HTML/PDF reports from stored data; no local, rank or merchant sections; no scheduled reports                                                                                                                         |
| Alerts                             | Missing                          | Domain events are written; no consumer, no alert rules                                                                                                                                                               |
| Usage and plan limits              | Implemented for existing metrics | Limits for the new dimensions exist but are not enforced                                                                                                                                                             |
| Google OAuth                       | Implemented (Search Console)     | PKCE, hashed single-use state, AES-GCM tokens, refresh and revoke; reusable for Business Profile and Merchant API                                                                                                    |
| Maps                               | Missing                          | No map library                                                                                                                                                                                                       |

**Blocked by external access** (cannot be verified live from this environment):

- Google Business Profile API: needs an approved Cloud project (default quota 0) and an OAuth client.
- Google Merchant API: needs an OAuth client, app verification and one-time developer registration.
- Maps / local pack / AI Mode / AI Overviews: Google has no API; needs a licensed SERP provider (DataForSEO) with
  credentials, or manual observations.
- Gemini: needs `GEMINI_API_KEY` (and only ungrounded answers may be stored, see
  [providers/ai-and-serp-providers.md](providers/ai-and-serp-providers.md)).

## Principles

- Every number comes from a stored observation with its source, capture method (API, licensed provider, manual,
  import, fixture), capture time and limitations. Manual entries are labeled manual and never shown as live
  rankings. The development fixture is refused in production.
- Surfaces are never merged: Maps, local pack, organic, Shopping and each AI system have their own metrics.
- Missing data is shown as "Connect account", "Data unavailable" or "Measurement unsupported" and is left out of
  scores (with coverage shown), never counted as zero.
- No guaranteed outcomes; correlations are described as such.
- Official APIs or licensed providers only. No CAPTCHA bypass, no scraping of Google, no private competitor data.

## Plan and status

Legend: ☐ to do, ◐ in progress, ☑ done (with tests).

### Phase 1 — Foundations (done 2026-10-23, D-040)

- ☑ Optional website: `projects.websiteUrl`/`domain` nullable; audits, crawls and website features show
  "no website" states.
- ☑ Business profile on the project (`projects.businessProfile`): types, presence, categories, services, products,
  localities, socials, directories, goals.
- ☑ `business_locations` (multi-location, manual or Business Profile source), CRUD API with plan limit, Locations
  page.
- ☑ Onboarding wizard: business type → details → location → online presence (website optional) → targets → plan.
- ☑ Local Search & AI Visibility dashboard: one card per surface with value, previous period, change, date range,
  place, provider, last collection, freshness and limitations; "connect / unavailable / unsupported" states.

### Phase 2 — Local ranking (done 2026-10-23, D-040)

- ☑ Tracked local queries with grid configuration (size, spacing, depth, device, language, surface, frequency).
- ◐ Providers: DataForSEO Maps and local pack (licensed, optional), Google Custom Search for the organic surface
  (free, official, 100/day), manual observations and fixture are done. CSV import of rank observations is not built
  yet (the `IMPORT` source exists).
- ☑ Scans and points (idempotent per scan and point, quota per point, failed points excluded), `local` queue,
  scheduled scans.
- ☑ Rank Tracker page: Leaflet map with grid markers, point details, grid visibility (top-3 share of measured
  points, coverage), history, CSV export.
- ☑ Local competitors discovered from scans (suggested → confirmed), comparison table, gap findings.

### Phase 3 — Google Business Profile (done 2026-10-24, D-041; not verified live)

- ☑ Catalog entry and OAuth connection (reuse), accounts and locations, link to business locations.
- ☑ Profile audit (applicable fields only), metrics (30-day retention), reviews, AI-drafted replies published
  only after approval. Dashboard cards use Google's numbers when a profile is linked.
- ☐ Later: profile edits and local posts (each with its own approval), attributes, keyword impressions.
- Live verification needs an OAuth client and Google's approval of API access (quota 0 until then).

### Phase 4 — Merchant Center (done 2026-10-24, D-042; not verified live)

- ☑ Product catalog: Merchant API sync (read-only adapter) and CSV/TSV feed import (Google format and Shopify
  exports), with preview, replace or merge, and the plan's product limit.
- ☑ Country- and program-aware validation, diagnostics, eligibility checklist (including no-website merchants);
  dashboard cards for Merchant Center and product health.
- ☐ Later: Merchant Center performance (MCQL reports), product changes through a supplemental data source with
  approval, local inventory.

### Phase 5 — AI search (done 2026-10-24, D-043; providers not verified live)

- ☑ Prompt locality (city), capture method and limitations on observations, manual observation capture for any AI
  surface (AI Mode, AI Overviews, ChatGPT, Gemini app, …).
- ☑ Gemini (ungrounded) and Google AI Mode through the licensed provider (opt-in); mention and citation rates per
  source on the dashboard.
- ☐ Later: AI Overviews through the licensed organic SERP (`load_async_ai_overview`), Search Console's generative AI
  report import.

### Phase 6 — Optimization and execution

- ☐ Citations and NAP consistency, brand mention types, review intelligence.
- ☐ Action center: statuses PLANNED, VERIFIED, BLOCKED; effort, owner, due date, recheck; local recommendation
  engine with evidence and verification method.

### Phase 7 — Reporting and operations

- ☐ Scheduled reports with local sections, alert rules with confirmation and cooldown, usage and provider cost
  monitoring.
