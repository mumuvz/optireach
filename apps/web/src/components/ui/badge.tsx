import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/cn';

export const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap',
  {
    variants: {
      tone: {
        neutral: 'border-border bg-muted text-muted-foreground',
        primary: 'border-primary/20 bg-accent text-accent-foreground',
        success:
          'border-emerald-600/20 bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300',
        warning: 'border-amber-600/25 bg-amber-50 text-amber-800 dark:bg-amber-500/10 dark:text-amber-300',
        danger: 'border-red-600/20 bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-300',
        info: 'border-sky-600/20 bg-sky-50 text-sky-800 dark:bg-sky-500/10 dark:text-sky-300',
        orange:
          'border-orange-600/20 bg-orange-50 text-orange-800 dark:bg-orange-500/10 dark:text-orange-300',
        demo: 'border-fuchsia-600/25 bg-fuchsia-50 text-fuchsia-800 dark:bg-fuchsia-500/10 dark:text-fuchsia-300',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
);

export type BadgeTone = NonNullable<VariantProps<typeof badgeVariants>['tone']>;

export function Badge({
  className,
  tone,
  ...props
}: ComponentProps<'span'> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}

const STATUS_TONES: Record<string, BadgeTone> = {
  QUEUED: 'neutral',
  PENDING: 'neutral',
  RUNNING: 'info',
  GENERATING: 'info',
  SUCCEEDED: 'success',
  READY: 'success',
  COMPLETED: 'success',
  ACTIVE: 'success',
  CONNECTED: 'success',
  PAID: 'success',
  FAILED: 'danger',
  CANCELLED: 'neutral',
  CANCELED: 'neutral',
  PAUSED: 'warning',
  PAST_DUE: 'danger',
  NEEDS_REAUTH: 'warning',
  DISCONNECTED: 'neutral',
  OPEN: 'warning',
  PLANNED: 'info',
  IGNORED: 'neutral',
  RESOLVED: 'success',
  DRAFT: 'neutral',
  IN_REVIEW: 'info',
  APPROVED: 'success',
  PUBLISHED: 'primary',
  IN_PROGRESS: 'info',
  AWAITING_APPROVAL: 'warning',
  DISMISSED: 'neutral',
  LOGGED_LOCALLY: 'warning',
  SENT: 'success',
  REJECTED: 'danger',
  CHANGES_REQUESTED: 'warning',
  WITHDRAWN: 'neutral',
  SUPERSEDED: 'neutral',
  REVOKED: 'neutral',
  TODO: 'neutral',
  BLOCKED: 'danger',
  DONE: 'success',
  VERIFIED: 'success',
};

export function humanize(value: string): string {
  const text = value.replace(/_/g, ' ').toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function StatusBadge({
  status,
  label,
  className,
}: {
  status: string;
  label?: string;
  className?: string;
}) {
  const tone = STATUS_TONES[status] ?? 'neutral';
  const live = status === 'RUNNING' || status === 'GENERATING';
  return (
    <Badge tone={tone} className={className}>
      {live ? <span className="size-1.5 animate-pulse rounded-full bg-current" aria-hidden /> : null}
      {label ?? humanize(status)}
    </Badge>
  );
}

const SEVERITY: Record<string, { tone: BadgeTone; label: string }> = {
  CRITICAL: { tone: 'danger', label: 'Critical' },
  HIGH: { tone: 'orange', label: 'High' },
  MEDIUM: { tone: 'warning', label: 'Medium' },
  LOW: { tone: 'info', label: 'Low' },
};

export function SeverityBadge({ severity, className }: { severity: string; className?: string }) {
  const s = SEVERITY[severity] ?? { tone: 'neutral' as const, label: humanize(severity) };
  return (
    <Badge tone={s.tone} className={className}>
      {s.label}
    </Badge>
  );
}

export function DemoBadge({ className }: { className?: string }) {
  return (
    <Badge
      tone="demo"
      className={className}
      title="Created by the development seed or the demo provider. Not real measurements."
    >
      Demo data
    </Badge>
  );
}

/** For values estimated by an AI model (sentiment, keyword ideas). */
export function EstimateBadge({ className, label = 'AI estimate' }: { className?: string; label?: string }) {
  return (
    <Badge tone="warning" className={className} title="Estimated by an AI model; not a measured value.">
      {label}
    </Badge>
  );
}
