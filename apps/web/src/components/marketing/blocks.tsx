import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { ArrowRight, Globe } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { Link, useNavigate } from 'react-router';
import { publicAuditSchema } from '@surfaced/shared';
import type { z } from 'zod';
import { Button } from '@/components/ui/button';
import { FieldError } from '@/components/ui/form';
import { api, ApiError, errorMessage } from '@/lib/api';
import { cn } from '@/lib/cn';

type AuditInput = z.input<typeof publicAuditSchema>;
type AuditOutput = z.output<typeof publicAuditSchema>;

interface StartedAudit {
  id: string;
  token: string;
  status: string;
  url: string;
  maxPages: number;
}

/** Free audit URL form: validates locally with the API's schema, then starts a real crawl. */
export function FreeAuditForm({ className, size = 'lg' }: { className?: string; size?: 'md' | 'lg' }) {
  const navigate = useNavigate();
  const form = useForm<AuditInput, unknown, AuditOutput>({
    resolver: zodResolver(publicAuditSchema),
    defaultValues: { url: '' },
  });
  const start = useMutation({
    mutationFn: (input: AuditOutput) => api.post<StartedAudit>('/public/audits', input),
    onSuccess: (audit) => {
      // The access token stays in the fragment, so it is never sent to servers or in Referer headers.
      void navigate(
        `/free-audit#id=${encodeURIComponent(audit.id)}&token=${encodeURIComponent(audit.token)}`,
      );
    },
    onError: (error) => {
      if (error instanceof ApiError && error.fieldErrors.url)
        form.setError('url', { message: error.fieldErrors.url });
    },
  });
  const fieldError = form.formState.errors.url?.message;
  const apiError =
    start.error && !(start.error instanceof ApiError && start.error.fieldErrors.url)
      ? errorMessage(start.error)
      : null;

  return (
    <form
      onSubmit={form.handleSubmit((values) => start.mutate(values))}
      className={cn('w-full max-w-xl', className)}
      noValidate
    >
      <label htmlFor="free-audit-url" className="sr-only">
        Website address
      </label>
      <div
        className={cn(
          'flex flex-col gap-2 rounded-xl border border-white/10 bg-white/[0.04] p-2 sm:flex-row',
          fieldError && 'border-red-400/60',
        )}
      >
        <div className="relative flex-1">
          <Globe
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400"
            aria-hidden
          />
          <input
            id="free-audit-url"
            type="text"
            inputMode="url"
            autoComplete="url"
            placeholder="yourwebsite.com"
            aria-invalid={fieldError ? true : undefined}
            aria-describedby={fieldError ? 'free-audit-url-error' : 'free-audit-url-hint'}
            className={cn(
              'w-full rounded-lg bg-transparent pr-3 pl-9 text-[15px] text-white placeholder:text-slate-500 focus:outline-none',
              size === 'lg' ? 'h-11' : 'h-10',
            )}
            {...form.register('url')}
          />
        </div>
        <Button type="submit" size={size === 'lg' ? 'lg' : 'md'} loading={start.isPending}>
          Run a free audit <ArrowRight />
        </Button>
      </div>
      <div className="mt-2 min-h-5">
        {fieldError ? (
          <FieldError id="free-audit-url-error">{fieldError}</FieldError>
        ) : apiError ? (
          <p role="alert" className="text-[13px] text-red-300">
            {apiError}
          </p>
        ) : (
          <p id="free-audit-url-hint" className="text-[13px] text-slate-400">
            Up to 20 pages, no account needed. We respect robots.txt.
          </p>
        )}
      </div>
    </form>
  );
}

