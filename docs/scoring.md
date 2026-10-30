# Audit scoring

The **site health index** is a 0–100 diagnostic index calculated by Surfaced from the pages an audit crawls.
**It is not a Google ranking score.** It does not predict rankings, featured snippets or AI citations, and the
product says so wherever it is shown. Its purpose is to make technical problems comparable over time and between
sections of a site.

The model is deterministic: re-scoring the same crawl with the same scoring version always gives the same
result. The implementation is `packages/shared/src/audit/scoring.ts` (version `2026.10`). Every audit run stores
the scoring version and the weights it used, so old results stay explainable after the model changes.

## Model

For each of the eight categories:

```
pagePenalty   = Σ over pages p of min(1, Σ pagePoints(severity) of p's issues in this category) × 100 / N
sitePenalty   = Σ sitePoints(severity) of site-level issues in this category
categoryScore = 100 − min(100, pagePenalty + sitePenalty)        (rounded, never below 0)
```

The overall index is the weighted mean of the category scores:

```
siteHealthIndex = round( Σ weight(c) × categoryScore(c) / Σ weight(c) )
```

`N` is the number of HTML pages analyzed (at least 1). Each page can lose at most one "page budget" per category,
so one broken template does not outweigh everything else. Site-level issues, such as a missing sitemap or HTTP
not redirecting to HTTPS, apply a fixed penalty to their category.

