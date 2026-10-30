import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, FileText, ListChecks, Radar, ScanSearch } from 'lucide-react';
import { Link, useNavigate } from 'react-router';
import { toast } from 'sonner';
import {
  useAuditRuns,
  useDocuments,
  useIssueSummary,
  usePrompts,
  useRecommendations,
  useVisibilitySummary,
} from '@/app/hooks';
import { useProject } from '@/app/project-scope';
import { useUsage } from '@/app/queries';
import { ChartFrame, HBars, LineTrend, Meter } from '@/components/charts/charts';
import { SERIES } from '@/components/charts/palette';
import { MetricCard, PageHeader } from '@/components/app/page';
import { SeverityBadge, StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeaderRow } from '@/components/ui/card';
import { EmptyState, ErrorState, LoadingBlock } from '@/components/ui/feedback';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { api, errorMessage } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { formatDate, formatNumber, formatPercent, formatRelative } from '@/lib/format';

function ScoreDelta({ current, previous }: { current: number | null; previous: number | null | undefined }) {
  if (current === null) return null;
  if (previous === null || previous === undefined) return <span>First completed audit</span>;
  const delta = current - previous;
  if (delta === 0) return <span>No change since the previous audit</span>;
  return (
    <span className={delta > 0 ? 'text-emerald-700' : 'text-red-700'}>
      {delta > 0 ? '+' : ''}
      {delta} since the previous audit
    </span>
  );
}

