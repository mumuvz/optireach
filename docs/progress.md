# Progress log

Newest entries first. Every test claim below corresponds to a command that was actually executed.

## 2026-10-24 — Free Google rank data: Google Custom Search (organic), and website-only pages gated

Request: a free alternative to paid DataForSEO for rank tracking, and "real Google data". Also reported: the
Competitor gaps page offered a "Run analysis" button that only errored for a business with no website.

**Honest outcome first.** No free, permitted source gives Google **Maps local-pack** rankings — Google has no API
for it and scraping Google breaks its terms and risks the business's own account. The only free way to get real
**Google** data is Google's own **Custom Search JSON API**, which returns **organic** web results. So this adds an
organic rank source, clearly labelled, never presented as Maps.

**Google Programmable Search provider** (`core/local/rank-providers.ts`, built in TypeScript — it's a JSON API, so
the Python service the request sketched would have been unnecessary infrastructure):

- Source `GOOGLE_CSE`, **ORGANIC surface only**; a MAPS/LOCAL_PACK scan returns an explicit "unsupported" error,
  never a fabricated local-pack rank.
- Enabled by `GOOGLE_CSE_API_KEY` + `GOOGLE_CSE_CX` (free key + engine ID). Free up to 100 searches/day; one page
  of up to 10 results.
- Country-level only (`gl`), not per coordinate: a scan makes **one** request reused for every grid point, so
  organic queries are forced to a 1×1 grid in the UI, and the limitation is stated on every scan.
- Organic web pages are not local businesses, so organic scans don't create competitor suggestions. It's free, so
  no grid-point quota is charged.
- The rank tracker shows the Google source only for organic queries, and the Track dialog adds the ORGANIC surface
  with an inline explanation.

**Website-only pages gated.** Competitor gaps, SEO comparison and Website audit now show a clear "needs a website"
state (with a link to add one) instead of a button that errors, for businesses with no website. Project settings
lets a no-website business **add** a website (the field was previously read-only); the backend already supported it.

**Verification (executed):**

- `npm run typecheck` exit 0 and `eslint` exit 0;
- new tests: Google Custom Search 10 (parse, domain match, not_found, Maps unsupported, daily-limit/timeout, one
  request per scan, organic scan stores a national position with the organic label and no competitors), plus a
  gap-analysis web test for the no-website state. Existing DataForSEO, manual and fixture providers still pass.
- Not verified live (no key); all requests tested with a fake Google.

## 2026-10-24 — Local dashboard: setup steps, health score, filling a location from a Google link

Reported with screenshots: every card on Local visibility said "connect" or "no data", with no hint of where to start,
and the location looked "already added" while its map position was empty.

- **Get started steps** on Local visibility, in order, each with its status, the cards it fills and a button:
  1. map position;
  2. shop details;
  3. first grid scan (the text matches the configured source: licensed provider, development fixture or manual);
  4. AI prompt;
  5. Google AI Mode by hand;
  6. product feed (businesses that sell products);
  7. Business Profile (marked "needs administrator setup" without an OAuth client);
  8. website (optional).
- **Local SEO health score** (`core/local/health.ts`). It is built from what the business controls:
  - profile completeness (40): from the live profile, or from the entered details;
  - review replies (20);
  - listing consistency (25): not tracked yet;
  - product data (15).

  Parts without data are left out, and the others are re-weighted. Maps and AI visibility stay on their own cards.

- **Fill from a Google link** (`core/local/google-place.ts`, `POST /workspaces/:id/places/from-google-link`):
  - **Link resolution.** share.google, maps.app.goo.gl and Google Maps or Search links are resolved from redirect
    headers only, on Google hosts only; Google pages are never fetched or parsed. The final URL gives the name,
    sometimes the coordinates and the place ID.
  - **Places API (optional).** With `GOOGLE_MAPS_API_KEY`, the official Places API (New) fills the address,
    locality, city, postcode, phone, opening hours, category, website, position and place ID. The user checks the
    values before saving.
  - **Place ID.** It is now kept on locations, which helps match the business in rank results.
- **Find from address** (`core/local/geocode.ts`, `POST /workspaces/:id/places/geocode`):
  - **Lookup.** OpenStreetMap Nominatim, one request per second, cached for 24 hours, with an identifying User-Agent
    and attribution. If the full address is not found, it falls back to the postal code, then the locality, and labels
    the result "approximate".
  - **Pin.** A draggable map pin confirms the position, and pasting a Google Maps link into Coordinates reads its
    coordinates.
  - **Settings.** `GEOCODER=none` turns the lookup off; tests use none.
- **Clearer wording** on the location card and the setup step: the location exists, only its map position is
  missing.

**Verification (executed):**

- `npm run typecheck` exit 0 and `eslint` exit 0;
- `npm test`: 62 files, 499 tests passed. New: places 6, location lookup 3, plus the setup steps in the local web
  test;
- live check on the reported project: the link gave the name only (no Places key is configured); the address lookup
  fell back to the postal code area, because the location's postal code (394101) differs from the one in its street
  address (395013).

## 2026-10-24 — Local SEO phase 4: Merchant Center and product feeds

Plan status in [local-seo-plan.md](local-seo-plan.md); decision D-042. Migration
`20261024120000_merchant_products` (additive: `merchant_products`, `product_feed_imports`).

**Product catalog** (`core/commerce`):

- **Feed files.** Google's CSV or TSV format (attribute names as headers, quoted multi-line fields) and Shopify
  product exports, where variants inherit the product's fields and the compare-at price becomes the regular price.
- **Preview first.** It shows the format, the columns read and ignored, skipped rows and the checks on the first
  products, before anything is saved.
- **Import** replaces or merges the catalog for one country and language, in one transaction with 500-row chunks,
  within the plan's `productsTracked`. Products beyond the limit are reported, not imported. The two import paths
  accept 25 MB requests; the global limit stays 1 MB.
- **Merchant Center (read-only).** Account choice, homepage claim, account issues, free listings program, shipping
  and return policies, and products with destination statuses and Google's item issues. Products deleted in
  Merchant Center are removed after a complete sync. Field names were checked against the Merchant API v1
  discovery documents (revision 20261021). Merchant Center is on the `integration-sync` queue (daily and on demand).

**Checks** (`validate.ts`):

- each check names the programs it affects (free listings, Shopping ads, free local listings) and, where rules
  differ, the country;
- covered: required attributes and lengths, currency per country, sale price, availability and condition values,
  GTIN check digits, brand and identifiers, landing page domain, images;
- apparel attributes are required only in BR, FR, DE, JP, GB and US;
- counterfeit wording is an error; "imitation" gets a gentle suggestion for Indian fashion jewellery;
- Google's issues are labeled "Reported by Google"; Surfaced's are labeled as checks.

**Checklist and screens.**

- The eligibility checklist covers the account, website claim, products, blocking errors, free listings, shipping
  and returns, account issues, Product structured data from the latest crawl, and Business Profile for local
  listings. Without a website, the website item does not apply and the local listings path is explained.
- New page **Local → Merchant Center**: checklist, connection and account, feed import with preview, and products
  with filters, search, pagination and issues per product.
- The Integrations page has a Merchant Center card.
- Dashboard cards for Merchant Center and product health.
- Usage shows tracked products; a product in both a feed and Merchant Center counts once.

**Verification (executed):**

- `npm run typecheck` exit 0 and `eslint .` exit 0;
- `npm test`: 57 files, 478 tests passed. New: core commerce 12, API merchant 5, web merchant 3;
- migration applied, and the schema diff afterwards is empty;
- `npm run test:e2e` (with Redis): 4 passed.

Merchant Center was **not verified against Google** (no OAuth client, app verification or developer registration);
all Merchant API requests are tested with a fake Google, and the tests check that every call is a GET.

## 2026-10-24 — Local SEO phases 1–3: foundations, rank grids, Google Business Profile

Request: the OptiReach "Complete Local SEO, Google Maps, Merchant Center & AI Search Visibility Module" specification.
Audit, plan and status: [local-seo-plan.md](local-seo-plan.md); decisions D-040 and D-041 in
[decisions.md](decisions.md). Phases 4–7 (Merchant Center, AI search, optimization, reporting) are not done yet.

**Phase 1 — foundations** (migration `20261023210000_local_seo_foundation`):

- the website is optional; website features answer "… needs a website …" instead of failing;
- business profile on the project (types, Business Profile presence, categories, services, products, localities,
  socials, directories, goals) and `business_locations` with a plan limit;
- onboarding wizard: business → type and presence → location → markets and targets → plan;
- Local Search & AI Visibility dashboard: one card per surface, each with value, previous period, place, source,
  freshness and limitations, or a "connect / unavailable / unsupported" state.

