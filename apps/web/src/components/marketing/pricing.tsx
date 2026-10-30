import { useQuery } from '@tanstack/react-query';
import { Check, Minus } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { DEFAULT_PLANS, type PlanLimits } from '@surfaced/shared';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatCurrency, formatNumber } from '@/lib/format';
import type { PlanDto, PlansResponse } from '@/lib/types';

const DEFAULT_RESPONSE: PlansResponse = {
  plans: DEFAULT_PLANS.map((p) => ({ ...p, features: [...p.features] })),
  billing: null,
};

/**
 * Plans from the API (admin-configurable). The prerendered HTML and the first client render use
 * the shared default plans, so hydration matches; live values replace them once loaded.
 */
export function usePlans() {
  return useQuery({
    queryKey: ['billing', 'plans'],
    queryFn: () => api.get<PlansResponse>('/billing/plans'),
    placeholderData: DEFAULT_RESPONSE,
    staleTime: 5 * 60_000,
  });
}

export type Interval = 'MONTH' | 'YEAR';

export function IntervalToggle({ value, onChange }: { value: Interval; onChange: (v: Interval) => void }) {
  return (
    <div
      role="radiogroup"
      aria-label="Billing interval"
      className="inline-flex rounded-full border border-border bg-muted p-1 text-sm"
    >
      {(['MONTH', 'YEAR'] as const).map((option) => (
        <button
          key={option}
          type="button"
          role="radio"
          aria-checked={value === option}
          onClick={() => onChange(option)}
          className={cn(
            'rounded-full px-4 py-1.5 font-medium transition-colors',
            value === option
              ? 'bg-primary text-primary-foreground'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {option === 'MONTH' ? 'Monthly' : 'Yearly'}
        </button>
      ))}
    </div>
  );
}

export function planPrice(
  plan: PlanDto,
  interval: Interval,
): { amount: number; suffix: string; note: string | null } {
  if (plan.priceMonthly === 0 && plan.priceYearly === 0)
    return { amount: 0, suffix: '', note: 'Free forever' };
  if (interval === 'YEAR') {
    const perMonth = plan.priceYearly / 12;
    return {
      amount: Math.round(perMonth * 100) / 100,
      suffix: '/month',
      note: `${formatCurrency(plan.priceYearly, plan.currency)} billed yearly`,
    };
  }
  return { amount: plan.priceMonthly, suffix: '/month', note: 'Billed monthly' };
}

export function PlanCard({ plan, interval, cta }: { plan: PlanDto; interval: Interval; cta?: ReactNode }) {
  const price = planPrice(plan, interval);
  return (
    <article
      className={cn(
        'relative flex flex-col rounded-2xl border bg-card p-6',
        plan.highlighted
          ? 'border-primary shadow-[0_0_0_1px_var(--primary),0_20px_60px_-20px_rgba(99,102,241,0.45)]'
          : 'border-border',
      )}
    >
      {plan.highlighted ? (
        <p className="absolute -top-3 left-6 rounded-full bg-primary px-3 py-0.5 text-xs font-semibold text-primary-foreground">
          Most popular
        </p>
      ) : null}
      <h3 className="text-lg font-semibold">{plan.name}</h3>
      <p className="mt-2 min-h-12 text-sm leading-relaxed text-muted-foreground">{plan.description}</p>
      <p className="mt-6 flex items-baseline gap-1">
        <span className="text-4xl font-semibold tracking-tight">
          {formatCurrency(price.amount, plan.currency)}
        </span>
        <span className="text-sm text-muted-foreground">{price.suffix}</span>
      </p>
      <p className="mt-1 text-[13px] text-muted-foreground">{price.note}</p>
      <div className="mt-6">
        {cta ?? (
          <Button asChild className="w-full" variant={plan.highlighted ? 'primary' : 'outline'}>
            <Link to={plan.key === 'FREE' ? '/register' : `/register?plan=${plan.key}&interval=${interval}`}>
              {plan.key === 'FREE' ? 'Start free' : `Choose ${plan.name}`}
            </Link>
          </Button>
        )}
      </div>
      <ul className="mt-6 space-y-2.5 text-sm">
        {plan.features.map((feature) => (
          <li key={feature} className="flex gap-2">
            <Check className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
            <span>{feature}</span>
          </li>
        ))}
      </ul>
    </article>
  );
}

export function PricingCards({ compact = false }: { compact?: boolean }) {
  const [interval, setBillingInterval] = useState<Interval>('MONTH');
  const { data } = usePlans();
  const plans = [...(data?.plans ?? DEFAULT_RESPONSE.plans)].sort((a, b) => a.sortOrder - b.sortOrder);
  return (
    <div className="space-y-8">
      <div className="flex justify-center">
        <IntervalToggle value={interval} onChange={setBillingInterval} />
      </div>
      <div className={cn('grid gap-5 sm:grid-cols-2', compact ? 'lg:grid-cols-4' : 'xl:grid-cols-4')}>
        {plans.map((plan) => (
          <PlanCard key={plan.key} plan={plan} interval={interval} />
        ))}
      </div>
    </div>
  );
}

type LimitRow = { label: string; get: (l: PlanLimits) => string | boolean };

const LIMIT_ROWS: LimitRow[] = [
  { label: 'Projects', get: (l) => formatNumber(l.projects) },
  { label: 'Team members', get: (l) => formatNumber(l.teamMembers) },
  {
    label: 'Pages per audit',
    get: (l) => (l.pagesPerAudit === null ? 'All pages' : formatNumber(l.pagesPerAudit)),
  },
  { label: 'Audits per month', get: (l) => formatNumber(l.auditsPerMonth) },
  { label: 'Scheduled audits', get: (l) => l.scheduledAudits },
  { label: 'Tracked AI prompts', get: (l) => formatNumber(l.trackedPrompts) },
  { label: 'AI visibility checks per month', get: (l) => formatNumber(l.visibilityChecksPerMonth) },
  {
    label: 'Check frequency',
    get: (l) =>
      l.promptFrequencies
        .filter((f) => f !== 'MANUAL')
        .map((f) => f.toLowerCase())
        .join(', ') || 'manual',
  },
  { label: 'AI content generations per month', get: (l) => formatNumber(l.contentGenerationsPerMonth) },
  { label: 'AI keyword idea runs per month', get: (l) => formatNumber(l.keywordSuggestionsPerMonth) },
  { label: 'Competitors per project', get: (l) => formatNumber(l.competitorsPerProject) },
  { label: 'Competitor analysis', get: (l) => l.competitorAnalysis },
  { label: 'Reports per month', get: (l) => formatNumber(l.reportsPerMonth) },
  { label: 'White-label reports', get: (l) => l.whiteLabelReports },
];

export function PlanComparisonTable() {
  const { data } = usePlans();
  const plans = [...(data?.plans ?? DEFAULT_RESPONSE.plans)].sort((a, b) => a.sortOrder - b.sortOrder);
  return (
    <div className="overflow-x-auto rounded-xl border border-border">
      <table className="w-full min-w-[640px] text-sm">
        <caption className="sr-only">Plan comparison</caption>
        <thead>
          <tr className="border-b border-border bg-muted/50">
            <th scope="col" className="p-4 text-left font-medium text-muted-foreground">
              Limit
            </th>
            {plans.map((plan) => (
              <th key={plan.key} scope="col" className="p-4 text-left font-semibold">
                {plan.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {LIMIT_ROWS.map((row) => (
            <tr key={row.label} className="border-b border-border last:border-0">
              <th scope="row" className="p-4 text-left font-normal text-muted-foreground">
                {row.label}
              </th>
              {plans.map((plan) => {
                const value = row.get(plan.limits);
                return (
                  <td key={plan.key} className="p-4 capitalize">
                    {typeof value === 'boolean' ? (
                      value ? (
                        <Check className="size-4 text-primary" aria-label="Included" />
                      ) : (
                        <Minus className="size-4 text-muted-foreground" aria-label="Not included" />
                      )
                    ) : (
                      value
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
