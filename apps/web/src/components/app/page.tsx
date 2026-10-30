import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { HelpCircle, Sparkles, X } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';
import { Link } from 'react-router';
import type { JobDto } from '@surfaced/shared';
import { StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ErrorState, LoadingBlock, Progress } from '@/components/ui/feedback';
import { Tooltip } from '@/components/ui/menu';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { usePageTitle } from '@/lib/seo';

export function PageHeader({
  title,
  description,
  actions,
  breadcrumbs,
  documentTitle,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  breadcrumbs?: { label: string; to?: string }[];
  /** Browser tab title when `title` is not plain text. */
  documentTitle?: string;
}) {
  usePageTitle(documentTitle ?? (typeof title === 'string' ? title : 'Dashboard'));
  return (
    <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        {breadcrumbs?.length ? (
          <nav
            aria-label="Breadcrumb"
            className="mb-1.5 flex flex-wrap items-center gap-1 text-[13px] text-muted-foreground"
          >
            {breadcrumbs.map((b, i) => (
              <span key={`${b.label}-${i}`} className="flex items-center gap-1">
                {i > 0 ? <span aria-hidden>/</span> : null}
                {b.to ? (
                  <Link to={b.to} className="hover:text-foreground">
                    {b.label}
                  </Link>
                ) : (
                  <span>{b.label}</span>
                )}
              </span>
            ))}
          </nav>
        ) : null}
        <h1 className="text-2xl font-semibold tracking-tight text-balance">{title}</h1>
        {description ? <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function HelpTip({ children, label = 'More information' }: { children: ReactNode; label?: string }) {
  return (
    <Tooltip content={children}>
      <button
        type="button"
        className="inline-flex text-muted-foreground hover:text-foreground"
        aria-label={label}
      >
        <HelpCircle className="size-3.5" aria-hidden />
      </button>
    </Tooltip>
  );
}

export function MetricCard({
  label,
  value,
  sub,
  help,
  icon,
  tone,
  className,
  to,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  help?: ReactNode;
  icon?: ReactNode;
  tone?: 'default' | 'danger' | 'warning' | 'success';
  className?: string;
  to?: string;
}) {
  const body = (
    <>
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-[13px] font-medium text-muted-foreground">
          {label}
          {help ? <HelpTip label={`About ${label}`}>{help}</HelpTip> : null}
        </p>
        {icon ? <span className="text-muted-foreground [&_svg]:size-4">{icon}</span> : null}
      </div>
      <p
        className={cn(
          'mt-2 text-2xl font-semibold tracking-tight tabular-nums',
          tone === 'danger' && 'text-red-600',
          tone === 'warning' && 'text-amber-700',
          tone === 'success' && 'text-emerald-700',
        )}
      >
        {value}
      </p>
      {sub ? <p className="mt-1 text-xs text-muted-foreground">{sub}</p> : null}
    </>
  );
  return (
    <Card className={cn('p-4', to && 'transition-colors hover:border-primary/40', className)}>
      {to ? (
        <Link to={to} className="block focus-visible:outline-none">
          {body}
        </Link>
      ) : (
        body
      )}
    </Card>
  );
}

/** Renders loading and error states for a query; children render with the data. */
export function QueryState<T>({
  query,
  children,
  loading,
  rows = 4,
}: {
  query: UseQueryResult<T>;
  children: (data: T) => ReactNode;
  loading?: ReactNode;
  rows?: number;
}) {
  if (query.isPending) return <>{loading ?? <LoadingBlock rows={rows} />}</>;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  return <>{children(query.data)}</>;
}

export function DemoBanner({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        'flex items-start gap-2.5 rounded-lg border border-fuchsia-600/25 bg-fuchsia-50 px-3.5 py-2.5 text-sm text-fuchsia-900',
        className,
      )}
      role="note"
    >
      <Sparkles className="mt-0.5 size-4 shrink-0" aria-hidden />
      <p>
        <span className="font-medium">Demo project.</span> The audit comes from a fictional in-memory website
        and the AI answers come from the labeled demo provider. None of it is real customer or provider data.
      </p>
    </div>
  );
}

const FINISHED = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED']);

/** Polls a background job and reports progress; calls onFinished once when it ends. */
export function useJob(jobId: string | null | undefined, onFinished?: (job: JobDto) => void) {
  const notified = useRef<string | null>(null);
  const query = useQuery({
    queryKey: ['job', jobId],
    queryFn: () => api.get<JobDto>(`/jobs/${jobId}`),
    enabled: Boolean(jobId),
    refetchInterval: (q) => (q.state.data && FINISHED.has(q.state.data.status) ? false : 1500),
  });
  useEffect(() => {
    const job = query.data;
    if (job && FINISHED.has(job.status) && notified.current !== job.id) {
      notified.current = job.id;
      onFinished?.(job);
    }
  }, [query.data, onFinished]);
  return query;
}

export function JobProgress({
  jobId,
  onFinished,
  onDismiss,
  label,
}: {
  jobId: string;
  onFinished?: (job: JobDto) => void;
  onDismiss?: () => void;
  label?: string;
}) {
  const { data: job } = useJob(jobId, onFinished);
  if (!job) return null;
  const finished = FINISHED.has(job.status);
  return (
    <Card className="flex flex-col gap-2 p-4" aria-live="polite">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-medium">{label ?? 'Background job'}</p>
        <div className="flex items-center gap-2">
          <StatusBadge status={job.status} />
          {finished && onDismiss ? (
            <Button variant="ghost" size="icon-sm" onClick={onDismiss} aria-label="Dismiss">
              <X />
            </Button>
          ) : null}
        </div>
      </div>
      {!finished ? <Progress value={Math.max(4, job.progress)} label={label ?? 'Progress'} /> : null}
      <p
        className={cn('text-[13px]', job.status === 'FAILED' ? 'text-destructive' : 'text-muted-foreground')}
      >
        {job.status === 'FAILED' ? (job.error ?? 'The job failed.') : job.message}
      </p>
    </Card>
  );
}

/** Small "n of m" sample-size note shown under metrics. */
export function SampleNote({ children }: { children: ReactNode }) {
  return <p className="text-xs text-muted-foreground">{children}</p>;
}
