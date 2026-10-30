import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Lock, Plus, RefreshCw, Scale, Swords } from 'lucide-react';
import { Fragment, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { toast } from 'sonner';
import {
  SEO_COMPARISON_MAX_COMPETITORS,
  SEO_METRIC_GROUPS,
  SEO_METRIC_GROUP_LABELS,
  SEO_METRICS,
  type SeoComparisonDto,
  type SeoComparisonResult,
  type SeoMetricDefinition,
  type SeoMetricStatus,
  type SeoSuggestion,
} from '@surfaced/shared';
import { useProject } from '@/app/project-scope';
import { NeedsWebsite } from '@/components/app/needs-website';
import { ChartFrame, HBars } from '@/components/charts/charts';
import { SERIES } from '@/components/charts/palette';
import { JobProgress, MetricCard, PageHeader } from '@/components/app/page';
import { Badge, type BadgeTone } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeaderRow } from '@/components/ui/card';
import { Alert, EmptyState, ErrorState, LoadingBlock } from '@/components/ui/feedback';
import { Checkbox } from '@/components/ui/form';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { api, ApiError, errorMessage } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { formatDateTime, formatNumber } from '@/lib/format';

const STATUS: Record<SeoMetricStatus, { tone: BadgeTone; label: string }> = {
  ahead: { tone: 'success', label: 'Ahead' },
  behind: { tone: 'danger', label: 'Behind' },
  even: { tone: 'neutral', label: 'Even' },
  unknown: { tone: 'neutral', label: '—' },
};

const PRIORITY: Record<SeoSuggestion['priority'], { tone: BadgeTone; label: string }> = {
  1: { tone: 'danger', label: 'Fix first' },
  2: { tone: 'orange', label: 'High impact' },
  3: { tone: 'warning', label: 'Worth doing' },
  4: { tone: 'info', label: 'Polish' },
};

function formatValue(def: SeoMetricDefinition, value: number | boolean | null | undefined): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  switch (def.unit) {
    case 'percent':
      return `${Math.round(value * 100)}%`;
    case 'ms':
      return `${formatNumber(Math.round(value))} ms`;
    case 'words':
      return formatNumber(Math.round(value));
    default:
      return formatNumber(Math.round(value));
  }
}

