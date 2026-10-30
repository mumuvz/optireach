// Schemas for unauthenticated endpoints (free audit, contact form) and the admin area.
import { z } from 'zod';
import { BACKGROUND_JOB_TYPES, CONTACT_TOPICS, JOB_STATUSES } from '../enums';
import { emailSchema, paginationSchema, websiteUrlSchema } from './common';

export const publicAuditSchema = z.object({
  url: websiteUrlSchema,
});
export type PublicAuditInput = z.input<typeof publicAuditSchema>;

export const contactSchema = z.object({
  name: z.string().trim().min(2, 'Enter your name').max(120),
  email: emailSchema,
  company: z.string().trim().max(160).optional(),
  topic: z.enum(CONTACT_TOPICS).default('sales'),
  message: z.string().trim().min(20, 'Tell us a little more (at least 20 characters)').max(5000),
  /** Honeypot field: real users never fill it in. */
  website: z.string().max(0, 'Invalid submission').optional(),
});
export type ContactInput = z.input<typeof contactSchema>;

export const adminUserListQuerySchema = paginationSchema.extend({
  q: z.string().trim().max(200).optional(),
  status: z.enum(['active', 'disabled', 'deletion_requested']).optional(),
});

export const adminUserUpdateSchema = z
  .object({
    disabled: z.boolean(),
    reason: z.string().trim().max(500).optional(),
  })
  .refine((v) => !v.disabled || Boolean(v.reason), {
    path: ['reason'],
    message: 'Give a reason for disabling',
  });
export type AdminUserUpdateInput = z.infer<typeof adminUserUpdateSchema>;

export const adminWorkspaceListQuerySchema = paginationSchema.extend({
  q: z.string().trim().max(200).optional(),
});

export const adminJobListQuerySchema = paginationSchema.extend({
  status: z.enum(JOB_STATUSES).optional(),
  type: z.enum(BACKGROUND_JOB_TYPES).optional(),
});

export const auditLogListQuerySchema = paginationSchema.extend({
  action: z.string().trim().max(80).optional(),
  actorUserId: z.string().trim().max(32).optional(),
});

/** Platform-wide audit log filter (admin area). */
export const adminAuditLogListQuerySchema = auditLogListQuerySchema.extend({
  workspaceId: z.string().trim().max(32).optional(),
});

export const adminUsageQuerySchema = z.object({
  /** UTC calendar month, e.g. "2026-10"; defaults to the current month. */
  period: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use the format YYYY-MM')
    .optional(),
});
