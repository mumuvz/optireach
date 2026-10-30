import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, ExternalLink, Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { AUDIT_CATEGORY_LABELS, type AuditCategory } from '@surfaced/shared';
import { FreeAuditForm } from '@/components/marketing/blocks';
import { Section } from '@/components/marketing/layout';
import { SeverityBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/feedback';
import { api, errorMessage } from '@/lib/api';
import { formatNumber, urlPath } from '@/lib/format';
import { isActiveStatus } from '@/lib/query';
import { Seo } from '@/lib/seo';
import { ScoreRing } from '@/components/app/score-ring';

interface PublicAuditResult {
  score: number;
  categoryScores: Record<string, number>;
  issueCounts: { total: number; bySeverity: Record<string, number>; byCategory: Record<string, number> };
  pagesAnalyzed: number;
  topIssues: {
    ruleId: string;
    title: string;
    category: string;
    severity: string;
    affected: number;
    fix: string;
    sampleUrls: string[];
  }[];
  limitations: string[];
  scoring: { version: string; note: string };
}

interface PublicAudit {
  id: string;
  url: string;
  domain: string;
  status: string;
  progress: number;
  pagesCrawled: number;
  maxPages: number;
  result: PublicAuditResult | null;
  errorMessage: string | null;
  expiresAt: string;
}

function readFragment(hash: string): { id: string; token: string } | null {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const id = params.get('id');
  const token = params.get('token');
  return id && token ? { id, token } : null;
}

function AuditResult({ access }: { access: { id: string; token: string } }) {
  const query = useQuery({
    queryKey: ['public-audit', access.id],
    queryFn: () => api.get<PublicAudit>(`/public/audits/${access.id}`, { token: access.token }),
    refetchInterval: (q) => (isActiveStatus(q.state.data?.status) || !q.state.data ? 2000 : false),
  });
  if (query.isError) {
    return (
      <div className="rounded-2xl border border-red-400/30 bg-red-500/10 p-6 text-red-100" role="alert">
        <p className="font-medium">We could not load this audit.</p>
        <p className="mt-1 text-sm opacity-90">
          {errorMessage(query.error)} Free audit links expire after 7 days.
        </p>
      </div>
    );
  }
  const audit = query.data;
  if (!audit || isActiveStatus(audit.status)) {
    const pct = audit ? Math.max(5, Math.min(100, audit.progress)) : 5;
    return (
      <div className="rounded-2xl border border-border bg-card p-8" role="status" aria-live="polite">
        <div className="flex items-center gap-3">
          <Loader2 className="size-5 animate-spin text-indigo-300" aria-hidden />
          <p className="font-medium text-white">
            {audit?.status === 'RUNNING' ? `Crawling ${audit.domain}…` : 'Waiting for a crawler…'}
          </p>
        </div>
        <Progress value={pct} className="mt-5" label="Audit progress" />
        <p className="mt-3 text-sm text-slate-400">
          {audit ? `${formatNumber(audit.pagesCrawled)} of up to ${audit.maxPages} pages fetched. ` : ''}This
          usually takes under a minute. You can keep this page open.
        </p>
      </div>
    );
  }
  if (audit.status === 'FAILED' || !audit.result) {
    return (
      <div className="rounded-2xl border border-amber-400/30 bg-amber-500/10 p-6 text-amber-100" role="alert">
        <p className="flex items-center gap-2 font-medium">
          <AlertTriangle className="size-5" aria-hidden /> The audit could not be completed
        </p>
        <p className="mt-2 text-sm opacity-90">{audit.errorMessage ?? 'The site could not be crawled.'}</p>
        <p className="mt-2 text-sm opacity-90">
          Common causes: the site blocks crawlers in robots.txt, it is not reachable from the internet, or it
          took too long to respond.
        </p>
      </div>
    );
  }
  const r = audit.result;
  return (
    <div className="space-y-6">
      <div className="grid gap-6 rounded-2xl border border-border bg-card p-6 sm:p-8 md:grid-cols-[auto_1fr] md:items-center">
        <ScoreRing score={r.score} size={132} label="Site health index" />
        <div>
          <p className="text-sm text-slate-400">Results for</p>
          <h2 className="mt-1 flex flex-wrap items-center gap-2 text-2xl font-semibold text-white">
            {audit.domain}
            <a
              href={audit.url}
              target="_blank"
              rel="noopener noreferrer nofollow"
              className="text-slate-400 hover:text-white"
              aria-label="Open the website in a new tab"
            >
              <ExternalLink className="size-4" />
            </a>
          </h2>
          <p className="mt-2 text-sm text-slate-300">
            {formatNumber(r.pagesAnalyzed)} pages analyzed · {formatNumber(r.issueCounts.total)} issues found
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            {(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const).map((s) => (
              <span
                key={s}
                className="inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1 text-[13px] text-slate-300"
              >
                <SeverityBadge severity={s} /> {formatNumber(r.issueCounts.bySeverity[s] ?? 0)}
              </span>
            ))}
          </div>
          <p className="mt-4 text-[13px] text-slate-400">{r.scoring.note}</p>
        </div>
      </div>

      <div className="rounded-2xl border border-border bg-card p-6">
        <h3 className="font-semibold text-white">Category scores</h3>
        <dl className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Object.entries(r.categoryScores).map(([category, score]) => (
            <div key={category}>
              <dt className="flex justify-between text-sm text-slate-300">
                <span>{AUDIT_CATEGORY_LABELS[category as AuditCategory] ?? category}</span>
                <span className="font-medium text-white tabular-nums">{Math.round(score)}</span>
              </dt>
              <dd className="mt-2">
                <Progress value={score} label={`${category} score`} />
              </dd>
            </div>
          ))}
        </dl>
      </div>

      <div className="rounded-2xl border border-border bg-card">
        <h3 className="border-b border-border p-6 font-semibold text-white">Top issues</h3>
        {r.topIssues.length === 0 ? (
          <p className="flex items-center gap-2 p-6 text-slate-300">
            <CheckCircle2 className="size-5 text-emerald-300" aria-hidden /> No issues were found on the pages
            we checked.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {r.topIssues.map((issue) => (
              <li key={issue.ruleId} className="p-6">
                <div className="flex flex-wrap items-center gap-2">
                  <SeverityBadge severity={issue.severity} />
                  <span className="text-xs text-slate-400">
                    {AUDIT_CATEGORY_LABELS[issue.category as AuditCategory] ?? issue.category}
                  </span>
                  <span className="text-xs text-slate-400">· {pluralPages(issue.affected)}</span>
                </div>
                <p className="mt-2 font-medium text-white">{issue.title}</p>
                <p className="mt-1 text-sm leading-relaxed text-slate-300">
                  <span className="font-medium text-slate-200">How to fix: </span>
                  {issue.fix}
                </p>
                {issue.sampleUrls.length ? (
                  <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[13px] text-slate-400">
                    {issue.sampleUrls.map((u) => (
                      <li key={u} className="max-w-full truncate font-mono">
                        {urlPath(u)}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>

      {r.limitations.length ? (
        <div className="rounded-2xl border border-border bg-card p-6">
          <h3 className="font-semibold text-white">Limitations of this audit</h3>
          <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-slate-300">
            {r.limitations.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="flex flex-col items-start gap-4 rounded-2xl border border-indigo-400/25 bg-indigo-500/10 p-6 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="font-semibold text-white">Track these issues and fix them with your team</p>
          <p className="mt-1 text-sm text-slate-300">
            A free account audits every page of your site, keeps issue history and tracks AI visibility.
          </p>
        </div>
        <Button asChild size="lg">
          <Link to="/register">Create a free account</Link>
        </Button>
      </div>
    </div>
  );
}

const pluralPages = (n: number) => `${formatNumber(n)} ${n === 1 ? 'page' : 'pages'}`;

export default function FreeAuditPage() {
  // Read after hydration (the prerendered HTML has no fragment). The router location also updates
  // when the form on this page navigates to a new fragment, which does not fire "hashchange".
  const location = useLocation();
  const [access, setAccess] = useState<{ id: string; token: string } | null>(null);
  useEffect(() => {
    setAccess(readFragment(location.hash));
  }, [location.hash]);

  return (
    <>
      <Seo
        title="Free website audit"
        description="Check up to 20 pages of your website for technical SEO issues: broken links, metadata, redirects, structured data and more. No account needed."
        path="/free-audit"
      />
      <Section className="max-w-4xl">
        <p className="text-sm font-semibold tracking-wide text-indigo-300 uppercase">Free audit</p>
        <h1 className="mt-3 text-4xl font-semibold tracking-tight text-white sm:text-5xl">
          Free website audit
        </h1>
        <p className="mt-5 max-w-2xl text-lg leading-relaxed text-slate-300">
          We crawl up to 20 public pages, respecting robots.txt, and check them for the technical issues that
          most often hurt search visibility.
        </p>
        <div className="mt-8">
          <FreeAuditForm size="md" />
        </div>
        {access ? (
          <div className="mt-10">
            <AuditResult key={access.id} access={access} />
          </div>
        ) : null}
      </Section>
    </>
  );
}
