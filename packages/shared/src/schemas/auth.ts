import { z } from 'zod';
import { emailSchema, nameSchema, passwordSchema } from './common';

export const registerSchema = z.object({
  name: nameSchema,
  email: emailSchema,
  password: passwordSchema,
  workspaceName: z.string().trim().min(2).max(120).optional(),
  acceptTerms: z.literal(true, { error: 'You must accept the Terms and Privacy Policy' }),
});
export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  email: emailSchema,
  // Do not apply the password policy at login: older passwords must still work.
  password: z.string().min(1, 'Enter your password').max(128),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const forgotPasswordSchema = z.object({ email: emailSchema });
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;

export const tokenSchema = z
  .string()
  .trim()
  .min(20)
  .max(200)
  .regex(/^[A-Za-z0-9_-]+$/, 'Invalid token');

export const resetPasswordSchema = z.object({ token: tokenSchema, password: passwordSchema });
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;

export const verifyEmailSchema = z.object({ token: tokenSchema });

export const updateProfileSchema = z.object({ name: nameSchema });
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Enter your current password').max(128),
    newPassword: passwordSchema,
  })
  .refine((v) => v.currentPassword !== v.newPassword, {
    path: ['newPassword'],
    message: 'Choose a password different from your current one',
  });
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

export const notificationPrefsSchema = z.object({
  auditCompleted: z.boolean(),
  reportReady: z.boolean(),
  weeklySummary: z.boolean(),
  billing: z.boolean(),
});
export type NotificationPrefs = z.infer<typeof notificationPrefsSchema>;
export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  auditCompleted: true,
  reportReady: true,
  weeklySummary: true,
  billing: true,
};

export const updatePreferencesSchema = z.object({
  notificationPrefs: notificationPrefsSchema.partial().optional(),
});

export const accountDeletionSchema = z.object({
  password: z.string().min(1, 'Enter your password').max(128),
  confirm: z.literal('DELETE', { error: 'Type DELETE to confirm' }),
  reason: z.string().trim().max(1000).optional(),
});
export type AccountDeletionInput = z.infer<typeof accountDeletionSchema>;
