# Known limitations and credentials checklist

## External credentials checklist

Everything runs locally without external accounts, using development modes that are labeled in the UI. For a
real deployment, provide the following. Store secrets in a secret manager, never in `VITE_*` variables or the
repository. **Rotate any key that has been shared outside your secret store** (for example in chat or email).

| Variables                                                                      | Needed for                                                                   | Where to get it                                                                                                                                  | Without it                                                                                                      |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL` (+ `DATABASE_SSL`)                                              | Everything                                                                   | MySQL 8 server or managed service                                                                                                                | The app does not start                                                                                          |
| `REDIS_URL`                                                                    | Queues, scheduled jobs, rate limits                                          | Redis 6.2+ (`noeviction`)                                                                                                                        | Jobs cannot run; health check fails                                                                             |
| `SESSION_SECRET`, `ENCRYPTION_KEY`                                             | Sessions, CSRF tokens, encrypted OAuth tokens and queued emails              | Generate (see `.env.example`)                                                                                                                    | The app does not start                                                                                          |
| `OPENAI_API_KEY` (+ `LLM_PROVIDER=openai`)                                     | Content generation, AI visibility with OpenAI, keyword ideas, mention checks | platform.openai.com                                                                                                                              | Content uses the labeled development adapter (development only); OpenAI visibility shows "not configured"       |
| `PERPLEXITY_API_KEY`                                                           | Perplexity visibility provider                                               | perplexity.ai API settings                                                                                                                       | Provider shows "not configured"                                                                                 |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`                                     | Search Console and Business Profile integrations                             | Google Cloud Console (OAuth client, see [integrations.md](integrations.md))                                                                      | Integration shows setup instructions                                                                            |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` + price IDs                       | Payments (Stripe)                                                            | Stripe dashboard                                                                                                                                 | Use Razorpay, `BILLING_PROVIDER=none`, or development billing (not in production)                               |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` + plan IDs | Payments (Razorpay)                                                          | Razorpay dashboard                                                                                                                               | As above                                                                                                        |
| `SMTP_HOST`, `SMTP_USER`, `SMTP_PASSWORD`, `EMAIL_FROM`                        | Verification, password reset, invitations, notifications                     | Any SMTP provider                                                                                                                                | Development writes `.eml` files; production refuses console email                                               |
| Chromium (`PDF_CHROMIUM_EXECUTABLE_PATH` optional)                             | PDF reports                                                                  | `npx playwright install chromium`                                                                                                                | Reports are HTML only                                                                                           |
| `VITE_SITE_URL`                                                                | Canonical URLs, Open Graph, sitemap                                          | Your public domain                                                                                                                               | Defaults to `http://localhost:5173` in the built pages                                                          |
| `PYTRENDS_SERVICE_URL` (+ `npm run trends:start`)                              | Live Google Trends data, free and experimental (unofficial pytrends)         | Runs locally ([providers/keyword-trends.md](providers/keyword-trends.md))                                                                        | Keyword trends uses CSV files exported from Google Trends                                                       |
| `DATAFORSEO_LOGIN`, `DATAFORSEO_PASSWORD`                                      | Live Google Trends data, licensed and paid                                   | app.dataforseo.com                                                                                                                               | As above                                                                                                        |
| Google Business Profile API access                                             | Business Profile audit of the live profile, metrics, reviews and replies     | Google's "Application for Basic API Access" for the Cloud project ([providers/google-business-profile.md](providers/google-business-profile.md)) | Quota is 0: Google refuses every request and the page shows Google's reason; the audit uses the entered details |
| `SERP_PROVIDER=dataforseo` (+ DataForSEO login)                                | Live local rank grids (Google Maps and local pack)                           | app.dataforseo.com                                                                                                                               | Rank grids take manual observations only, labeled as manual                                                     |
| `GOOGLE_MAPS_API_KEY` (Places API (New))                                       | Filling a location from a Google link: address, phone, hours, category       | Google Cloud Console (enable Places API (New), restrict the key)                                                                                 | Only the name (and position, when the link has one) is filled                                                   |
| Keyword data provider                                                          | Search volume, difficulty, CPC                                               | Not integrated (needs a licensed provider)                                                                                                       | These metrics are not shown                                                                                     |

## Verification status of external providers

