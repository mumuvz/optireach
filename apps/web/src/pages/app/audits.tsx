import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, ScanSearch } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { toast } from 'sonner';
import { AUDIT_CATEGORIES, AUDIT_CATEGORY_LABELS } from '@surfaced/shared';
import { useAuditRuns, useIssueSummary } from '@/app/hooks';
import { useProject } from '@/app/project-scope';
import { ExportPdfButton } from '@/components/app/export-pdf-button';
import { NeedsWebsite } from '@/components/app/needs-website';
import { PageHeader } from '@/components/app/page';
import { Badge, SeverityBadge, StatusBadge, humanize } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeaderRow } from '@/components/ui/card';
import { Alert, EmptyState, ErrorState, LoadingBlock, Progress } from '@/components/ui/feedback';
import { Pagination, TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { api, errorMessage } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { formatDateTime, formatDuration, formatNumber } from '@/lib/format';
import { isActiveStatus } from '@/lib/query';

export default function AuditsPage() {
  const project = useProject();
  const [page, setPage] = useState(1);
  const runs = useAuditRuns(project.id, page, 15);
  const summary = useIssueSummary(project.id);
  const canAudit = useCan('audit.run');
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const start = useMutation({
    mutationFn: () => api.post<{ auditRunId: string }>(`/projects/${project.id}/audits`, {}),
    onSuccess: async (r) => {
      await queryClient.invalidateQueries({ queryKey: ['audits', project.id] });
      void navigate(`/app/p/${project.id}/audits/${r.auditRunId}`);
    },
    onError: (e) => toast.error('Could not start the audit', { description: errorMessage(e) }),
  });
  const active = runs.data?.items.find((r) => isActiveStatus(r.status) || isActiveStatus(r.crawlStatus));
  const sev = summary.data?.bySeverity ?? {};

  if (!project.websiteUrl)
    return (
      <>
        <PageHeader
          title="Website audit"
          description="Crawls your website and checks every page against 55 rules."
        />
        <NeedsWebsite
          feature="The website audit"
          description="It crawls your website and checks each page for technical SEO, structured data, speed and more."
        />
      </>
    );

  return (
    <>
      <PageHeader
        title="Website audit"
        description={`Crawls ${
          project.crawlSettings.maxPages
            ? `up to ${formatNumber(project.crawlSettings.maxPages)} pages of`
            : 'every reachable page of'
        } ${project.domain}, respecting robots.txt, and checks every page against 55 rules.`}
        actions={
          <>
            <ExportPdfButton module="audit" />
            <Button asChild variant="outline">
              <Link to={`/app/p/${project.id}/issues`}>All open issues</Link>
            </Button>
            {canAudit ? (
              <Button onClick={() => start.mutate()} loading={start.isPending} disabled={Boolean(active)}>
                <ScanSearch /> {active ? 'Audit running' : 'Run audit'}
              </Button>
            ) : null}
          </>
        }
      />

      {active ? (
        <Card className="mb-5 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm font-medium">
              Audit in progress · {formatNumber(active.pagesCrawled)} pages crawled
            </p>
            <Button asChild size="sm" variant="outline">
              <Link to={`/app/p/${project.id}/audits/${active.id}`}>View progress</Link>
            </Button>
          </div>
          <Progress className="mt-3" value={Math.max(4, active.progress)} label="Audit progress" />
        </Card>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-[1fr_1.4fr]">
        <Card>
          <CardHeaderRow title="Open issues" description="Across the latest crawl of each page" />
          <CardContent>
            {summary.isPending ? (
              <LoadingBlock />
            ) : summary.isError ? (
              <ErrorState error={summary.error} onRetry={() => void summary.refetch()} />
            ) : (
              <>
                <ul className="grid grid-cols-2 gap-2">
                  {(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const).map((s) => (
                    <li key={s}>
                      <Link
                        to={`/app/p/${project.id}/issues?severity=${s}`}
                        className="flex items-center justify-between rounded-lg border border-border px-3 py-2.5 hover:bg-muted"
                      >
                        <SeverityBadge severity={s} />
                        <span className="font-semibold">{formatNumber(sev[s] ?? 0)}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
                <ul className="mt-4 divide-y divide-border text-sm">
                  {AUDIT_CATEGORIES.map((c) => (
                    <li key={c} className="flex items-center justify-between py-2">
                      <Link to={`/app/p/${project.id}/issues?category=${c}`} className="hover:text-primary">
                        {AUDIT_CATEGORY_LABELS[c]}
                      </Link>
                      <span className="text-muted-foreground tabular-nums">
                        {formatNumber(summary.data.byCategory[c] ?? 0)}
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </CardContent>
        </Card>
        <div className="space-y-5">
          <Card className="p-4">
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <CalendarClock className="size-4 text-muted-foreground" aria-hidden />
              {project.auditSchedule === 'MANUAL' ? (
                <span>Audits run when you start them.</span>
              ) : (
                <span>
                  {humanize(project.auditSchedule)} audits are scheduled · next run{' '}
                  {formatDateTime(project.nextAuditAt)}
                </span>
              )}
              <Link
                to={`/app/p/${project.id}/settings`}
                className="ml-auto text-[13px] font-medium text-primary hover:underline"
              >
                Change schedule
              </Link>
            </div>
          </Card>
          <Card>
            <CardHeaderRow title="Audit runs" />
            {runs.isPending ? (
              <CardContent>
                <LoadingBlock rows={5} />
              </CardContent>
            ) : runs.isError ? (
              <CardContent>
                <ErrorState error={runs.error} onRetry={() => void runs.refetch()} />
              </CardContent>
            ) : runs.data.items.length === 0 ? (
              <CardContent>
                <EmptyState
                  icon={ScanSearch}
                  title="No audits yet"
                  description="Run the first audit to crawl your site and find technical issues."
                />
              </CardContent>
            ) : (
              <>
                <Table>
                  <THead>
                    <TR>
                      <TH>Started</TH>
                      <TH>Trigger</TH>
                      <TH>Status</TH>
                      <TH className="text-right">Pages</TH>
                      <TH className="text-right">Issues</TH>
                      <TH className="text-right">Index</TH>
                      <TH className="text-right">Duration</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {runs.data.items.map((r) => (
                      <TR key={r.id}>
                        <TD>
                          <Link
                            to={`/app/p/${project.id}/audits/${r.id}`}
                            className="font-medium hover:text-primary"
                          >
                            {formatDateTime(r.createdAt)}
                          </Link>
                          {r.isDemo ? (
                            <Badge tone="demo" className="ml-2">
                              Demo
                            </Badge>
                          ) : null}
                        </TD>
                        <TD className="text-muted-foreground">{humanize(r.trigger)}</TD>
                        <TD>
                          <StatusBadge status={r.status} />
                        </TD>
                        <TD className="text-right tabular-nums">{formatNumber(r.pagesCrawled)}</TD>
                        <TD className="text-right tabular-nums">{formatNumber(r.issueCounts?.total)}</TD>
                        <TD className="text-right font-medium tabular-nums">{r.score ?? '—'}</TD>
                        <TD className="text-right text-muted-foreground tabular-nums">
                          {r.finishedAt
                            ? formatDuration(
                                new Date(r.finishedAt).getTime() - new Date(r.createdAt).getTime(),
                              )
                            : '—'}
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
                <Pagination meta={runs.data.meta} onPage={setPage} />
              </>
            )}
          </Card>
          {!canAudit ? <Alert tone="info">Your role can view audits but not start them.</Alert> : null}
        </div>
      </div>
    </>
  );
}
