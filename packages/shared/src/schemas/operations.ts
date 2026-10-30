// Schemas for cross-module operations: approvals, team tasks, agency client workspaces and provider rates.
import { z } from 'zod';
import {
  AGENCY_BILLING_MODES,
  APPROVAL_DECISIONS,
  APPROVAL_ENTITY_TYPES,
  APPROVAL_STATUSES,
  TASK_PRIORITIES,
  TASK_STATUSES,
  TASK_TYPES,
} from '../enums';
import {
  booleanQuerySchema,
  csvListSchema,
  dateInputSchema,
  emailSchema,
  idSchema,
  paginationSchema,
} from './common';

/** UTC calendar month, e.g. "2026-11". */
export const periodKeySchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use a month such as 2026-11');

/** A calendar date (YYYY-MM-DD), stored as UTC midnight. */
export const dateOnlySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date such as 2026-11-30')
  .transform((value, ctx) => {
    const date = new Date(`${value}T00:00:00.000Z`);
    if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
      ctx.addIssue({ code: 'custom', message: 'Invalid date' });
      return z.NEVER;
    }
    return date;
  });

const nonEmpty = (value: Record<string, unknown>) => Object.values(value).some((v) => v !== undefined);

// ---------------- Approvals ----------------

export const approvalListQuerySchema = paginationSchema.extend({
  workspaceId: idSchema.optional(),
  projectId: idSchema.optional(),
  status: csvListSchema(z.enum(APPROVAL_STATUSES)),
  entityType: csvListSchema(z.enum(APPROVAL_ENTITY_TYPES)),
  /** Only requests the current user is entitled to decide. */
  decidable: booleanQuerySchema,
});
export type ApprovalListQuery = z.infer<typeof approvalListQuerySchema>;

export const approvalDecisionSchema = z
  .object({
    decision: z.enum(APPROVAL_DECISIONS),
    note: z.string().trim().max(2000).optional(),
  })
  .refine((v) => v.decision === 'APPROVED' || Boolean(v.note), {
    path: ['note'],
    message: 'Explain what should change',
  });
export type ApprovalDecisionBody = z.infer<typeof approvalDecisionSchema>;

// ---------------- Tasks ----------------

const taskFields = {
  title: z.string().trim().min(2, 'Enter at least 2 characters').max(255),
  description: z.string().trim().max(10_000).nullable().optional(),
  type: z.enum(TASK_TYPES),
  priority: z.enum(TASK_PRIORITIES),
  status: z.enum(TASK_STATUSES),
  assigneeId: idSchema.nullable().optional(),
  dueDate: dateOnlySchema.nullable().optional(),
  periodKey: periodKeySchema.nullable().optional(),
  clientVisible: z.boolean(),
};

export const taskCreateSchema = z.object({
  ...taskFields,
  type: taskFields.type.default('OTHER'),
  priority: taskFields.priority.default('MEDIUM'),
  status: taskFields.status.default('TODO'),
  clientVisible: taskFields.clientVisible.default(false),
  /** Optional link to the record the task is about, e.g. ("Recommendation", id). */
  entityType: z
    .string()
    .regex(/^[A-Za-z]{2,40}$/)
    .optional(),
  entityId: idSchema.optional(),
});
export type TaskCreateInput = z.input<typeof taskCreateSchema>;

export const taskUpdateSchema = z.object(taskFields).partial().refine(nonEmpty, 'Nothing to update');
export type TaskUpdateInput = z.input<typeof taskUpdateSchema>;

export const taskListQuerySchema = paginationSchema.extend({
  workspaceId: idSchema.optional(),
  projectId: idSchema.optional(),
  status: csvListSchema(z.enum(TASK_STATUSES)),
  type: csvListSchema(z.enum(TASK_TYPES)),
  /** "me" or a user id. */
  assignee: z.union([z.literal('me'), z.literal('none'), idSchema]).optional(),
  dueBefore: dateInputSchema.optional(),
  periodKey: periodKeySchema.optional(),
  q: z.string().trim().max(200).optional(),
});
export type TaskListQuery = z.infer<typeof taskListQuerySchema>;

export const timeEntryCreateSchema = z.object({
  minutes: z
    .int()
    .min(1)
    .max(24 * 60),
  workDate: dateOnlySchema,
  note: z.string().trim().max(500).optional(),
});
export type TimeEntryCreateInput = z.input<typeof timeEntryCreateSchema>;

// ---------------- Agency ----------------

export const clientWorkspaceCreateSchema = z.object({
  name: z.string().trim().min(2, 'Enter at least 2 characters').max(120),
  billingMode: z.enum(AGENCY_BILLING_MODES).default('AGENCY'),
  approvalsDelegated: z.boolean().default(false),
  /** Invites the client contact by email. */
  contactEmail: emailSchema.optional(),
  contactRole: z.enum(['OWNER', 'CLIENT']).default('CLIENT'),
});
export type ClientWorkspaceCreateInput = z.input<typeof clientWorkspaceCreateSchema>;

export const agencyLinkRequestSchema = z.object({
  /** The agency's code (its workspace slug), shown in the agency's settings. */
  agencyCode: z
    .string()
    .trim()
    .toLowerCase()
    // Workspace slugs end with a random base64url part, which can contain "_".
    .regex(/^[a-z0-9_-]{3,140}$/, 'Enter the agency code exactly as the agency gave it'),
  accessRole: z.enum(['ADMIN', 'MEMBER']).default('ADMIN'),
  approvalsDelegated: z.boolean().default(false),
});
export type AgencyLinkRequestInput = z.input<typeof agencyLinkRequestSchema>;

export const agencyLinkUpdateSchema = z
  .object({
    accessRole: z.enum(['ADMIN', 'MEMBER']).optional(),
    approvalsDelegated: z.boolean().optional(),
  })
  .refine(nonEmpty, 'Nothing to update');
export type AgencyLinkUpdateInput = z.input<typeof agencyLinkUpdateSchema>;

// ---------------- Provider rates (platform administration) ----------------

export const providerRateCreateSchema = z.object({
  provider: z.string().regex(/^[a-z0-9_]{2,40}$/, 'Lower-case letters, digits and underscores'),
  operation: z
    .string()
    .regex(/^[a-z0-9_]{2,40}$/)
    .nullable()
    .optional(),
  unit: z.enum(['input_token', 'output_token', 'request']),
  /** Price in currency units for `unitQuantity` units, e.g. 0.15 per 1,000,000 input tokens. */
  price: z.number().min(0).max(1_000_000),
  unitQuantity: z.int().min(1).max(100_000_000).default(1),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .default('USD'),
  effectiveFrom: dateInputSchema,
  note: z.string().trim().max(500).optional(),
});
export type ProviderRateCreateInput = z.input<typeof providerRateCreateSchema>;

export const dateRangeQuerySchema = z.object({
  from: dateInputSchema.optional(),
  to: dateInputSchema.optional(),
});
