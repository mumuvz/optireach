// Content generation prompts, strict output schemas and deterministic development templates.
// Generated content is a draft for human review: the model is told never to invent facts, figures,
// quotes or sources, and to mark claims that need evidence with [SOURCE NEEDED: ...].
import {
  SEARCH_INTENTS,
  SEARCH_INTENT_LABELS,
  languageName,
  type ContentGenerationMode,
  type SearchIntent,
} from '@surfaced/shared';
import { z } from 'zod';

// Schemas use only required fields (no optional/defaults) so they work with strict structured outputs.
export const outlineOutputSchema = z.object({
  title: z.string(),
  sections: z.array(z.object({ heading: z.string(), level: z.number(), points: z.array(z.string()) })),
});
export const articleOutputSchema = z.object({
  title: z.string(),
  metaTitle: z.string(),
  metaDescription: z.string(),
  markdown: z.string(),
  faqs: z.array(z.object({ question: z.string(), answer: z.string() })),
});
export const metaOutputSchema = z.object({ metaTitle: z.string(), metaDescription: z.string() });
export const faqOutputSchema = z.object({
  faqs: z.array(z.object({ question: z.string(), answer: z.string() })),
});
export const sectionOutputSchema = z.object({ markdown: z.string() });
export const keywordIdeasOutputSchema = z.object({
  keywords: z.array(
    z.object({
      phrase: z.string(),
      intent: z.enum(SEARCH_INTENTS),
      relatedQuestions: z.array(z.string()),
      rationale: z.string(),
    }),
  ),
});

// A content-brief proposal for one topic: the real questions people ask, plus the fields an editor needs.
// Contains no measured metrics — wordCountTarget is a writing-length suggestion, not search data.
export const briefIdeasOutputSchema = z.object({
  title: z.string(),
  primaryKeyword: z.string(),
  secondaryKeywords: z.array(z.string()),
  searchIntent: z.enum(SEARCH_INTENTS),
  targetAudience: z.string(),
  angle: z.string(),
  wordCountTarget: z.number(),
  questions: z.array(
    z.object({ question: z.string(), intent: z.enum(SEARCH_INTENTS), rationale: z.string() }),
  ),
  outlineHeadings: z.array(z.string()),
});
export type BriefIdeas = z.infer<typeof briefIdeasOutputSchema>;

export const BRIEF_IDEAS_SYSTEM_PROMPT = [
  'You are an SEO and answer-engine (AEO) content strategist. From the business context you are given, produce a',
  'content-brief proposal for the requested topic: the real questions people ask Google and AI assistants about it,',
  'and the fields an editor needs to write one page that answers them well.',
  'Rules you must follow:',
  '- Base everything on what the business actually offers (its description, pages, products and keywords). Do not',
  '  propose topics, products or services the business does not show.',
  '- NEVER invent or estimate search volume, keyword difficulty, CPC, rankings, traffic or any other metric.',
  '  wordCountTarget is only a suggested writing length (an integer between 600 and 3000), not a measurement.',
  '- questions must be natural phrasings a real person would type or ask aloud, each answerable on one page.',
  '- outlineHeadings are concise H2s; phrase several of them as the questions so each can be answered directly.',
  '- primaryKeyword is the single phrase the page should target; secondaryKeywords are closely related phrases.',
  '- Write every field in the requested language.',
].join('\n');

export function buildBriefIdeasPrompt(
  seed: string,
  businessContext: string,
  country: string,
  language: string,
  questionCount: number,
): string {
  return [
    businessContext,
    `Topic to build the brief around: ${seed}`,
    `Market: ${country}; language: ${languageName(language)} (${language}).`,
    `Propose ${questionCount} distinct questions across informational, commercial and transactional intent, and an`,
    'outline of 5–8 headings. Keep the brief tightly focused on this one topic and what the business offers.',
  ]
    .filter(Boolean)
    .join('\n');
}

export function devBriefIdeas(
  seed: string,
  brandName: string,
  questionCount: number,
): z.infer<typeof briefIdeasOutputSchema> {
  const topic = seed.trim() || brandName;
  const questions = [
    { q: `What is ${topic}?`, intent: 'INFORMATIONAL' as const },
    { q: `How do I choose ${topic}?`, intent: 'COMMERCIAL' as const },
    { q: `How much does ${topic} cost?`, intent: 'COMMERCIAL' as const },
    { q: `Is ${topic} worth it?`, intent: 'COMMERCIAL' as const },
    { q: `Where can I get ${topic}?`, intent: 'TRANSACTIONAL' as const },
    { q: `${topic} vs the alternatives`, intent: 'COMMERCIAL' as const },
  ].slice(0, Math.max(3, Math.min(questionCount, 6)));
  return {
    title: `${topic}: a complete guide`,
    primaryKeyword: topic.toLowerCase(),
    secondaryKeywords: [`best ${topic}`, `${topic} guide`],
    searchIntent: 'INFORMATIONAL',
    targetAudience: 'People researching this topic (development template — not AI-generated).',
    angle: `Template brief for ${topic}; configure an LLM provider for a real proposal.`,
    wordCountTarget: 1200,
    questions: questions.map((x) => ({
      question: x.q,
      intent: x.intent,
      rationale: 'Development adapter template question (not AI-generated).',
    })),
    outlineHeadings: questions.map((x) => x.q),
  };
}

