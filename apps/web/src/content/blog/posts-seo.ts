import type { BlogPostSource } from './types';

export const SEO_POSTS: BlogPostSource[] = [
  {
    slug: 'technical-seo-audit-checklist',
    title: 'A practical technical SEO audit checklist',
    description:
      'The checks that catch most crawlability and indexing problems, in the order we run them, with what to fix first.',
    category: 'seo',
    cluster: 'Technical SEO',
    publishedAt: '2026-10-06',
    body: `
A technical SEO audit answers one question: **can search engines reach, read and understand the pages you want found?** Content and links matter too, but they cannot help pages that are never crawled or indexed. This checklist follows the order we use: start with problems that block whole sections of a site, then move to page-level issues.

## 1. Crawl access

- **robots.txt** — Fetch \`/robots.txt\` and read it like a crawler would. A single \`Disallow: /\` under \`User-agent: *\` blocks everything. A robots.txt that returns a server error is also a problem: under the robots exclusion standard (RFC 9309), crawlers may treat a 5xx as "disallow all".
- **XML sitemaps** — List the canonical URLs you want indexed, reference the sitemap in robots.txt, and keep it free of redirects, 404s and \`noindex\` pages.
- **HTTPS and redirects** — \`http://\` should redirect to \`https://\` in a single hop, and internal links should point straight at final URLs.

## 2. Status codes

- **Broken internal links (4xx)** waste crawl budget and frustrate visitors. Fix the link, or redirect the old URL if it had value.
- **Server errors (5xx)** often point to fragile templates or overloaded hosting. Recurring 5xx responses can lead search engines to crawl less often.
- **Redirect chains** — Each extra hop adds latency and risk. Collapse chains to one redirect.

## 3. Indexing signals

- **Canonical tags** should point to a live, indexable URL, ideally the page itself. Canonicals that point to redirects or 404s send mixed signals.
- **\`noindex\`** is right for thank-you pages and internal search results. It is wrong on pages you list in your sitemap.
- **Orphan pages** — pages in your sitemap that no internal link points to — are hard for crawlers and people to find. Link to them from relevant pages.

## 4. Page metadata

- A unique, descriptive **title** for every page. Titles are often truncated around 60 characters in results, so put the important words first.
- A **meta description** that summarizes the page. It is not a ranking factor, but it often becomes the snippet people read before clicking.
- **One clear H1** that matches the page's purpose, and headings that form a logical outline.

## 5. Content quality signals

- **Thin pages** with very little visible text rarely satisfy a query. Expand them, merge them with a related page, or keep them out of the index.
- **Duplicate and near-duplicate pages** split signals between URLs. Consolidate them, or choose a canonical.
- **Images** need descriptive \`alt\` text and sensible file sizes.

## 6. Performance

Slow server responses hurt users first and crawl efficiency second. Measure the time to first byte on key templates, enable compression (gzip or Brotli), and cache static assets.

## What to fix first

Prioritize by **reach × severity**: a robots.txt mistake or a broken template affects every page, while a missing alt attribute affects one image. In Surfaced, every issue has a severity and a list of affected URLs, so you can sort by impact and track each fix through the next crawl.

> A site health score is a diagnostic summary of these checks. It is useful for tracking progress, but it is not a search engine's ranking score.
`,
  },
  {
    slug: 'structured-data-what-schema-can-and-cannot-do',
    title: 'Structured data: what schema markup can and cannot do',
    description:
      'How JSON-LD helps search engines and AI systems understand a page, where it is ignored, and how to avoid misleading markup.',
    category: 'seo',
    cluster: 'Technical SEO',
    publishedAt: '2026-10-13',
    body: `
Structured data is a standard way to describe what a page is about, in a form machines can parse without guessing. Most sites add it as **JSON-LD** using the schema.org vocabulary: a \`<script type="application/ld+json">\` block that says "this page is an Article, written by this organization, published on this date".

## What it can do

- **Remove ambiguity.** "Apple" the company and "apple" the fruit look the same in plain text. An \`Organization\` with a \`url\` and \`sameAs\` links does not.
- **Make a page eligible for some search features.** Some result types, such as product details or breadcrumbs, depend on specific markup and content.
- **Keep facts consistent.** When your name, logo, address and products are described the same way everywhere, they are easier to verify.

## What it cannot do

- **Guarantee rich results.** Search engines decide when to show enhanced results. Valid markup makes a page eligible; it does not make it chosen.
- **Fix weak content.** Markup describes the page. If the page does not answer the question, the description will not help.
- **Guarantee AI citations.** There is no public evidence that any schema type makes an AI assistant cite a page. Clear, accurate, well-structured content is the more reliable route.

## Rules that keep markup trustworthy

1. **Describe only what is visible on the page.** FAQ markup must match questions and answers users can actually read. Review markup must reflect real reviews.
2. **Use the most specific type that fits**, such as \`SoftwareApplication\` rather than a generic \`Thing\`.
3. **Validate it.** Invalid JSON is ignored completely, and a missing required property can disqualify a feature.
4. **Keep it in sync.** Prices, dates and availability in markup must change when the page changes.

## A minimal, honest starting point

For most marketing sites, three blocks cover the essentials:

- \`Organization\` on the home page: name, URL, logo and official profiles.
- \`Article\` on blog posts: headline, author, publish and update dates.
- \`FAQPage\` only where a page really contains a list of questions and answers.

Surfaced checks pages for JSON-LD that does not parse and for common missing properties, and Content Studio can suggest FAQ and Article markup for your drafts. You review it before publishing, because markup that claims more than the page shows does more harm than good.
`,
  },
];
