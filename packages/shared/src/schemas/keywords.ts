import { z } from 'zod';
import { KEYWORD_PRIORITIES, KEYWORD_STATUSES, LLM_PROVIDER_KEYS, SEARCH_INTENTS } from '../enums';
import {
  countryCodeSchema,
  idSchema,
  languageCodeSchema,
  optionalHttpUrlSchema,
  paginationSchema,
} from './common';

/** 1 MB of CSV text is roughly 20k keyword rows; larger files should be split. */
export const KEYWORD_CSV_MAX_CHARS = 1_000_000;
export const KEYWORD_IMPORT_MAX_ROWS = 5000;

const relatedQuestionsSchema = z.array(z.string().trim().min(3).max(300)).max(20);

export const keywordInputSchema = z.object({
  phrase: z.string().trim().min(1, 'Enter a keyword').max(200),
  intent: z.enum(SEARCH_INTENTS).optional(),
  country: countryCodeSchema,
  language: languageCodeSchema,
  priority: z.enum(KEYWORD_PRIORITIES).default('MEDIUM'),
  status: z.enum(KEYWORD_STATUSES).default('IDEA'),
  listId: idSchema.optional(),
  clusterId: idSchema.optional(),
  relatedQuestions: relatedQuestionsSchema.default([]),
  targetUrl: optionalHttpUrlSchema,
  notes: z.string().trim().max(1000).optional(),
  isPrimary: z.boolean().default(false),
});
export type KeywordInput = z.input<typeof keywordInputSchema>;

export const keywordBulkCreateSchema = z.object({
  keywords: z.array(keywordInputSchema).min(1).max(500),
});

export const keywordUpdateSchema = z.object({
  phrase: z.string().trim().min(1).max(200).optional(),
  intent: z.enum(SEARCH_INTENTS).nullable().optional(),
  priority: z.enum(KEYWORD_PRIORITIES).optional(),
  status: z.enum(KEYWORD_STATUSES).optional(),
  listId: idSchema.nullable().optional(),
  clusterId: idSchema.nullable().optional(),
  relatedQuestions: relatedQuestionsSchema.optional(),
  targetUrl: optionalHttpUrlSchema.nullable(),
  notes: z.string().trim().max(1000).nullable().optional(),
  isPrimary: z.boolean().optional(),
});
export type KeywordUpdateInput = z.input<typeof keywordUpdateSchema>;

export const keywordListQuerySchema = paginationSchema.extend({
  q: z.string().trim().max(200).optional(),
  listId: idSchema.optional(),
  clusterId: idSchema.optional(),
  intent: z.enum(SEARCH_INTENTS).optional(),
  priority: z.enum(KEYWORD_PRIORITIES).optional(),
  status: z.enum(KEYWORD_STATUSES).optional(),
  primary: z.enum(['true', 'false']).optional(),
  sort: z.enum(['phrase', 'priority', 'status', 'createdAt']).default('createdAt'),
  order: z.enum(['asc', 'desc']).default('desc'),
});
export type KeywordListQuery = z.infer<typeof keywordListQuerySchema>;

export const keywordImportSchema = z.object({
  csv: z.string().min(1, 'The file is empty').max(KEYWORD_CSV_MAX_CHARS, 'The file is larger than 1 MB'),
  defaultCountry: countryCodeSchema,
  defaultLanguage: languageCodeSchema,
  listId: idSchema.optional(),
});
export type KeywordImportInput = z.input<typeof keywordImportSchema>;

export const keywordSuggestSchema = z.object({
  /** Topic to focus on; leave empty for ideas about the whole business (its pages, products and keywords). */
  seed: z
    .string()
    .trim()
    .max(200)
    .optional()
    .transform((v) => (v && v.length >= 2 ? v : undefined)),
  country: countryCodeSchema,
  language: languageCodeSchema,
  count: z.int().min(5).max(50).default(20),
  /** Which configured LLM provider generates the ideas; omit to use the server default. Lets the same seed be run
   * on each provider and the results compared. The server rejects a provider that is not configured. */
  provider: z.enum(LLM_PROVIDER_KEYS).optional(),
});
export type KeywordSuggestInput = z.input<typeof keywordSuggestSchema>;

export const keywordGroupInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).optional(),
  pillarUrl: optionalHttpUrlSchema,
});
export type KeywordGroupInput = z.input<typeof keywordGroupInputSchema>;