export interface ContentContext {
  brandName: string;
  brandUrl: string | null;
  industry: string | null;
  brandVoice: string | null;
  title: string;
  primaryKeyword: string;
  secondaryKeywords: string[];
  searchIntent: SearchIntent;
  targetAudience: string | null;
  country: string;
  language: string;
  wordCountTarget: number;
  notes: string | null;
  outline: { heading: string; level: number; points: string[] }[] | null;
  existingMarkdown: string | null;
  instructions: string | null;
  internalLinks: { url: string; anchorText: string }[];
}

export const CONTENT_SYSTEM_PROMPT = [
  'You are an experienced SEO and answer-engine content writer producing a DRAFT for human editors.',
  'Rules you must follow:',
  '- Write original, accurate, genuinely helpful content for the stated audience and search intent.',
  '- NEVER invent statistics, prices, dates, studies, quotes, customer names, testimonials, awards or sources.',
  '- When a statement would need evidence, write it carefully and add a marker like [SOURCE NEEDED: what to verify].',
  '- Do not claim the brand is the best or guaranteed to deliver results; describe what it offers based only on the brief.',
  '- Use clear question-style H2/H3 headings where natural, and answer each question directly in the first sentence below it.',
  '- Use Markdown (## for H2, ### for H3, lists, tables when useful). Do not include an H1; the title is separate.',
  '- Only link to URLs that are provided to you. Do not create other links.',
  '- Write in the requested language.',
].join('\n');

function contextBlock(ctx: ContentContext): string {
  return [
    `Brand: ${ctx.brandName}${ctx.brandUrl ? ` (${ctx.brandUrl})` : ' (no website)'}${ctx.industry ? `, industry: ${ctx.industry}` : ''}`,
    `Working title: ${ctx.title}`,
    `Primary keyword: ${ctx.primaryKeyword}`,
    ctx.secondaryKeywords.length ? `Secondary keywords: ${ctx.secondaryKeywords.join(', ')}` : null,
    `Search intent: ${SEARCH_INTENT_LABELS[ctx.searchIntent]}`,
    ctx.targetAudience ? `Target audience: ${ctx.targetAudience}` : null,
    `Market: ${ctx.country}; language: ${languageName(ctx.language)} (${ctx.language})`,
    ctx.brandVoice ? `Brand voice: ${ctx.brandVoice}` : null,
    ctx.notes ? `Editor notes: ${ctx.notes}` : null,
    ctx.instructions ? `Extra instructions for this request: ${ctx.instructions}` : null,
    ctx.internalLinks.length
      ? `Internal pages you MAY link to (use only these URLs):\n${ctx.internalLinks.map((l) => `- ${l.anchorText}: ${l.url}`).join('\n')}`
      : 'No internal link targets were provided; do not add links.',
  ]
    .filter(Boolean)
    .join('\n');
}

export function buildUserPrompt(
  mode: ContentGenerationMode,
  ctx: ContentContext,
  sectionHeading?: string,
): string {
  const base = contextBlock(ctx);
  switch (mode) {
    case 'outline':
      return `${base}\n\nCreate a detailed article outline (6–10 sections of H2/H3 with 2–4 key points each) that fully answers the search intent. Return the title and sections.`;
    case 'article':
      return `${base}\n\n${ctx.outline?.length ? `Follow this outline:\n${ctx.outline.map((s) => `${'#'.repeat(Math.min(3, Math.max(2, s.level)))} ${s.heading}${s.points.length ? ` — ${s.points.join('; ')}` : ''}`).join('\n')}\n\n` : ''}Write the full article in Markdown (about ${ctx.wordCountTarget} words). Also return an SEO meta title (max 60 characters), a meta description (max 155 characters) and 3–6 FAQs whose answers also appear in the article.`;
    case 'meta':
      return `${base}\n\n${ctx.existingMarkdown ? `Article:\n"""\n${ctx.existingMarkdown.slice(0, 20_000)}\n"""\n\n` : ''}Write an SEO meta title (max 60 characters) and meta description (max 155 characters) that accurately describe the content.`;
    case 'faq':
      return `${base}\n\n${ctx.existingMarkdown ? `Article:\n"""\n${ctx.existingMarkdown.slice(0, 20_000)}\n"""\n\n` : ''}Suggest 4–6 frequently asked questions with concise, factual answers (2–4 sentences) based only on the article and brief.`;
    case 'section':
      return `${base}\n\nCurrent article:\n"""\n${(ctx.existingMarkdown ?? '').slice(0, 20_000)}\n"""\n\nRewrite ONLY the section headed "${sectionHeading}". Return Markdown starting with the same heading line and keep it consistent with the rest of the article.`;
    default:
      throw new Error(`Mode ${mode} does not use the LLM`);
  }
}

