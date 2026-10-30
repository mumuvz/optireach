import { z } from 'zod';
import { AUDIT_CATEGORIES, ISSUE_SEVERITIES, ISSUE_STATUSES, LLM_PROVIDER_KEYS } from '../enums';
import { csvListSchema, paginationSchema, sortOrderSchema } from './common';
import { crawlSettingsSchema } from './project';

export const startAuditSchema = z.object({
  /** One-off overrides for this run; clamped to plan limits by the API. */
  crawlSettings: crawlSettingsSchema.partial().optional(),
});
export type StartAuditInput = z.infer<typeof startAuditSchema>;

/** Request to run an AEO answerability analysis on the chosen LLM provider (omit for the server default). */
export const answerabilityRunSchema = z.object({
  provider: z.enum(LLM_PROVIDER_KEYS).optional(),
});
export type AnswerabilityRunInput = z.infer<typeof answerabilityRunSchema>;

export const ISSUE_SORT_FIELDS = ['severity', 'lastDetectedAt', 'firstDetectedAt', 'url', 'ruleId'] as const;

export const issueListQuerySchema = paginationSchema.extend({
  severity: csvListSchema(z.enum(ISSUE_SEVERITIES)),
  category: csvListSchema(z.enum(AUDIT_CATEGORIES)),
  status: csvListSchema(z.enum(ISSUE_STATUSES)),
  ruleId: z.string().trim().max(64).optional(),
  q: z.string().trim().max(200).optional(),
  sort: z.enum(ISSUE_SORT_FIELDS).default('severity'),
  order: sortOrderSchema,
});
export type IssueListQuery = z.infer<typeof issueListQuerySchema>;

export const issueUpdateSchema = z.object({
  status: z.enum(['OPEN', 'IGNORED']),
});
export type IssueUpdateInput = z.infer<typeof issueUpdateSchema>;

export const PAGE_SORT_FIELDS = [
  'url',
  'statusCode',
  'responseTimeMs',
  'wordCount',
  'depth',
  'inlinksCount',
] as const;

export const pageListQuerySchema = paginationSchema.extend({
  q: z.string().trim().max(200).optional(),
  statusClass: z.enum(['2xx', '3xx', '4xx', '5xx', 'error']).optional(),
  indexable: z.enum(['true', 'false']).optional(),
  sort: z.enum(PAGE_SORT_FIELDS).default('url'),
  order: z.enum(['asc', 'desc']).default('asc'),
});
export type PageListQuery = z.infer<typeof pageListQuerySchema>;
