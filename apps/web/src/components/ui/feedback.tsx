import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Info,
  Loader2,
  RefreshCw,
  type LucideIcon,
} from 'lucide-react';
import { Progress as RadixProgress } from 'radix-ui';
import type { ComponentProps, ReactNode } from 'react';
import { errorMessage } from '@/lib/api';
import { cn } from '@/lib/cn';
import { Button } from './button';

export function Skeleton({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('animate-pulse rounded-md bg-muted', className)} aria-hidden {...props} />;
}

export function Spinner({ className, label = 'Loading' }: { className?: string; label?: string }) {
  return (
    <span role="status" className="inline-flex items-center">
      <Loader2 className={cn('size-4 animate-spin text-muted-foreground', className)} aria-hidden />
      <span className="sr-only">{label}</span>
    </span>
  );
}

/** Placeholder block shown while a page section loads. */
export function LoadingBlock({ rows = 3, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn('space-y-3', className)} role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className={cn('h-4', i === 0 ? 'w-1/3' : i % 2 ? 'w-full' : 'w-5/6')} />
      ))}
    </div>
  );
}

export function Progress({ value, className, label }: { value: number; className?: string; label?: string }) {
  const clamped = Math.max(0, Math.min(100, value));
  return (
    <RadixProgress.Root
      value={clamped}
      aria-label={label}
      className={cn('relative h-2 w-full overflow-hidden rounded-full bg-muted', className)}
    >
      <RadixProgress.Indicator
        className="h-full bg-primary transition-[width] duration-500"
        style={{ width: `${clamped}%` }}
      />
    </RadixProgress.Root>
  );
}

const ALERT_STYLES: Record<
  'info' | 'success' | 'warning' | 'danger',
  { icon: LucideIcon; className: string }
> = {
  info: {
    icon: Info,
    className: 'border-sky-600/20 bg-sky-50 text-sky-900 dark:bg-sky-500/10 dark:text-sky-100',
  },
  success: {
    icon: CheckCircle2,
    className:
      'border-emerald-600/20 bg-emerald-50 text-emerald-900 dark:bg-emerald-500/10 dark:text-emerald-100',
  },
  warning: {
    icon: AlertTriangle,
    className: 'border-amber-600/25 bg-amber-50 text-amber-900 dark:bg-amber-500/10 dark:text-amber-100',
  },
  danger: {
    icon: AlertCircle,
    className: 'border-red-600/20 bg-red-50 text-red-900 dark:bg-red-500/10 dark:text-red-100',
  },
};

export function Alert({
  tone = 'info',
  title,
  children,
  action,
  className,
}: {
  tone?: keyof typeof ALERT_STYLES;
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  const { icon: Icon, className: toneClass } = ALERT_STYLES[tone];
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      className={cn('flex gap-3 rounded-lg border p-3.5 text-sm', toneClass, className)}
    >
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1 space-y-1">
        {title ? <p className="font-medium">{title}</p> : null}
        {children ? <div className="leading-relaxed opacity-90">{children}</div> : null}
      </div>
      {action ? <div className="shrink-0 self-center">{action}</div> : null}
    </div>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: {
  icon?: LucideIcon;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center rounded-lg border border-dashed border-border px-6 py-10 text-center',
        className,
      )}
    >
      {Icon ? (
        <div className="mb-3 flex size-10 items-center justify-center rounded-full bg-muted">
          <Icon className="size-5 text-muted-foreground" aria-hidden />
        </div>
      ) : null}
      <p className="text-sm font-medium">{title}</p>
      {description ? <p className="mt-1 max-w-md text-[13px] text-muted-foreground">{description}</p> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export function ErrorState({
  error,
  onRetry,
  title = 'This section could not be loaded',
  className,
}: {
  error: unknown;
  onRetry?: () => void;
  title?: string;
  className?: string;
}) {
  return (
    <Alert
      tone="danger"
      title={title}
      className={className}
      action={
        onRetry ? (
          <Button size="sm" variant="outline" onClick={onRetry}>
            <RefreshCw /> Retry
          </Button>
        ) : undefined
      }
    >
      {errorMessage(error)}
    </Alert>
  );
}
