# Brand mention sources and CMS publishing: implementation notes

Checked on 2026-10-22, with robots.txt files read live. These notes drive the brand mention and CMS modules.

## Mention and discussion sources

| Source                                                     | Status in Surfaced           | Rules that apply                                                                                                                                                                                                                 |
| ---------------------------------------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| YouTube Data API v3 (`search.list`, API key)               | **Supported**                | `search.list` has its own quota since 2026-06-01: 100 calls per day by default. Data fetched without user OAuth may be stored for at most 30 days, then refreshed or deleted. Show YouTube as the source and do not alter links. |
| Hacker News (Algolia API, no key)                          | **Supported**                | `GET https://hn.algolia.com/api/v1/search_by_date?query=…&tags=(story,comment)`; 10,000 requests per hour per IP.                                                                                                                |
| GDELT DOC 2.0 (news)                                       | **Supported**                | `https://api.gdeltproject.org/api/v2/doc/doc?query=…&mode=ArtList&format=json`; at most 1 request every 5 seconds; cite and link GDELT.                                                                                          |
| Brave Search API (web and news)                            | Optional, not stored         | Its terms forbid storing results beyond transient use unless the plan includes storage rights.                                                                                                                                   |
| Domains cited in Surfaced's own AI visibility observations | **Supported**                | First-party data already stored.                                                                                                                                                                                                 |
| Manual entry and CSV import                                | **Supported**                |                                                                                                                                                                                                                                  |
| Reddit                                                     | **Not supported**            | Commercial use requires a separate agreement with Reddit. robots.txt disallows generic crawlers.                                                                                                                                 |
| Quora, LinkedIn, Facebook, Instagram, X                    | **Not supported for search** | No permitted public search (LinkedIn and Meta: only mentions of the brand's own page after app review; X: paid API). robots.txt disallows generic crawlers on all of them.                                                       |

**Verification.** Surfaced checks a published URL only where robots.txt allows its crawler. For blocked platforms
(Reddit, Quora, LinkedIn, Facebook, Instagram and X), a team member confirms the post manually, and the record is
labeled "Manually confirmed" with their name and the date.

## WordPress (REST API)

- **Detection:** the `Link: <…/wp-json/>; rel="https://api.w.org/"` header, or `<link rel="https://api.w.org/">` in
  the HTML; the index must list the `wp/v2` namespace.
- **Authentication:** Application Passwords, sent as HTTP Basic auth (`user_login:application_password`) over HTTPS
  only. A dedicated Editor account is recommended.
- **Finding a post from its URL:** the `Link: <…/wp-json/wp/v2/pages/15740>; rel="alternate"; type="application/json"`
  header on the page (WordPress 5.5+). Fallback: `GET /wp-json/wp/v2/posts?slug=…` (or `/pages`), then compare the
  `link` field with the URL.
- **Read:** `GET /wp-json/wp/v2/posts/{id}?context=edit` returns `title.raw`, `content.raw`, `excerpt.raw` and
  `modified`.
- **Write:** `POST /wp-json/wp/v2/posts/{id}` with `{title, content, excerpt, status, meta}`. Re-read `modified`
  before writing, so another person's edit is never overwritten.
- **Block content:** edit `content.raw` only, and only the text inside simple core blocks. Keep block comment
  markers and attributes unchanged.
- **SEO fields:**
  - Yoast 27.7+ registers `_yoast_wpseo_title` and `_yoast_wpseo_metadesc` for posts (`meta` in the posts
    endpoint).
  - Yoast 28.7+ adds an Abilities endpoint:
    `POST /wp-json/wp-abilities/v1/abilities/yoast-seo/update-post-seo-data/run`.
  - Rank Math uses an internal route, `POST /wp-json/rankmath/v1/updateMeta`.
  - Otherwise the site owner must register the keys with `show_in_rest`.
  - Surfaced detects what the site's schema exposes and reports fields it cannot write.

## Shopify (Admin GraphQL)

- Access: OAuth authorization-code grant with expiring offline tokens (`expiring=1`). API version `2026-10`:
  `POST https://{shop}.myshopify.com/admin/api/2026-10/graphql.json` with `X-Shopify-Access-Token`.
- Products: `productUpdate(product: {id, title, descriptionHtml, seo: {title, description}})` (scope
  `write_products`).
- Pages: `pageUpdate(id, page: {title, body})` (scope `write_content`). Page SEO uses the metafields
  `global.title_tag` and `global.description_tag` (via `metafieldsSet`).
- Rate limits are cost points (100/s on Standard). `THROTTLED` errors are retried after a pause.
