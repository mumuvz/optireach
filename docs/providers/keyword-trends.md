# Keyword trends providers

Keyword trends (SEO → **Keyword trends**, `/app/p/:projectId/trends`) shows Google Trends data for a set of terms. It
compares that data with the project's crawled pages and the project's own Search Console figures, and can suggest
where to add the terms the site misses (AI placements, checked against real pages and headings).

Every report has **exactly one source**. Data from different sources is never merged or converted. Google Trends
values are **relative interest** (0–100, scaled within one comparison), never search counts.

## Sources at a glance

| Source (`TRENDS_PROVIDERS` name)              | Cost         | Status in this codebase                                              | Tested how                                                                      |
| --------------------------------------------- | ------------ | -------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| CSV export from Google Trends (`csv`)         | Free         | Always available                                                     | Unit and API tests with sample exports of all four chart types                  |
| pytrends service (`pytrends`)                 | Free         | Optional, **experimental**, off until `PYTRENDS_SERVICE_URL` is set  | **Live on 2026-10-23** (see below), plus unit tests with a fake pytrends client |
| DataForSEO (`dataforseo`)                     | Paid         | Optional, off until `DATAFORSEO_LOGIN`/`DATAFORSEO_PASSWORD` are set | Only with recorded-format fake responses: **no live account was used**          |
| Google Trends API alpha (`google_trends_api`) | Free (alpha) | **Not implemented.** Reported as unavailable                         | Not tested: Google publishes the request format only to accepted testers        |
| Development fixture (`fixture`)               | Free         | Generated sample data, labeled everywhere, refused in production     | API tests and the E2E journey                                                   |
| Google Search Console (your own data)         | Free         | Shown next to trends when connected (never combined with them)       | Tests with stored Search Console rows (no live Google account in this change)   |
| Google Ads Keyword Planner                    | Ads account  | **Not implemented** (design below). Shown as "not connected"         | —                                                                               |

`TRENDS_PROVIDERS` (default `csv,pytrends,dataforseo,google_trends_api`) is the administrator's switch: a source
left out is hidden from the status endpoint and the UI, and requests for it are refused. The UI is driven by
`GET /projects/:id/trends/status`, so enabling or disabling a source needs no UI change.

## CSV import (always available)

In Google Trends, open the comparison, click the download icon on each chart and upload the files unchanged.
"Open in Google Trends" on the page builds the same comparison link as trends.google.com.

| Chart                                | File              | Parsed into                                                                    |
| ------------------------------------ | ----------------- | ------------------------------------------------------------------------------ |
| Interest over time                   | `multiTimeline`   | Periods × terms; `<1` becomes 0, empty cells stay empty (no data, not zero)    |
| Interest by subregion / city / metro | `geoMap`          | Places × terms; with several terms the values are shares (they add up to 100%) |
| Related queries                      | `relatedQueries`  | TOP (relative popularity) and RISING (growth, "Breakout" = over 5,000%)        |
| Related topics                       | `relatedEntities` | Same, with the topic type split off ("Canva - Software company")               |

The import dialog reads the files **in the browser first** and shows each file's kind, terms, row count and first
rows before anything is saved (`POST …/trends/import/preview` does the same for API clients). Unknown layouts are
reported as "not recognised", never guessed. Google's related files do not say which term they belong to, so the
user picks the term when the comparison has several. Each imported file is recorded in `trend_csv_imports` (name,
kind, terms, place, period, header note, row count, import time).

## pytrends service (optional, experimental)