| Severity | Page points (share of one page's budget) | Site points (fixed category penalty) |
| -------- | ---------------------------------------- | ------------------------------------ |
| Critical | 1.0                                      | 60                                   |
| High     | 0.6                                      | 35                                   |
| Medium   | 0.3                                      | 15                                   |
| Low      | 0.1                                      | 5                                    |

| Category                    | Weight |
| --------------------------- | ------ |
| Crawlability & indexability | 20     |
| HTTP errors                 | 15     |
| Metadata                    | 15     |
| Content structure           | 12     |
| Internal links              | 12     |
| Structured data             | 10     |
| Performance observations    | 10     |
| Images                      | 6      |

Score bands used in the interface: **good** 80 or more, **fair** 50–79, **poor** below 50.

### Worked example

Suppose 10 pages are analyzed and the Metadata category has:

- 2 pages each missing a meta description (Medium, 0.3);
- 1 page missing a title (High, 0.6) that also lacks Open Graph tags (Low, 0.1);
- no site-level metadata issues.

Then `pagePenalty = (0.3 + 0.3 + min(1, 0.7)) × 100 / 10 = 13`, so Metadata scores 87.

## Issues over time

- **Identity.** Each issue has a stable fingerprint: rule, normalized URL and, for some rules, a detail key. It
  keeps its identity across audits, with first-detected and last-detected dates and an occurrence per run.
- **Automatic resolution.** An issue resolves automatically only when its page was crawled again and the rule no
  longer fires. Pages that were not re-crawled, for example because of a lower page limit, keep their issues
  open. It reopens if it comes back.
- **Ignoring.** People can ignore an issue (it stays ignored across audits) and reopen it later.
- **Re-scoring** (`POST /audits/:id/rescore`) re-applies the current rules and weights to a stored crawl
  without fetching the site again.

## Limitations

The index only reflects what the crawler could fetch:

- Pages beyond the page or depth limit, and pages blocked by robots.txt, are not analyzed.
- JavaScript is not executed, so client-rendered content is invisible to the audit.
- Response times are measured from the crawler's location.

Every audit lists its own limitations next to the results.

## Rule catalog

### Crawlability & indexability (weight 20)

| Rule                         | Severity | Scope | Checks for                                            |
| ---------------------------- | -------- | ----- | ----------------------------------------------------- |
| `robots-txt-missing`         | Low      | site  | robots.txt not found                                  |
| `robots-txt-unreachable`     | High     | site  | robots.txt returns a server error or times out        |
| `sitemap-missing`            | Medium   | site  | No XML sitemap found                                  |
| `sitemap-error`              | Medium   | site  | XML sitemap could not be fetched or parsed            |
| `sitemap-non-indexable-url`  | Medium   | page  | Sitemap lists a URL that is not indexable             |
| `page-noindex`               | Medium   | page  | Page is excluded from indexing (noindex)              |
| `blocked-by-robots`          | Medium   | page  | Internally linked URL is blocked by robots.txt        |
| `canonical-missing`          | Low      | page  | Missing canonical URL                                 |
| `canonical-multiple`         | Medium   | page  | Multiple canonical tags                               |
| `canonical-target-error`     | High     | page  | Canonical points to a broken or redirecting URL       |
| `canonical-points-elsewhere` | Low      | page  | Canonical points to a different URL                   |
| `http-not-https`             | High     | site  | Site is served over HTTP without redirecting to HTTPS |

### HTTP errors (weight 15)

| Rule             | Severity | Scope | Checks for                                              |
| ---------------- | -------- | ----- | ------------------------------------------------------- |
| `http-4xx`       | High     | page  | Page returns a 4xx client error                         |
| `http-5xx`       | Critical | page  | Page returns a 5xx server error                         |
| `fetch-failed`   | High     | page  | Page could not be fetched (timeout or connection error) |
| `redirect-chain` | Medium   | page  | Redirect chain (two or more hops)                       |
| `redirect-loop`  | High     | page  | Redirect loop or too many redirects                     |
| `mixed-content`  | Medium   | page  | HTTPS page loads resources over HTTP                    |

### Metadata (weight 15)

| Rule                         | Severity | Scope | Checks for                                     |
| ---------------------------- | -------- | ----- | ---------------------------------------------- |
| `title-missing`              | High     | page  | Missing page title                             |
| `title-too-long`             | Low      | page  | Title is longer than 60 characters             |
| `title-too-short`            | Low      | page  | Title is shorter than 15 characters            |
| `title-duplicate`            | Medium   | page  | Duplicate title                                |
| `title-near-duplicate`       | Low      | page  | Title is nearly identical to another page      |
| `meta-description-missing`   | Medium   | page  | Missing meta description                       |
| `meta-description-too-long`  | Low      | page  | Meta description is longer than 160 characters |
| `meta-description-too-short` | Low      | page  | Meta description is shorter than 50 characters |
| `meta-description-duplicate` | Low      | page  | Duplicate meta description                     |
| `og-tags-missing`            | Low      | page  | Missing Open Graph title or description        |

### Content structure (weight 12)

| Rule                       | Severity | Scope | Checks for                                  |
| -------------------------- | -------- | ----- | ------------------------------------------- |
| `h1-missing`               | Medium   | page  | Missing H1 heading                          |
| `h1-multiple`              | Low      | page  | Multiple H1 headings                        |
| `heading-level-skipped`    | Low      | page  | Heading levels are skipped                  |
| `missing-lang`             | Low      | page  | Missing language attribute                  |
| `thin-content`             | Low      | page  | Little visible text (under 200 words)       |
| `duplicate-content`        | Medium   | page  | Content is nearly identical to another page |
| `aeo-no-question-headings` | Low      | site  | No question-style headings found            |

### Internal links (weight 12)

| Rule                        | Severity | Scope | Checks for                                        |
| --------------------------- | -------- | ----- | ------------------------------------------------- |
| `broken-internal-link`      | High     | page  | Page links to broken internal URLs                |
| `internal-link-to-redirect` | Low      | page  | Page links to internal URLs that redirect         |
| `orphan-page`               | Medium   | page  | Orphan page (in sitemap, not linked internally)   |
| `no-internal-outlinks`      | Medium   | page  | Page has no internal links                        |
| `deep-page`                 | Low      | page  | Page is more than four clicks from the start page |
| `generic-anchor-text`       | Low      | page  | Internal links use generic anchor text            |
| `nofollow-internal-links`   | Low      | page  | Internal links marked nofollow                    |

### Structured data (weight 10)

| Rule                          | Severity | Scope | Checks for                                                |
| ----------------------------- | -------- | ----- | --------------------------------------------------------- |
| `jsonld-parse-error`          | High     | page  | Invalid JSON-LD (parse error)                             |
| `jsonld-missing-type`         | Medium   | page  | JSON-LD object without @type                              |
| `jsonld-missing-context`      | Low      | page  | JSON-LD without a schema.org @context                     |
| `jsonld-required-props`       | Medium   | page  | Structured data is missing key properties                 |
| `structured-data-none`        | Medium   | site  | No structured data found on any crawled page              |
| `organization-schema-missing` | Low      | site  | No Organization or LocalBusiness entity on the start page |

### Images (weight 6)

| Rule                     | Severity | Scope | Checks for                      |
| ------------------------ | -------- | ----- | ------------------------------- |
| `img-missing-alt`        | Medium   | page  | Images missing alt attributes   |
| `img-missing-dimensions` | Low      | page  | Images without width and height |

### Performance observations (weight 10)

| Rule                    | Severity | Scope | Checks for                                |
| ----------------------- | -------- | ----- | ----------------------------------------- |
| `slow-response`         | Medium   | page  | Slow server response                      |
| `large-html`            | Low      | page  | Large HTML document (over 1 MB)           |
| `uncompressed-response` | Low      | page  | HTML served without compression           |
| `viewport-missing`      | Medium   | page  | Missing mobile viewport meta tag          |
| `many-blocking-scripts` | Low      | page  | Several render-blocking scripts in <head> |