export default function OverviewPage() {
  const project = useProject();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const canAudit = useCan('audit.run');
  const audits = useAuditRuns(project.id, 1, 10);
  const issues = useIssueSummary(project.id);
  const visibility = useVisibilitySummary(project.id);
  const prompts = usePrompts(project.id, 1, 1);
  const documents = useDocuments(project.id, { pageSize: 5 });
  const recommendations = useRecommendations(project.id, { pageSize: 5, status: 'OPEN,IN_PROGRESS' });
  const usage = useUsage();

  const startAudit = useMutation({
    mutationFn: () => api.post<{ auditRunId: string }>(`/projects/${project.id}/audits`, {}),
    onSuccess: async (r) => {
      await queryClient.invalidateQueries({ queryKey: ['audits', project.id] });
      void navigate(`/app/p/${project.id}/audits/${r.auditRunId}`);
    },
    onError: (e) => toast.error('Could not start the audit', { description: errorMessage(e) }),
  });

  const runs = audits.data?.items ?? [];
  const completed = runs.filter((r) => r.status === 'SUCCEEDED' && r.score !== null);
  const latest = completed[0];
  const previous = completed[1];
  const sev = issues.data?.bySeverity ?? {};
  const openIssues = Object.values(sev).reduce((a, b) => a + b, 0);
  const metrics = visibility.data?.metrics;
  const successful = metrics?.totals.successful ?? 0;
  const scoreHistory = [...completed].reverse().map((r) => ({
    date: formatDate(r.finishedAt ?? r.createdAt, { month: 'short', day: 'numeric' }),
    score: r.score,
  }));
  const entities = metrics
    ? [
        {
          key: 'brand',
          label: project.name,
          value: metrics.mentionRate,
          note: `${metrics.brandMentions} of ${successful} answers`,
        },
        ...metrics.competitors.map((c) => ({
          key: c.id,
          label: c.name,
          value: c.mentionRate,
          note: `${c.mentions} of ${successful} answers`,
        })),
      ]
    : [];

  return (
    <>
      <PageHeader
        title={project.name}
        documentTitle={`${project.name} · Overview`}
        description={
          project.websiteUrl ? (
            <a
              href={project.websiteUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 hover:text-foreground"
            >
              {project.domain} <ExternalLink className="size-3" aria-hidden />
            </a>
          ) : (
            'No website: local listings, rankings and AI visibility only'
          )
        }
        actions={
          canAudit ? (
            <>
              <Button variant="outline" asChild>
                <Link to={`/app/p/${project.id}/visibility`}>
                  <Radar /> AI visibility
                </Link>
              </Button>
              <Button onClick={() => startAudit.mutate()} loading={startAudit.isPending}>
                <ScanSearch /> Run audit
              </Button>
            </>
          ) : null
        }
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <MetricCard
          label="Site health index"
          value={latest ? `${latest.score}` : '—'}
          sub={
            latest ? (
              <ScoreDelta current={latest.score} previous={previous?.score} />
            ) : (
              'No completed audit yet'
            )
          }
          help="A 0–100 diagnostic index calculated from the latest audit. It is not a search engine ranking score."
          to={latest ? `/app/p/${project.id}/audits/${latest.id}` : `/app/p/${project.id}/audits`}
        />
        <MetricCard
          label="Crawled URLs"
          value={latest ? formatNumber(latest.pagesCrawled) : '—'}
          sub={latest ? `Audit of ${formatDate(latest.finishedAt)}` : 'Run an audit to crawl the site'}
        />
        <MetricCard
          label="Open issues"
          value={issues.data ? formatNumber(openIssues) : '—'}
          sub={
            issues.data
              ? `${formatNumber(sev.CRITICAL ?? 0)} critical · ${formatNumber(sev.HIGH ?? 0)} high`
              : undefined
          }
          tone={sev.CRITICAL ? 'danger' : undefined}
          to={`/app/p/${project.id}/issues`}
        />
        <MetricCard
          label="Brand mention rate"
          value={formatPercent(metrics?.mentionRate)}
          sub={
            metrics
              ? `${formatNumber(metrics.brandMentions)} of ${formatNumber(successful)} answers · 30 days`
              : undefined
          }
          help="Successful AI answers that mention your brand ÷ all successful answers, for the last 30 days."
          to={`/app/p/${project.id}/visibility`}
        />
        <MetricCard
          label="Owned citations"
          value={metrics ? formatNumber(metrics.brandCitations) : '—'}
          sub={metrics ? `Citation rate ${formatPercent(metrics.citationRate)}` : undefined}
          help="Successful answers that cite at least one URL on your domain (last 30 days)."
        />
        <MetricCard
          label="Tracked prompts"
          value={prompts.data ? formatNumber(prompts.data.meta.total) : '—'}
          sub={
            usage.data
              ? `Plan limit ${formatNumber(usage.data.counts.find((c) => c.kind === 'trackedPrompts')?.limit)}`
              : undefined
          }
          to={`/app/p/${project.id}/visibility?tab=prompts`}
        />
      </div>

      <div className="mt-5 grid gap-5 xl:grid-cols-[1.3fr_1fr]">
        <Card>
          <CardHeaderRow title="Audit history" description="Site health index of completed audits" />
          <CardContent>
            {audits.isPending ? (
              <LoadingBlock />
            ) : audits.isError ? (
              <ErrorState error={audits.error} onRetry={() => void audits.refetch()} />
            ) : scoreHistory.length < 2 ? (
              <EmptyState
                icon={ScanSearch}
                title={scoreHistory.length ? 'One audit so far' : 'No audits yet'}
                description="The trend appears after two completed audits. Scheduled audits keep it up to date."
                action={
                  canAudit && !scoreHistory.length ? (
                    <Button size="sm" onClick={() => startAudit.mutate()} loading={startAudit.isPending}>
                      Run the first audit
                    </Button>
                  ) : undefined
                }
              />
            ) : (
              <ChartFrame
                title="Site health index"
                description={`${scoreHistory.length} completed audits`}
                table={{
                  columns: ['Audit', 'Index'],
                  rows: scoreHistory.map((p) => [p.date, p.score ?? '—']),
                }}
              >
                <LineTrend
                  data={scoreHistory}
                  xKey="date"
                  series={[{ key: 'score', label: 'Site health index', color: SERIES[0] }]}
                  formatY={(v) => String(Math.round(v))}
                  domain={[0, 100]}
                  height={200}
                />
              </ChartFrame>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeaderRow
            title="Open issues by severity"
            actions={
              <Button asChild variant="link" size="sm">
                <Link to={`/app/p/${project.id}/issues`}>View issues</Link>
              </Button>
            }
          />
          <CardContent>
            {issues.isPending ? (
              <LoadingBlock />
            ) : issues.isError ? (
              <ErrorState error={issues.error} onRetry={() => void issues.refetch()} />
            ) : (
              <ul className="grid grid-cols-2 gap-3">
                {(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const).map((s) => (
                  <li key={s}>
                    <Link
                      to={`/app/p/${project.id}/issues?severity=${s}`}
                      className="flex items-center justify-between rounded-lg border border-border p-3 hover:bg-muted"
                    >
                      <SeverityBadge severity={s} />
                      <span className="text-lg font-semibold">{formatNumber(sev[s] ?? 0)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
            {issues.data?.rules.length ? (
              <div className="mt-4">
                <p className="mb-2 text-xs font-medium text-muted-foreground">Most common</p>
                <ul className="space-y-1.5 text-sm">
                  {issues.data.rules.slice(0, 4).map((r) => (
                    <li key={r.ruleId} className="flex justify-between gap-3">
                      <Link
                        to={`/app/p/${project.id}/issues?ruleId=${r.ruleId}`}
                        className="truncate hover:text-primary"
                      >
                        {r.title}
                      </Link>
                      <span className="shrink-0 text-muted-foreground tabular-nums">
                        {formatNumber(r.count)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </CardContent>
        </Card>
      </div>

      <div className="mt-5 grid gap-5 xl:grid-cols-2">
        <Card>
          <CardHeaderRow
            title="AI visibility vs competitors"
            description="Mention rate in successful AI answers, last 30 days"
            actions={
              <Button asChild variant="link" size="sm">
                <Link to={`/app/p/${project.id}/competitors`}>Compare</Link>
              </Button>
            }
          />
          <CardContent>
            {visibility.isPending ? (
              <LoadingBlock />
            ) : visibility.isError ? (
              <ErrorState error={visibility.error} onRetry={() => void visibility.refetch()} />
            ) : successful === 0 ? (
              <EmptyState
                icon={Radar}
                title="No AI answers recorded in the last 30 days"
                description="Add prompts and run checks to see how often AI assistants mention your brand and competitors."
                action={
                  <Button asChild size="sm">
                    <Link to={`/app/p/${project.id}/visibility?tab=prompts`}>Set up prompts</Link>
                  </Button>
                }
              />
            ) : (
              <ChartFrame
                title="Mention rate"
                description={`Based on ${formatNumber(successful)} successful answers${visibility.data?.composition.includesDemoData ? ' (includes demo data)' : ''}`}
                table={{
                  columns: ['Brand', 'Mention rate', 'Answers mentioning'],
                  rows: entities.map((e) => [e.label, formatPercent(e.value), e.note]),
                }}
              >
                <HBars
                  data={entities}
                  formatValue={(v) => formatPercent(v)}
                  color={SERIES[0]}
                  emphasisKey="brand"
                  max={1}
                />
              </ChartFrame>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeaderRow
            title="Usage this month"
            description={usage.data ? `${usage.data.plan.name} plan · resets on the 1st (UTC)` : undefined}
            actions={
              <Button asChild variant="link" size="sm">
                <Link to="/app/billing">Billing</Link>
              </Button>
            }
          />
          <CardContent>
            {usage.isPending ? (
              <LoadingBlock />
            ) : usage.isError ? (
              <ErrorState error={usage.error} onRetry={() => void usage.refetch()} />
            ) : (
              <ul className="space-y-3">
                {[
                  ...usage.data.metrics.filter((m) => m.limit !== null),
                  ...usage.data.counts.map((c) => ({
                    metric: c.kind,
                    label: c.label,
                    used: c.used,
                    limit: c.limit as number | null,
                  })),
                ].map((m) => (
                  <li key={m.metric}>
                    <div className="mb-1 flex justify-between text-[13px]">
                      <span>{m.label}</span>
                      <span className="text-muted-foreground tabular-nums">
                        {formatNumber(m.used)} / {formatNumber(m.limit)}
                      </span>
                    </div>
                    <Meter value={m.limit ? (m.used / m.limit) * 100 : 0} label={`${m.label} used`} />
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="mt-5 grid gap-5 xl:grid-cols-3">
        <Card className="xl:col-span-1">
          <CardHeaderRow
            title="Recent audits"
            actions={
              <Button asChild variant="link" size="sm">
                <Link to={`/app/p/${project.id}/audits`}>All audits</Link>
              </Button>
            }
          />
          {runs.length ? (
            <Table>
              <THead>
                <TR>
                  <TH>Started</TH>
                  <TH>Status</TH>
                  <TH className="text-right">Index</TH>
                </TR>
              </THead>
              <TBody>
                {runs.slice(0, 5).map((r) => (
                  <TR key={r.id}>
                    <TD>
                      <Link to={`/app/p/${project.id}/audits/${r.id}`} className="hover:text-primary">
                        {formatRelative(r.createdAt)}
                      </Link>
                    </TD>
                    <TD>
                      <StatusBadge status={r.status} />
                    </TD>
                    <TD className="text-right tabular-nums">{r.score ?? '—'}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          ) : (
            <CardContent>
              <p className="text-sm text-muted-foreground">No audits yet.</p>
            </CardContent>
          )}
        </Card>
        <Card>
          <CardHeaderRow
            title="Recent content"
            actions={
              <Button asChild variant="link" size="sm">
                <Link to={`/app/p/${project.id}/content`}>Content Studio</Link>
              </Button>
            }
          />
          <CardContent>
            {documents.data?.items.length ? (
              <ul className="space-y-2.5">
                {documents.data.items.map((d) => (
                  <li key={d.id} className="flex items-center justify-between gap-3">
                    <Link
                      to={`/app/p/${project.id}/content/${d.id}`}
                      className="flex min-w-0 items-center gap-2 text-sm hover:text-primary"
                    >
                      <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                      <span className="truncate">{d.title}</span>
                    </Link>
                    <StatusBadge status={d.status} />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">
                {documents.isPending ? 'Loading…' : 'No content yet.'}
              </p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeaderRow
            title="Outstanding recommendations"
            description={
              recommendations.data
                ? `${formatNumber((recommendations.data.data.byStatus.OPEN ?? 0) + (recommendations.data.data.byStatus.IN_PROGRESS ?? 0))} open or in progress`
                : undefined
            }
            actions={
              <Button asChild variant="link" size="sm">
                <Link to={`/app/p/${project.id}/recommendations`}>All</Link>
              </Button>
            }
          />
          <CardContent>
            {recommendations.data?.data.items.length ? (
              <ul className="space-y-2.5">
                {recommendations.data.data.items.map((r) => (
                  <li key={r.id} className="flex items-start gap-2 text-sm">
                    <ListChecks className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                    <Link
                      to={`/app/p/${project.id}/recommendations?open=${r.id}`}
                      className="min-w-0 flex-1 hover:text-primary"
                    >
                      {r.title}
                    </Link>
                    <SeverityBadge severity={r.severity} />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">
                {recommendations.isPending ? 'Loading…' : 'Nothing outstanding.'}
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
