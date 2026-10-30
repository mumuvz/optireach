# Google Business Profile: implementation notes

Checked against Google's documentation and the live discovery documents (revision 20261021) on 2026-10-22. These
notes drive `packages/core/src/local`. Re-check them when Google publishes changes.

## Access

- One OAuth scope covers everything: `https://www.googleapis.com/auth/business.manage`.
- **Default quota is 0 queries per minute until Google approves the project.** Apply through the GBP API contact
  form ("Application for Basic API Access") with the Cloud project number, from an account that owns or manages a
  profile verified and active for 60+ days that has a website. Reviews take up to 14 days.
- Enable these APIs: Google My Business API (v4, visible only after approval), My Business Account Management,
  My Business Business Information, Business Profile Performance; optionally Verifications.
- Quotas: 300 QPM per API after approval; profile edits are limited to 10 per minute per profile (fixed). Over quota
  returns HTTP 429 `RESOURCE_EXHAUSTED`, so retry with exponential backoff and jitter.
- There is no sandbox. Use `validateOnly=true` to test updates.

## Endpoints used

| Purpose             | Request                                                                                                                                               |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Accounts            | `GET https://mybusinessaccountmanagement.googleapis.com/v1/accounts` (pageSize ≤ 20)                                                                  |
| Locations           | `GET https://mybusinessbusinessinformation.googleapis.com/v1/{accounts/-}/locations?readMask=…` (pageSize ≤ 100; `accounts/-` includes group access)  |
| Location            | `GET …/v1/locations/{id}?readMask=…`; live Maps view: `…/v1/locations/{id}:getGoogleUpdated?readMask=…`                                               |
| Update              | `PATCH …/v1/locations/{id}?updateMask=…&validateOnly=true                                                                                             | false` (body: partial Location)                         |
| Attributes          | `GET …/v1/locations/{id}/attributes`; metadata `GET …/v1/attributes?parent=locations/{id}`                                                            |
| Voice of Merchant   | `GET https://mybusinessverifications.googleapis.com/v1/locations/{id}/VoiceOfMerchantState`                                                           |
| Daily metrics       | `GET https://businessprofileperformance.googleapis.com/v1/locations/{id}:fetchMultiDailyMetricsTimeSeries?dailyMetrics=…&dailyRange.startDate.year=…` |
| Keyword impressions | `GET …/v1/locations/{id}/searchkeywords/impressions/monthly?monthlyRange.startMonth.year=…`                                                           |
| Reviews             | `GET https://mybusiness.googleapis.com/v4/accounts/{a}/locations/{l}/reviews?pageSize=50`                                                             |
| Reply               | `PUT …/v4/accounts/{a}/locations/{l}/reviews/{r}/reply` body `{"comment":"…"}` (≤ 4096 bytes); `DELETE` removes it                                    |
| Posts               | `POST                                                                                                                                                 | GET …/v4/accounts/{a}/locations/{l}/localPosts`; `PATCH | DELETE …/localPosts/{p}` |

The read mask used for locations: `name,title,storeCode,phoneNumbers,categories,storefrontAddress,websiteUri,
regularHours,specialHours,serviceArea,labels,latlng,openInfo,metadata,profile`.

## Formats that matter

- `categories`: `{primaryCategory, additionalCategories[]}`; names look like `categories/gcid:jewelry_store`. Send
  both on update.
- `phoneNumbers`: `{primaryPhone, additionalPhones[≤2]}`. The update mask must be the whole `phoneNumbers` object.
- `regularHours.periods[]`: `{openDay, openTime, closeDay, closeTime}` with `TimeOfDay` objects `{hours, minutes}`.
  Zero values are omitted, so `{}` means 00:00 and `{hours: 24}` means end of day. A day without a period is closed.
- `specialHours.specialHourPeriods[]`: `{startDate, endDate?, openTime?, closeTime?, closed?}`; special hours need
  regular hours.
- `profile.description`: at most 750 characters (Help Center); no URLs or HTML (`PROFILE_DESCRIPTION_CONTAINS_URL`).
- `title`: the real-world business name only (no taglines, phone numbers, URLs, addresses or hours).
- `metadata` (read-only): `placeId`, `mapsUri`, `newReviewUri`, `hasVoiceOfMerchant`, `hasPendingEdits`,
  `hasGoogleUpdated`. Without Voice of Merchant, edits do not go live.
- Not editable through `PATCH`: `metadata`, `languageCode`, `serviceArea.regionCode`; `latlng` only for approved
  clients. Attributes use `updateAttributes`.
- Reviews: `starRating` is `ONE`…`FIVE`; replies have `reviewReplyState` PENDING, REJECTED or APPROVED.
- Metrics: `BUSINESS_IMPRESSIONS_{DESKTOP,MOBILE}_{MAPS,SEARCH}`, `BUSINESS_DIRECTION_REQUESTS`, `CALL_CLICKS`,
  `WEBSITE_CLICKS`, `BUSINESS_BOOKINGS`, `BUSINESS_FOOD_MENU_CLICKS`, `MESSAGING_CLICKS`. Values are int64 strings
  and are omitted when zero. Keyword impressions return either `value` or `threshold`.
- Posts: `topicType` STANDARD, EVENT, OFFER (ALERT is restricted); call to action BOOK, ORDER, SHOP, LEARN_MORE,
  SIGN_UP, CALL (no URL for CALL); media only by public `sourceUrl`; `event` is required for EVENT and OFFER.
- The Q&A API was discontinued on 2025-11-03.

## Policies that shape the product

- **Storage:** Business Profile content may be stored only in limited amounts, for at most 30 calendar days, and
  "cannot be manipulated or aggregated". Surfaced therefore:
  - deletes reviews, metrics and profile snapshots older than 30 days;
  - fetches longer metric ranges from the API when a report needs them;
  - keeps only its own records (approved changes, findings, tasks).
- **Consent:** no edits, posts or review replies without the client's prior, specific consent. Every write requires
  an approved approval request for the exact content.
- **Notice:** the client is notified of changes made through Surfaced (Google requires notice within 48 hours).
- **No indirect access:** Business Profile data and actions are not exposed through Surfaced's public API.

## Implementation status (2026-10-24)

Implemented in `packages/core/src/local/business-profile.ts`, `profile-audit.ts` and `review-replies.ts`, with the
API in `apps/api/src/services/business-profile.service.ts`:

| Area           | Status                                                                                                     |
| -------------- | ---------------------------------------------------------------------------------------------------------- |
| Accounts       | Listed live (paged, 20 per page) for linking                                                               |
| Locations      | Listed live with the read mask above; linked by resource name; "add as new location" copies once           |
| Sync           | Location, 56 days of daily metrics (10 non-deprecated metrics), up to 200 reviews; daily and on demand     |
| Retention      | Snapshots, metrics and reviews deleted 30 days after fetching, and at once on unlink, archive, disconnect  |
| Profile audit  | Ownership (Voice of Merchant), open status, Google updates, name, categories, description, NAP, website,   |
|                | address or service area, hours, review replies; applicable checks only                                     |
| Review replies | Draft (person or AI), approval of the exact text, publish with `local.publish` (`PUT …/reviews/{r}/reply`) |
| Not built yet  | Profile edits (`PATCH`), attributes, keyword impressions, local posts, deleting replies, Voice of Merchant |
|                | API, notifications from Google (Pub/Sub)                                                                   |

Not verified against the live API: the project has no OAuth client and no approved API access. All requests are
tested with a fake Google that returns the documented shapes, including the 403 returned before approval.