**Phase 2 — local rank grids:**

- tracked queries on 1×1 to 9×9 grids, on the `local` queue with schedules;
- points from DataForSEO (opt-in, `SERP_PROVIDER=dataforseo`), manual observations (labeled) or a development
  fixture (refused in production);
- grid visibility over measured points only, with coverage shown;
- Rank Tracker page with a map, a point table, history and CSV export;
- local competitors suggested from scans, confirmed by a user.
- Not done: CSV import of rank observations.

**Phase 3 — Google Business Profile** (migration `20261024100000_business_profile`, additive):

- **Connection.** Catalog entry "implemented", using the same OAuth client and the `business.manage` scope. The
  callback lands on the new **Local → Business Profile** page.
- **Linking.** Accounts and locations are read live and linked to business locations, or a location is created from
  a profile.
- **Sync** runs daily and on demand: the profile, 56 days of the 10 non-deprecated daily metrics, and up to 200
  reviews per location. One failing location does not stop the others (status `PARTIAL`).
- **30-day storage.** Data is deleted 30 days after fetching (hourly cleanup), and at once on unlink, archive or
  disconnect.
- **Profile audit** with evidence, fix, how to verify and Google's guideline link for each check. Only checks that
  apply count (no website: the website check is not counted). Without a connection it audits the entered details
  and says so.
- **Review replies:**
  - a person writes the reply, or the AI model drafts it (one content generation; the development adapter is
    labeled as a template);
  - an approver approves the exact text, then an owner or admin publishes it;
  - editing withdraws the pending approval, and the approval snapshot excludes the review text.
- **Dashboard.** The Business Profile and review cards show Google's own numbers once a profile is linked.
- **Errors.** Google's refusals (for example quota 0 before API approval) are returned as 502 `UPSTREAM_ERROR`
  with Google's reason.
- **Endpoints.** The generic integration routes are provider-aware: sync works for Business Profile, and the
  property selection is Search Console only.

**Bug fixed on the way.** Clicking **Next** on the step before the review submitted the onboarding form, so the
project was created without the review step being shown. The cause was React reusing one button element and
switching it to `type="submit"` during the click. The Next and Create buttons now have distinct keys. Found by the
e2e journey; a check was also added to the wizard's unit test.

