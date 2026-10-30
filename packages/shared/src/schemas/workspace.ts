import { z } from 'zod';
import { WORKSPACE_ROLES } from '../enums';
import { emailSchema } from './common';

export const workspaceCreateSchema = z.object({
  name: z.string().trim().min(2, 'Enter at least 2 characters').max(120),
});
export type WorkspaceCreateInput = z.infer<typeof workspaceCreateSchema>;

export const whiteLabelSchema = z.object({
  enabled: z.boolean(),
  brandName: z.string().trim().min(1).max(80).optional(),
  accentColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex color such as #4f46e5')
    .optional(),
  /** HTTPS image shown in the client portal and reports instead of the Surfaced logo. */
  logoUrl: z
    .string()
    .trim()
    .max(2048)
    .regex(/^https:\/\/[^\s"'<>]+$/i, 'Use an https:// image URL')
    .optional(),
  supportEmail: emailSchema.optional(),
  /** Hide the "Powered by Surfaced" footer in the client portal and reports. */
  hidePoweredBy: z.boolean().optional(),
});
export type WhiteLabelSettings = z.infer<typeof whiteLabelSchema>;

export const workspaceUpdateSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  whiteLabel: whiteLabelSchema.optional(),
});
export type WorkspaceUpdateInput = z.infer<typeof workspaceUpdateSchema>;

export const invitationCreateSchema = z.object({
  email: emailSchema,
  role: z.enum(WORKSPACE_ROLES).default('MEMBER'),
});
export type InvitationCreateInput = z.infer<typeof invitationCreateSchema>;

export const invitationAcceptSchema = z.object({
  token: z
    .string()
    .trim()
    .min(20)
    .max(200)
    .regex(/^[A-Za-z0-9_-]+$/),
});

export const memberRoleUpdateSchema = z.object({ role: z.enum(WORKSPACE_ROLES) });
export type MemberRoleUpdateInput = z.infer<typeof memberRoleUpdateSchema>;
