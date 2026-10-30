# Google Merchant API: implementation notes

Checked against Google's documentation on 2026-10-22. These notes drive `packages/core/src/commerce`.

## Status and setup

- Merchant API **v1** is GA; v1beta has been discontinued. The Content API for Shopping was sunset on 2026-08-18
  (intermittent HTTP 410 since 2026-09-01). URL pattern: `https://merchantapi.googleapis.com/{sub-api}/v1/...`.
- OAuth scope: `https://www.googleapis.com/auth/content` (read/write; there is no read-only scope). API keys are not
  supported. The OAuth app needs Google verification.
- **Mandatory one-time developer registration** of the Google Cloud project, done once by the operator against
  the operator's own production Merchant Center account (verified website, admin user):
  `POST /accounts/v1/accounts/{operatorAccountId}/developerRegistration:registerGcp` with
  `{"developerEmail": "..."}`.
  - Without it, every call fails with `401 UNAUTHENTICATED` ("GCP project ... is not registered with the merchant
    account").
  - After registration the project can call any account the signed-in user can access.
  - Check with `GET /accounts/v1/accounts:getAccountForGcpRegistration`.

## Endpoints used

| Purpose               | Request                                                                                                                                                                 |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Accessible accounts   | `GET /accounts/v1/accounts?pageSize=500` → `{name, accountId, accountName, timeZone, languageCode, homePageUri}`                                                        |
| Homepage              | `GET /accounts/v1/accounts/{id}/homepage` → `{uri, claimed}`                                                                                                            |
| Account issues        | `GET /accounts/v1/accounts/{id}/issues?pageSize=100&languageCode=en-US` → `{title, severity CRITICAL/ERROR/SUGGESTION, impactedDestinations, detail, documentationUri}` |
| Free listings program | `GET /accounts/v1/accounts/{id}/programs/free-listings` → `{state NOT_ELIGIBLE/ELIGIBLE/ENABLED, activeRegionCodes, unmetRequirements}`                                 |
| Products              | `GET /products/v1/accounts/{id}/products?pageSize=1000&pageToken=…`                                                                                                     |
| Data sources          | `GET /datasources/v1/accounts/{id}/dataSources` (`input`: API, FILE, UI, AUTOFEED; `primaryProductDataSource` or `supplementalProductDataSource`)                       |
| Write an input        | `POST /products/v1/accounts/{id}/productInputs:insert?dataSource=accounts/{id}/dataSources/{dsId}`                                                                      |
| Patch an input        | `PATCH /products/v1/accounts/{id}/productInputs/{name}?updateMask=productAttributes.title,…&dataSource=…`                                                               |
| Performance           | `POST /reports/v1/accounts/{id}/reports:search` with an MCQL query                                                                                                      |
| Issue text            | `POST /issueresolution/v1/accounts/{id}/products/{product}:renderproductissues` (pre-rendered HTML; sanitize; do not cache)                                             |

## Products

- Name: `accounts/{a}/products/{contentLanguage}~{feedLabel}~{offerId}`. Use the returned `base64EncodedName`
  (unpadded base64url) when any part contains `/`, `%` or `~`.
- `productAttributes` (v1 names):
  - `title`, `description`, `link`, `imageLink`, `additionalImageLinks`
  - `price{amountMicros (int64 string), currencyCode}`, `salePrice`
  - `availability` IN_STOCK/OUT_OF_STOCK/PREORDER/LIMITED_AVAILABILITY/BACKORDER, `condition` NEW/USED/REFURBISHED
  - `brand`, `gtins[]`, `mpn`, `identifierExists`
  - `googleProductCategory`, `productTypes[]`, `itemGroupId`
  - `color`, `material`, `pattern`, `size`, `gender`, `ageGroup`
  - `productDetails[{sectionName, attributeName, attributeValue}]`, `productHighlights[]`, `certifications[]`
- `productStatus.destinationStatuses[{reportingContext, approvedCountries, pendingCountries, disapprovedCountries}]`
  and `itemLevelIssues[{code, severity NOT_IMPACTED/DEMOTED/DISAPPROVED, resolution, attribute, reportingContext,
description, detail, documentation, applicableCountries}]`.
- Reporting contexts include `SHOPPING_ADS`, `FREE_LISTINGS`, `FREE_LOCAL_LISTINGS` and `LOCAL_INVENTORY_ADS`.

## Writing changes

- Only **API** data sources accept writes; FILE, UI and AUTOFEED sources are read-only through the API.
- To change products that come from a file feed:
  1. Create an API supplemental data source (`POST /datasources/v1/accounts/{id}/dataSources` with
     `{"displayName": "Surfaced approved changes", "supplementalProductDataSource": {}}`).
  2. Link it in the primary source's `defaultRule.takeFromDataSources`, with the supplemental listed before
     `{"self": true}` so it overrides. The patch replaces the whole rule, which must keep exactly one `self`.
  3. Insert product inputs with the same `offerId`, `contentLanguage` and `feedLabel`.
- In a `PATCH`, fields named in `updateMask` but missing from the body are deleted.
- Processed products reflect changes after "several minutes"; aggregate statuses take more than 30 minutes.
- Quotas are per method group, with daily and per-minute limits. Errors are HTTP 429 `RESOURCE_EXHAUSTED`; back off
  with jitter.

## Reports

- MCQL: `SELECT … FROM view WHERE … ORDER BY …`. No `SELECT *` and no `OR`. Performance queries need a date
  condition and a metric.
- `product_performance_view`:
  - `marketing_method` is `ORGANIC` (free listings) or `ADS` (Shopping ads). This is how the two are kept separate.
  - Metrics: `clicks`, `impressions`, `click_through_rate`; conversions only for organic.
- `product_view`: `id`, `offer_id`, `title`, `price`, `availability`, `gtin`, `aggregated_reporting_context_status`,
  `item_issues`, `click_potential`.
- Merchant Center changed its performance metric definitions on 2026-08-24, so comparisons across that date are
  flagged.

## Jewellery

- Category `Apparel & Accessories > Jewelry` (188): Rings 200, Necklaces 196, Earrings 194, Bracelets 191.
- Apparel rules apply: free listings need `color`, `gender` and `ageGroup`. `size` and `color` are needed for
  variants (for example ring sizes), with `itemGroupId`.
- Precious metals: submit both `color` and `material` (for example `material: sterling silver`).
- Google has no attribute for gemstone, karat/purity or weight. These go in `productDetails`
  (`{"sectionName":"Gemstone","attributeName":"Stone","attributeValue":"Blue sapphire"}`) and in the title or
  description, using only facts the merchant has provided.
- Identifiers:
  - `brand` is required.
  - GTIN only when it really exists; a wrong GTIN causes disapproval.
  - Custom or handmade pieces: brand is the store, MPN is the SKU, and `identifierExists=false` when there is
    neither a GTIN nor brand+MPN.
- Images must be at least 500×500 from 2027-01-31 (1500×1500 recommended), without watermarks.
- Counterfeit wording ("replica", "imitation" with a brand name) leads to suspension. Surfaced never suggests it.

## Free listings, Shopping ads and organic search

- **Free listings:** unpaid product listings on Google surfaces (Search, Shopping tab, Images, Lens, YouTube,
  Business Profile). They need shipping settings and a return policy in some countries.
- **Shopping ads:** paid placements managed in Google Ads.
- **Organic search:** merchant listing experiences and product snippets, driven by structured data on the website.
  Providing both a feed and structured data maximizes eligibility.
- Landing pages must show the same price, currency and availability as the feed in the server-rendered HTML.
  Mismatches cause disapproval and can lead to suspension. Merchant Center automatic item updates correct
  occasional mismatches but are not a substitute for correct data.

## Implementation status (2026-10-24)

Implemented in `packages/core/src/commerce` (`feed.ts`, `validate.ts`, `merchant-api.ts`, `catalog.ts`) and
`apps/api/src/services/merchant.service.ts`. Field names were checked against the v1 discovery documents (products_v1
and accounts_v1, revision 20261021): `productAttributes`, `productStatus.destinationStatuses`, `itemLevelIssues`
(severity NOT_IMPACTED, DEMOTED, DISAPPROVED), `Price.amountMicros`, and upper-case enums (IN_STOCK, NEW, FEMALE,
ADULT) that Surfaced stores in feed form (in_stock, new, female, adult).

| Area          | Status                                                                                           |
| ------------- | ------------------------------------------------------------------------------------------------ |
| Accounts      | Listed live; one account chosen per project                                                      |
| Account data  | Homepage (claimed), account issues, free listings program, shipping services and return policies |
| Products      | Read with statuses and item issues (1,000 per page, up to the plan limit); removed when deleted  |
| Feed files    | Google CSV/TSV (attribute names as headers) and Shopify product exports; preview before import   |
| Checks        | Required attributes, lengths, currency per country, GTIN check digit, apparel rules by country,  |
|               | counterfeit wording, landing page domain, images; each names the programs it affects             |
| Not built yet | Writing product changes (supplemental data source, with approval), performance reports (MCQL),   |
|               | issue rendering (`renderproductissues`), local inventory                                         |