| Provider                 | Status                                                                                                                                                                                                                                                                 |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenAI                   | **Verified live** during development: a web search observation (`gpt-5.4-mini`) with 67 citations, and structured output                                                                                                                                               |
| Perplexity               | **Not verified live** (no key). Built against the documented Agent API, because Sonar Chat Completions support ended on 2026-09-27                                                                                                                                     |
| Google Search Console    | **Not verified live** (no OAuth client). OAuth, refresh, sync and revoke are covered by tests with a mocked HTTP layer                                                                                                                                                 |
| Google Business Profile  | **Not verified live** (no OAuth client, and API access needs Google's approval). Built against the live discovery documents (revision 20261021); accounts, locations, metrics, reviews, reply publishing and the 403 "not approved" case are tested with a fake Google |
| Google Merchant Center   | **Not verified live** (no OAuth client, verification or developer registration). Built against the Merchant API v1 discovery documents (revision 20261021); account, program, products and item issues are tested with a fake Google                                   |
| Gemini API (ungrounded)  | **Not verified live** (no key). Built against the v1beta discovery document (revision 20261023); tested with a fake API, including that no grounding tool is sent                                                                                                      |
| DataForSEO AI Mode       | **Not verified live** (no account). Built from the documented `ai_mode/live/advanced` endpoint; tested with fake responses                                                                                                                                             |
| Google Custom Search     | **Not verified live** (no key). Google’s official organic web-results API (free 100/day); built and tested with fake responses. Organic only, never the Maps local pack                                                                                                |
| DataForSEO Maps          | **Not verified live** (no account). Built from the documented Maps SERP endpoint; tested with fake responses                                                                                                                                                           |
| Stripe and Razorpay      | **Not verified live** (no keys). Webhook signatures, idempotency and state transitions are covered by tests with signed payloads                                                                                                                                       |
| SMTP                     | **Not verified live**. Email rendering and queueing are tested; development uses local `.eml` files                                                                                                                                                                    |
| Chromium PDF             | Verified locally                                                                                                                                                                                                                                                       |
| pytrends (Google Trends) | **Verified live** on 2026-10-23: interest over time, regions and related queries for a five-term comparison in India. Related topics came back empty from Google                                                                                                       |
| DataForSEO               | **Not verified live** (no account). Built from the documented Explore endpoint; tested with fake responses                                                                                                                                                             |
| Google Trends API        | **Not implemented**: a closed alpha whose request format is shared only with accepted testers                                                                                                                                                                          |

## Product limitations

- **Business Profile data is short-lived.** Google allows its content to be stored for at most 30 days, so Surfaced
  keeps only the latest sync (profile, 56 days of daily metrics, the 200 most recent reviews per location) and
  deletes older data daily. Long-term charts of Business Profile metrics are therefore not available; reports must
  fetch longer ranges from Google when they need them (not implemented yet). Profile edits and local posts are not
  implemented; only review replies are published, after approval. The Q&A feature no longer exists in Google's API.
- **Product checks are predictions.** Surfaced checks feed data against Google's product data specification
  (required attributes, currency per country, GTIN check digits, apparel rules in the six countries where they are
  required, counterfeit wording, landing page domain). It cannot see landing pages, images, shipping rules or
  policy reviews the way Google does; only Merchant Center's own item issues (when connected) are Google's decision.
  Merchant Center performance (clicks, impressions) is not read yet, and Surfaced does not edit products.
- **Map positions are found approximately.** "Find from address" uses OpenStreetMap, which often lacks Indian society
  and landmark addresses; it then returns the postal code or locality area, labeled approximate, and the user drags
  the pin onto the shop. The public Nominatim service allows light use only (one request per second); set
  `GEOCODER_URL` to your own instance for heavier use.
- **No free source gives Google Maps rankings.** The Maps local pack (the 3-business box) has no API and cannot be
  scraped within Google’s terms. The free Google option, the **Custom Search JSON API** (`GOOGLE_CSE_API_KEY` +
  `GOOGLE_CSE_CX`, 100 searches/day), returns Google **organic** web results only, country-level (not per grid
  point), labelled “organic SERP position”, never Maps. Real Maps rankings need a licensed provider (DataForSEO) or
  manual observation.
- **Local rank grids need a licensed provider or manual work.** Google has no API for Maps or local-pack rankings.
  Without `SERP_PROVIDER=dataforseo`, every grid point is entered by hand and labeled manual. CSV import of rank
  observations is not implemented yet.
- **No keyword metrics.** Search volume, difficulty, CPC and rank tracking need a licensed data provider, and none
  is integrated. AI keyword ideas are labeled as unmeasured.
- **Keyword trends are relative.** Google Trends values are scaled 0–100 within one comparison and are never search
  counts; different comparisons cannot be compared. pytrends is unofficial and archived: Google may change or block
  it, it is deliberately slow (one request every 8 s) and pauses for 15 minutes after a rate limit, and related
  topics are often empty. Interest by region with several terms shows each place's split between the terms. Keyword
  Planner volumes are not integrated, so opportunity scores leave search volume and competition out.
- **AI answers are samples per surface.** Google AI Mode and AI Overviews have no API: they are measured through the
  licensed provider (AI Mode only, opt-in) or recorded by hand, and the two features are never combined. Manual
  observations record one answer seen once by one person; mentions in them are found by name matching, without AI
  verification. A prompt's city reaches OpenAI web search (approximate location) and AI Mode (the coordinates of a
  business location in that city); Perplexity receives only the country, and model-knowledge answers have no
  location. Each observation lists these limits.
