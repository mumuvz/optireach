import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, RefreshCw, Search, XCircle } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import { AUDIT_CATEGORY_LABELS, type AuditCategory } from '@surfaced/shared';
import { useProject } from '@/app/project-scope';
import { Meter } from '@/components/charts/charts';
import { IssuesTable } from '@/components/app/issues-table';
import { MetricCard, PageHeader } from '@/components/app/page';
import { ScoreRing } from '@/components/app/score-ring';
import { Badge, StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeaderRow } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/dialog';
import { Alert, EmptyState, ErrorState, LoadingBlock, Progress } from '@/components/ui/feedback';
import { Input, NativeSelect } from '@/components/ui/form';
import { Pagination, TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api, ApiError, errorMessage } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { formatDateTime, formatDuration, formatNumber, urlPath } from '@/lib/format';
import { isActiveStatus } from '@/lib/query';
import type { AuditDetailDto, CrawledPageRow } from '@/lib/types';

const HTTPS_LABELS: Record<string, string> = {
  ok: 'HTTP redirects to HTTPS',
  not_redirected: 'HTTP is not redirected to HTTPS',
  unreachable: 'HTTP version unreachable',
  not_https: 'Site is not served over HTTPS',
};

function Fact({ ok, label, detail }: { ok: boolean | null; label: string; detail?: string }) {
  const Icon = ok === null ? AlertTriangle : ok ? CheckCircle2 : XCircle;
  return (
    <li className="flex items-start gap-2.5 py-2 text-sm">
      <Icon
        className={
          ok === null
            ? 'mt-0.5 size-4 text-amber-600'
            : ok
              ? 'mt-0.5 size-4 text-emerald-600'
              : 'mt-0.5 size-4 text-red-600'
        }
        aria-hidden
      />
      <span>
        <span className="sr-only">{ok === null ? 'Warning: ' : ok ? 'OK: ' : 'Problem: '}</span>
        {label}
        {detail ? <span className="block text-xs text-muted-foreground">{detail}</span> : null}
      </span>
    </li>
  );
}

