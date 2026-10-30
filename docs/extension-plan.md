# Extension plan: local, commerce, search performance, authority and agency operations

Design for the scope listed in [feature-audit.md](feature-audit.md): the incremental feature request (X1–X8) and the
three-phase list (E1–E5, G1–G6, A1–A6). Status per feature is tracked in the audit table; work logs are in
[progress.md](progress.md). Decisions continue the numbering in [decisions.md](decisions.md).

## Principles carried over

- Every number shown comes from a stored record with its source and capture time. Demo providers exist only for
  development and tests and are labeled everywhere.
- Changes to anything outside Surfaced (a Business Profile, a Merchant Center feed, a CMS, a customer website) need an
  approved approval request that matches the exact content being published.
- Each external provider has an adapter that reports "configured" or "not configured" honestly. Nothing is
  marked verified without a live check.
- Tenant isolation is enforced in the API on every request. Resources in other workspaces return 404.
- Recurring jobs are idempotent (claims, unique keys) and recoverable (job records, stuck-job reconciliation).

## Architecture decisions

### D-024 Agency client workspaces and the Client role

- New workspace role **CLIENT** (client portal user). Clients can view projects, dashboards and reports, decide
  approvals, edit the onboarding brief and comment on approvals. They cannot run paid actions, change SEO data,
  manage members, integrations or billing.
- New table `agency_client_links` (agency workspace → client workspace) with status (PENDING, ACTIVE, REVOKED),
  the access level agency members receive (ADMIN or MEMBER), whether approvals are delegated to the agency, and who
  pays (AGENCY or CLIENT).
- **Effective access** = the direct membership role, or (if none) inherited access: an ACTIVE link plus membership
  in the agency workspace. Agency owners and admins get the link's access level, and agency members get MEMBER.
  CLIENT is never inherited. Both access guards (`requireWorkspaceAccess`, `requireProjectAccess`) and workspace
  listings use this resolution.
- **Approvals** are decided by direct members with `approval.decide` (OWNER, ADMIN, CLIENT). Inherited agency
  members can decide only when the client delegated approvals on the link.
- Agencies create client workspaces from the Agency area (plan feature `clientWorkspaces`). The agency's white-label
  settings brand the client's app shell and reports while the link is active.
- A client owner can revoke the link at any time; inherited access ends immediately.
- With AGENCY billing, the client workspace uses the agency's plan, and monthly quotas are pooled across the agency
  and its AGENCY-billed clients.

### D-025 Managed service packages and engagements

- `service_packages` are configured by platform administrators (or by an agency, for its own templates). Each has:
  - commitments: websites, articles per month, backlink placement target range, PR campaigns per month or quarter,
    brand mention target range, included services;
  - an approval policy per deliverable type;
  - pricing (monthly fee or "price on request") and marketing bullets.
- Defaults: **Managed Growth**, **Managed Scale** and **Enterprise**. Their prices are left unset ("price on
  request") until an administrator sets them.
- A **service engagement** links a client workspace and one website (project) to a package, run by a provider
  workspace: the platform's service-provider workspace, or an agency. It has a status (REQUESTED, ONBOARDING, ACTIVE,
  PAUSED, ENDED, DECLINED), effective commitments (package values plus overrides), the approval policy, an agreed fee
  and staff assignments.
- Managed services are sold through a request and activation flow (sales-led), not self-serve checkout. A package
  checkout would share the plan subscription path, whose webhooks resolve one subscription per workspace and would
  overwrite the plan. The agreed fee and billing reference are recorded on the engagement.
- **Counting rules for delivered work** (enforced in one module, used by the dashboard and reports):
  - articles: content approved in the month;
  - backlinks: placements whose live URL was verified in the month, with syndicated copies reported separately;
  - PR: campaigns launched in the period, plus verified coverage;
  - brand mentions: contributions or mentions verified live, or confirmed manually and labeled as such.
  - Targets are service commitments, not ranking guarantees.

### D-026 Approval requests for every external change

- `approval_requests` cover these entity types: profile edits, posts, review replies, product change sets, site
  optimizations, CMS publications, outreach drafts, PR assets, community contributions, strategy reviews and content.
- Each request stores a snapshot and its SHA-256 hash. Publishing checks that the latest decision is APPROVED for the
  current hash, so editing after approval requires a new approval.
- Publishing creates a **site change** record (D-029) and emits events (D-030).

