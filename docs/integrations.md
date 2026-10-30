# Integrations and providers

Every external provider is optional. When one is not configured, the product says so in the UI ("Provider not
configured", "Planned", or "Development billing mode") and never fills in invented results. Admin → System shows
the configuration status of every provider without revealing secrets.

| Provider                | Used for                                                                                          | Status in this codebase                                                         | Verified live                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| OpenAI                  | Content generation, AI visibility (web search and model knowledge), mention checks, keyword ideas | Implemented                                                                     | Yes: web search answer with citations, structured output         |
| Perplexity              | AI visibility (Agent API with web search)                                                         | Implemented                                                                     | **No** (no API key available)                                    |
| Google Search Console   | Clicks, impressions, CTR and position                                                             | Implemented (OAuth 2.0 with PKCE)                                               | **No** (no OAuth client available); covered by mocked tests      |
| Stripe                  | Subscriptions                                                                                     | Implemented (Checkout, portal, webhooks)                                        | **No** (no keys); covered by signed test payloads                |
| Razorpay                | Subscriptions                                                                                     | Implemented (Subscriptions API, webhooks)                                       | **No** (no keys); covered by signed test payloads                |
| SMTP                    | Transactional email                                                                               | Implemented (nodemailer)                                                        | **No**; development writes `.eml` files instead                  |
| Chromium                | PDF reports                                                                                       | Implemented (playwright-core)                                                   | Yes: PDF with Japanese and Hindi text, external requests blocked |
| GA4, WordPress, Shopify | Analytics and publishing                                                                          | **Planned**: interfaces documented, nothing imported or published               | —                                                                |
| Keyword data provider   | Search volume, difficulty, CPC                                                                    | **Not available**: no licensed provider integrated; metrics are never estimated | —                                                                |

## OpenAI

```
LLM_PROVIDER=openai
OPENAI_API_KEY=sk-…
OPENAI_MODEL=gpt-5.4-mini              # content generation (default)
OPENAI_VISIBILITY_MODEL=gpt-5.4-mini   # visibility checks (default)
```

- **Content** uses the Responses API with strict structured output. Prompts forbid invented facts, statistics,
  quotes and sources; where evidence is needed, drafts contain a visible `[SOURCE NEEDED: …]` marker.
- **AI visibility ("OpenAI · web search")** uses the Responses API with the `web_search` tool and the prompt's
  country as the user location. It stores inline `url_citation` annotations and the consulted sources. This
  approximates, but is not identical to, what ChatGPT users see.
- **"OpenAI · model knowledge"** answers without browsing. It is useful for what the model has learned about a
  brand, and usually returns no citations.
- Without a key: `LLM_PROVIDER=dev` gives deterministic template text, labeled "Development template text"
  (refused in production), and `AI_DEMO_MODE=true` enables the labeled demo visibility provider.

## Perplexity

```
PERPLEXITY_API_KEY=pplx-…
PERPLEXITY_MODEL=sonar     # mapped to the Agent API preset "fast"; other values are passed as the preset
```

Perplexity's documentation states that support for the Sonar Chat Completions endpoint ended on 2026-09-27. The
adapter therefore calls `POST https://api.perplexity.ai/v1/agent` and parses both documented result shapes,
including numbered inline citations. **It has not been tested against the live API.** Run one check and inspect
the stored observation before relying on it.

## Google Search Console

1. In Google Cloud Console, create a project and enable the **Google Search Console API**.
2. Configure the OAuth consent screen. Add the scope `https://www.googleapis.com/auth/webmasters.readonly` (plus
   `openid` and `email`, used to show which Google account is connected). While the app is in testing mode,
   add your test users.
3. Create an **OAuth client ID** of type _Web application_ with this authorized redirect URI:
   `https://<API_URL>/api/v1/integrations/google/callback` (locally: `http://localhost:4000/api/v1/integrations/google/callback`).
4. Configure the environment:

   ```
   GOOGLE_CLIENT_ID=….apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=…
   GOOGLE_OAUTH_REDIRECT_URI=        # optional; defaults to the URL above
   ```

5. In the app, open a project → Integrations → **Connect with Google**, choose a property and **Sync now**.

How it works:

- **Consent** uses a random state, stored hashed, single-use, bound to the user and valid for 10 minutes. PKCE
  uses S256. The flow requests offline access to obtain a refresh token.
- **Tokens** are encrypted with AES-256-GCM. Access tokens refresh automatically; if refreshing fails, the
  integration shows "needs re-authentication".
- **Sync** stores 90 days of daily totals and the top 1,000 queries and pages for the last 28 days. Search Console
  data lags by about two days. A daily sync runs at 03:30 UTC, and reports include the synced data.
- **Disconnect** revokes the token at Google and deletes it; synced data remains.

## Google Business Profile

Uses the same OAuth client as Search Console, with its own consent and the single scope
`https://www.googleapis.com/auth/business.manage`. Implementation notes, endpoints and Google's policies are in
[providers/google-business-profile.md](providers/google-business-profile.md).

1. **Apply for API access.** Business Profile APIs have a quota of 0 until Google approves the Cloud project
   ("Application for Basic API Access", from an account that manages a verified profile active for 60+ days).
   Until then every request returns 403/429 and the app shows Google's reason.
2. After approval, enable **My Business Account Management**, **My Business Business Information**, **Business
   Profile Performance** and **Google My Business API** (v4, for reviews) in the Cloud project.
3. Add the scope to the OAuth consent screen. The redirect URI is the same as for Search Console.
4. In the app: project → Local → **Business Profile** → **Connect with Google**, then link each location to its
   profile. The first sync starts immediately.

How it works:

- **Linking** stores only the profile's resource name, account and place ID on the location. "Add as new location"
  copies the name, address, phone, categories and hours once, as the business's own record.
- **Sync** (daily, and on demand) stores the profile as returned, 56 days of daily metrics and the 200 most recent
  reviews per linked location. Google allows this content to be kept for at most 30 days: it is replaced at each
  sync, deleted after 30 days, and deleted at once on unlink, archive or disconnect.
- **Audit** checks the live profile against Google's guidelines; only checks that apply count (no website: the
  website check does not apply; service-area business: no address expected). Without a connection it audits the
  details entered in Surfaced and says so.
