import { z } from 'zod';
import { CONTENT_GENERATION_MODES, CONTENT_STATUSES, LLM_PROVIDER_KEYS, SEARCH_INTENTS } from '../enums';
import {
  countryCodeSchema,
  idSchema,
  languageCodeSchema,
  optionalHttpUrlSchema,
  paginationSchema,
} from './common';

/** Hard cap on stored Markdown per version (~30k words); generation targets are far lower. */
export const CONTENT_BODY_MAX_CHARS = 200_000;

export const contentBriefInputSchema = z.object({
  title: z.string().trim().min(3).max(255),
  primaryKeyword: z.string().trim().min(2).max(200),
  secondaryKeywords: z.array(z.string().trim().min(1).max(200)).max(20).default([]),
  searchIntent: z.enum(SEARCH_INTENTS).default('INFORMATIONAL'),
  targetAudience: z.string().trim().max(500).optional(),
  country: countryCodeSchema,
  language: languageCodeSchema,
  brandVoice: z.string().trim().max(2000).optional(),
  targetUrl: optionalHttpUrlSchema,
  wordCountTarget: z.int().min(300).max(4000).optional(),
  notes: z.string().trim().max(4000).optional(),
});
export type ContentBriefInput = z.input<typeof contentBriefInputSchema>;

export const contentBriefUpdateSchema = contentBriefInputSchema.partial();

/** Request to generate an AI content-brief proposal (questions + brief fields) for one topic. */
export const briefIdeasSchema = z.object({
  seed: z.string().trim().min(2, 'Enter a topic').max(200),
  country: countryCodeSchema,
  language: languageCodeSchema,
  questionCount: z.int().min(3).max(12).default(6),
  /** Which configured LLM provider generates it; omit for the server default. Lets the same topic be proposed
   * by each provider and compared. */
  provider: z.enum(LLM_PROVIDER_KEYS).optional(),
});
export type BriefIdeasInput = z.input<typeof briefIdeasSchema>;

export const outlineItemSchema = z.object({
  heading: z.string().trim().min(1).max(200),
  level: z.union([z.literal(2), z.literal(3)]),
  points: z.array(z.string().trim().min(1).max(300)).max(8).default([]),
});
export type OutlineItem = z.infer<typeof outlineItemSchema>;

export const faqItemSchema = z.object({
  question: z.string().trim().min(5).max(300),
  answer: z.string().trim().min(5).max(2000),
});
export type FaqItem = z.infer<typeof faqItemSchema>;

export const internalLinkSuggestionSchema = z.object({
  url: z.url({ protocol: /^https?$/ }).max(2048),
  anchorText: z.string().trim().min(1).max(120),
  reason: z.string().trim().max(300).optional(),
});
export type InternalLinkSuggestion = z.infer<typeof internalLinkSuggestionSchema>;

export const contentDocumentCreateSchema = z.object({
  title: z.string().trim().min(3).max(255),
  briefId: idSchema.optional(),
  targetUrl: optionalHttpUrlSchema,
});
export type ContentDocumentCreateInput = z.input<typeof contentDocumentCreateSchema>;

export const contentDocumentUpdateSchema = z.object({
  title: z.string().trim().min(3).max(255).optional(),
  status: z.enum(CONTENT_STATUSES).optional(),
  assigneeId: idSchema.nullable().optional(),
  targetUrl: optionalHttpUrlSchema.nullable(),
});
export type ContentDocumentUpdateInput = z.input<typeof contentDocumentUpdateSchema>;

export const contentVersionSaveSchema = z.object({
  title: z.string().trim().min(3).max(255),
  body: z.string().max(CONTENT_BODY_MAX_CHARS),
  metaTitle: z.string().trim().max(255).optional(),
  metaDescription: z.string().trim().max(500).optional(),
  faqs: z.array(faqItemSchema).max(20).optional(),
  internalLinks: z.array(internalLinkSuggestionSchema).max(30).optional(),
  schemaJsonLd: z.record(z.string(), z.unknown()).optional(),
  note: z.string().trim().max(500).optional(),
});
export type ContentVersionSaveInput = z.input<typeof contentVersionSaveSchema>;

export const contentGenerateSchema = z
  .object({
    mode: z.enum(CONTENT_GENERATION_MODES),
    /** Required for mode "section": the exact heading of the section to regenerate. */
    sectionHeading: z.string().trim().min(1).max(200).optional(),
    instructions: z.string().trim().max(2000).optional(),
  })
  .refine((v) => v.mode !== 'section' || Boolean(v.sectionHeading), {
    path: ['sectionHeading'],
    message: 'Choose the section to regenerate',
  });
export type ContentGenerateInput = z.infer<typeof contentGenerateSchema>;

export const contentListQuerySchema = paginationSchema.extend({
  status: z.enum(CONTENT_STATUSES).optional(),
  q: z.string().trim().max(200).optional(),
});
