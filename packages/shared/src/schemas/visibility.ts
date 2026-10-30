import { z } from 'zod';
import { MANUAL_PROVIDER_KEYS, citySchema } from '../ai-search';
import { PROMPT_FREQUENCIES, PROMPT_STATUSES, VISIBILITY_PROVIDER_KEYS } from '../enums';
import {
  countryCodeSchema,
  csvListSchema,
  dateInputSchema,
  idSchema,
  languageCodeSchema,
  paginationSchema,
} from './common';

export const promptInputSchema = z.object({
  text: z.string().trim().min(10, 'Write the full question (at least 10 characters)').max(1000),
  intent: z.string().trim().max(60).optional(),
  country: countryCodeSchema,
  /** City the answer should be local to (sent to providers that accept a location; others say so). */
  city: citySchema.nullable().optional(),
  language: languageCodeSchema,
  /** Defaults to the project's business name when omitted. */
  targetBrand: z.string().trim().min(1).max(120).optional(),
  /** Subset of the project's competitors to compare; empty means all project competitors. */
  competitorIds: z.array(idSchema).max(25).default([]),
  providers: z.array(z.enum(VISIBILITY_PROVIDER_KEYS)).min(1, 'Choose at least one provider').max(4),
  frequency: z.enum(PROMPT_FREQUENCIES).default('WEEKLY'),
  status: z.enum(PROMPT_STATUSES).default('ACTIVE'),
});
export type PromptInput = z.input<typeof promptInputSchema>;
export type PromptData = z.output<typeof promptInputSchema>;

export const promptUpdateSchema = promptInputSchema.partial();

/** Prompts added in one bulk request. */
export const PROMPT_BULK_MAX = 100;

/**
 * Many prompts with the same settings. Lines shorter than a full question are skipped (and reported) rather than
 * failing the whole list, as are duplicates and prompts already tracked for the same country and language.
 */
export const promptBulkInputSchema = promptInputSchema.omit({ text: true }).extend({
  texts: z
    .array(z.string().trim().max(1000, 'Keep each question under 1,000 characters'))
    .min(1, 'Add at least one question')
    .max(PROMPT_BULK_MAX, `Add at most ${PROMPT_BULK_MAX} questions at a time`),
});
export type PromptBulkInput = z.input<typeof promptBulkInputSchema>;
export type PromptBulkData = z.output<typeof promptBulkInputSchema>;

/** Patterns that turn a keyword into the kind of question people ask an AI assistant when choosing. */
export const KEYWORD_QUESTION_TEMPLATES = [
  { key: 'best', template: 'What is the best {keyword}?' },
  { key: 'best-in', template: 'Best {keyword} in {country}' },
  { key: 'recommend', template: 'Which {keyword} do you recommend?' },
  { key: 'options', template: 'What are the top {keyword} options?' },
  { key: 'choose', template: 'How do I choose a {keyword}?' },
] as const;

/** Comparable form of a prompt for duplicate checks: lower case, single spaces, no trailing punctuation. */
export function normalizePromptText(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[\s?.!]+$/, '');
}

/** Keywords × templates, without duplicates, in keyword order. */
export function expandKeywords(keywords: string[], templates: string[], vars: { country: string }): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of keywords) {
    const keyword = raw.replace(/\s+/g, ' ').trim();
    if (!keyword) continue;
    for (const template of templates) {
      const text = template.replaceAll('{keyword}', keyword).replaceAll('{country}', vars.country);
      const key = normalizePromptText(text);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(text);
    }
  }
  return out;
}

export const promptListQuerySchema = paginationSchema.extend({
  status: z.enum(PROMPT_STATUSES).optional(),
  q: z.string().trim().max(200).optional(),
});

export const startVisibilityRunSchema = z.object({
  /** Limit the run to these prompts; defaults to all active prompts in the project. */
  promptIds: z.array(idSchema).max(500).optional(),
});

/**
 * Filters that define the observation set behind every visibility metric. The API echoes the
 * resolved filters back as the metric "composition" so comparisons are never silently mixed.
 */
export const visibilityFilterSchema = z.object({
  provider: z.enum([...VISIBILITY_PROVIDER_KEYS, ...MANUAL_PROVIDER_KEYS, 'all']).default('all'),
  country: countryCodeSchema.optional(),
  language: languageCodeSchema.optional(),
  promptIds: csvListSchema(idSchema, 200),
  from: dateInputSchema.optional(),
  to: dateInputSchema.optional(),
  includeDemo: z.enum(['true', 'false']).optional(),
});
export type VisibilityFilter = z.infer<typeof visibilityFilterSchema>;

export const visibilityTrendQuerySchema = visibilityFilterSchema.extend({
  bucket: z.enum(['day', 'week', 'month']).default('week'),
});

export const observationListQuerySchema = paginationSchema.extend(visibilityFilterSchema.shape).extend({
  mentioned: z.enum(['true', 'false']).optional(),
  cited: z.enum(['true', 'false']).optional(),
  status: z.enum(['SUCCEEDED', 'FAILED']).optional(),
});
export type ObservationListQuery = z.infer<typeof observationListQuerySchema>;