### D-027 Provider adapters, capture methods and costs

- Every observation stores `captureMethod`: API (official), LICENSED_PROVIDER (third-party data API), MANUAL,
  IMPORT or DEMO. It also stores the provider name, the capture time and any measurement limitations.
- `provider_usage_events` record each paid external call: provider, operation, units (tokens, requests), the estimated
  cost and the job. `provider_rates` (admin-editable) convert units to cost. With no rate configured, the cost shows
  "not priced" rather than an invented number.

### D-028 SERP and maps data (rank tracking, local grid, Google AI features)

- Google offers no API for organic rankings, the local pack or AI Overviews. These come from one licensed provider
  adapter configured by the customer (choice and endpoints: see "Provider notes"), or from imported or manual
  observations.
- Search Console average position remains the first-party measure and is labeled differently from provider ranks.

### D-029 Change history and impact monitoring

- `site_changes` records what changed, where, when, by whom and how (CMS publish, Business Profile or Merchant
  update, optimization applied, or a manual entry).
- Verification fetches the live URL safely and checks for the new value.
- Measurements compare equal windows before and after the change: Search Console per page or query, ranks and Web
  Vitals. The result is classified as positive, negative, inconclusive or "insufficient data". It counts only when
  the change exceeds both a minimum effect and the window's own variability, adjusted for the site-wide trend.
- Every result is labeled as an observed association, not proof of causation.

### D-030 Events, alerts and webhooks

- `emitEvent()` writes domain events (for example `audit.completed`, `rank.changed`, `approval.requested`,
  `content.published`, `placement.verified`, `alert.triggered`). Events fan out to webhook deliveries and alert
  evaluation.
- **Alert rules** evaluate real conditions after the relevant job, and on a schedule for time-based rules. Examples:
  clicks drop, rank drop, Web Vitals regression, a new low-star review, product disapprovals, a lost backlink, an AI
  visibility drop, new critical audit issues, quota near the limit. Rules have cooldowns and delivery channels:
  in-app, email (console mode in development) and webhook.
- **Outbound webhooks** are signed with HMAC-SHA256 over the timestamp and body. Deliveries are retried with backoff
  through BullMQ and logged. Endpoints must pass the SSRF policy.

### D-031 Public API

- Workspace API keys are stored hashed and shown once. Each key has scopes, an optional expiry, revocation and a
  per-key rate limit.
- The public API lives at `/api/public/v1` with the same tenant isolation and its own OpenAPI document. It covers
  read endpoints for projects, audits, issues, visibility, ranks, Web Vitals, locations and products, and write
  endpoints for conversions and site changes.

### D-032 Usage-based billing and service margins

- Plans may define overage pricing per usage metric. Monthly usage statements list included and billable usage.
  Charging happens only through a configured billing provider; in development the statement is labeled
  "not charged".
- **Service margin** for each engagement and month = the agreed fee minus provider costs, direct costs (PR costs,
  paid placements) and labor (logged task time × the member's cost rate). Every input is shown, and missing rates
  are flagged.

### D-033 Attribution

- Conversions come from GA4 (Analytics Data API, OAuth), CSV import, manual entry or the public API.
- Each conversion is associated with the acquisition data recorded with it (UTM source, medium and campaign,
  referrer, landing page, GA4 channel). Surfaced's own tracked links (Business Profile website links, community
  posts, PR) carry UTM tags.
- Reports show associations by recorded source and never claim causation or model-based credit.

### D-034 Markets

- `markets` define country, language and the URL scope (subfolder, subdomain or domain) per project. GSC country
  data, rank tracking, AI prompts and reports are split by market.
- hreflang is extracted by the crawler from HTML, HTTP headers and sitemaps, and validated by new audit rules
  (codes, return links, self-reference, x-default, targets that are not indexable).

## Data model (new tables)

