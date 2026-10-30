# AI visibility metrics

This page defines every AI visibility number in the product. The formulas are implemented once, in
`packages/shared/src/metrics.ts`, and used by the API, the reports and the tests. Every figure is calculated from
**stored observations**: you can open each one and read the answer, the mentions and the citations behind it.

## Observations

An **observation** is one prompt sent once to one provider for a given country and language. Each stores:

- the full answer text, model, latency and token usage;
- the cited URLs (inline citations, consulted search results and URLs written in the answer);
- the detected mentions, and a redacted copy of the raw provider response.

An observation either **succeeds** or **fails**, for example on a timeout, rate limit or provider error. Failed
observations are kept and shown with their error, but **they are excluded from every rate**, so an outage never
looks like a drop in visibility.

One observation equals one **AI visibility check** for plan limits. Usage is recorded only for successful
observations, and each observation is recorded once, even if the job is retried.

### Mentions

Mentions are matched deterministically:

- Unicode-aware word-boundary matching of the brand name (the prompt's target brand) and the project's brand
  aliases.
- The project's domain appearing in the answer or its citations.
- The same for each tracked competitor: name, aliases and domain.

When a real LLM is configured (`LLM_PROVIDER=openai`), an AI check reviews each answer that has name or alias
matches. It confirms which matches refer to the company rather than a generic word, and estimates the
sentiment toward the brand. Domain matches are always kept, and if the check fails the deterministic matches
stand. The check never runs for demo data or the development adapter.
Each mention stores its matched text,
match type and **rank**: its 1-based order among all entities mentioned in the answer.

### Citations

Tracking parameters (`utm_*`) are removed and duplicates are merged. A citation is attributed:

- to **your site** when its domain is the project domain or a subdomain of it;
- to a **competitor** when it matches that competitor's domain;
- otherwise to a **third party**.

## Formulas

Let _S_ be the successful observations in the selected set.

| Metric                                    | Formula                                                              | Notes                                                                                                                         |
| ----------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **Mention rate**                          | observations in _S_ that mention the brand ÷ \|_S_\|                 | Each answer counts once, however often the brand appears                                                                      |
| **Citation rate**                         | observations in _S_ citing at least one URL on your domain ÷ \|_S_\| | Model-only providers usually return no citations; compare within one provider                                                 |
| **Competitor mention and citation rates** | Same formulas per competitor                                         | Same denominator as the brand                                                                                                 |
| **Share of voice**                        | brand mentions ÷ (brand mentions + Σ competitor mentions)            | Each answer counts at most once per entity. Depends on which competitors you track. Empty when no tracked brand was mentioned |
| **Average position**                      | Mean rank of the entity in the answers that mention it               | Lower is earlier in the answer                                                                                                |
| **Source share**                          | citations of a domain ÷ all citations in _S_                         | Also reported: how many observations cited the domain at least once                                                           |

When the denominator is zero, the metric is **not available** (shown as "—"), never 0%.

### Worked example

48 successful observations. The brand is mentioned in 17, competitor A in 20 and competitor B in 13. Nine answers
cite a page on your domain.

- Mention rate = 17 ÷ 48 = 35%
- Citation rate = 9 ÷ 48 = 19%
- Share of voice = 17 ÷ (17 + 20 + 13) = 34%

## Filters and composition

Every metric is computed for an explicit set of observations: provider (or all), country, language, date range
and whether to include demo data. The API returns the set's **composition** with each result:

- the providers, countries and languages in the set;
- the number of prompts and the date range;
- flags for mixed providers, mixed locales and demo data.

The UI turns these into notes, for example:

- "Rates pool 2 providers…"
- "Includes demo fixture data, which is not real AI output"
- "Only the most recent 20,000 observations are included" (the per-query cap).

Pooling providers or locales is allowed but always disclosed, because providers answer differently.

## Trends

Trend charts group observations by **UTC day**, **ISO week** (starting Monday) or **calendar month**, and apply
the same formulas within each period. Each point carries its sample size: successful and total observations.
A period without successful observations is a **gap** in the chart, not a zero.

## Estimates and demo data

- **Sentiment** (positive, neutral, negative, mixed) is classified by an AI model and labeled _AI estimate_. It is
  never part of any rate.
- **Demo observations** come from the labeled demo provider (`AI_DEMO_MODE=true`). The answer text begins with
  "Demo data — not a real AI response". They are marked `isDemo`, can be excluded with a filter, and are noted
  wherever they are included.

## Competitor gap analysis

The **Competitor gaps** page explains why answers recommend other brands. It analyzes successful, non-demo
answers from the last 90 days (at most 2,000), and it has four parts.

**Brands named.** These come from three sources:

- your brand and tracked competitors, from stored mention matching;
- brands named in an answer that also cites their website (for example "Canva" with canva.com);
- with an AI provider configured, the brands each answer recommends.

AI extraction covers the 120 most recent answers. A name is kept only when it appears in the answer text.
Composite names ("A / B tools") are split, and channels such as WhatsApp are dropped. A tracked brand written
differently in the answers (for example "Crafty Art" for `craftyart`) is reported as an alias suggestion, and those
answers count for it.

**Reasons.** These are short labels for what an answer credits a brand with. Each label comes with a quote that
was checked word for word against the stored answer; any reason whose quote is not found is dropped. "On your
site" is a keyword check: all the label's words must appear in your homepage text or in one crawled page's address,
title, headings or description. It is not proof that you offer the feature.

**Sources.** These are cited domains, grouped under a brand's own site when they belong to it (including its file
hosts), then classified as one of: your site, a competitor's site, a recommended brand's site, an article or
guide, community, app store, video, social, press release, review site or directory, file host, or other. Up to 12
article, directory, discussion and press pages are opened live (robots.txt respected, SSRF-safe) to see which of
the named brands appear on them and whether yours does.

**Your pages.** For each question, the best page of your latest crawl is the one whose address, title and main
heading contain at least 60% of the question's significant words.

**Actions.** These are built by fixed rules from that evidence. Each action states its evidence, and none promises
an outcome. The rules cover:

- AI search crawlers blocked in robots.txt (OAI-SearchBot, PerplexityBot, Googlebot, Bingbot);
- a homepage that cannot be read, or shows fewer than 150 words without JavaScript;
- questions with no matching page;
- reasons missing from your site;
- cited list pages that name rivals but not you;
- brands' own comparison pages being cited;
- community, app store, press and video sources;
- untracked brands;
- alias gaps;
- prompts where at most half the answers name any brand.

## What these metrics do not say

- **Not every user's experience.** Consumer AI apps personalize answers and change often. A tracked prompt set is
  a sample observed through official APIs, not a census of what every user sees.
- **Not causation.** You can see which sources are cited together with competitors, but not why a model chose
  them.
- **Not every assistant.** Assistants without an official API are not tracked, and consumer chat apps are not
  scraped.
