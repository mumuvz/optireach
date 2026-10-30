# Database design (MySQL 8 · Prisma 7)

The source of truth is [`prisma/schema.prisma`](../prisma/schema.prisma), and migrations live in `prisma/migrations/`.
The diagrams below are split by domain so they stay readable. Every tenant-owned table is reachable from
`workspaces` through foreign keys, and API services always scope queries by the caller's workspace memberships.

## Conventions

| Topic        | Rule                                                                                                                                                                                                   |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Primary keys | `VARCHAR(32)` CUIDs (non-sequential). Join tables use composite keys.                                                                                                                                  |
| Time         | `DATETIME(3)`, written in UTC by Prisma. Search Console days use `DATE`.                                                                                                                               |
| Money        | `DECIMAL(10,2)` (`subscription_plans`, `billing_invoices`, keyword CPC).                                                                                                                               |
| Long URLs    | `VARCHAR(2048)`, plus a `CHAR(64)` SHA-256 hash column for unique/indexed lookups (InnoDB cannot index 2048 utf8mb4 chars).                                                                            |
| JSON         | Only for small, schema-validated structures: settings snapshots, evidence, code lists (countries, languages, provider keys), plan limits. Never for relational data.                                   |
| Deletion     | `ON DELETE CASCADE` from workspace → project → everything below it. User references on content (author, assignee, approver) use `SET NULL`. Plans use `RESTRICT`.                                      |
| Idempotency  | `ai_visibility_observations.idempotencyKey`, `usage_records.idempotencyKey`, `content_versions.generationJobId`, `webhook_events (provider,eventId)`, `billing_invoices (provider,providerInvoiceId)`. |
| Secrets      | Session/verification/reset/invitation/OAuth-state tokens are stored only as SHA-256 hashes. OAuth access and refresh tokens and PKCE verifiers are AES-256-GCM ciphertext.                             |
| Demo data    | `projects.isDemo`, `crawl_jobs.isDemo`, `audit_runs.isDemo`, `ai_visibility_runs.isDemo` and `ai_visibility_observations.isDemo` flag records created by the dev seed or mock provider.                |

## Identity, tenancy, billing

```mermaid
erDiagram
  users ||--o{ sessions : "authenticates"
  users ||--o{ user_tokens : "verify / reset"
  users ||--o{ workspace_members : "belongs to"
  workspaces ||--o{ workspace_members : "has"
  workspaces ||--o{ workspace_invitations : "invites"
  users ||--o{ workspace_invitations : "sent"
  workspaces ||--o| subscriptions : "has one"
  subscription_plans ||--o{ subscriptions : "priced by"
  subscriptions ||--o{ billing_invoices : "bills"
  workspaces ||--o{ billing_invoices : "owns"
  workspaces ||--o{ usage_records : "meters"
  workspaces ||--o{ projects : "owns"
  users ||--o{ notifications : "receives"
  workspaces ||--o{ audit_logs : "records"
  users ||--o{ audit_logs : "acts"
  workspaces ||--o{ background_job_records : "runs"

  users {
    varchar id PK
    varchar email UK
    varchar passwordHash "argon2id"
    datetime emailVerifiedAt
    enum platformRole "USER|ADMIN"
    datetime disabledAt
    datetime deletionRequestedAt
  }
  sessions {
    varchar id PK
    char tokenHash UK
    datetime expiresAt
  }
  workspace_members {
    varchar workspaceId FK
    varchar userId FK
    enum role "OWNER|ADMIN|MEMBER"
  }
  subscriptions {
    varchar workspaceId UK
    varchar planId FK
    enum status
    enum provider "NONE|DEV|STRIPE|RAZORPAY"
    datetime currentPeriodEnd
    bool cancelAtPeriodEnd
  }
  subscription_plans {
    varchar key UK
    decimal priceMonthly
    decimal priceYearly
    json limits
  }
  usage_records {
    enum metric
    int quantity
    char periodKey "YYYY-MM"
    varchar idempotencyKey UK
  }
  webhook_events {
    enum provider
    varchar eventId "UK with provider"
    enum status
  }
```

## Projects, crawling and audits

```mermaid
erDiagram
  projects ||--o{ project_competitors : "tracks"
  projects ||--o{ crawl_jobs : "crawls"
  crawl_jobs ||--o{ crawled_pages : "fetched"
  crawl_jobs ||--o{ crawled_links : "discovered"
  crawled_pages ||--o{ crawled_links : "links out"
  crawl_jobs ||--o{ audit_runs : "scored by"
  projects ||--o{ audit_runs : "has"
  projects ||--o{ audit_issues : "has"
  audit_runs ||--o{ audit_issue_occurrences : "detected"
  audit_issues ||--o{ audit_issue_occurrences : "seen in"
  crawled_pages ||--o{ audit_issue_occurrences : "on page"
  crawl_jobs ||--o| public_audits : "free audit"
  project_competitors ||--o{ competitor_snapshots : "public metadata"
  projects ||--o{ recommendations : "suggests"

  crawl_jobs {
    varchar projectId FK "null for free audits"
    enum status
    json settings "limit snapshot"
    int pagesCrawled
    int progress
    datetime cancelRequestedAt
  }
  crawled_pages {
    char urlHash "UK with crawlJobId"
    int statusCode
    int responseTimeMs
    json redirectChain
    bool isIndexable
    varchar title
    text metaDescription
    json headings
    json structuredData
    bool inSitemap
  }
  audit_runs {
    int score "0-100 diagnostic index"
    json categoryScores
    json issueCounts
    json weights "snapshot"
  }
  audit_issues {
    varchar ruleId
    enum category
    enum severity
    char fingerprint "UK with projectId"
    json evidence
    text suggestedFix
    enum status "OPEN|IGNORED|RESOLVED"
    datetime firstDetectedAt
    datetime lastDetectedAt
  }
  recommendations {
    char fingerprint "UK with projectId"
    enum category
    enum status
    varchar assigneeId FK
  }
```

