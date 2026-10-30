import type { BlogPostSource } from './types';

export const AEO_GEO_POSTS: BlogPostSource[] = [
  {
    slug: 'what-is-answer-engine-optimization',
    title: 'What is answer engine optimization (AEO)?',
    description:
      'AEO makes your content easy to quote as a direct answer. Here is how it differs from SEO and where to start.',
    category: 'aeo',
    cluster: 'Answer engines',
    publishedAt: '2026-09-29',
    body: `
People increasingly ask questions and expect an answer, not a list of links. Featured snippets, voice assistants and AI chat tools all try to give one clear response. **Answer engine optimization (AEO)** is the practice of making your content the easiest source to quote for those questions.

## How AEO differs from SEO

Classic SEO asks: *will this page rank for this query?* AEO asks: *does this page contain a clear, self-contained answer that a system can extract and attribute?* The two overlap heavily. A page that cannot be crawled will not be quoted. But a page can rank well and still bury the answer under introductions and filler.

## What answer-ready content looks like

- **The question appears as a heading**, phrased the way people ask it: "How long does a tent footprint last?"
- **The answer comes first**, in one to three sentences, before the nuance.
- **Specifics beat generalities.** Numbers, steps, conditions and definitions are easier to quote than opinions.
- **One idea per section**, so a passage still makes sense when it is lifted out of context.
- **Evidence is visible.** Cite sources, show dates and say who wrote the page.

## Where to start

1. **Collect real questions** from sales calls, support tickets, site search and "people also ask" boxes.
2. **Map each question to one page** that should own the answer, and avoid spreading it thinly across several.
3. **Rewrite the key passages** so the answer comes first, then add detail and caveats.
4. **Add an FAQ section** where several short questions belong together, and describe it with \`FAQPage\` markup only if the questions are visible on the page.
5. **Measure.** Track which questions you are quoted for over time, rather than relying on one-off checks.

## A caution

No technique guarantees that an answer engine will quote you. Systems change, and they combine many signals. Treat AEO as a way of writing that serves readers first. If a human can find the answer in five seconds, a machine probably can too.
`,
  },
  {
    slug: 'how-to-write-content-that-answers-questions',
    title: 'How to write content that answers questions well',
    description:
      'A repeatable structure for pages that satisfy readers, featured snippets and AI assistants, without keyword stuffing.',
    category: 'aeo',
    cluster: 'Content',
    publishedAt: '2026-10-20',
    body: `
Good answer content is not a new genre. It is clear writing with a predictable structure. Here is the structure we recommend in Content Studio briefs.

## 1. Start with the reader's question

Write the question exactly as a customer would ask it, then decide what a complete answer needs: a definition, a recommendation, a set of steps or a comparison. If you cannot state the answer in two sentences, the page probably covers too much.

## 2. Lead with the answer

Put the direct answer in the first paragraph under the heading. Then explain why, when it does not apply, and what to do next. Readers skim, and extraction systems favour passages that stand on their own.

## 3. Use headings as a table of contents

Each H2 should be a question or a task ("Choosing a size", "Cleaning and storage"). Someone who reads only the headings should still learn something.

## 4. Prefer lists and tables for structure

Use steps for processes and tables for comparisons. Do not turn every paragraph into bullets, though: reasoning needs sentences.

## 5. Show your evidence

- Link to primary sources for statistics and claims.
- Show a publish date, and an update date when facts change.
- Say who is behind the content and why they are qualified.

When a draft makes a claim you cannot support yet, mark it. Content Studio inserts a visible **[SOURCE NEEDED]** marker instead of inventing a citation, so an editor resolves it before publishing.

## 6. Link to the next question

Every answer raises a follow-up. Link to the page that answers it, using descriptive anchor text such as "how to choose a tent size", not "click here". Content Studio suggests internal links using only pages found in your latest crawl.

## 7. Review before publishing

AI-assisted drafts save time, but a person who knows the subject should check facts, tone and claims. That is why Surfaced drafts go through draft, in review and approved stages, and nothing is published to your site automatically.
`,
  },
  {
    slug: 'generative-engine-optimization-what-you-can-measure',
    title: 'Generative engine optimization: what you can measure today',
    description:
      'GEO is about how AI assistants describe and cite your brand. Here is what is measurable, what is not, and how to avoid misleading numbers.',
    category: 'geo',
    cluster: 'AI visibility',
    publishedAt: '2026-10-09',
    body: `
**Generative engine optimization (GEO)** is about how AI assistants talk about your brand when people ask for recommendations, comparisons or explanations. Unlike search rankings, there is no single position to track. Answers vary by wording, location, time and model. Even so, a lot can be measured, as long as you are careful about what the numbers mean.

## What you can observe

When an assistant answers through an official API, you can record:

- **The full answer text.** Is your brand mentioned? Where does it appear relative to competitors?
- **Citations.** Many assistants with web search attach source URLs to their answers. Do they include pages on your domain?
- **Sources.** Which domains does the assistant rely on for your topic? These are often review sites, forums, documentation and publishers.
- **Context.** Which model answered, for which country and language, and when.

## What you cannot observe

- **What every user sees.** Consumer apps personalize answers and change often. A set of tracked prompts is a sample, not a census.
- **Why a model chose a source.** You can see correlations, such as pages that are often cited, but not the model's reasoning.
- **Answers from assistants without an official API.** We do not scrape consumer chat interfaces. Doing so would break providers' terms and produce unreliable data.

## Making the numbers honest

1. **Report the sample size.** "Mentioned in 34% of answers" means little without "out of 48 answers from 12 prompts".
2. **Keep successful and failed calls separate.** An API timeout is not a missing mention.
3. **Compare like with like.** Do not mix providers, countries or prompt sets in one trend line without saying so.
4. **Label estimates.** Sentiment scored by a model is an estimate, not a measurement.

## What tends to help

GEO builds on fundamentals: a crawlable site, clear answers, consistent facts about your brand, and presence in the independent sources assistants already cite. Track a stable set of prompts over time, look at which sources appear for competitors but not for you, and work on earning a place in them.
`,
  },
  {
    slug: 'mention-rate-citation-rate-share-of-voice',
    title: 'Mention rate, citation rate and share of voice, explained',
    description:
      'The exact formulas behind AI visibility metrics, with worked examples and the mistakes that make them misleading.',
    category: 'geo',
    cluster: 'AI visibility',
    publishedAt: '2026-10-16',
    body: `
AI visibility dashboards are only useful if you know how every number is calculated. These are the definitions Surfaced uses, and the reasons behind them.

## The unit: an observation

An **observation** is one prompt sent to one provider once, for a given country and language. Each observation either succeeds, giving an answer we can analyze, or fails, for example with a timeout or rate limit. **Metrics use successful observations only.** Failed calls are shown separately, so an outage never looks like a drop in visibility.

## Mention rate

> **Mention rate** = successful observations that mention your brand ÷ successful observations

If 48 answers succeeded and 17 mention your brand by name, alias or domain, your mention rate is 17 ÷ 48 ≈ **35%**. Each answer counts once, however many times the brand appears in it.

## Citation rate

> **Citation rate** = successful observations that cite at least one URL on your domain ÷ successful observations

Being cited is stronger than being mentioned: it means the assistant pointed readers to your content. Citations depend on the provider. Model-only answers without web search usually include none, so compare citation rates within one provider.

## Share of voice

> **Share of voice** = your brand's mentions ÷ (your mentions + all tracked competitors' mentions)

Again, each entity counts once per answer. If your brand appears in 17 answers and two competitors appear in 20 and 13, your share of voice is 17 ÷ (17 + 20 + 13) = **34%**. Share of voice depends on which competitors you track, so it is a relative measure.

## Common mistakes

- **Small samples.** Five prompts on one day cannot show a trend. Look at weekly or monthly buckets and their sizes.
- **Mixing settings.** Comparing a US English answer with a German one, or web search with model-only answers, changes what you measure.
- **Treating estimates as facts.** Sentiment is classified by a model, so Surfaced labels it as an AI estimate.
- **Hiding the denominator.** Every Surfaced chart shows how many observations it is based on, and you can open each one to read the original answer.

Clear definitions do not make AI answers predictable, but they make your measurements comparable over time.
`,
  },
];