| Area                        | Tables                                                                                                                                                                                                                                                                          |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Foundation                  | `agency_client_links`, `approval_requests`, `tasks`, `task_time_entries`, `provider_rates`, `provider_usage_events`, `domain_events`, `alert_rules`, `alert_events`, `webhook_endpoints`, `webhook_deliveries`, `api_keys`, `markets`, `integration_credentials`                |
| Local                       | `business_locations`, `location_snapshots`, `location_changes`, `local_posts`, `location_reviews`, `review_replies`, `location_metrics`, `location_keyword_impressions`, `local_search_areas`, `local_competitors`, `local_rank_grids`, `local_rank_scans`, `local_rank_points` |
| Commerce                    | `merchant_accounts`, `products`, `product_issues`, `product_sync_runs`, `product_change_sets`, `product_changes`, `product_page_checks`, `merchant_performance`                                                                                                                 |
| Search performance          | `site_changes`, `change_measurements`, `rank_tracking_configs`, `rank_checks`, `web_vitals_targets`, `web_vitals_measurements` (+ new Search Console dimensions)                                                                                                                |
| Content operations          | `content_publications` (+ planning and refresh fields on `content_documents`)                                                                                                                                                                                                   |
| Authority                   | `publications`, `backlink_prospects`, `outreach_drafts`, `placements`, `pr_campaigns`, `pr_campaign_costs`, `public_mentions`, `community_opportunities`, `community_contributions`                                                                                             |
| Agency and managed services | `service_packages`, `service_engagements`, `engagement_assignments`, `client_briefs`, `engagement_periods`, `strategy_reviews`, `report_templates`, `report_deliveries`, `usage_statements`                                                                                     |
| Attribution                 | `analytics_metrics`, `conversion_events`, `tracked_links`                                                                                                                                                                                                                       |

Existing tables gain columns where reuse is natural: workspace roles (CLIENT), platform role unchanged, AI prompt
location fields, observation capture method and limitations, citation source category, crawled-page hreflang,
keyword market links, recommendation categories and sources for the new modules.

## Build order

1. **Foundation:** roles and permissions, agency links and access resolution, approvals, tasks, events, provider
   usage and costs, plan feature flags (backward-compatible limits), a generic Google OAuth flow, and safe URL
   verification helpers.
2. **Local:** locations (manual and Business Profile), multi-location management, profile audit, approval-gated
   edits, posts and replies, performance metrics, search areas, local competitors, the rank grid (import, provider,
   demo) and tasks.
3. **Commerce:** catalogue import and Merchant Center sync, product data inspection, Product/Offer structured data
   validation, landing-page consistency, recommendations, approval-gated change sets, verification and performance.
4. **Search performance:** Search Console extensions and opportunities, change history and impact monitoring, rank
   tracking, Core Web Vitals and international SEO (markets, hreflang).
5. **AI visibility:** Gemini, Google AI features through the licensed provider, manual observations, location-aware
   prompts and citation source intelligence.
6. **Content operations:** editorial calendar, refresh schedules and CMS publishing (WordPress, Shopify, signed
   webhook) with verification.
7. **Authority:** backlinks, digital PR, brand mentions and community workflows.
8. **Agency:** packages and engagements, client workspaces and portal, approval center, team tasks, briefs,
   strategy reviews, custom and scheduled reports, managed deliverables.
9. **Platform:** alerts, public API and webhooks, usage-based billing and margins, attribution.
10. **Verification:** migrations, lint, typecheck, unit/integration/E2E tests for the listed journeys, builds and
    documentation.

## Provider notes

Current provider facts and the decisions they drove, checked on 2026-10-22:

- [Google Business Profile](providers/google-business-profile.md): access approval (quota 0 until approved), the
  30-day storage limit, consent and notice rules, and no exposure through the public API.
- [Google Merchant API](providers/google-merchant-center.md): mandatory developer registration, supplemental API
  data sources for edits, MCQL reports (`ORGANIC` vs `ADS`), and jewellery attributes.
- [AI answer and SERP providers](providers/ai-and-serp-providers.md):
  - Gemini grounding results may not be tracked, so only ungrounded Gemini is used;
  - Google offers no API for AI Overviews or rankings, so DataForSEO is an optional licensed adapter with a
    compliance note;
  - the Search Console generative AI report is imported from CSV.
- [GA4, PageSpeed/CrUX, structured data and hreflang](providers/google-analytics-web-vitals-structured-data.md):
  - GA4: `keyEvents` and the AI Assistant channel;
  - PageSpeed and CrUX need an API key;
  - Product, Offer and hreflang rules;
  - Stripe meters and Razorpay limits.
- [Brand mention sources and CMS publishing](providers/mentions-and-cms.md):
  - permitted sources (YouTube, Hacker News, GDELT); Reddit and the other social platforms are excluded;
  - WordPress Application Passwords, SEO meta fields and Shopify GraphQL.