## AI visibility (AEO/GEO)

```mermaid
erDiagram
  projects ||--o{ ai_prompts : "tracks"
  ai_prompts ||--o{ ai_prompt_competitors : "compares"
  project_competitors ||--o{ ai_prompt_competitors : "in"
  projects ||--o{ ai_visibility_runs : "executes"
  ai_visibility_runs ||--o{ ai_visibility_observations : "produces"
  ai_prompts ||--o{ ai_visibility_observations : "observed"
  ai_visibility_observations ||--o{ brand_mentions : "mentions"
  ai_visibility_observations ||--o{ ai_citations : "cites"
  project_competitors ||--o{ brand_mentions : "competitor"
  project_competitors ||--o{ ai_citations : "competitor domain"

  ai_prompts {
    varchar text
    char country
    varchar language
    json providers "provider keys"
    enum frequency
    enum status
    datetime nextRunAt
  }
  ai_visibility_observations {
    varchar provider
    varchar model
    enum status
    bool isDemo
    json rawResponse "redacted"
    mediumtext answerText
    bool brandMentioned
    bool brandCited
    enum sentiment "AI estimate"
    varchar idempotencyKey UK
  }
  brand_mentions {
    enum entityType "BRAND|COMPETITOR"
    enum matchType "NAME|ALIAS|DOMAIN|AI_ENTITY"
    int rank
  }
  ai_citations {
    varchar url
    varchar domain
    bool isOwnedDomain
    enum sourceType
  }
```

## Content, keywords, reports, integrations

```mermaid
erDiagram
  projects ||--o{ content_briefs : "plans"
  content_briefs ||--o{ content_documents : "produces"
  projects ||--o{ content_documents : "owns"
  content_documents ||--o{ content_versions : "versioned"
  projects ||--o{ keyword_lists : "groups"
  projects ||--o{ topic_clusters : "clusters"
  projects ||--o{ project_keywords : "targets"
  keyword_lists ||--o{ project_keywords : "contains"
  topic_clusters ||--o{ project_keywords : "contains"
  projects ||--o{ reports : "reported"
  projects ||--o{ integrations : "connects"
  integrations ||--o| oauth_tokens : "encrypted tokens"
  integrations ||--o{ search_console_metrics : "synced"
  users ||--o{ oauth_states : "PKCE state"

  content_documents {
    enum status "DRAFT|IN_REVIEW|APPROVED|PUBLISHED|ARCHIVED"
    int latestVersion
    varchar approvedById FK
  }
  content_versions {
    int versionNumber "UK with documentId"
    mediumtext body "markdown"
    json faqs
    json schemaJsonLd
    enum source
    bool isDevAdapter
    varchar generationJobId UK
  }
  project_keywords {
    varchar normalizedPhrase "UK with project+country+language"
    enum intent
    enum priority
    enum status
    int searchVolume "provider-only, nullable"
    decimal cpc "provider-only, nullable"
  }
  reports {
    json sections
    datetime dateFrom
    datetime dateTo
    enum status
    varchar htmlPath
    varchar pdfPath
    json limitations
  }
  oauth_tokens {
    text accessTokenEnc "AES-256-GCM"
    text refreshTokenEnc "AES-256-GCM"
    datetime expiresAt
  }
```

## Table summary