[pytrends](https://github.com/GeneralMills/pytrends) is an **unofficial** Python library that reads Google Trends'
website endpoints. It was **archived on 2025-04-17**. Google may change or block those endpoints at any time, and
Google's Terms of Service restrict automated access to its services: whether to enable this source is the
operator's decision. It is off unless `PYTRENDS_SERVICE_URL` is set.

The service lives in `services/pytrends` (Python standard library HTTP server + `pytrends==4.9.2`); Node stays the
main backend and calls it over HTTP.

```bash
npm run trends:setup    # creates services/pytrends/.venv and installs requirements.txt
npm run trends:start    # listens on PYTRENDS_SERVICE_URL (default http://127.0.0.1:4410)
npm run trends:test     # unit tests with a fake pytrends client (no request reaches Google)
```

Then set `PYTRENDS_SERVICE_URL=http://127.0.0.1:4410` (and a `PYTRENDS_SERVICE_TOKEN`, required if the service
listens beyond localhost) in the API and worker environment.

**Endpoints** (JSON, header `X-Service-Token` when a token is set):

| Endpoint                   | Input                                                        | Output                                                       |
| -------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------ |
| `GET /health`              | —                                                            | installed, robots.txt allowed, cool-down seconds, last error |
| `POST /interest-over-time` | 1–5 `keywords`, `geo`, `timeframe`, `category`, `hl`         | points with per-term values and `isPartial`                  |
| `POST /interest-by-region` | as above + `resolution` (`COUNTRY`, `REGION`, `CITY`, `DMA`) | places with geo codes and per-term values                    |
| `POST /related`            | one `keyword`, `kinds` (`queries`, `topics`)                 | top and rising queries and topics                            |

**Safeguards (what the service does and does not do):**

- It checks `trends.google.com/robots.txt` (at most once a day) and refuses with `DISALLOWED` if the endpoints
  it uses are not allowed. On 2026-10-23 robots.txt disallowed only `/explore?` and `/trends/explore?`; the
  `/trends/api/…` endpoints pytrends uses were allowed.
- One request to Google at a time, at least `PYTRENDS_MIN_INTERVAL_SECONDS` (default 8) apart, plus a few seconds
  between the calls of one related-searches request.
- After a 429 from Google it stops calling Google for `PYTRENDS_COOLDOWN_SECONDS` (default 900) and answers
  `RATE_LIMITED` with `retryAfterSeconds`. **No proxies, rotating identities, retries or CAPTCHA handling** are
  used to get around Google's limits; pytrends' own retries are turned off.
- Timeouts (10 s connect, 30 s read), an in-memory cache (`PYTRENDS_CACHE_SECONDS`, default 3600) and input
  validation (≤ 5 terms, geo codes, a fixed set of periods).
- Explicit errors: `INVALID_REQUEST`, `NO_DATA`, `RATE_LIMITED`, `TIMEOUT`, `DISALLOWED`, `UNAVAILABLE`,
  `UPSTREAM_ERROR`. pytrends 4.9.2 crashes when Google returns an empty related list; the service reports that as
  "no related topics/queries" instead.
- The start script passes the service only its `PYTRENDS_*` settings and OS variables, never the app's other
  secrets.

**On the Node side** (`core/trends/providers.ts`), interest over time is required: if it fails, the report fails
with the reason. Regions and related searches are optional: a failure there is listed under "limitations" and the
report is marked **partial**. After a rate limit or refusal, the remaining requests are skipped, not retried.
Rate limits, refusals and missing setup are permanent job errors (no automatic retry); timeouts are retried once.

**Live tests (2026-10-23, from this development machine, about 15 service calls in total):**

- The user's example comparison (India, past 90 days, category 293 "Weddings", five terms) through the Node
  provider: 99 s for 7 service calls, with no rate limiting. It returned 93 daily points, all 36 regions, and
  related queries for every term. Google returned **no related topics** for any of these terms; the report says so.
- Each service call makes two or three requests to Google, plus a cookie request when the service creates its
  client. That run created a client per call; the service now reuses one client per language, which was checked
  with two further live calls (interest over time for 12 months, then related queries).
- Behaviour under heavier load is unknown: Google does not publish its limits.

## DataForSEO (optional, paid)

`POST https://api.dataforseo.com/v3/keywords_data/google_trends/explore/live` with Basic auth. One request returns
interest over time (and the regional map) for up to five terms; related queries and topics need one request per
term. About $0.009 per request; requests are recorded as provider usage. Sub-regions are not supported here.
**Implemented from DataForSEO's documentation and tested only with fake responses** — verify with a real account
before relying on it.

## Official Google Trends API (alpha)

Announced in July 2025 as an application-only alpha (consistently scaled values, five-year window, regions and
sub-regions). Google shares the request format only with accepted testers, so **no adapter is implemented**:
`GOOGLE_TRENDS_API_KEY` + `GOOGLE_TRENDS_API_ALPHA_ACCESS=true` only change the status message, and requests are
refused as unavailable. To add it: implement `fetch()` in `GoogleTrendsApiProvider` against Google's documentation,
test it with real access, and update this page.

## Google Search Console (your own measured data)

When the project's Search Console integration is connected and synced, each term shows its clicks, impressions,
CTR and average position over the latest synced query range, labeled "your own measured data". These numbers are
**never combined** with Trends interest. The opportunity score uses them as a separate signal.

## Google Ads Keyword Planner (design, not implemented)

Keyword Planner would supply measured monthly search volume (as ranges for most accounts) and competition. Proposed
design, not built:

- A `KeywordVolumeProvider` that fills `project_keywords.searchVolume`, `difficulty`, `cpc`, `metricsSource` and
  `metricsFetchedAt` (the columns the opportunity score already reads), never Trends tables.
- Needs a Google Ads developer token (basic access), OAuth for an Ads account with active campaigns, and a customer
  ID; uses `KeywordPlanIdeaService.GenerateKeywordHistoricalMetrics`.
- Volumes are stored with their range and source. Nothing is estimated when the API is unavailable.

The status endpoint reports it as not connected.

## Data model and caching

| Table                     | Holds                                                                                                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `trend_reports`           | One comparison: source, terms, country, region, language, period, category, data types, cache key, partial flag, limitations, retrieval and expiry times, analysis |
| `trend_observations`      | Interest over time: term, period start, value (null = no data), partial flag                                                                                       |
| `trend_regional_interest` | Term, place name and code, resolution, `single` or `share` comparison, value                                                                                       |
| `trend_related_items`     | Term, `QUERY`/`TOPIC`, `TOP`/`RISING`, rank, label, topic type, value or growth                                                                                    |
| `trend_csv_imports`       | Each imported file                                                                                                                                                 |
| `trend_provider_events`   | Outcome of every provider request (kept 90 days): success, cache hit, rate limit, timeout…                                                                         |
| `trend_saved_queries`     | Saved comparisons with a refresh schedule (`NONE`, `WEEKLY`, `MONTHLY`)                                                                                            |

- **Cache:** the cache key covers the source, terms (any order or case), place, period, category, language and
  data types. A request that matches a complete, unexpired report copies that report's data rows into a new
  report for the requesting project, keeping the original retrieval time. Report details of other tenants are
  never exposed. Lifetimes come from `TRENDS_CACHE_TTL_HOURS`, e.g. `default=12,regions=24,pytrends.interest=6`
  (the most specific entry wins; a report uses its shortest data type).
- **Limits:** one report per project at a time, 20 reports per project per day, and
  `TRENDS_LIVE_REPORTS_PER_WORKSPACE_PER_DAY` (default 30) live lookups per workspace (cache hits and imports do
  not count). A report with AI placements uses one AI keyword run of the monthly quota.
- **Queue:** reports run on the `trends` BullMQ queue (concurrency 2, limiter 10 a minute). Saved comparisons with
  a schedule are started hourly by the `scheduled-trends` maintenance task, without AI placements.

## Keyword opportunity scores

Keyword research → **Opportunities** scores each keyword from the signals it has (`GET
/projects/:id/keywords/opportunities`):

| Signal                 | Points | From                                                                         |
| ---------------------- | ------ | ---------------------------------------------------------------------------- |
| Search trend           | 20     | The newest trends report that mentions the keyword (one report, never a mix) |
| Search Console demand  | 25     | Impressions (log scale) plus room to grow (position 4–20, or low CTR)        |
| Measured search volume | 20     | A keyword-data provider only                                                 |
| Relevance              | 15     | Primary flag and priority                                                    |
| Competition            | 10     | Provider difficulty only                                                     |
| Content gap            | 10     | Whether the latest crawl targets the phrase                                  |

The score is out of the points that are **available** for that keyword. Missing signals are listed and left out,
and the confidence label says how much of the full set was available. Next steps are rule-based: landing page,
article, page update, FAQ answer, local page, AEO answer or GEO coverage.

## Troubleshooting

| What you see                                                     | Cause and fix                                                                                                                                                                                               |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| pytrends shows **Not set up**                                    | `PYTRENDS_SERVICE_URL` is missing from `.env`, or `npm run dev` was not restarted after adding it (the API and worker read `.env` only at start).                                                           |
| **A live data source is set up but not reachable** with a reason | The page shows the service's own answer: not running (`npm run trends:start`), a token that differs between the service and the app, or a pause after Google rate-limited it. Fix it, then **Check again**. |
| "Port 4410 is already in use" when starting the service          | Another copy is still running. Only one copy may use the port (on Windows this is enforced since 2026-10-23); stop the old one or choose another port in `PYTRENDS_SERVICE_URL`.                            |
| **Paused N min**                                                 | Google answered "too many requests". The service waits 15 minutes on purpose; cached comparisons and CSV import still work.                                                                                 |

## City filter

Google Trends' smallest place is a state or region (plus metro areas in the US). Its city breakdown, requested
through pytrends on 2026-10-23, returned 200 small places without data for India: at country level, for Gujarat,
and even for "cricket". So the **City** field does not pretend to measure one city:

- Each term is sent with the city added ("wedding card" → "wedding card surat"), and the comparison is measured in
  the city's state (filled in for about 60 Indian and 18 US cities; other city names can be typed).
- Reports, history and exports label it "searches mentioning Surat in Gujarat", and the limitations say it is not
  every search made in the city.
- These city-mentioning searches are often the ones a local landing page targets. Low-volume cities can return
  "no data", which is reported as such.
