import { z } from 'zod';
import { canonicalLanguageCode, isCountryCode } from '../constants/locales';
import { MAX_URL_LENGTH, UrlValidationError, normalizeWebsiteUrl } from '../url';

/** Prisma CUID ids (25 chars today; allow a little headroom). */
export const idSchema = z.string().regex(/^[a-z0-9]{20,32}$/, 'Invalid id');

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254, 'Email is too long')
  .pipe(z.email('Enter a valid email address'));

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 128;

/** Length-based policy (NIST SP 800-63B): at least 10 characters, not just one repeated character. */
export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Use at least ${PASSWORD_MIN_LENGTH} characters`)
  .max(PASSWORD_MAX_LENGTH, `Use at most ${PASSWORD_MAX_LENGTH} characters`)
  .refine((value) => new Set(value).size > 2, 'Choose a less predictable password');

export const nameSchema = z.string().trim().min(2, 'Enter at least 2 characters').max(120, 'Too long');

export const countryCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .refine(isCountryCode, 'Unsupported country code');

export const languageCodeSchema = z
  .string()
  .trim()
  .transform((value, ctx) => {
    const canonical = canonicalLanguageCode(value);
    if (!canonical) {
      ctx.addIssue({ code: 'custom', message: 'Unsupported language' });
      return z.NEVER;
    }
    return canonical;
  });

/** Website input normalized to a start URL (syntactic validation only). */
export const websiteUrlSchema = z
  .string()
  .trim()
  .max(MAX_URL_LENGTH)
  .transform((value, ctx) => {
    try {
      return normalizeWebsiteUrl(value).url;
    } catch (error) {
      ctx.addIssue({
        code: 'custom',
        message: error instanceof UrlValidationError ? error.message : 'Invalid website address',
      });
      return z.NEVER;
    }
  });

/** Optional absolute http(s) URL, e.g. a target page. Empty strings become undefined. */
export const optionalHttpUrlSchema = z
  .string()
  .trim()
  .max(MAX_URL_LENGTH)
  .optional()
  .transform((value, ctx) => {
    if (!value) return undefined;
    try {
      const parsed = new URL(value);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('protocol');
      return parsed.toString();
    } catch {
      ctx.addIssue({ code: 'custom', message: 'Enter a full URL starting with http:// or https://' });
      return z.NEVER;
    }
  });

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
export type PaginationInput = z.infer<typeof paginationSchema>;

export const sortOrderSchema = z.enum(['asc', 'desc']).default('desc');

/** ISO date (YYYY-MM-DD) or full ISO timestamp, parsed to a Date. */
export const dateInputSchema = z.coerce.date().refine((d) => !Number.isNaN(d.getTime()), 'Invalid date');

/** Comma-separated query value ("a,b") or repeated params, normalized to a string array. */
export function csvListSchema<T extends z.ZodType>(item: T, max = 50) {
  return z.preprocess((value) => {
    if (value === undefined || value === null || value === '') return undefined;
    const raw = Array.isArray(value) ? value : String(value).split(',');
    const parts = raw.map((part) => String(part).trim()).filter(Boolean);
    return parts.length ? parts : undefined;
  }, z.array(item).max(max).optional());
}

export const booleanQuerySchema = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .optional()
  .transform((value) =>
    value === undefined ? undefined : value === true || value === 'true' || value === '1',
  );