| Table                                                                                        | Purpose                                                                                                                                                                                                                                                                                  |
| -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `users`, `sessions`, `user_tokens`                                                           | Accounts, server-side sessions, email-verification and password-reset tokens                                                                                                                                                                                                             |
| `workspaces`, `workspace_members`, `workspace_invitations`                                   | Tenancy and roles                                                                                                                                                                                                                                                                        |
| `projects`, `project_competitors`, `competitor_snapshots`                                    | Websites under management, competitors, public competitor metadata                                                                                                                                                                                                                       |
| `visibility_gap_analyses`                                                                    | Competitor gap analyses: status and the stored report (brands, reasons, sources, live checks, actions)                                                                                                                                                                                   |
| `seo_comparisons`                                                                            | SEO comparisons: chosen competitors, status and the stored result (per-site summaries, checks and suggestions; no per-page rows)                                                                                                                                                         |
| `trend_reports`                                                                              | Keyword trends comparisons: one source each (pytrends, DataForSEO, CSV import, fixture), terms, place, period, data types, cache key, partial flag, limitations, retrieval/expiry, comparison with the site                                                                              |
| `trend_observations`, `trend_regional_interest`, `trend_related_items`                       | Normalized Google Trends data of a report: interest over time per term and period, interest by place, related queries and topics (relative values, never counts)                                                                                                                         |
| `trend_csv_imports`, `trend_saved_queries`                                                   | Imported Google Trends files (kind, terms, rows); saved comparisons with a weekly or monthly refresh schedule                                                                                                                                                                            |
| `trend_provider_events`                                                                      | Outcome of each trends provider request (success, cache hit, rate limit, timeout…), kept 90 days for provider status                                                                                                                                                                     |
| `business_locations`                                                                         | Business locations (storefront, service area or both): address, coordinates, categories, hours, phone; optional link to a Business Profile location (`profileLocationName`, `profileAccountName`) and Google place ID. Archived, never deleted. Counts against the plan's location limit |
| `local_rank_queries`, `local_rank_scans`, `local_rank_points`                                | Local rank grids: a query tracked around a location (surface, grid size, spacing, depth, schedule), each scan with its source (licensed provider, manual, fixture) and summary, and one row per grid point with the businesses listed there                                              |
| `business_profile_snapshots`, `business_profile_metrics`, `business_reviews`                 | Google Business Profile data of linked locations: the profile as returned, daily performance values and recent reviews. Replaced at each sync and **deleted after 30 days** (Google's storage limit); also deleted on unlink, archive and disconnect                                     |
| `merchant_products`, `product_feed_imports`                                                  | Products from imported feed files or the connected Merchant Center account (attributes as given, Surfaced's checks and Google's item issues, Google's destination statuses), unique per project, source, country, language and id; and one row per imported file                         |
| `review_replies`                                                                             | Reply drafts (written or AI-drafted), their status (draft, awaiting approval, publishing, published, failed, discarded) and publish result; publishing needs an approved `approval_requests` row for the exact text                                                                      |
| `crawl_jobs`, `crawled_pages`, `crawled_links`                                               | Crawl executions and their page and link data                                                                                                                                                                                                                                            |
| `audit_runs`, `audit_issues`, `audit_issue_occurrences`                                      | Scored audits and persistent issues with per-run occurrences                                                                                                                                                                                                                             |
| `public_audits`                                                                              | Anonymous free audits (rate limited, purged after 7 days)                                                                                                                                                                                                                                |
| `ai_prompts`, `ai_prompt_competitors`                                                        | Tracked commercial questions                                                                                                                                                                                                                                                             |
| `ai_visibility_runs`, `ai_visibility_observations`, `brand_mentions`, `ai_citations`         | Provider executions and their evidence                                                                                                                                                                                                                                                   |
| `content_briefs`, `content_documents`, `content_versions`                                    | Content Studio                                                                                                                                                                                                                                                                           |
| `keyword_lists`, `topic_clusters`, `project_keywords`                                        | Keyword research (`project_keywords` with `isPrimary` holds primary keywords)                                                                                                                                                                                                            |
| `recommendations`                                                                            | Actionable work items generated from evidence                                                                                                                                                                                                                                            |
| `integrations`, `oauth_tokens`, `oauth_states`, `search_console_metrics`                     | OAuth integrations and synced first-party data                                                                                                                                                                                                                                           |
| `subscription_plans`, `subscriptions`, `billing_invoices`, `webhook_events`, `usage_records` | Billing and metering                                                                                                                                                                                                                                                                     |
| `reports`                                                                                    | Generated report metadata and file references                                                                                                                                                                                                                                            |
| `notifications`, `email_deliveries`, `contact_messages`                                      | Messaging                                                                                                                                                                                                                                                                                |
| `background_job_records`, `audit_logs`                                                       | Operations and accountability                                                                                                                                                                                                                                                            |

### Indexing notes

- Dashboard filters: `audit_issues (projectId, status, severity)`, `(projectId, category)`, `(projectId, ruleId)`.
- Time-series reads: `ai_visibility_observations (projectId, observedAt)` and `(projectId, provider, observedAt)`.
- Schedulers: `ai_prompts (status, frequency, nextRunAt)`, `projects (auditSchedule, nextAuditAt)`.
- Stuck-job detection: `background_job_records (status, heartbeatAt)`.
- Usage limit checks: `usage_records (workspaceId, metric, periodKey)`.
- Business Profile retention purge: `fetchedAt` indexes on `business_profile_snapshots`, `business_profile_metrics`
  and `business_reviews`.

### Departures from the brief's suggested table list

- `sessions` replaces `refresh_tokens`: Surfaced uses opaque server-side sessions (see `decisions.md`).
- `audit_runs` and `crawl_jobs` are separate. A crawl can be **re-scored** with new weights without
  re-crawling, and issues keep their identity across runs through `audit_issue_occurrences`.
- `brand_mentions` and `ai_citations` hang off observations, so every metric can be traced to its evidence.
