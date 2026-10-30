// Schemas for recommendations, reports and competitor analysis.
import { MANUAL_PROVIDER_KEYS } from '../ai-search';
import { z } from 'zod';
import {
  ISSUE_SEVERITIES,
  RECOMMENDATION_CATEGORIES,
  RECOMMENDATION_EFFORTS,
  RECOMMENDATION_OWNER_ROLES,
  RECOMMENDATION_STATUSES,
  REPORT_SECTIONS,
  VISIBILITY_PROVIDER_KEYS,
} from '../enums';
import { csvListSchema, dateInputSchema, idSchema, paginationSchema } from './common';

export const recommendationListQuerySchema = paginationSchema.extend({
  status: csvListSchema(z.enum(RECOMMENDATION_STATUSES)),
  category: csvListSchema(z.enum(RECOMMENDATION_CATEGORIES)),
  severity: csvListSchema(z.enum(ISSUE_SEVERITIES)),
  assigneeId: idSchema.optional(),
});
export type RecommendationListQuery = z.infer<typeof recommendationListQuerySchema>;

export const recommendationUpdateSchema = z
  .object({
    status: z.enum(RECOMMENDATION_STATUSES).optional(),
    assigneeId: idSchema.nullable().optional(),
    ownerRole: z.enum(RECOMMENDATION_OWNER_ROLES).nullable().optional(),
    effort: z.enum(RECOMMENDATION_EFFORTS).nullable().optional(),
    verification: z.string().trim().max(2000).nullable().optional(),
    dueAt: dateInputSchema.nullable().optional(),
    dismissedReason: z.string().trim().max(500).optional(),
    blockedReason: z.string().trim().max(500).optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), 'Nothing to update')
  .refine((v) => v.status !== 'BLOCKED' || Boolean(v.blockedReason?.trim()), {
    path: ['blockedReason'],
    message: 'Add a reason the recommendation is blocked.',
  });
export type RecommendationUpdateInput = z.infer<typeof recommendationUpdateSchema>;

/** Longest report window; keeps report generation bounded. */
export const REPORT_MAX_RANGE_DAYS = 366;

export const reportCreateSchema = z
  .object({
    title: z.string().trim().min(3).max(255),
    dateFrom: dateInputSchema,
    dateTo: dateInputSchema,
    sections: z.array(z.enum(REPORT_SECTIONS)).min(1, 'Choose at least one section'),
    /** Restrict visibility sections to one provider; "all" pools providers with a visible note. */
    provider: z.enum([...VISIBILITY_PROVIDER_KEYS, ...MANUAL_PROVIDER_KEYS, 'all']).default('all'),
  })
  .refine((v) => v.dateFrom <= v.dateTo, {
    path: ['dateTo'],
    message: 'End date must be after the start date',
  })
  .refine((v) => (v.dateTo.getTime() - v.dateFrom.getTime()) / 86_400_000 <= REPORT_MAX_RANGE_DAYS, {
    path: ['dateFrom'],
    message: `Reports can cover at most ${REPORT_MAX_RANGE_DAYS} days`,
  });
export type ReportCreateInput = z.input<typeof reportCreateSchema>;

export const competitorComparisonQuerySchema = z.object({
  provider: z.enum([...VISIBILITY_PROVIDER_KEYS, ...MANUAL_PROVIDER_KEYS, 'all']).default('all'),
  from: dateInputSchema.optional(),
  to: dateInputSchema.optional(),
});
export type CompetitorComparisonQuery = z.infer<typeof competitorComparisonQuerySchema>;
