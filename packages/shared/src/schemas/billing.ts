import { z } from 'zod';
import { BILLING_INTERVALS } from '../enums';
import { planLimitsSchema } from '../plans';
import { idSchema } from './common';

export const checkoutSchema = z.object({
  workspaceId: idSchema,
  planKey: z.string().regex(/^[A-Z][A-Z0-9_]{1,31}$/),
  interval: z.enum(BILLING_INTERVALS).default('MONTH'),
});
export type CheckoutInput = z.input<typeof checkoutSchema>;

export const workspaceRefSchema = z.object({ workspaceId: idSchema });

/** Admin edit of a plan. Prices are entered as decimal numbers in the plan currency. */
export const planUpdateSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  description: z.string().trim().min(1).max(500).optional(),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .optional(),
  priceMonthly: z.number().min(0).max(1_000_000).multipleOf(0.01).optional(),
  priceYearly: z.number().min(0).max(10_000_000).multipleOf(0.01).optional(),
  limits: planLimitsSchema.optional(),
  features: z.array(z.string().trim().min(1).max(160)).max(30).optional(),
  highlighted: z.boolean().optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.int().optional(),
  stripePriceMonthlyId: z.string().trim().max(120).nullable().optional(),
  stripePriceYearlyId: z.string().trim().max(120).nullable().optional(),
  razorpayPlanMonthlyId: z.string().trim().max(120).nullable().optional(),
  razorpayPlanYearlyId: z.string().trim().max(120).nullable().optional(),
});
export type PlanUpdateInput = z.infer<typeof planUpdateSchema>;