export default function SeoComparisonPage() {
  const project = useProject();
  const queryClient = useQueryClient();
  const canRun = useCan('competitor.snapshot');
  const [selected, setSelected] = useState<string[]>(() =>
    project.competitors.slice(0, SEO_COMPARISON_MAX_COMPETITORS).map((c) => c.id),
  );
  const latest = useQuery({
    queryKey: ['seo-comparison', project.id],
    queryFn: () => api.get<SeoComparisonDto | null>(`/projects/${project.id}/seo-comparisons/latest`),
    retry: false,
    refetchInterval: (query) =>
      query.state.data && ['QUEUED', 'RUNNING'].includes(query.state.data.status) ? 3000 : false,
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['seo-comparison', project.id] });
  const start = useMutation({
    mutationFn: () =>
      api.post<{ jobId: string }>(`/projects/${project.id}/seo-comparisons`, { competitorIds: selected }),
    onSuccess: () => void refresh(),
    onError: (e) => toast.error('Could not start the comparison', { description: errorMessage(e) }),
  });

  const comparison = latest.data ?? null;
  const running = comparison ? ['QUEUED', 'RUNNING'].includes(comparison.status) : false;
  const gated = latest.error instanceof ApiError && latest.error.code === 'PLAN_LIMIT_REACHED';
  const header = (
    <PageHeader
      title="SEO comparison"
      description="Your site and your competitors, crawled the same way and checked with the same audit rules: see where you are behind, and what to fix first."
      actions={
        <Button asChild variant="outline">
          <Link to={`/app/p/${project.id}/settings#competitors`}>Manage competitors</Link>
        </Button>
      }
    />
  );

  if (latest.isLoading)
    return (
      <>
        {header}
        <LoadingBlock rows={6} />
      </>
    );
  if (!project.websiteUrl)
    return (
      <>
        {header}
        <NeedsWebsite
          feature="SEO comparison"
          description="It crawls your site and your competitors' sites and checks them with the same audit rules."
        />
      </>
    );
  if (gated)
    return (
      <>
        {header}
        <EmptyState
          icon={Lock}
          title="SEO comparison is part of the Growth and Agency plans"
          description={(latest.error as ApiError).message}
          action={
            <Button asChild>
              <Link to="/app/billing">See plans</Link>
            </Button>
          }
        />
      </>
    );
  if (latest.error)
    return (
      <>
        {header}
        <ErrorState error={latest.error} onRetry={() => void latest.refetch()} />
      </>
    );
  if (!project.competitors.length)
    return (
      <>
        {header}
        <EmptyState
          icon={Swords}
          title="Add competitors to compare with"
          description="Track the sites you compete with (for example the brands AI recommends on the Competitor gaps page), then compare them here."
          action={
            <Button asChild>
              <Link to={`/app/p/${project.id}/settings#competitors`}>Add competitors</Link>
            </Button>
          }
        />
      </>
    );

  const toggle = (id: string, on: boolean) =>
    setSelected((prev) =>
      on ? [...prev, id].slice(0, SEO_COMPARISON_MAX_COMPETITORS) : prev.filter((x) => x !== id),
    );
  const result = comparison?.status === 'SUCCEEDED' ? comparison.result : null;
  return (
    <>
      {header}
      <Card className="mb-5">
        <CardContent className="flex flex-wrap items-center justify-between gap-4 pt-5">
          <fieldset className="min-w-0">
            <legend className="mb-2 text-sm font-medium">
              Compare with (up to {SEO_COMPARISON_MAX_COMPETITORS})
            </legend>
            <div className="flex flex-wrap gap-x-5 gap-y-2">
              {project.competitors.map((c) => {
                const checked = selected.includes(c.id);
                return (
                  <label key={c.id} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={checked}
                      disabled={!checked && selected.length >= SEO_COMPARISON_MAX_COMPETITORS}
                      onCheckedChange={(v) => toggle(c.id, v === true)}
                    />
                    {c.name} <span className="text-muted-foreground">{c.domain}</span>
                  </label>
                );
              })}
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              Each competitor counts as one competitor snapshot this month. Every site is checked on the same
              number of pages, starting at its homepage, with robots.txt respected.
            </p>
          </fieldset>
          {canRun ? (
            <Button
              onClick={() => start.mutate()}
              loading={start.isPending}
              disabled={running || selected.length === 0}
            >
              <RefreshCw /> {result ? 'Compare again' : 'Run comparison'}
            </Button>
          ) : null}
        </CardContent>
      </Card>
      {running && comparison?.jobId ? (
        <div className="mb-5">
          <JobProgress
            jobId={comparison.jobId}
            label="Crawling and comparing sites"
            onFinished={() => void refresh()}
          />
        </div>
      ) : null}
      {comparison?.status === 'FAILED' ? (
        <Alert tone="danger" title="The last comparison failed" className="mb-5">
          {comparison.errorMessage ?? 'Unknown error.'}
        </Alert>
      ) : null}
      {!comparison ? (
        <EmptyState
          icon={Scale}
          title="See how far behind (or ahead) your site is"
          description="The comparison crawls your site and the competitors you choose, checks every page with the same audit rules, and lists what to fix first. It takes a few minutes."
        />
      ) : null}
      {result && comparison ? <Report comparison={comparison} result={result} /> : null}
    </>
  );
}