- **AI visibility is a sample.** Answers come from official provider APIs for the prompts you track. OpenAI with
  web search approximates, but is not identical to, what ChatGPT users see. Consumer apps personalize answers.
  Assistants without an official API are not tracked; adapters for other providers are not implemented.
- **The crawler does not execute JavaScript.** Content rendered only in the browser is not seen. Audits crawl
  every page reachable through internal links and sitemaps by default. They respect robots.txt, never log in,
  and skip links caught by loop protection: more than 100 query-string variants of one path, or URLs longer
  than 2,048 characters. Page and depth caps are optional, per project, per plan (admin) or per server
  (`CRAWLER_MAX_PAGES_HARD_LIMIT`). The free public audit stays at 20 pages.
- **Very large sites take time and memory.** Requests to one host are throttled (250 ms by default, or the
  robots.txt `Crawl-delay`), so 100,000 pages take several hours. Analysis loads the whole crawl into the
  worker: plan roughly 1 GB of worker memory per 100,000 pages with dense internal linking. A sitemap is read up to
  500,000 URLs when no page cap is set. Robots-blocked URLs are counted in full, but links to them are checked
  for the first 500 only.
- **Competitor snapshots** read a small number of public pages per competitor.
- **Planned integrations:** GA4, WordPress and Shopify are listed as planned. Content is exported for manual
  publishing; nothing is published automatically.
- **Storage** is a local filesystem directory. With several servers it must be a shared volume; object storage
  (S3 and similar) is not implemented.
- **No real-time push.** Job progress is polled every one to three seconds.
- **English UI only.** Target countries and languages apply to prompts and content, not to the interface.
- **Scheduling uses UTC**: monthly usage periods, schedules and the weekly summary.
- **White-label reports** support a brand name and accent color only.
- **Billing:** taxes, invoices and proration are handled by the payment provider. With Razorpay, a workspace
  must cancel its current paid subscription before choosing another plan.
- **Security:** no multi-factor authentication, single sign-on or CAPTCHA (see [security.md](security.md)).
- **Legal pages** describe the implemented data handling but have not been reviewed by a lawyer.
- **Web performance:** the JavaScript entry chunk is about 180 KB gzipped (React, router, query and the marketing
  and auth pages). Marketing pages are fully prerendered, so content appears before JavaScript loads. Further
  route-level code splitting is possible.
- **Accessibility:** forms, dialogs, menus, tables and charts have labels, keyboard support and table
  alternatives, but no formal WCAG audit has been performed.

## Engineering notes

- **Reference site:** aeoengine.ai blocked automated access (HTTP 403 from its firewall). No screenshots were
  captured, and the design is original. See [reference/README.md](reference/README.md).
- **Prisma reset guard:** Prisma 7 refuses `migrate reset` when it detects an AI agent and asks for explicit user
  consent. Test setup therefore uses the non-destructive `migrate deploy` with unique test data. To wipe a test
  database, run the reset yourself.
- **Deployment:** this repository has not been deployed to a hosted environment as part of this work; see
  [deployment.md](deployment.md).
- **CI:** there is no CI pipeline configuration. The test commands are listed in [test-report.md](test-report.md).