/** Original dashboard illustration made with HTML and CSS. Values are illustrative and labeled as such. */
export function DashboardPreview() {
  const bars = [38, 44, 41, 52, 49, 58, 63, 61, 70, 74];
  return (
    <figure className="relative mx-auto w-full max-w-5xl">
      <div
        className="absolute -inset-x-10 -top-10 -bottom-10 -z-10 bg-[radial-gradient(ellipse_at_center,rgba(99,102,241,0.25),transparent_65%)]"
        aria-hidden
      />
      <div className="overflow-hidden rounded-2xl border border-white/10 bg-[#0b1224] shadow-2xl" aria-hidden>
        <div className="flex items-center gap-2 border-b border-white/5 px-4 py-3">
          <span className="size-2.5 rounded-full bg-white/15" />
          <span className="size-2.5 rounded-full bg-white/15" />
          <span className="size-2.5 rounded-full bg-white/15" />
          <span className="ml-3 rounded-md bg-white/5 px-3 py-1 text-[11px] text-slate-400">
            app · Overview
          </span>
        </div>
        <div className="grid gap-4 p-4 sm:p-6 lg:grid-cols-[180px_1fr]">
          <div className="hidden space-y-1.5 lg:block">
            {[
              'Overview',
              'Website audit',
              'AI visibility',
              'Keywords',
              'Content Studio',
              'Competitors',
              'Reports',
            ].map((item, i) => (
              <div
                key={item}
                className={cn(
                  'rounded-md px-3 py-2 text-[12px]',
                  i === 0 ? 'bg-indigo-500/15 text-indigo-200' : 'text-slate-400',
                )}
              >
                {item}
              </div>
            ))}
          </div>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              {[
                ['Site health index', '82', '/100'],
                ['Brand mention rate', '34%', '48 answers'],
                ['Owned citations', '12', 'last 30 days'],
                ['Open issues', '27', '3 critical'],
              ].map(([label, value, sub]) => (
                <div key={label} className="rounded-xl border border-white/5 bg-white/[0.03] p-3.5">
                  <p className="text-[11px] text-slate-400">{label}</p>
                  <p className="mt-1.5 text-xl font-semibold text-white">{value}</p>
                  <p className="text-[11px] text-slate-500">{sub}</p>
                </div>
              ))}
            </div>
            <div className="grid gap-3 md:grid-cols-[1.6fr_1fr]">
              <div className="rounded-xl border border-white/5 bg-white/[0.03] p-4">
                <p className="text-[12px] text-slate-300">Mention rate by week</p>
                <div className="mt-4 flex h-28 items-end gap-2">
                  {bars.map((h, i) => (
                    <div
                      key={i}
                      className="flex-1 rounded-t bg-gradient-to-t from-indigo-500/50 to-sky-400/80"
                      style={{ height: `${h}%` }}
                    />
                  ))}
                </div>
              </div>
              <div className="space-y-2 rounded-xl border border-white/5 bg-white/[0.03] p-4">
                <p className="text-[12px] text-slate-300">Top recommendations</p>
                {[
                  'Fix 4 broken internal links',
                  'Add FAQ structured data',
                  'Answer "best X for Y" prompts',
                ].map((t) => (
                  <div
                    key={t}
                    className="flex items-center gap-2 rounded-md bg-white/[0.03] px-2.5 py-2 text-[11px] text-slate-300"
                  >
                    <span className="size-1.5 rounded-full bg-amber-400" />
                    {t}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
      <figcaption className="mt-3 text-center text-[13px] text-slate-500">
        Product illustration with sample values — not customer data.
      </figcaption>
    </figure>
  );
}

export function CtaBand({
  title = 'See where your site stands today',
  text = 'Run a free audit of up to 20 pages, or create an account to track AI visibility and work through fixes with your team.',
}: {
  title?: string;
  text?: string;
}) {
  return (
    <section className="mx-auto max-w-7xl px-4 pb-20 sm:px-6 lg:px-8">
      <div className="relative overflow-hidden rounded-3xl border border-indigo-400/20 bg-gradient-to-br from-indigo-600/25 via-[#0d1426] to-sky-500/10 px-6 py-14 text-center sm:px-12">
        <h2 className="text-3xl font-semibold tracking-tight text-white sm:text-4xl">{title}</h2>
        <p className="mx-auto mt-4 max-w-2xl text-[17px] leading-relaxed text-slate-300">{text}</p>
        <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
          <Button asChild size="lg">
            <Link to="/register">Create a free account</Link>
          </Button>
          <Button
            asChild
            size="lg"
            variant="outline"
            className="border-white/15 bg-transparent text-white hover:bg-white/5"
          >
            <Link to="/free-audit">Run a free audit</Link>
          </Button>
        </div>
      </div>
    </section>
  );
}