Also: `test/setup-env.ts` pins `SERP_PROVIDER=none` and `LOCAL_RANK_FIXTURES=false`. The e2e journey was updated
for the new wizard (heading, and a Website textbox locator that no longer also matches "This business has no
website").

**Verification (executed):**

- `npm run typecheck` exit 0 and `eslint .` exit 0;
- `npm test`: 54 files, 458 tests passed. New: core Business Profile 7, API Business Profile 6, web Business
  Profile 3;
- migrations applied to the development database, and the schema diff afterwards is empty;
- `npm run test:e2e` (with Redis): 4 passed, including the full journey through the new wizard.

Business Profile was **not verified against Google**: there is no OAuth client and no approved API access. The
client was built against the live discovery documents (Business Information, Performance, Account Management,
revision 20261021, and the published v4 reviews document), and every request is tested with a fake Google.

## 2026-10-23 — Keyword trends: "Fetch live data" stayed disabled (fixed)

Reported with a screenshot: the button was disabled and the Category box offered no entries.

- **Cause:** three pytrends service copies were listening on port 4410. Two were leftovers from development test
  runs, started with a test token. On Windows, Python's default `SO_REUSEADDR` let them share the port, so the app's
  health check reached a copy that answered "wrong service token", and pytrends counted as unavailable. The two
  leftovers were stopped; the user's own copy was kept.
- **Fixes:**
  - the service now binds its port exclusively on Windows; a second copy exits with "Port 4410 is already in use"
    (checked on a spare port);
  - when a configured source fails its health check, the page shows the reason and a **Check again** button;
  - provider health is cached for 10 s instead of 30 s;
  - **Category** is now a searchable list (top-level categories on focus, matches while typing, keyboard support).
    The browser's datalist only matched the text already in the box, so it looked empty;
  - the misaligned Data source dropdown is fixed;
  - a troubleshooting table was added to [providers/keyword-trends.md](providers/keyword-trends.md).
- **Verification (executed):** `npm run typecheck` exit 0, `eslint .` exit 0, the four trends test files (48 tests,
  2 of them new web tests) and `npm run trends:test` (8) passed. With the app's settings, the provider status
  reports pytrends configured, healthy and the default source.

## 2026-10-23 — Keyword trends: providers (pytrends), normalized data, scoring and content planning

Request: the "Keyword Trends" specification (dashboard, provider architecture, normalized data, opportunity scoring,
caching, queues, endpoints, UI, tests), using the free pytrends library. Decision D-039 in
[decisions.md](decisions.md); full provider guide in [providers/keyword-trends.md](providers/keyword-trends.md).

**Built on the existing module** (Search trends → **Keyword trends**, same page and tables, extended):

- **Providers** (`core/trends/providers.ts`): one source per report, chosen by `provider` or automatically
  (official, then free, then paid). `TRENDS_PROVIDERS` turns sources on or off; the UI follows the status endpoint.
  - **CSV import**: now all four Google Trends exports (interest over time, by subregion/city, related queries,
    related topics), with a preview in the browser and at `POST …/trends/import/preview` before saving. Each file
    is recorded in `trend_csv_imports`.
  - **pytrends**: a separate Python service (`services/pytrends`, `pytrends==4.9.2`; `npm run trends:setup`,
    `trends:start`, `trends:test`). Safeguards:
    - it checks robots.txt and makes one request every 8 s;
    - after a 429 it pauses 15 minutes, with no proxies, retries or CAPTCHA handling;
    - it requires a token beyond localhost;
    - it gets only `PYTRENDS_*` and OS variables, never the app's other secrets.
      Off until `PYTRENDS_SERVICE_URL` is set.
  - **DataForSEO**: extended with the regional map and related topics.
  - **Official Google Trends API alpha**: reported as unavailable, not implemented (its format is not public).
  - **Development fixture**: labeled everywhere, refused in production.
  - **Search Console** figures appear next to Trends, never combined. **Keyword Planner** is a documented design,
    shown as not connected.
- **Normalized data model** (migration `20261023180000_keyword_trends_providers`, additive only; applied to the
  dev database, schema diff empty):
  - `trend_reports` gains region, language, data types, cache key, partial flag, limitations, expiry, trigger and
    saved-query link;
  - new tables `trend_observations`, `trend_regional_interest`, `trend_related_items`, `trend_csv_imports`,
    `trend_provider_events` (kept 90 days) and `trend_saved_queries`;
  - older reports keep their JSON data and still load.
- **Caching and limits:**
  - identical requests reuse unexpired data by copying rows, keeping the original retrieval time; another
    tenant's report is never exposed;
  - lifetimes come from `TRENDS_CACHE_TTL_HOURS`, by provider and data type;
  - live lookups are capped at `TRENDS_LIVE_REPORTS_PER_WORKSPACE_PER_DAY` (default 30);
  - AI quota is used only when placements are requested.
- **Jobs:** a dedicated `trends` BullMQ queue. The `scheduled-trends` maintenance task (hourly) refreshes saved
  comparisons weekly or monthly, without AI. Rate limits and refusals are not retried. Stuck reports are released.
- **Endpoints** (see [api.md](api.md)): status (health, last success and failure, limits), categories, submit,
  history, report, import preview and import, CSV export per part, save terms to keywords or lists, plan content
  (brief and dated task), recommendations, saved comparisons (CRUD and run), and keyword opportunities.
- **UI:**
  - Keyword trends page:
    - inputs: country, a region select (all Indian states with Google's codes, US states, any ISO code), a
      searchable list of 1,132 Google Trends categories, a source selector, and data-type and AI-suggestion
      toggles;
    - each report shows its source, freshness, cache, partial-data and limitation labels;
    - charts: interest over time with each term's direction, and interest by region (shares, or the top places);
    - related queries and topics, a terms table with Search Console figures, "Save to keywords" and "Plan";
    - CSV export, history, saved comparisons, and the Data sources panel.
  - Keyword research gains an **Opportunities** tab: explainable scores, missing signals, next steps.
- **Accuracy fix:** grouping trends terms no longer strips modifiers ("free", "best", "how to make"), which had
  merged different searches.

**Providers actually tested:**

| Source                     | How it was tested                                                                                                                                                                                                                                                   |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| pytrends                   | **Live, about 15 service calls on 2026-10-23.** The user's example (India, past 90 days, category 293 "Weddings", five terms) through the Node provider: 93 daily points, 36 regions and related queries in 99 s, no rate limit. Google returned no related topics. |
| CSV import                 | Unit and API tests with sample exports of all four kinds                                                                                                                                                                                                            |
| DataForSEO                 | Fake responses only (no account): **not verified live**                                                                                                                                                                                                             |
| Google Trends API alpha    | **Not implemented, not tested**                                                                                                                                                                                                                                     |
| Development fixture        | API tests and the E2E journey (through the real worker and `trends` queue)                                                                                                                                                                                          |
| Search Console (alongside) | Stored metric rows in tests; no live Google account in this change                                                                                                                                                                                                  |

- **Live comparison with Shubhlink's 247 crawled pages** (read-only dry run, no AI): the five compared terms are
  targeted. Rising searches the site does not target yet include:
  - "wedding invitation fonts" (Breakout);
  - "wedding invitation content" (+250%);
  - "digital wedding invitation video" (+110%);
  - "animated wedding invitation" (+100%, only in a page description);
  - "wedding invitation logo" (+80%).
- **Tests added or updated:**
  - shared: 10 (all four CSV kinds, import preview, term assignment, trend direction, settings validation);
  - core: 23 (pytrends mapping, partial results after a 429, rate limit, timeout, service down, wrong token, health,
    cache keys and lifetimes, row storage round trip and copy, CSV export, provider events, DataForSEO, scheduled
    refresh, opportunity scoring with incomplete data and on MySQL);
  - API: 11 (provider status, a configured but stopped service, preview, import, export, quota, tenant isolation,
    cross-workspace cache reuse, region validation, save to keywords, brief and task, saved comparisons,
    categories, opportunities);
  - web: 3 (report with partial data, live request with region and data types, CSV preview before import);
  - Python: 8 (validation, cache, cool-down after 429, robots.txt refusal, regions and related, empty topics,
    requested kinds only, token);
  - E2E: a Keyword trends step in the journey.
- **Verification (executed):**
  - `npm run typecheck` exit 0, `eslint .` exit 0, Prettier clean for the changed files;
  - `npm test` 48 files and 420 tests passed;
  - `npm run trends:test` 8 tests passed;
  - `npm run test:e2e` 4 of 4 passed (Redis was started for the run, then stopped).
- **To use pytrends locally:** run `npm run trends:setup` once and `npm run trends:start`, then add
  `PYTRENDS_SERVICE_URL=http://127.0.0.1:4410` to `.env` (not changed by this work) and restart `npm run dev`.

## 2026-10-23 — AI keyword ideas for bulk prompts

Request: in bulk keyword entry, use the OpenAI key to generate many keywords related to the business.

- **Bulk dialog** (AI Visibility "Add in bulk", Competitor gaps "Add keywords in bulk"): a new **Generate keywords
  with AI** section takes an optional topic and a count (10–50). The ideas fill the Keywords list, and the related
  questions the AI suggests fill the Questions tab. Everything stays editable before adding.
- **Keyword ideas job** (`executeKeywordSuggestions`, also used by Keyword Research):
  - the topic is now optional; without one, ideas cover the whole business;
  - the prompt is grounded in `businessContext()`: the description, primary keywords, competitors, and up to 40
    titles or main headings of indexable crawled pages;
  - the AI is told not to suggest products the business does not show;
  - each run uses one AI keyword run from the monthly quota.
- **Checked on real data** (dry run for Shubhlink with OpenAI; usage writes intercepted): 20 ideas and 60 related
  questions in 7 s, all tied to the site's real offerings. Examples: "kankotri wedding invitation", "godh bharai
  invitation templates", "griha pravesh invitation card templates", "cinematic wedding invitation video", "AI
  wedding invitation maker".
- **Bug fixed:** workspace slugs end with a random base64url part that can contain "\_". The agency code check
  rejected such codes (about 9% of new workspaces), which made an agency test fail intermittently. The check now
  accepts "\_", with a regression test.
- **Tests:** API (topic-less ideas grounded in pages and keywords), web (Generate fills keywords and questions),
  shared (agency codes).
- **Verification (executed):**
  - `npm run typecheck` exit 0, `eslint .` exit 0;
  - `npm test` 48 files and 391 tests passed;
  - `npm run test:e2e` 4 of 4 passed.

## 2026-10-23 — Search trends (Google Trends compared with the site)

Request: show what people search for in the customer's field (Google Trends), which of those terms the site lacks,
and use OpenAI to say on which page and in which section to add them. Decision D-038 in [decisions.md](decisions.md).

- **Data sources (research):**
  - Google's official Trends API is an invitation-only alpha, and automated access to trends.google.com conflicts
    with Google's terms, so the site is not scraped.
  - Live data comes from DataForSEO's Google Trends endpoint (licensed, about $0.009 per request).
  - The free path is importing the CSV files Google Trends exports.
- **Page:** SEO → **Search trends** (`/app/p/:id/trends`).
  - Inputs: terms (pre-filled from primary keywords), country, period and category.
  - Getting data: "Fetch live data" (with DataForSEO configured), "Open in Google Trends" (the same link format
    as the user's example) or "Import CSV".
  - Results: interest over time, average interest, top and rising related searches, and a "your site and these
    searches" table (Targeted, Not targeted, Missing, with the pages and fields where each term appears).
  - "Where to add them": page, section, spot and wording, with copy and "Add to recommendations" buttons.
- **Backend:**
  - `core/trends`: DataForSEO client, phrase matching against the latest crawl, AI placements checked against
    real pages and headings, and the job;
  - table `trend_reports`, job type `TREND_REPORT` and recommendation source `SEARCH_TRENDS` (migration
    `20261023150000_search_trends`, applied to the dev database; the schema diff is empty);
  - routes under `/projects/:id/trends`;
  - one AI keyword run of quota per report, 20 a day, one at a time;
  - new optional settings `DATAFORSEO_LOGIN` and `DATAFORSEO_PASSWORD` (blanked in tests).
- **Checked on real data (dry run, Shubhlink's 247 crawled pages, OpenAI):**
  - Targeted: "wedding invitation", "birthday invitation", "invitation templates", "digital invitation" and
    "invitation card design".
  - Not targeted: "housewarming invitation" (only a blog sub-heading), "video invitation maker", "e invite for
    whatsapp" and "wedding invitation wording in hindi".
  - The suggestions named real sections: the homepage's "Video Invitations" and "WhatsApp Delivery" sections, and
    the "Invitation Wording Guides" heading on /blog/category/wording.
  - No live Trends numbers were fetched: there are no DataForSEO credentials, and Google is not scraped.
- **Tests:**
  - shared: 4 (link format equal to the user's example, both CSV exports, unknown files, term validation);
  - core: 6 (phrase matching, dropping invented pages, DataForSEO mapping and errors, a MySQL run with a fake AI
    that names a page that does not exist, a live-data run);
  - API: 4 (not-configured response, the import/queue/report flow, unreadable files, quota and tenant isolation);
  - web: 2 (report view, CSV upload request).
- **Verification (executed):**
  - `npm run typecheck` exit 0, `eslint .` exit 0;
  - `npm test` 48 files and 388 tests passed;
  - `npm run test:e2e` 4 of 4 passed (Redis was started for the run, then stopped).

## 2026-10-23 — SEO comparison and bulk prompts

Requests: a screen comparing the site's SEO with competitors (how far behind, plus a full suggestion list), and bulk
keyword entry on the AI pages. Decision D-037 in [decisions.md](decisions.md).

- **SEO comparison page:** SEO → **SEO comparison** (`/app/p/:id/seo-comparison`). It shows:
  - a picker for up to five competitors;
  - "behind on X of Y checks";
  - site health per site;
  - a side-by-side table of 32 checks in 8 groups, with the best value bold and an ahead/behind/even status;
  - a prioritized suggestion list, each item with its evidence and an "Add to recommendations" button;
  - what each crawl could read, and what the comparison does not measure (rankings, traffic, backlinks, Core Web
    Vitals).
- **Backend:**
  - `core/competitors/seo-compare.ts`: the same crawler, page budget (`COMPETITOR_CRAWL_MAX_PAGES`, default 250)
    and time limit (4 minutes) for every site, with the audit rules run in memory;
  - table `seo_comparisons` and job type `SEO_COMPARISON` (migration `20261023120000_seo_comparison`, applied to the
    dev database; the schema diff is empty);
  - routes `POST /projects/:id/seo-comparisons`, `GET …/latest` and `POST …/:comparisonId/recommendations`;
  - gated by competitor analysis and `competitor.snapshot`; one comparison at a time; each competitor counts as one
    competitor snapshot.
- **Bulk prompts:** "Add in bulk" on AI Visibility and "Add keywords in bulk" on Competitor gaps.
  - Two modes: paste questions, or turn keywords (or your primary keywords) into questions with five templates.
  - The preview can be edited before anything is added.
  - `POST /projects/:id/prompts/bulk` takes up to 100 prompts. It skips and reports short lines, duplicates and
    prompts already tracked, and applies the plan's prompt limit to the whole batch.
- **Refactor:** recommendations from the gap analysis and the comparison are saved through one helper
  (`recommendations/evidence.ts`); the audit-rule category map moved to `recommendations/benefit.ts`.
- **Checked on real sites (dry run, prints only, 40 pages each, 24 s):** Shubhlink against craftyartapp.com.
  - Even on site health (98 vs 99).
  - Ahead on server response (53 ms vs 290 ms).
  - Behind on content depth (median 324 words vs 3,880), internal links (28 vs 250), question/FAQ coverage (55% vs
    95%), title lengths (75% vs 95%) and description lengths (73% vs 93%).
- **Tests:**
  - core: 4 (comparison statuses, suggestion ranking, and a MySQL run with your site, a stronger rival and a site
    whose robots.txt blocks crawling);
  - API: 4 SEO comparison tests (plan gate, at most five competitors, the queue/usage/save flow, tenant isolation)
    and 3 bulk prompt tests;
  - shared: 3;
  - web: 3 (comparison page, starting a comparison, and the bulk dialog from keywords to request).
- **Verification (executed):**
  - `npm run typecheck` exit 0, `eslint .` exit 0;
  - `npm test` 44 files and 371 tests passed;
  - `npm run test:e2e` 4 of 4 passed (Redis was started for the run, then stopped).

## 2026-10-23 — Competitor gaps: why AI recommends other brands

Request: the visibility page showed a score but no section explaining how to beat competitors. Decision D-036 in
[decisions.md](decisions.md); definitions in [metrics.md](metrics.md#competitor-gap-analysis).

- **New page:** AI → **Competitor gaps** (`/app/p/:id/gaps`), linked from the visibility brand chart. It shows:
  - an action plan with the evidence behind each action, plus buttons to add an action to recommendations, track a
    brand and add an alias;
  - who AI recommends, including untracked brands, with verified quotes;
  - the reasons given and whether those words appear on your site;
  - each question's best page in your crawl;
  - the websites AI relies on, with live checks;
  - your site's readiness: robots.txt for AI crawlers, the homepage without JavaScript, and the latest audit.
- **Backend:**
  - `core/competitors/gap.ts`: a job on the `competitor` queue;
  - table `visibility_gap_analyses` and job type `GAP_ANALYSIS` (migration
    `20261023090000_visibility_gap_analysis`, applied to the dev database; the schema diff is empty);
  - routes `POST /projects/:id/gap-analyses`, `GET …/gap-analyses/latest` and
    `POST …/gap-analyses/:analysisId/recommendations`;
  - gated by the competitor analysis plan feature and `competitor.snapshot`; one analysis at a time, 10 a day;
  - provider usage is recorded per run, and admins can retry the job.
- **Fixed on the way:** text extraction joined words around `<br>` (a homepage H1 read "ElegantDigital"). Both
  extractors now treat a line break as a space.
- **Checked on real data (dry run against the dev database, Shubhlink, 14 real answers, OpenAI extraction):**
  - Canva was named in 12 answers, Adobe Express in 5, Greetings Island in 4 and Fotor in 3; none are tracked.
  - "Crafty Art" was found as an alias the tracked `craftyart` misses.
  - Live checks found list articles (weddingkart.co, magicalstar.in, tyingknot.in, wedence.in) that name rivals but
    not Shubhlink.
  - robots.txt allows every AI crawler. The homepage has 519 words and Organization, WebSite and FAQPage data.
  - Each run took 27 to 49 s. The dry run stored only provider usage events (analysis id `dryrun`).
  - Problems this run exposed, then fixed and re-checked:
    - duplicate brands ("Adobe" next to "Adobe Express");
    - composite names;
    - blog indexes counted as the target page;
    - PDFs taking the page-check budget.
- **Tests:**
  - core: 9 new tests (helpers, rules, and a MySQL run with a local site and a fake extractor that invents a brand
    and a quote; both are dropped);
  - API: 4 new tests (plan gate, no real answers, the queue/report/recommendation flow, tenant isolation);
  - web: 2 new tests (empty state; actions call the API);
  - `npm run typecheck` exit 0, `eslint .` exit 0, `npm test` 39 files and 354 tests passed;
    `npm run test:e2e` 4 of 4 passed (Redis was started for the run, then stopped).

## 2026-10-22 — Audits crawl every page

Request: remove the crawl page limit so audits cover every page. Decision D-035 in [decisions.md](decisions.md).

- **Caps are optional:**
  - plan `pagesPerAudit`, project `maxPages` and `maxDepth`, and `CRAWLER_MAX_PAGES_HARD_LIMIT` accept `null`
    (`0` for the server setting) for no cap; `combinePageCaps` applies the smallest cap that is set;
  - every default plan, new projects and the seed use no cap;
  - migration `20261022180000_crawl_all_pages` cleared only the old built-in defaults (dev database: 3 projects,
    4 plans);
  - `.env` and `.env.example`: `CRAWLER_MAX_PAGES_HARD_LIMIT=0` (only that line of `.env` was changed).
- **Unchanged safeguards:**
  - robots.txt, the per-host delay and SSRF rules;
  - no logins;
  - the anonymous free audit stays at 20 pages.
- **Crawler:**
  - constant-time FIFO queue;
  - loop protection: at most 100 query-string variants per path, and URLs longer than 2,048 characters are
    skipped and counted (`loopUrlsSkipped`);
  - a sitemap is read up to 500,000 URLs when uncapped;
  - the full robots-blocked count is kept (`blockedByRobotsTotal`).
- **Analysis:**
  - the stored crawl loads in batches, with shared link objects;
  - near-duplicate checks cover every indexable page instead of the first 1,500: PPJoin prefix filtering for
    titles, six-block SimHash keys for content;
  - inlink counting no longer keeps a set per URL;
  - robots-blocked links are matched in one pass;
  - limitation texts were updated.
- **Worker:** the audit queue's lock is now 5 minutes.
- **UI:** "Crawl every page" and "Any depth" options in project settings; "All pages" on pricing; "no page
  limit" and loop-protection facts on the audit page; copy no longer mentions a plan page limit.
- **Measured:**
  - 100,000 synthetic pages (6 million links): analysis took 18 s before the inlink change. With the earlier
    near-duplicate code, the title check ran out of its budget.
  - 20,000 pages (1.2 million links) after all changes: 1.4 s, about 170 MB of heap.
- **New tests:**
  - near-duplicate results equal the all-pairs comparison (4 generated sites of 700 pages), including pages
    beyond the first 1,500 and a group of 3,000 identical pages;
  - an uncapped crawl of a 30-level chain with an endless calendar and an over-long URL;
  - the depth cap still applies;
  - cap combination, and an admin plan cap still applies;
  - API defaults with no cap.
- **Verification (executed):**
  - `npm run typecheck` (all workspaces): exit 0;
  - `eslint .`: exit 0;
  - `npm test`: 36 files, 339 tests passed;
  - `npm run test:e2e`: 4 of 4 passed (Redis was started for the run, then stopped again).
  - The first full run had 1 failure, an API test that subscribed to an inactive plan (which falls back to Free).
    That check moved to a unit test of `clampCrawlSettings`, because an active test plan would change the plan
    lists other tests assert.

**Next unfinished task:** wrap up extension phase 1 in [feature-audit.md](feature-audit.md) (approvals, tasks,
agency access, white-label fields, provider costs), then phase 2 (local SEO, Business Profile, multi-location,
rank grid) as planned in [extension-plan.md](extension-plan.md).

## 2026-10-22 — Extension phase 0: gap analysis and plan

Scope: the incremental feature request and the three-phase feature list, treated together as one required scope.

**Gap analysis** (details per feature in [feature-audit.md](feature-audit.md)):

- **Missing (14):**
  - local rank tracking and the geographic grid;
  - ecommerce SEO and product schema;
  - conversion attribution;
  - change history and impact monitoring;
  - SERP rank tracking;
  - Core Web Vitals;
  - editorial calendar and content refresh;
  - automated alerts;
  - CMS publishing;
  - multi-location management;
  - public API and webhooks;
  - managed service packages;
  - Business Profile and Merchant Center;
  - backlinks, PR, brand mentions and community.
- **Partially implemented (8):**
  - AI citation intelligence: citations are stored and aggregated by domain; there is no history or source
    classification.
  - International SEO: target countries and languages; no hreflang validation and no markets.
  - White-label: report branding only.
  - Approvals and tasks: content approval and recommendation assignees only.
  - Reports: section picker, no schedules.
  - Usage billing: quotas exist; no provider cost tracking or overage billing.
  - Search Console: OAuth and basic sync; no opportunities or optimization workflow.
  - AI visibility: OpenAI and Perplexity only; no Gemini or Google AI features.
- **Inaccuracy found:** [integrations.md](integrations.md) claims reports include Search Console data. They do not.
- **Not received:** the "best jewellers in Surat" screenshot.

**Plan:** [extension-plan.md](extension-plan.md) records decisions D-024 to D-034 (agency client workspaces and
the Client role, managed packages, approvals, provider capture methods and costs, SERP data, change impact, events,
public API, usage billing, attribution, markets), the new tables and the build order.

**Research:** current provider documentation is being collected by background research for Business Profile,
Merchant API, Gemini grounding and SERP/maps providers, mention sources and CMS APIs, GA4, PageSpeed and CrUX.

**Next unfinished task**

- Extension phase 1 (foundation): roles and permissions, agency links and access resolution, approvals, tasks,
  events, provider usage and costs, plan feature flags, a generic Google OAuth flow and safe URL verification helpers.

## 2026-10-22 — Phase F: documentation and final verification

**Completed**

- **Documentation:**
  - `README.md`, [setup](setup.md), [deployment](deployment.md), [security](security.md) and [integrations](integrations.md);
  - the [API reference](api.md), whose endpoint index is generated from the 155 registered routes;
  - [scoring](scoring.md), whose rule table is generated from the 55-rule catalog, and [metrics](metrics.md);
  - [known limitations with the external credentials checklist](known-limitations.md), and the
    [test report](test-report.md);
  - decisions D-018 to D-023, and architecture updates.
- **`.env.example`:** contact and seed account addresses, the Perplexity Agent API note and the 10-character
  password note.
- **Worker tests:** `apps/worker/test/runtime.test.ts` (3). It covers maintenance task dispatch, skipping unknown
  tasks, and which errors are never retried. The worker is now one of the root Vitest projects.
- **Formatting:** `npm run format:check` failed on 230 files that had never been run through Prettier.
  - Those files were backed up outside the repository, then `npm run format` was run. Four files needed a second
    pass before Prettier's output stopped changing.
  - Nothing uses tagged template literals, and no test reads the docs, so formatting cannot change behaviour.
    The full verification below was nevertheless repeated after it.

**Verification (executed after the formatting pass; details in [test-report.md](test-report.md))**

- `npm run format:check`, `npm run lint`, `npm run typecheck`: all exit 0.
- `npm run test`: **33 files, 299 tests passed** (216.8 s).
- `npm run build`: exit 0. `npm run db:deploy`: no pending migrations. `npm run db:seed`: idempotent.
- The built API (`SERVE_WEB_DIST=true`) and worker started, and `npm run dev` started all three processes. Both
  passed their HTTP checks.
- `npm run test:e2e`: **4 passed**. `npm audit`: 0 vulnerabilities.

**Next unfinished task**

- None within the MVP scope. What remains needs the owner:
  - credentials and a live check for each of Perplexity, Google Search Console, Stripe or Razorpay, and SMTP;
  - `VITE_SITE_URL` and a hosted deployment (see [deployment.md](deployment.md));
  - rotating the OpenAI key that was shared in chat.
- Optional follow-ups: a CI pipeline, object storage, the planned GA4/WordPress/Shopify integrations and a
  licensed keyword data provider.

## 2026-10-22 — Phase C (web app), account deletion, static serving, E2E

**Completed**

- **Design system** (`apps/web/src/components/ui`): shadcn-style primitives on Radix UI and Tailwind 4 tokens:
  buttons, form fields wired for screen readers, cards, badges (status, severity, demo, AI estimate), dialogs,
  confirm dialogs, sheets, menus, tabs, accordions, tables, pagination, skeletons, empty and error states, alerts,
  and searchable multi-select and tag inputs. The marketing theme is dark navy; the dashboard is light.
- **Marketing site:** all 20 routes from the brief, plus blog category pages, prerendered to static HTML.
  - `scripts/prerender.ts` renders each route with `StaticRouter` and writes per-route title, description,
    canonical, Open Graph and Twitter tags and JSON-LD. Organization, WebSite and SoftwareApplication carry offers
    from the real plans; FAQPage only where the questions are on the page; BlogPosting and BreadcrumbList.
  - It also writes `404.html`, the noindex SPA shell `app.html`, `sitemap.xml` (24 indexable URLs) and
    `robots.txt`. Collapsed FAQ answers stay in the HTML so the structured data matches visible text.
  - Six original blog articles in three categories and four topic clusters. Original logo and favicon; the OG
    image and 512 px logo are rendered from HTML with Chromium (`npm run brand-images -w @surfaced/web`).
  - No testimonials, customer logos or invented statistics. The dashboard illustration is labeled
    "Product illustration with sample values".
  - The homepage free-audit form submits to the real API. The access token stays in the URL fragment.
- **Auth pages:** register, login, forgot and reset password, email verification and invitation acceptance.
  Return paths are same-site only; zod schemas are shared with the API.
- **Dashboard** (lazy chunks per page):
  - Overview, projects and project creation (optionally starting the first audit), and audits with live progress,
    cancel, re-score, category meters, crawl facts and limitations.
  - Issues with filters, issue detail and history, and page detail with inlinks and outlinks.
  - AI visibility: one filter row scoping every chart; trend, brand comparison, share of voice and cited domains;
    prompts restricted to configured providers and plan frequencies; runs; observations and observation detail.
  - Keyword research (lists and clusters, CSV import and export, AI ideas labeled unmeasured), Content Studio
    (briefs, editor with preview, generation modes and section regeneration, workflow, assignee, versions and
    restore, crawl-based internal links, export) and competitors (plan-gated).
  - Recommendations, reports (sandboxed HTML viewer, PDF when available), integrations (Search Console with
    property picker, sync and disconnect; planned integrations labeled), project settings and billing (labeled
    development billing, provider checkout redirect, portal, cancel and resume, invoices, usage meters, dev
    simulator).
  - Settings (profile, password, notifications, sessions, deletion, workspace, white label, members,
    invitations, audit log) and the admin area.
- **Charts** follow the dataviz skill. The categorical palette was validated with its validator on the
  dashboard's white surface (adjacent CVD ΔE 9.1, normal-vision ΔE 19.6; three slots fall below 3:1 contrast, so
  every chart has a legend and a table view). Other rules applied:
  - one axis per chart, so Search Console clicks and impressions are two charts;
  - emphasis form for brand vs competitors;
  - gaps for buckets without data rather than zeros;
  - colors bound to entities, not rank.
- **Account deletion job:** the API documentation and the privacy page promised that accounts are deleted after
  the 14-day grace period, but nothing implemented it.
  - `core/accounts.ts` now runs daily from the maintenance queue. It deletes the account, the workspaces where the
    user is the only member, their report files and the email-delivery records.
  - It defers, with an in-app notice at most weekly, when the user is still the sole owner of a shared workspace
    or a workspace has an active paid subscription.
  - Project deletion now also removes report files (`removeReportFiles`).
- **`SERVE_WEB_DIST`:**
  - The API can serve the built web app: prerendered pages, the SPA shell for `/app/*`, real 404s, a year-long
    immutable cache for hashed assets, a restrictive page CSP and path-traversal protection.
  - The session middleware is now scoped to `/api`, so static files never trigger session lookups.
- **Playwright E2E** (`npm run test:e2e`): `e2e/global-setup.ts` starts an isolated stack.
  - It runs the fixture website, the API serving the build, and the worker against `surfaced_e2e`, using the
    `surfaced-e2e` Redis namespace (cleared each run).
  - Providers: development LLM adapter, labeled demo AI provider, development billing, console email. No
    external calls.
- Corrections found along the way:
  - The shared Perplexity provider description still said "Sonar API"; it now names the Agent API.
  - The privacy page initially claimed IPs were stored hashed. Sessions and audit logs keep the raw IP, so the
    text was corrected.

**Bugs found by the E2E run and fixed**

- The audit page mounted the issue list as soon as the crawl finished. It fetched before the analysis had saved
  any issues and kept showing "No issues match" after completion. The list now waits for the analysis, and issue
  queries are refreshed when a run finishes.
- On `/free-audit` itself, starting an audit changed only the URL fragment through the router. That does not
  fire `hashchange`, so results never appeared; it worked only when arriving from the homepage. The page now
  reads the fragment from the router location.
- The first production build shipped React's development build. The shared root `.env` sets
  `NODE_ENV=development` for the API, and Vite honoured it. `apps/web/scripts/build.ts` now sets
  `NODE_ENV=production` before calling Vite. The entry chunk went from 880 KB to 637 KB (182 KB gzipped).

**Verification (executed)**

- `npm run build -w @surfaced/web`: client build, SSR build and prerender of 28 routes, `404.html`, `app.html`,
  `sitemap.xml` and `robots.txt`.
- `npx vitest run --project web`: **3 files, 18 tests passed**. They cover:
  - API client: CSRF retry, field errors, 401 handler, network errors; safe redirects;
  - SEO head escaping; formatting;
  - free-audit validation and submit; pricing toggle; auth guard redirect; login error;
  - prerendered home, every public route having a unique title, description and canonical, blog posts and the 404.
- `npx vitest run --project api test/web-static.test.ts` (4) and `--project core test/accounts.test.ts` (2): passed.
- `npx playwright test`: **4 passed**.
  - The full journey: register, create a project, audit the fixture site, view issues and pages, create a prompt,
    run a demo observation and open it, generate a content draft, generate and view a report, change the profile,
    log out, and log back in to the same page.
  - Prerendered HTML, robots.txt, the sitemap and a real 404; the free audit; the pricing page.
  - After teardown no stack processes or ports remained.
- Browser smoke test with Chromium against the API serving the build and the seeded demo workspace: 25 pages
  were visited, including mobile widths, with no page errors and no failed API requests. The only console
  entries were the expected 401s of the signed-out session probe on the login page.
- `tsc` for web and API: exit 0. `npx eslint apps/web`: exit 0, after fixing a useless assignment and an unused
  import.

**Next unfinished task**

- Phase F: documentation (setup, deployment, security, API, scoring, metrics, integrations, known limitations,
  credentials checklist, test report), `.env.example` additions, then a full verification run: lint, typecheck,
  every test project, API/worker/web builds, migrations, seed, E2E.

## 2026-10-22 — Phase E: reports, billing, integrations, admin, scheduling, seed

**Completed**

- **Reports:** generation jobs build HTML from stored project data for a date range (audit, issues, AI
  visibility, competitors, recommendations, Search Console). Data gaps are listed as limitations. PDFs are
  rendered with Chromium (playwright-core) with JavaScript disabled and every network request blocked. The
  HTML endpoint is served with a sandboxing CSP. Report quota, idempotent usage and a white-label snapshot apply
  when the plan allows them.
- **Billing:** plans API, subscription view, checkout, portal, cancel/resume, invoices and usage.
  - Adapters: Stripe (Checkout, portal, Basil API shapes: `items.data[].current_period_*` and
    `invoice.parent.subscription_details`), Razorpay (Subscriptions REST, HMAC-SHA256 webhook signatures), and a
    labeled development mode.
  - Webhooks verify signatures on the raw body and are idempotent per provider event id (`webhook_events`). They
    drive every state change: paid, past due, recovered, canceled.
  - Checkout never marks a paid plan as paid; in development mode a plan is activated immediately and flagged
    `development: true`.
  - A development-only simulator covers the payment-failed, recovered and canceled UI states.
- **Google Search Console:**
  - OAuth uses a hashed, single-use, user-bound state with a 10-minute TTL, plus PKCE (S256), offline access and
    AES-GCM encrypted tokens.
  - Access tokens refresh automatically; a failed refresh moves the integration to "needs re-authentication".
  - Disconnect revokes access and deletes the stored tokens.
  - Property selection is validated against the sites the account can access.
  - Sync covers 90 days of dates plus the top 1,000 queries and pages, with a 2-day data lag.
  - GA4, WordPress and Shopify are listed as **planned**, never as available.
- **Admin API** (`/admin/*`, platform admins only; everyone else gets 404):
  - Overview totals.
  - User search and detail. Disabling a user records a reason and revokes all of their sessions. Admins cannot
    disable themselves.
  - Workspace search and detail with usage.
  - Jobs list, and retry of failed jobs through BullMQ `job.retry` with a fresh attempt budget. Only report,
    integration sync, competitor snapshot and email jobs are retryable here; crawls, audits and runs are started
    again from the product so limits are re-checked.
  - Plan editor (validated limits, cent-precision prices; the Free plan cannot be deactivated).
  - Monthly usage, system status (dependency health and whether providers are configured, never secrets) and the
    platform audit log. Every admin change is audit-logged.
- **Scheduled jobs** (`core/scheduling`, run by the maintenance queue):
  - Due audits and visibility prompts every 15 minutes. Weekly audits require a plan that includes them.
  - Daily Search Console sync at 03:30 UTC.
  - Weekly summary email on Mondays at 08:00 UTC, built only from data recorded in the last 7 days. It is sent to
    opted-in, verified users and at most once per 6 days.
  - Each due item is claimed with a conditional update, so overlapping ticks cannot start it twice. Plan features,
    prompt frequencies, provider configuration and monthly quotas are re-checked at run time.
  - Skipped items wait for the next period, and owners and admins get an in-app notification.
- **Development seed** (`npm run db:seed`, `npm run db:seed:reset-demo`):
  - Creates plans, an admin account and a demo account (password from `SEED_DEMO_PASSWORD`, reserved `.test`
    addresses, email notifications off) and a demo workspace on the Growth plan in development billing mode.
  - The demo audit is produced by the real crawler and audit engine. They analyze an in-memory demo site on the
    reserved `.example` TLD through a `SafeFetcher` subclass, so the seed makes no network requests.
  - Demo visibility observations come from the labeled demo provider with LLM verification disabled.
  - Keywords are phrases only, with no search metrics.
  - Production runs only ensure the plans. The reset flag refuses to delete a demo workspace that contains a
    non-demo project.
- The API's crawl-settings clamp and next-audit-date helpers now live in `core/scheduling` and are shared with
  the scheduler (no duplicate logic). `QueueGateway` gained `retry()`.

**Live verification (executed)**

- Chromium PDF rendering produced a PDF with Japanese and Hindi text. An external image in the HTML was blocked,
  as intended.
- `npm run db:seed` against the development database created both accounts and the demo workspace. The demo
  audit crawled 12 pages. After the demo copy was lengthened and Open Graph tags were added, a
  `db:seed:reset-demo` run produced **17 issues, every one of them a problem deliberately planted in the demo
  site**: a broken internal link, the 404 page, the robots-blocked `/cart`, the missing h1, missing alt text, the
  missing meta description, the orphan page, the noindex page listed in the sitemap, the slow page, the duplicate
  titles, a link to a redirect, the thin page and the long title. The site health index was 95. The run also
  created 5 demo observations (2 brand mentions, 2 citations) and 19 recommendations. That second run reported
  both existing accounts as "left unchanged" and rebuilt only the demo workspace.
- Stripe, Razorpay and Google were **not** exercised live (no credentials). Their behaviour is covered by signed
  test payloads and a mocked HTTP layer.

**Verification (executed)**

- New tests:
  - `core/test/integrations.test.ts` (3): state replay, expiry and user binding; PKCE; encrypted tokens;
    refresh; re-auth on refresh failure; sync math; revoke.
  - `api/test/integrations.test.ts` (2): catalog honesty, 503 when OAuth is unconfigured, tenant 404, callback
    error redirects.
  - `api/test/admin.test.ts` (8): hidden from non-admins, no secrets in system status, disabling revokes
    sessions, no self-disable, workspaces, plan validation, safe retry rules, usage.
  - `core/test/scheduling.test.ts` (6): plan, quota and frequency gating, claim idempotency, unconfigured
    providers, active-run deferral, sync de-duplication, weekly summary content and de-duplication.
  - Reports (2) and billing (5) API tests were run individually when written.
- Failures seen while writing these tests were all wrong expectations in the tests themselves, and each was
  fixed in the test:
  - a metric name (`CRAWL_PAGES`);
  - the Growth page cap (2,000);
  - the quota message wording;
  - two test projects sharing a domain within one workspace.
- `npx vitest run --project shared --project core --project api`: **27 files, 272 tests passed**.
- `tsc` for shared, core, api, worker and root (including `prisma/seed.ts`): all exit 0.
- `npx eslint .` reported 1 error (a useless initial assignment in `core/reports`). It was fixed, and the changed
  files were re-linted with exit 0.

**Next unfinished task**

- Phase C frontend (`apps/web`): design system, prerendered marketing routes (sitemap, robots, Open Graph,
  JSON-LD), auth pages, dashboard shell and every module page, admin pages, RTL tests. Then `SERVE_WEB_DIST`
  static serving in the API, the Playwright E2E suite and the Phase F docs and verification.

## 2026-10-22 — Phase B (part 1): tooling, database, shared package

**Note on interruption:** a previous turn ended with an "Output blocked by content filtering policy" API
error while starting the shared package. Inspection afterwards showed no partial files: only
`packages/shared/src/enums.ts` existed, and it was complete (303 lines). Work resumed from there in smaller files.

**Completed**

- npm workspaces monorepo (`packages/shared`, `packages/core`, `apps/api`, `apps/worker`, `apps/web`) with
  913 packages installed. `@hookform/resolvers` is pinned to 5.9.2 because 6.0.0 (published 2026-10-19) has a
  broken optional-peer graph.
- Tooling: `tsconfig.base.json` (TS 6.0.3, strict, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`),
  ESLint 10 flat config, Prettier, EditorConfig, root Vitest projects config.
- Prisma 7.10.1: `prisma.config.ts`, client generated to `packages/core/src/generated/prisma`, and initial migration
  `20261022051514_init` applied to the new `surfaced` database (44 tables).
- `@surfaced/shared` (isomorphic, used by React and Node):
  - `enums.ts` mirrors the Prisma enums, plus provider metadata, report sections and labels.
  - `constants/locales.ts`: all 249 ISO 3166-1 alpha-2 countries and 51 BCP 47 languages, with display names via `Intl.DisplayNames`.
  - `constants/industries.ts`: 31 industry options.
  - `plans.ts`: plan limit schema, four default plans (Free/Starter/Growth/Agency), quota math, UTC usage periods.
  - `permissions.ts`: Owner/Admin/Member matrix (31 permissions), role-change, member-removal and invitation rules.
  - `content-workflow.ts`: approval state machine (approve and publish are restricted to Owner/Admin).
  - `url.ts` and `util.ts`: URL normalization (punycode, credential and protocol checks) and text helpers.
  - `audit/`: catalog of 55 deterministic rules and the scoring model (weights, severity points, pure `computeAuditScore`).
  - `metrics.ts`: mention rate, citation rate, competitor rates, share of voice, source distribution, trend, composition.
  - `markdown.ts`: safe Markdown rendering (raw HTML escaped, unsafe URL protocols dropped) and section replacement.
  - `schemas/`: zod request schemas for auth, workspaces, projects, audits, visibility, content, keywords,
    recommendations, reports, billing, public endpoints and admin.
  - `types.ts`: API envelope, error codes and core DTOs.

**Verification (executed)**

- `npx vitest run --project shared`: **5 files, 67 tests passed**. The first run had 1 failure, caused by a wrong
  expected error code in a test (the input was correctly rejected); the expectation was fixed and the suite re-run.
- `npx tsc -p packages/shared/tsconfig.json`: exit 0.
- `npx eslint packages/shared prisma.config.ts vitest.config.ts eslint.config.js scripts`: exit 0.

### Core foundation (same day)

**Completed**

- `packages/core/src/env.ts`: zod-validated configuration. Empty values are treated as unset, provider credentials
  are required when a provider is selected, and dev billing, the dev LLM adapter, demo AI data, insecure cookies
  and console email are all **rejected when `NODE_ENV=production`**. The crawler dev allowlist is ignored in production.
- `logger.ts`: pino with redaction of cookies, auth headers, passwords, tokens, API keys and signatures.
- `db.ts`: Prisma 7 client with `@prisma/adapter-mariadb`; `DATABASE_URL` is parsed into the pool config.
  A smoke test confirmed a DateTime round-trips exactly and MySQL stores it in UTC.
- `redis.ts`, `crypto.ts` (random tokens, SHA-256 token hashing, HMAC, AES-256-GCM, Argon2id with OWASP
  parameters, PKCE), `errors.ts` (`AppError` + stable error codes).
- `queue/`: queue names, typed payloads, `BullQueueGateway` (BullMQ 6) and `MemoryQueueGateway` for tests.
- `jobs/`: persistent job records. Enqueue failures mark the record FAILED (returning 503), plus a progress/heartbeat
  tracker, cooperative cancellation, and retry-aware failure handling.
- Test infrastructure: `test/setup-env.ts` points server tests at `surfaced_test` and disables real providers.
  `test/global-setup.ts` runs the non-destructive `prisma migrate deploy` (see the note below).

**Note — Prisma blocks AI-invoked `migrate reset`:** the global setup first used `prisma migrate reset --force`.
Prisma 7 detected that an AI agent invoked it and refused, requiring explicit user consent. The guard was
**not** bypassed. The setup now uses `prisma migrate deploy`, and tests use unique data, so a reset is unnecessary.
To wipe the test database, a developer can run the reset manually.

**Verification (executed)**

- `npx vitest run --project shared --project core`: **8 files, 120 tests passed**. This includes 39 Prisma↔shared
  enum parity checks and job lifecycle tests against MySQL.
- `npx tsc -p packages/core/tsconfig.json` and `npx tsc -p tsconfig.json`: exit 0.
- `npx eslint packages test prisma.config.ts vitest.config.ts`: exit 0.

### API foundation, auth and tenancy (same day)

**Completed**

- `.env.example` (every variable documented, no secrets), `docker-compose.yml` (optional MySQL 8.4 and Redis 8),
  `scripts/build-node-app.mjs` (esbuild bundle for API/worker), `scripts/dev-redis.mjs` (starts the local Redis).
- Core services: `audit-log.ts` (best-effort, scrubs sensitive keys), `notifications.ts`, `email/` (templates with
  escaping; console provider writes `.eml` files and records **LOGGED_LOCALLY, never SENT**; SMTP provider; rendered
  messages travel AES-GCM-encrypted in the queue and are never stored in MySQL), `billing/plans.ts` (limits validated
  on read, Free fallback), `usage/` (idempotent usage records, monthly/count quota checks, per-workspace row lock).
- API (`apps/api`): Express 5 app factory with request ids, pino-http (secrets redacted), helmet, a CORS allowlist,
  raw-body webhook routes, 1 MB JSON limit, cookie sessions, signed double-submit CSRF plus Origin check, and Redis-backed
  rate limiting (memory store in tests). Also a declarative route helper (zod validation plus auto-generated OpenAPI 3.1
  at `/api/v1/openapi.json` and Swagger UI at `/api/docs`) and a central error handler with stable codes.
- Endpoints: `/auth` (csrf, register, login, logout, me, verify-email, resend-verification, forgot/reset-password),
  `/users/me` (profile, preferences, password, sessions, deletion request/cancel), `/workspaces` (CRUD, switch,
  members, roles, invitations, accept, audit logs), `/jobs/:id` (status, cancel), `/notifications`, `/health`, `/meta/config`.
- Tenant guards (`services/access.ts`): one query resolves the resource and the caller's membership. Other
  workspaces get 404, and insufficient roles get 403.

**Verification (executed)**

- `npx vitest run --project api`: **2 files, 23 tests passed**. Coverage: registration (session cookie flags, Free
  subscription, queued verification email), duplicate rejection (409), validation details, login/logout, disabled
  accounts, login rate limiting (429 + Retry-After), unauthorized access (401), CSRF (missing, forged, cross-origin),
  email verification, password reset (non-enumerating, revokes sessions, single-use), password change, preferences,
  deletion request, cross-tenant 404s for workspaces and jobs, the Free plan team limit (402), invitation acceptance
  bound to the invited email, role rules (member/admin/owner, last owner), and white-label plan gating.
- The first run surfaced 1 failure: the register rate limiter (10/hour per IP) correctly blocked the suite's 11th
  signup. Limits are now injectable (`rateLimitMultiplier`), with a dedicated test asserting the real limit.
- `npx vitest run --project core`: 4 files, 60 tests passed. `tsc` (api, core, root) and `eslint apps/api packages test scripts`: exit 0.

### Projects, crawler, audit engine, worker (same day)

**Completed**

- Projects API: CRUD, competitors, primary keywords, crawl settings clamped to the plan, scheduled-audit plan gating,
  history feed, website SSRF policy at creation, project-count and competitor limits under a workspace row lock.
- SSRF guard (`crawler/ssrf.ts`): `net.BlockList` ranges for IPv4/IPv6, embedded IPv4 in mapped/NAT64/6to4 addresses,
  internal hostname suffixes, ports 80/443 only, all-addresses-public DNS rule, and a dev allowlist ignored in production.
- Fetcher: undici Agent with a validating DNS `lookup` (the connection is pinned to the checked address), manual
  redirects re-validated per hop plus a robots check per hop, decompression with a byte cap, and timeouts.
- robots.txt (RFC 9309 semantics), sitemaps (index, gzip, caps), cheerio extraction, SimHash, and a BFS crawler
  (orphans via depth -1, per-host politeness, concurrency, cancellation, HTTPS redirect probe).
- Audit engine: 55 deterministic rules, near-duplicate detection, distinct-source inlinks, scoring, issue persistence
  (stable fingerprints, first/last detected, per-run occurrences, safe auto-resolution), and audit-driven
  recommendations (qualitative benefit text, auto-complete on verified fix, reopen on regression).
- Audit API: start (quota + idempotent usage + one active crawl per project), list, detail (with job ids and
  previous-run delta), cancel, re-score, pages, page detail (issues/inlinks/outlinks), project and run issue lists
  with filters/sort/pagination, issue summary, issue detail/history, ignore/reopen, crawl job status.
- Public endpoints: free audit (20 pages, per-IP and global limits, token-protected results), contact form.
- Worker (`apps/worker`): BullMQ 6 workers for crawl, audit, email and maintenance. A tracked runtime syncs job records
  (attempts, cancellation, non-retryable SSRF errors). Job Schedulers handle stuck-job reconciliation and expiry cleanup.
- Migration `20261022062000_crawl_summary` adds `crawl_jobs.summary`.

**Issue found and resolved: slow `prisma migrate dev` on this machine.** `migrate dev` replays every migration into a
temporary shadow database. Each `ALTER TABLE … ADD FOREIGN KEY` rebuilds a table file, which is slow here (minutes).
Two interrupted attempts left orphaned `prisma_migrate_shadow_db_<uuid>` databases. They were created by those runs and
contained only the empty schema, so they were dropped; no other database was touched. The additive migration was then
written by hand and applied with `migrate deploy`. `prisma migrate diff --from-config-datasource --to-schema` printed
"empty migration", confirming the database matches the schema exactly.

**Live verification (executed against the real stack: API + worker + MySQL + Redis)**

- Registered via HTTP with CSRF, created a project for `https://books.toscrape.com/` (a site published for crawler
  practice), and started an audit. It crawled 50 pages (the Free plan cap) in about 18 s; analysis finished at about 21 s with score 72.
- Spot-checked findings against the live site: mixed content (jQuery loaded over `http://` on an HTTPS page) and
  HTTP→HTTPS not redirected were both **confirmed**; no compression issue was raised because the server returns Brotli
  when asked. **Confirmed correct.**
- Free audit of `example.com`: 1 page, score 69. `h1-missing` and `no-internal-outlinks` were confirmed against its current HTML.
- OpenAPI document: 50 paths and 62 operations at that point.

**Verification (executed)**

- `npx vitest run --project shared --project core --project api`: **16 files, 218 tests passed**.
- `npx eslint .`: exit 0. `tsc` for shared, core, api, worker and root: all exit 0.

### AI visibility (same day)

**Completed**

- `core/ai/llm.ts`: OpenAI Responses API adapter with strict structured output (`zodTextFormat`), reasoning effort only
  for models that support it, retryable/permanent error classification, and a dev adapter that only returns
  caller-supplied templates flagged `isDevAdapter`.
- `core/visibility/providers.ts`: OpenAI web search (inline `url_citation`s plus consulted sources, search queries),
  OpenAI model knowledge (no browsing; URLs only as written), Perplexity **Agent API**, and labeled demo fixtures.
  Perplexity's docs state that Sonar Chat Completions support ended on 2026-09-27; the adapter targets
  `POST /v1/agent` (preset `fast`) and parses both documented result shapes. **It is not verified live** (no key).
- Matching: Unicode word-boundary names and aliases, domain mentions, ranks. Citations: utm stripping, de-duplication,
  owned and competitor attribution. An optional LLM verification step confirms mentions and adds a sentiment labeled
  `AI_ESTIMATE` (never for demo data or the dev adapter).
- Run executor: prompt × provider with parallelism of 3, in-job retries with backoff honouring `Retry-After`, visible
  failed observations, idempotent observation keys, and idempotent `VISIBILITY_CHECK` usage per successful observation.
- Metrics service: filtered observation sets, composition and notes (mixed providers/locales, demo data, truncation).
- API: prompts CRUD and run-now, visibility runs, summary, trend, observations, observation detail, citation domains
  with sample URLs, provider status. Worker `visibility` queue with a limiter.

**Live verification (executed with the provided OpenAI key)**

- Web search observation: `gpt-5.4-mini-2026-03-17`, about 18 s, a 2,715-character answer, 67 citations
  (9 inline + 58 consulted sources), search queries captured, mentions ranked correctly.
- Structured output call: valid parsed JSON, token usage returned.

**Incident (found and fixed): real API calls from one test run.** A new test asserting "OpenAI not configured" failed
because the test environment still had the real key. `test/setup-env.ts` deleted `OPENAI_API_KEY`, but core's
`getEnv()` re-read `.env` and restored it. In that single run, **2 real OpenAI web-search requests** were made (small
cost). Fix: core honours `SURFACED_SKIP_ENV_FILE=true`, and the setup file blanks all provider keys instead of deleting
them. A regression test now asserts that no provider credential is visible to tests. Later runs make no network calls
(that test file dropped from 28 s to 6 s).

**Verification (executed)**

- `npx vitest run --project core test/visibility.test.ts test/env-and-crypto.test.ts`: 16 passed.
- `npx vitest run --project api test/visibility.test.ts`: 4 passed.

### Content Studio, keywords, competitors, recommendations (same day)

**Completed**

- Content: briefs, documents, versions (row-locked numbering), restore, save. The approval workflow enforces role-based
  transitions; approve and publish need Owner/Admin, and approved or published content must return to draft before
  editing. Generation jobs cover outline, article, meta, FAQ, section and schema. Prompts forbid invented facts and
  sources and use `[SOURCE NEEDED: …]` markers. Dev adapter output is labeled; schema is deterministic and free.
  Internal links come only from real crawl data. Exports are Markdown, or HTML with raw HTML escaped and JSON-LD made `<`-safe.
- Keywords: CRUD, duplicate detection, bulk add, CSV import (header aliases, line-numbered errors, auto-created clusters
  and lists, idempotent re-import), CSV export with formula-injection protection, and AI ideas labeled as unmeasured.
  Volume, difficulty and CPC are never shown without a licensed provider.
- Competitors (Growth/Agency): comparison (mention/citation rates, SOV, average rank), shared vs competitor-only cited
  sources, topic gaps, trend, robots-respecting public snapshots, and metadata comparison against the own crawl.
- Recommendations API: list (filters, counts by status), detail, status workflow with timestamps, assignee
  validation, and regeneration from audit and visibility evidence (dismissed items stay dismissed).
- Worker queues: `content` (generation + keyword ideas) and `competitor` (snapshots).

**Verification (executed)**

- `npx vitest run --project shared --project core --project api`: **21 files, 246 tests passed**.
- `npx eslint .`: exit 0 (a literal BOM character in a regex was replaced with a `charCodeAt` check).
  `tsc` for shared, core, api and worker: all ok.

**Next unfinished task** (done; see the Phase E entry above)

- Phase E: reports (HTML + PDF via Chromium), billing (plans API, checkout, Stripe/Razorpay/dev adapters, webhooks),
  Google Search Console OAuth integration, admin API, scheduled jobs (audits, visibility, weekly summary), dev seed.

## 2026-10-22 — Phase A: discovery and architecture

**Completed**

- Environment survey: Node 24.16, npm 10.8, Git 2.53, MySQL 8.0.46 (`MySQL80` service), no Docker, no Redis.
- Portable Redis 8.10.2 for Windows downloaded, SHA-256 verified against the release digest, and started on
  `127.0.0.1:6379` (`PING` → `PONG`).
- MySQL credentials verified (`SELECT VERSION()` → 8.0.46, `caching_sha2_password`, `utf8mb4`).
- Reference site inspection attempted with WebFetch and Playwright Chromium. It is blocked by the site's firewall
  (HTTP 403, `X-Vercel-Mitigated: deny`). Documented in `docs/reference/README.md`; no screenshots are claimed.
- Dependency research: current majors identified and upgrade notes read for Prisma 7 (MySQL adapter),
  React Router 8, BullMQ 6, and the OpenAI Responses `web_search` tool.
- OpenAI key validated by listing models (`gpt-5.4-mini` chosen as the configurable default).
- Docs written: implementation plan, architecture, database (Mermaid ER), decisions, reference notes.
- `prisma/schema.prisma` drafted (40 models).

**Next**

- Phase B: monorepo tooling, packages, Prisma migration, API foundation, auth and tenancy.