function Report({ comparison, result }: { comparison: SeoComparisonDto; result: SeoComparisonResult }) {
  const project = useProject();
  const you = result.sites.find((s) => s.isYou)!;
  const competitors = result.sites.filter((s) => !s.isYou);
  const bestCompetitor = competitors
    .filter((s) => s.score !== null)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0];
  return (
    <div className="grid gap-5">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          label="Behind competitors on"
          value={`${result.summary.behind} of ${result.summary.compared}`}
          sub="checks"
          tone={result.summary.behind > result.summary.ahead ? 'danger' : 'default'}
        />
        <MetricCard label="Ahead on" value={`${result.summary.ahead}`} sub="checks" tone="success" />
        <MetricCard
          label="Your site health"
          value={you.score === null ? '—' : `${you.score}/100`}
          sub={
            bestCompetitor ? `Best competitor: ${bestCompetitor.name} ${bestCompetitor.score}/100` : undefined
          }
        />
        <MetricCard
          label="Pages checked per site"
          value={`up to ${formatNumber(result.maxPagesPerSite)}`}
          sub={`Compared ${formatDateTime(comparison.finishedAt)}`}
        />
      </div>

      <Card>
        <CardContent className="pt-5">
          <ChartFrame
            title="Site health index"
            description="Same audit rules on the same number of pages per site. Surfaced’s index, not a Google score."
            table={{
              columns: ['Site', 'Site health', 'Pages checked'],
              rows: result.sites.map((s) => [s.name, s.score ?? '—', s.pagesAnalyzed]),
            }}
          >
            <HBars
              data={result.sites.map((s) => ({
                key: s.key,
                label: s.isYou ? `${s.name} (you)` : s.name,
                value: s.score,
                note: s.status === 'OK' ? `${s.pagesAnalyzed} pages` : 'not checked',
              }))}
              formatValue={(v) => `${Math.round(v)}`}
              color={SERIES[0]}
              emphasisKey="you"
              max={100}
            />
          </ChartFrame>
        </CardContent>
      </Card>

      <Suggestions comparison={comparison} result={result} />

      <Card>
        <CardHeaderRow
          title="Side by side"
          description={`Your value against the competitors’ median. “Behind” means a clear gap, not a rounding difference.`}
        />
        <CardContent>
          <Table>
            <THead>
              <TR>
                <TH>Check</TH>
                {result.sites.map((s) => (
                  <TH key={s.key} className="text-right">
                    {s.isYou ? `${s.name} (you)` : s.name}
                  </TH>
                ))}
                <TH>You are</TH>
              </TR>
            </THead>
            <TBody>
              {SEO_METRIC_GROUPS.map((group) => (
                <Fragment key={group}>
                  <TR>
                    <TD
                      colSpan={result.sites.length + 2}
                      className="bg-muted/50 text-xs font-semibold tracking-wide uppercase"
                    >
                      {SEO_METRIC_GROUP_LABELS[group]}
                    </TD>
                  </TR>
                  {SEO_METRICS.filter((d) => d.group === group).map((def) => {
                    const row = result.metrics.find((m) => m.key === def.key);
                    if (!row) return null;
                    return (
                      <TR key={def.key}>
                        <TD title={def.help}>
                          <div className="font-medium">{def.label}</div>
                          <div className="text-xs text-muted-foreground">{def.help}</div>
                        </TD>
                        {result.sites.map((s) => (
                          <TD
                            key={s.key}
                            className={`text-right tabular-nums ${row.best?.siteKey === s.key ? 'font-semibold' : ''}`}
                          >
                            {formatValue(def, row.values[s.key])}
                          </TD>
                        ))}
                        <TD>
                          <Badge tone={STATUS[row.status].tone}>{STATUS[row.status].label}</Badge>
                        </TD>
                      </TR>
                    );
                  })}
                </Fragment>
              ))}
            </TBody>
          </Table>
          <p className="mt-2 text-xs text-muted-foreground">Bold marks the best value in each row.</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeaderRow title="Sites checked" description="What each crawl could read." />
        <CardContent>
          <ul className="grid gap-3 text-sm">
            {result.sites.map((s) => (
              <li key={s.key} className="rounded-lg border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{s.isYou ? `${s.name} (you)` : s.name}</span>
                  <span className="text-muted-foreground">{s.domain}</span>
                  {s.status === 'OK' ? (
                    <Badge tone="success">Checked</Badge>
                  ) : (
                    <Badge tone="warning">Not checked</Badge>
                  )}
                </div>
                <p className="mt-1 text-muted-foreground">
                  {s.status === 'OK'
                    ? `${formatNumber(s.pagesAnalyzed)} pages analyzed${s.limitReached ? ' (more pages exist)' : ''}${s.timeLimitReached ? ', stopped by the time limit' : ''}. Structured data: ${s.schemaTypes.join(', ') || 'none'}.`
                    : s.error}
                </p>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeaderRow title="What this comparison does not measure" />
        <CardContent>
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            {result.notCompared.map((n) => (
              <li key={n}>{n}</li>
            ))}
            {result.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
          <p className="mt-3 text-sm text-muted-foreground">
            Fixing these does not guarantee a higher ranking: search engines weigh many signals you cannot see
            here. Run the comparison again after changes to see how {project.name} moves.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function Suggestions({ comparison, result }: { comparison: SeoComparisonDto; result: SeoComparisonResult }) {
  const project = useProject();
  const navigate = useNavigate();
  const canSave = useCan('recommendation.update');
  const [saved, setSaved] = useState<Set<string>>(new Set());
  const [showAll, setShowAll] = useState(false);
  const save = useMutation({
    mutationFn: (s: SeoSuggestion) =>
      api.post<{ created: boolean }>(
        `/projects/${project.id}/seo-comparisons/${comparison.id}/recommendations`,
        {
          suggestionKey: s.key,
        },
      ),
    onSuccess: (r, s) => {
      setSaved((prev) => new Set(prev).add(s.key));
      toast.success(r.created ? 'Added to recommendations' : 'Recommendation updated', {
        action: { label: 'Open', onClick: () => void navigate(`/app/p/${project.id}/recommendations`) },
      });
    },
    onError: (e) => toast.error('Could not save the recommendation', { description: errorMessage(e) }),
  });
  const shown = showAll ? result.suggestions : result.suggestions.slice(0, 12);
  return (
    <Card>
      <CardHeaderRow
        title={`What to improve (${result.suggestions.length})`}
        description="Every problem found on your pages and every check where competitors are clearly ahead, most important first. Each item says what it is based on."
      />
      <CardContent>
        {result.suggestions.length === 0 ? (
          <p className="text-sm text-muted-foreground">No problems were found on the pages checked.</p>
        ) : (
          <ol className="grid gap-4">
            {shown.map((s) => (
              <li key={s.key} className="rounded-lg border p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <Badge tone={PRIORITY[s.priority].tone} className="mb-1">
                      {PRIORITY[s.priority].label}
                    </Badge>
                    <h3 className="font-medium break-words">{s.title}</h3>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {s.link ? (
                      <Button asChild size="sm" variant="outline">
                        <Link to={`/app/p/${project.id}/${s.link.path}`}>{s.link.label}</Link>
                      </Button>
                    ) : null}
                    {canSave ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={saved.has(s.key)}
                        loading={save.isPending && save.variables?.key === s.key}
                        onClick={() => save.mutate(s)}
                      >
                        <Plus /> {saved.has(s.key) ? 'Added' : 'Add to recommendations'}
                      </Button>
                    ) : null}
                  </div>
                </div>
                <p className="mt-2 text-sm break-words text-muted-foreground">
                  <span className="font-medium text-foreground">Why: </span>
                  {s.why}
                </p>
                <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm break-words">
                  {s.steps.map((step) => (
                    <li key={step}>{step}</li>
                  ))}
                </ol>
              </li>
            ))}
          </ol>
        )}
        {result.suggestions.length > 12 ? (
          <Button variant="outline" size="sm" className="mt-4" onClick={() => setShowAll((v) => !v)}>
            {showAll ? 'Show fewer' : `Show all ${result.suggestions.length}`}
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}