function PagesTab({ auditId, projectId }: { auditId: string; projectId: string }) {
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  const [statusClass, setStatusClass] = useState('');
  const [sort, setSort] = useState('url');
  const query = useQuery({
    queryKey: ['audit-pages', auditId, page, search, statusClass, sort],
    queryFn: () =>
      api.page<CrawledPageRow>(`/audits/${auditId}/pages`, {
        page,
        pageSize: 25,
        q: search || undefined,
        statusClass: statusClass || undefined,
        sort,
        order: sort === 'url' ? 'asc' : 'desc',
      }),
    placeholderData: keepPreviousData,
  });
  return (
    <div>
      <div className="flex flex-wrap gap-2 px-5 pb-3">
        <form
          className="relative min-w-52 flex-1"
          onSubmit={(e) => {
            e.preventDefault();
            setPage(1);
            setSearch(q.trim());
          }}
        >
          <Search
            className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search URL or title"
            aria-label="Search pages"
            className="pl-8"
          />
        </form>
        <NativeSelect
          aria-label="Status code"
          value={statusClass}
          onChange={(e) => (setPage(1), setStatusClass(e.target.value))}
          className="w-40"
        >
          <option value="">All status codes</option>
          <option value="2xx">2xx success</option>
          <option value="3xx">3xx redirect</option>
          <option value="4xx">4xx client error</option>
          <option value="5xx">5xx server error</option>
          <option value="error">Fetch failed</option>
        </NativeSelect>
        <NativeSelect
          aria-label="Sort by"
          value={sort}
          onChange={(e) => setSort(e.target.value)}
          className="w-44"
        >
          <option value="url">URL</option>
          <option value="responseTimeMs">Slowest first</option>
          <option value="wordCount">Most words</option>
          <option value="inlinksCount">Most inlinks</option>
          <option value="depth">Deepest first</option>
        </NativeSelect>
      </div>
      {query.isPending ? (
        <LoadingBlock className="px-5 pb-5" rows={6} />
      ) : query.isError ? (
        <ErrorState className="mx-5 mb-5" error={query.error} onRetry={() => void query.refetch()} />
      ) : query.data.items.length === 0 ? (
        <EmptyState className="mx-5 mb-5" title="No pages match" />
      ) : (
        <div className={query.isPlaceholderData ? 'opacity-60' : undefined}>
          <Table>
            <THead>
              <TR>
                <TH>Page</TH>
                <TH>Status</TH>
                <TH className="text-right">Response</TH>
                <TH className="text-right">Words</TH>
                <TH className="text-right">Inlinks</TH>
                <TH className="text-right">Issues</TH>
              </TR>
            </THead>
            <TBody>
              {query.data.items.map((p) => (
                <TR key={p.id}>
                  <TD className="max-w-[28rem]">
                    <Link
                      to={`/app/p/${projectId}/audits/${auditId}/pages/${p.id}`}
                      className="block truncate font-mono text-xs hover:text-primary"
                      title={p.url}
                    >
                      {urlPath(p.url)}
                    </Link>
                    <span className="block truncate text-xs text-muted-foreground">
                      {p.title ?? (p.fetchError ? `Fetch failed: ${p.fetchError}` : 'No title')}
                    </span>
                  </TD>
                  <TD>
                    <span className="flex flex-wrap items-center gap-1">
                      <Badge
                        tone={
                          p.statusCode === null
                            ? 'danger'
                            : p.statusCode >= 400
                              ? 'danger'
                              : p.statusCode >= 300
                                ? 'warning'
                                : 'success'
                        }
                      >
                        {p.statusCode ?? 'Error'}
                      </Badge>
                      {!p.isIndexable ? (
                        <Badge title={p.indexabilityReason ?? undefined}>Not indexable</Badge>
                      ) : null}
                    </span>
                  </TD>
                  <TD className="text-right tabular-nums">{formatDuration(p.responseTimeMs)}</TD>
                  <TD className="text-right tabular-nums">{formatNumber(p.wordCount)}</TD>
                  <TD className="text-right tabular-nums">{formatNumber(p.inlinksCount)}</TD>
                  <TD className="text-right tabular-nums">{formatNumber(p.issueCount)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
          <Pagination meta={query.data.meta} onPage={setPage} />
        </div>
      )}
    </div>
  );
}

export default function AuditDetailPage() {
  const project = useProject();
  const { auditId } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const canAudit = useCan('audit.run');
  const canCancel = useCan('audit.cancel');
  const query = useQuery({
    queryKey: ['audit', auditId],
    queryFn: () => api.get<AuditDetailDto>(`/audits/${auditId}`),
    refetchInterval: (q) =>
      q.state.data && (isActiveStatus(q.state.data.status) || isActiveStatus(q.state.data.crawl.status))
        ? 2000
        : false,
  });
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['audit', auditId] });
    void queryClient.invalidateQueries({ queryKey: ['audits', project.id] });
    void queryClient.invalidateQueries({ queryKey: ['issues', project.id] });
  };
  const cancel = useMutation({
    mutationFn: () => api.post<AuditDetailDto>(`/audits/${auditId}/cancel`),
    onSuccess: () => {
      toast.success('Cancellation requested');
      refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  // When a running audit finishes, refresh the issue and page lists that depend on it.
  const lastStatus = useRef<string | null>(null);
  useEffect(() => {
    const status = query.data?.status ?? null;
    if (lastStatus.current && lastStatus.current !== status && status === 'SUCCEEDED') {
      void queryClient.invalidateQueries({ queryKey: ['issues', project.id] });
      void queryClient.invalidateQueries({ queryKey: ['audit-pages', auditId] });
      void queryClient.invalidateQueries({ queryKey: ['audits', project.id] });
    }
    lastStatus.current = status;
  }, [query.data?.status, queryClient, project.id, auditId]);
  const rescore = useMutation({
    mutationFn: () => api.post<{ auditRunId: string }>(`/audits/${auditId}/rescore`),
    onSuccess: (r) => {
      toast.success('Re-scoring started', {
        description: 'The stored crawl is analyzed again; no new requests are made to the site.',
      });
      refresh();
      void navigate(`/app/p/${project.id}/audits/${r.auditRunId}`);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  if (query.isPending) return <LoadingBlock rows={8} />;
  if (query.isError) {
    if (query.error instanceof ApiError && query.error.status === 404)
      return (
        <EmptyState
          title="Audit not found"
          action={
            <Button asChild>
              <Link to={`/app/p/${project.id}/audits`}>Back to audits</Link>
            </Button>
          }
        />
      );
    return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  }
  const audit = query.data;
  const running = isActiveStatus(audit.status) || isActiveStatus(audit.crawl.status);
  const counts = audit.issueCounts;
  const robots = audit.crawl.robots;
  const sitemap = audit.crawl.sitemap;
  const summary = audit.crawl.summary;
  const job =
    audit.jobs.audit && isActiveStatus(audit.jobs.audit.status) ? audit.jobs.audit : audit.jobs.crawl;

  return (
    <>
      <PageHeader
        title={`Audit of ${formatDateTime(audit.createdAt)}`}
        documentTitle="Audit"
        breadcrumbs={[{ label: 'Website audit', to: `/app/p/${project.id}/audits` }, { label: 'Audit' }]}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <StatusBadge status={audit.status} /> {audit.crawl.startUrl}
            {audit.isDemo ? <Badge tone="demo">Demo data</Badge> : null}
          </span>
        }
        actions={
          <>
            {running && canCancel ? (
              <ConfirmDialog
                title="Cancel this audit?"
                description="The crawl stops after the pages in progress. Pages crawled so far are discarded."
                confirmLabel="Cancel audit"
                destructive
                onConfirm={() => cancel.mutateAsync()}
                trigger={<Button variant="outline">Cancel audit</Button>}
              />
            ) : null}
            {!running && audit.crawl.status === 'SUCCEEDED' && canAudit ? (
              <Button variant="outline" onClick={() => rescore.mutate()} loading={rescore.isPending}>
                <RefreshCw /> Re-score
              </Button>
            ) : null}
          </>
        }
      />

      {running ? (
        <Card className="mb-5 p-5" aria-live="polite">
          <p className="font-medium">
            {audit.crawl.status === 'RUNNING'
              ? 'Crawling the website…'
              : audit.status === 'RUNNING'
                ? 'Analyzing pages…'
                : 'Waiting for a worker…'}
          </p>
          <Progress
            className="mt-3"
            value={Math.max(4, audit.crawl.status === 'SUCCEEDED' ? 90 : audit.crawl.progress)}
            label="Audit progress"
          />
          <p className="mt-2 text-sm text-muted-foreground">
            {formatNumber(audit.crawl.pagesCrawled)} pages crawled ·{' '}
            {formatNumber(audit.crawl.pagesDiscovered)} discovered
            {audit.crawl.settings?.maxPages
              ? ` · limit ${formatNumber(audit.crawl.settings.maxPages)}`
              : audit.crawl.settings?.maxPages === null
                ? ' · no page limit'
                : ''}
            {job?.message ? ` · ${job.message}` : ''}
          </p>
        </Card>
      ) : null}

      {audit.status === 'FAILED' || audit.crawl.status === 'FAILED' ? (
        <Alert tone="danger" title="This audit did not complete" className="mb-5">
          {audit.crawl.errorMessage ??
            audit.jobs.audit?.error ??
            audit.jobs.crawl?.error ??
            'The audit failed.'}
        </Alert>
      ) : null}
      {audit.status === 'CANCELLED' ? (
        <Alert tone="info" className="mb-5">
          This audit was cancelled.
        </Alert>
      ) : null}

      {audit.status === 'SUCCEEDED' ? (
        <>
          <div className="grid gap-5 lg:grid-cols-[auto_1fr]">
            <Card className="flex flex-col items-center justify-center p-6">
              <ScoreRing score={audit.score} size={140} label="Site health index" />
              {audit.previous?.score != null && audit.score !== null ? (
                <p className="mt-3 text-sm">
                  <span
                    className={audit.score - audit.previous.score >= 0 ? 'text-emerald-700' : 'text-red-700'}
                  >
                    {audit.score - audit.previous.score >= 0 ? '+' : ''}
                    {audit.score - audit.previous.score}
                  </span>{' '}
                  <Link
                    to={`/app/p/${project.id}/audits/${audit.previous.id}`}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    vs previous audit
                  </Link>
                </p>
              ) : null}
              <p className="mt-2 max-w-[14rem] text-center text-xs text-muted-foreground">
                Diagnostic index calculated by Surfaced (scoring {audit.scoringVersion}); not a search engine
                score.
              </p>
            </Card>
            <div className="grid content-start gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <MetricCard
                label="Pages analyzed"
                value={formatNumber(audit.pagesAnalyzed)}
                sub={`${formatNumber(audit.crawl.pagesFailed)} failed to load`}
              />
              <MetricCard
                label="Issues found"
                value={formatNumber(counts?.total)}
                sub={`${formatNumber(counts?.bySeverity.CRITICAL ?? 0)} critical · ${formatNumber(counts?.bySeverity.HIGH ?? 0)} high`}
                tone={counts?.bySeverity.CRITICAL ? 'danger' : undefined}
              />
              <MetricCard
                label="Duration"
                value={
                  audit.finishedAt
                    ? formatDuration(
                        new Date(audit.finishedAt).getTime() - new Date(audit.createdAt).getTime(),
                      )
                    : '—'
                }
                sub={`Finished ${formatDateTime(audit.finishedAt)}`}
              />
              <MetricCard
                label="Sitemap URLs"
                value={sitemap?.found ? formatNumber(sitemap.urlCount) : 'None found'}
                sub={sitemap?.found ? `${sitemap.files.length} sitemap file(s)` : 'Add a sitemap.xml'}
              />
              <Card className="p-4 sm:col-span-2 xl:col-span-4">
                <p className="mb-3 text-[13px] font-medium text-muted-foreground">Category scores</p>
                <div className="grid gap-x-8 gap-y-3 sm:grid-cols-2">
                  {Object.entries(audit.categoryScores ?? {}).map(([category, score]) => (
                    <div key={category}>
                      <div className="mb-1 flex justify-between text-[13px]">
                        <span>{AUDIT_CATEGORY_LABELS[category as AuditCategory] ?? category}</span>
                        <span className="font-medium tabular-nums">{Math.round(score)}</span>
                      </div>
                      <Meter
                        value={score}
                        label={`${AUDIT_CATEGORY_LABELS[category as AuditCategory] ?? category} score`}
                      />
                    </div>
                  ))}
                </div>
              </Card>
            </div>
          </div>

          <div className="mt-5 grid gap-5 lg:grid-cols-2">
            <Card>
              <CardHeaderRow title="Crawl facts" />
              <CardContent>
                <ul className="divide-y divide-border">
                  <Fact
                    ok={robots ? robots.status !== 'error' && !robots.disallowAll : null}
                    label={
                      robots
                        ? robots.status === 'missing'
                          ? 'No robots.txt (everything allowed)'
                          : robots.disallowAll
                            ? 'robots.txt blocks all crawling'
                            : 'robots.txt found and respected'
                        : 'robots.txt not checked'
                    }
                    detail={
                      robots?.crawlDelaySec
                        ? `Crawl-delay ${robots.crawlDelaySec}s honoured`
                        : (robots?.error ?? undefined)
                    }
                  />
                  <Fact
                    ok={sitemap ? sitemap.found : null}
                    label={
                      sitemap?.found
                        ? `XML sitemap with ${formatNumber(sitemap.urlCount)} URLs${sitemap.truncated ? ' (truncated)' : ''}`
                        : 'No XML sitemap found'
                    }
                  />
                  <Fact
                    ok={summary?.httpsRedirect ? summary.httpsRedirect === 'ok' : null}
                    label={
                      summary?.httpsRedirect
                        ? (HTTPS_LABELS[summary.httpsRedirect] ?? summary.httpsRedirect)
                        : 'HTTPS redirect not checked'
                    }
                  />
                  <Fact
                    ok={!summary?.limitReached}
                    label={
                      summary?.limitReached
                        ? 'A page cap was reached before the whole site was crawled'
                        : audit.crawl.settings?.maxPages === null
                          ? 'No page cap: every reachable page was crawled'
                          : 'All discovered pages within the limit were crawled'
                    }
                    detail={
                      summary?.limitReached
                        ? 'Choose “Crawl every page” in project settings. A cap set on the plan or the server still applies.'
                        : undefined
                    }
                  />
                  {summary?.blockedByRobots?.length ? (
                    <Fact
                      ok={null}
                      label={`${formatNumber(Math.max(summary.blockedByRobotsTotal ?? 0, summary.blockedByRobots.length))} internal URLs are blocked by robots.txt`}
                      detail={summary.blockedByRobots.slice(0, 3).map(urlPath).join(', ')}
                    />
                  ) : null}
                  {summary?.loopUrlsSkipped ? (
                    <Fact
                      ok={null}
                      label={`${formatNumber(summary.loopUrlsSkipped)} links were not followed by loop protection`}
                      detail="Repeated query-string variants of one path (such as calendars or filters), or URLs longer than 2,048 characters."
                    />
                  ) : null}
                </ul>
              </CardContent>
            </Card>
            <Card>
              <CardHeaderRow title="Limitations" description="What this audit could not check" />
              <CardContent>
                {audit.limitations.length ? (
                  <ul className="list-disc space-y-1.5 pl-5 text-sm text-muted-foreground">
                    {audit.limitations.map((l) => (
                      <li key={l}>{l}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-muted-foreground">No limitations were recorded for this run.</p>
                )}
              </CardContent>
            </Card>
          </div>
        </>
      ) : null}

      {audit.status === 'SUCCEEDED' ? (
        <Card className="mt-5">
          <Tabs defaultValue="issues">
            <div className="px-5 pt-4">
              <TabsList>
                <TabsTrigger value="issues">Issues in this audit</TabsTrigger>
                <TabsTrigger value="pages">Crawled pages</TabsTrigger>
              </TabsList>
            </div>
            <TabsContent value="issues">
              <IssuesTable
                path={`/audits/${audit.id}/issues`}
                projectId={project.id}
                showStatusFilter={false}
              />
            </TabsContent>
            <TabsContent value="pages">
              <PagesTab auditId={audit.id} projectId={project.id} />
            </TabsContent>
          </Tabs>
        </Card>
      ) : null}
    </>
  );
}