// ---------------- Development templates (clearly labeled, not AI) ----------------

export const DEV_ADAPTER_NOTICE =
  '> **Development adapter output** — this is template text, not AI-generated. Configure an LLM provider for real drafts.';

export function devOutline(ctx: ContentContext): z.infer<typeof outlineOutputSchema> {
  const k = ctx.primaryKeyword;
  return {
    title: ctx.title,
    sections: [
      { heading: `What is ${k}?`, level: 2, points: ['Plain-language definition', 'Who it is for'] },
      {
        heading: `Why ${k} matters`,
        level: 2,
        points: ['Problems it solves', 'When it is not the right fit'],
      },
      {
        heading: `How to choose the right ${k}`,
        level: 2,
        points: ['Key criteria', 'Questions to ask vendors'],
      },
      {
        heading: `How ${ctx.brandName} approaches ${k}`,
        level: 2,
        points: ['What the offering includes (from the brief)', '[SOURCE NEEDED: confirm features]'],
      },
      { heading: 'Frequently asked questions', level: 2, points: ['Short, direct answers'] },
    ],
  };
}

export function devArticle(ctx: ContentContext): z.infer<typeof articleOutputSchema> {
  const outline = ctx.outline?.length ? ctx.outline : devOutline(ctx).sections;
  const body = outline
    .map(
      (s) =>
        `${'#'.repeat(Math.min(3, Math.max(2, s.level)))} ${s.heading}\n\n${s.points.map((p) => `- ${p}`).join('\n')}\n\nThis section should explain ${s.heading.toLowerCase()} for ${ctx.targetAudience ?? 'your readers'}. [SOURCE NEEDED: add verified details]`,
    )
    .join('\n\n');
  return {
    title: ctx.title,
    metaTitle: ctx.title.slice(0, 60),
    metaDescription:
      `Learn about ${ctx.primaryKeyword}: key criteria, common questions and how ${ctx.brandName} can help.`.slice(
        0,
        155,
      ),
    markdown: `${DEV_ADAPTER_NOTICE}\n\n${body}`,
    faqs: devFaqs(ctx).faqs,
  };
}

export function devMeta(ctx: ContentContext): z.infer<typeof metaOutputSchema> {
  return {
    metaTitle: `${ctx.primaryKeyword} | ${ctx.brandName}`.slice(0, 60),
    metaDescription:
      `A practical guide to ${ctx.primaryKeyword} for ${ctx.targetAudience ?? 'teams'}, with answers to common questions.`.slice(
        0,
        155,
      ),
  };
}

export function devFaqs(ctx: ContentContext): z.infer<typeof faqOutputSchema> {
  return {
    faqs: [
      {
        question: `What is ${ctx.primaryKeyword}?`,
        answer: `Template answer: describe ${ctx.primaryKeyword} in one or two sentences. [SOURCE NEEDED]`,
      },
      {
        question: `How do I choose ${ctx.primaryKeyword}?`,
        answer: 'Template answer: list the most important selection criteria for your audience.',
      },
      {
        question: `Does ${ctx.brandName} offer ${ctx.primaryKeyword}?`,
        answer: 'Template answer: confirm the offering and link to the relevant page.',
      },
    ],
  };
}

export function devSection(ctx: ContentContext, heading: string): z.infer<typeof sectionOutputSchema> {
  return {
    markdown: `## ${heading}\n\n${DEV_ADAPTER_NOTICE}\n\nTemplate rewrite of this section for ${ctx.primaryKeyword}. [SOURCE NEEDED: add verified details]\n`,
  };
}

export function outlineToMarkdown(outline: z.infer<typeof outlineOutputSchema>['sections']): string {
  return outline
    .map(
      (s) =>
        `${'#'.repeat(Math.min(3, Math.max(2, s.level)))} ${s.heading}\n\n${s.points.map((p) => `- ${p}`).join('\n')}`,
    )
    .join('\n\n');
}
