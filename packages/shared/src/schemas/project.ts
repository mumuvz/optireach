import { z } from 'zod';
import { isIndustryKey } from '../constants/industries';
import { AUDIT_SCHEDULES } from '../enums';
import { normalizeDomain, UrlValidationError } from '../url';
import { businessProfileSchema, locationInputSchema } from '../local';
import { countryCodeSchema, languageCodeSchema, websiteUrlSchema } from './common';

/** Largest explicit page cap a project can set (null means every page the crawler can reach). */
export const CRAWL_MAX_PAGES_CEILING = 10_000_000;
export const CRAWL_MAX_DEPTH_CEILING = 100;

export const crawlSettingsSchema = z.object({
  /** null crawls every page reachable through links and sitemaps (plan and server caps still apply if set). */
  maxPages: z.int().min(1).max(CRAWL_MAX_PAGES_CEILING).nullable(),
  /** null follows links at any click depth. */
  maxDepth: z.int().min(0).max(CRAWL_MAX_DEPTH_CEILING).nullable(),
  includeSubdomains: z.boolean(),
  /** Extra politeness delay between requests to the same host (robots.txt Crawl-delay still applies). */
  crawlDelayMs: z.int().min(0).max(10_000),
});
export type CrawlSettings = z.infer<typeof crawlSettingsSchema>;

export const DEFAULT_CRAWL_SETTINGS: CrawlSettings = {
  maxPages: null,
  maxDepth: null,
  includeSubdomains: false,
  crawlDelayMs: 250,
};

/** The smallest of several optional page caps (null = no cap). */
export function combinePageCaps(...caps: (number | null | undefined)[]): number | null {
  const set = caps.filter((c): c is number => typeof c === 'number' && c > 0);
  return set.length ? Math.min(...set) : null;
}

export const domainSchema = z
  .string()
  .trim()
  .min(3)
  .max(253)
  .transform((value, ctx) => {
    try {
      return normalizeDomain(value);
    } catch (error) {
      ctx.addIssue({
        code: 'custom',
        message: error instanceof UrlValidationError ? error.message : 'Invalid domain',
      });
      return z.NEVER;
    }
  });

const aliasListSchema = z.array(z.string().trim().min(1).max(120)).max(10);

export const competitorInputSchema = z.object({
  name: z.string().trim().min(1, 'Enter a name').max(120),
  domain: domainSchema,
  aliases: aliasListSchema.optional(),
  notes: z.string().trim().max(2000).optional(),
});
export type CompetitorInput = z.infer<typeof competitorInputSchema>;

export const competitorUpdateSchema = competitorInputSchema.partial();

const keywordPhraseSchema = z.string().trim().min(1).max(200);

const projectFields = {
  name: z.string().trim().min(2, 'Enter the business name').max(120),
  /** Optional: local businesses can be managed through their listings without a website. */
  websiteUrl: websiteUrlSchema.nullable().optional(),
  description: z.string().trim().max(5000).optional(),
  industry: z
    .string()
    .refine((value) => isIndustryKey(value), 'Choose an industry from the list')
    .optional(),
  targetCountries: z.array(countryCodeSchema).min(1, 'Choose at least one country').max(25),
  targetLanguages: z.array(languageCodeSchema).min(1, 'Choose at least one language').max(10),
  brandVoice: z.string().trim().max(2000).optional(),
  brandAliases: aliasListSchema.optional(),
  crawlSettings: crawlSettingsSchema.partial().optional(),
  auditSchedule: z.enum(AUDIT_SCHEDULES).optional(),
  businessProfile: businessProfileSchema.optional(),
};

export const projectCreateSchema = z.object({
  ...projectFields,
  competitors: z.array(competitorInputSchema).max(25).optional(),
  primaryKeywords: z.array(keywordPhraseSchema).max(50).optional(),
  /** Business locations created with the project (onboarding). */
  locations: z.array(locationInputSchema).max(25).optional(),
});
export type ProjectCreateInput = z.input<typeof projectCreateSchema>;
export type ProjectCreateData = z.output<typeof projectCreateSchema>;

export const projectUpdateSchema = z.object({
  name: projectFields.name.optional(),
  /** null removes the website (audits and other website features then stop). */
  websiteUrl: projectFields.websiteUrl,
  businessProfile: projectFields.businessProfile,
  description: projectFields.description.nullable(),
  industry: projectFields.industry.nullable(),
  targetCountries: projectFields.targetCountries.optional(),
  targetLanguages: projectFields.targetLanguages.optional(),
  brandVoice: projectFields.brandVoice.nullable(),
  brandAliases: projectFields.brandAliases,
  crawlSettings: projectFields.crawlSettings,
  auditSchedule: projectFields.auditSchedule,
  /** Replaces the project's primary keyword set when provided. */
  primaryKeywords: z.array(keywordPhraseSchema).max(50).optional(),
});
export type ProjectUpdateInput = z.input<typeof projectUpdateSchema>;
export type ProjectUpdateData = z.output<typeof projectUpdateSchema>;