- **Review replies** are drafted by a person or by the AI model (`CONTENT_GENERATION` quota; the development
  adapter is labeled as a template). An approver approves the exact text; then an owner or admin publishes it
  (`local.publish`). Editing the text withdraws the pending approval. The approver and the author are notified when
  a reply is published.
- **No indirect access:** Business Profile data is served only to the business's own signed-in users.

## Google Merchant Center

Same OAuth client, scope `https://www.googleapis.com/auth/content` (Merchant API v1). Notes:
[providers/google-merchant-center.md](providers/google-merchant-center.md).

1. The OAuth app needs Google's verification for this scope, and the Cloud project needs the one-time Merchant API
   developer registration (`registerGcp`); without it every call fails with 401.
2. In the app: project → Local → **Merchant Center** → **Connect with Google**, choose the account, and the first sync
   starts.

How it works:

- **Read-only.** Surfaced reads the account, homepage claim, account issues, the free listings program, shipping
  and return policies, and products with their destination statuses and item issues. It never writes to Merchant
  Center.
- **Products** are stored per project with Surfaced's own checks next to Google's issues (labeled "Reported by
  Google"). Products deleted in Merchant Center are removed after a complete sync. The plan's `productsTracked`
  limit applies; a product present in both a feed and Merchant Center counts once.
- **Without Merchant Center**, a feed file (Google CSV/TSV or a Shopify export) can be imported and checked.
- **Disconnect** revokes access; products already read stay until removed or replaced.

## Stripe

1. Create a Product for each paid plan, with a monthly and a yearly recurring Price.
2. Admin → Plans → _Edit_: paste the price IDs (`price_…`) into "Stripe monthly/yearly price ID".
3. Add a webhook endpoint `https://<API_URL>/api/v1/billing/webhooks/stripe` with these events:
   - `checkout.session.completed`;
   - `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`;
   - `invoice.paid`, `invoice.payment_failed`.
4. Configure the environment:

   ```
   BILLING_PROVIDER=stripe
   STRIPE_SECRET_KEY=sk_live_…        # or sk_test_… in staging
   STRIPE_WEBHOOK_SECRET=whsec_…
   ```

5. Enable the Customer Portal in Stripe so "Manage billing" works.

Checkout requires a verified email address. The plan changes only when the verified webhook arrives; returning
from Checkout never activates a plan by itself. Cancelling schedules the end of the period; "Keep my plan"
undoes it.

## Razorpay

1. Create a Plan for each paid plan and interval in the Razorpay dashboard.
2. Admin → Plans: paste the plan IDs (`plan_…`).
3. Add a webhook `https://<API_URL>/api/v1/billing/webhooks/razorpay` with a secret, and select the
   `subscription.*` events and `payment.failed`.
4. Configure the environment:

   ```
   BILLING_PROVIDER=razorpay
   RAZORPAY_KEY_ID=rzp_…
   RAZORPAY_KEY_SECRET=…
   RAZORPAY_WEBHOOK_SECRET=…
   ```

Signatures are HMAC-SHA256 over the raw body. Events are de-duplicated with the `X-Razorpay-Event-Id` header.

## Development billing

`BILLING_PROVIDER=dev` applies plan changes immediately with no payment and no invoices. The billing page shows a
"Development billing mode" notice and offers simulated payment failure, recovery and cancellation for testing.
The server refuses to start with development billing in production.

## Email (SMTP)

```
EMAIL_PROVIDER=smtp
EMAIL_FROM=Surfaced <no-reply@your-domain.com>
SALES_EMAIL=sales@your-domain.com       # receives contact-form messages
SMTP_HOST=smtp.your-provider.com
SMTP_PORT=587
SMTP_SECURE=false                        # true for port 465
SMTP_USER=…
SMTP_PASSWORD=…
```

Set up SPF, DKIM and DMARC for the sending domain. Delivery status is recorded per email: queued, sent or failed.
In development `EMAIL_PROVIDER=console` writes `.eml` files to `var/mail/` and records them as `LOGGED_LOCALLY`.

## PDF reports (Chromium)

```
PDF_RENDERER=chromium
PDF_CHROMIUM_EXECUTABLE_PATH=      # optional; defaults to the Playwright-managed Chromium
```

Install Chromium in the worker environment with `npx playwright install --with-deps chromium`. PDFs are printed
from the stored report HTML with JavaScript disabled and every network request blocked. With
`PDF_RENDERER=none`, or when Chromium is missing, reports are HTML-only and the UI says so.

## Planned integrations

**GA4, WordPress and Shopify** appear in the Integrations page as "Planned". They have no connect buttons and
import or publish nothing. Content Studio exports Markdown and HTML for manual publishing. Publishing will
always require explicit confirmation; the product never changes a customer's website automatically.
