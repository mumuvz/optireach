import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Lock, RefreshCw, Swords } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { DEFAULT_VISIBILITY_FILTER, filterQuery, type VisibilityFilterState } from '@/app/hooks';
import { useProject } from '@/app/project-scope';
import { ChartFrame, HBars, LineTrend } from '@/components/charts/charts';
import { SERIES, entityColor } from '@/components/charts/palette';
import { ExportPdfButton } from '@/components/app/export-pdf-button';
import { FilterRow } from '@/components/app/visibility-filters';
import { JobProgress, PageHeader } from '@/components/app/page';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeaderRow } from '@/components/ui/card';
import { EmptyState, ErrorState, LoadingBlock } from '@/components/ui/feedback';
import { NativeSelect } from '@/components/ui/form';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { api, ApiError, errorMessage } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { formatDate, formatNumber, formatPercent } from '@/lib/format';

interface EntityComparison {
  id: string | null;
  name: string;
  domain: string;
  isBrand: boolean;
  mentions: number;
  mentionRate: number | null;
  citedObservations: number;
  citationRate: number | null;
  shareOfVoice: number | null;
  averageRank: number | null;
}

interface ComparisonDto {
  entities: EntityComparison[];
  sources: { competitorId: string; name: string; shared: string[]; onlyWithCompetitor: string[] }[];
  totals: { observations: number; successful: number; failed: number };
  observationCount: number;
}

interface GapDto {
  promptId: string;
  prompt: string;
  observations: number;
  brandAbsentWhileCompetitorsPresent: number;
  gapRate: number;
  competitorsMentioned: { name: string; count: number }[];
  lastObservedAt: string;
  sampleObservationIds: string[];
}

interface MetadataProfile {
  name: string;
  domain: string;
  isBrand: boolean;
  source: 'crawl' | 'snapshot' | 'none';
  pages: number;
  fetchedAt: string | null;
  withMetaDescription: number | null;
  averageTitleLength: number | null;
  averageWordCount: number | null;
  withFaqContent: number | null;
  withQuestionHeadings: number | null;
  schemaTypes: string[];
}

const MAX_TREND_COMPETITORS = 3;

export default function CompetitorsPage() {
  const project = useProject();
  const queryClient = useQueryClient();
  const canSnapshot = useCan('competitor.snapshot');
  const [filter, setFilter] = useState<VisibilityFilterState>(DEFAULT_VISIBILITY_FILTER);
  const [bucket, setBucket] = useState<'day' | 'week' | 'month'>('week');
  const [jobs, setJobs] = useState<{ jobId: string; name: string }[]>([]);
  const key = [
    filter.provider,
    filter.country ?? '',
    filter.language ?? '',
    filter.days ?? 'all',
    filter.includeDemo,
  ];
  const comparison = useQuery({
    queryKey: ['competitors', project.id, 'comparison', ...key],
    queryFn: () =>
      api.get<ComparisonDto>(`/projects/${project.id}/competitors/comparison`, filterQuery(filter)),
    placeholderData: (prev) => prev,
    retry: false,
  });
  const gated = comparison.error instanceof ApiError && comparison.error.code === 'PLAN_LIMIT_REACHED';
  const enabled = !gated && project.competitors.length > 0;
  const gaps = useQuery({
    queryKey: ['competitors', project.id, 'gaps', ...key],
    queryFn: () => api.get<GapDto[]>(`/projects/${project.id}/competitors/topic-gaps`, filterQuery(filter)),
    enabled,
    placeholderData: (prev) => prev,
  });
  const trend = useQuery({
    queryKey: ['competitors', project.id, 'trend', bucket, ...key],
    queryFn: () =>
      api.get<{
        competitors: { id: string; name: string }[];
        points: {
          bucketStart: string;
          observations: number;
          brand: number | null;
          competitors: Record<string, number | null>;
        }[];
      }>(`/projects/${project.id}/competitors/trend`, { ...filterQuery(filter), bucket }),
    enabled,
    placeholderData: (prev) => prev,
  });
  const metadata = useQuery({
    queryKey: ['competitors', project.id, 'metadata'],
    queryFn: () => api.get<MetadataProfile[]>(`/projects/${project.id}/competitors/metadata`),
    enabled,
  });
  const snapshot = useMutation({
    mutationFn: (c: { id: string; name: string }) =>
      api
        .post<{ jobId: string }>(`/projects/${project.id}/competitors/${c.id}/snapshot`)
        .then((r) => ({ ...r, name: c.name })),
    onSuccess: (r) => setJobs((prev) => [...prev, { jobId: r.jobId, name: r.name }]),
    onError: (e) => toast.error('Could not start the snapshot', { description: errorMessage(e) }),
  });

  const header = (
    <PageHeader
      title="Competitors"
      description="Compare AI visibility with the competitors you track, find prompts where they appear and you do not, and see which sources each of you is cited from."
      actions={
        <>
          <ExportPdfButton module="competitors" />
          <Button asChild variant="outline">
            <Link to={`/app/p/${project.id}/settings#competitors`}>Manage competitors</Link>
          </Button>
        </>
      }
    />
  );

  if (gated) {
    return (
      <>
        {header}
        <EmptyState
          icon={Lock}
          title="Competitor analysis is part of the Growth and Agency plans"
          description={(comparison.error as ApiError).message}
          action={
            <Button asChild>
              <Link to="/app/billing">See plans</Link>
            </Button>
          }
        />
      </>
    );
  }
  if (project.competitors.length === 0) {
    return (
      <>
        {header}
        <EmptyState
          icon={Swords}
          title="No competitors yet"
          description="Add the brands you compete with. Their mentions are tracked in the same AI answers as yours."
          action={
            <Button asChild>
              <Link to={`/app/p/${project.id}/settings#competitors`}>Add competitors</Link>
            </Button>
          }
        />
      </>
    );
  }

  const entities = comparison.data?.entities ?? [];
  const n = comparison.data?.totals.successful ?? 0;
  const trendCompetitors = project.competitors.slice(0, MAX_TREND_COMPETITORS);
  const trendSeries = [
    { key: 'brand', label: project.name, color: entityColor(0) },
    ...trendCompetitors.map((c) => ({
      key: c.id,
      label: c.name,
      color: entityColor(project.competitors.findIndex((x) => x.id === c.id) + 1),
    })),
  ];
  const trendRows = (trend.data?.points ?? []).map((p) => ({
    bucket: p.bucketStart,
    brand: p.brand,
    observations: p.observations,
    ...Object.fromEntries(trendCompetitors.map((c) => [c.id, p.competitors[c.id] ?? null])),
  }));

  return (
    <>
      {header}
      <FilterRow
        value={filter}
        onChange={setFilter}
        countries={project.targetCountries}
        languages={project.targetLanguages}
      />
      {comparison.isPending ? (
        <LoadingBlock rows={8} />
      ) : comparison.isError ? (
        <ErrorState error={comparison.error} onRetry={() => void comparison.refetch()} />
      ) : n === 0 ? (
        <EmptyState
          title="No successful AI answers for these filters"
          description="Run your tracked prompts or widen the date range."
          action={
            <Button asChild size="sm">
              <Link to={`/app/p/${project.id}/visibility?tab=prompts`}>Tracked prompts</Link>
            </Button>
          }
        />
      ) : (
        <div className={comparison.isPlaceholderData ? 'space-y-5 opacity-60' : 'space-y-5'}>
          <div className="grid gap-5 xl:grid-cols-2">
            <Card>
              <CardContent className="pt-5">
                <ChartFrame
                  title="Mention rate"
                  description={`Share of ${formatNumber(n)} successful answers that mention each brand`}
                  table={{
                    columns: ['Brand', 'Mention rate', 'Mentions'],
                    rows: entities.map((e) => [e.name, formatPercent(e.mentionRate), e.mentions]),
                  }}
                >
                  <HBars
                    data={entities.map((e) => ({
                      key: e.id ?? 'brand',
                      label: e.name,
                      value: e.mentionRate,
                      note: `${e.mentions} answers`,
                    }))}
                    formatValue={(v) => formatPercent(v)}
                    color={SERIES[0]}
                    emphasisKey="brand"
                    max={1}
                  />
                </ChartFrame>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-5">
                <ChartFrame
                  title="Citation rate"
                  description="Share of the same answers that cite each brand's domain"
                  table={{
                    columns: ['Brand', 'Citation rate', 'Answers citing'],
                    rows: entities.map((e) => [e.name, formatPercent(e.citationRate), e.citedObservations]),
                  }}
                >
                  <HBars
                    data={entities.map((e) => ({
                      key: e.id ?? 'brand',
                      label: e.name,
                      value: e.citationRate,
                      note: `${e.citedObservations} answers`,
                    }))}
                    formatValue={(v) => formatPercent(v)}
                    color={SERIES[0]}
                    emphasisKey="brand"
                    max={1}
                  />
                </ChartFrame>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeaderRow
              title="Side by side"
              description={`${formatNumber(n)} successful answers · ${formatNumber(comparison.data.totals.failed)} failed calls excluded`}
            />
            <Table>
              <THead>
                <TR>
                  <TH>Brand</TH>
                  <TH className="text-right">Mention rate</TH>
                  <TH className="text-right">Citation rate</TH>
                  <TH className="text-right">Share of voice</TH>
                  <TH className="text-right">Average position</TH>
                </TR>
              </THead>
              <TBody>
                {entities.map((e) => (
                  <TR key={e.id ?? 'brand'}>
                    <TD>
                      <span className="font-medium">{e.name}</span>{' '}
                      {e.isBrand ? <Badge tone="primary">You</Badge> : null}
                      <span className="block text-xs text-muted-foreground">{e.domain}</span>
                    </TD>
                    <TD className="text-right tabular-nums">{formatPercent(e.mentionRate)}</TD>
                    <TD className="text-right tabular-nums">{formatPercent(e.citationRate)}</TD>
                    <TD className="text-right tabular-nums">{formatPercent(e.shareOfVoice)}</TD>
                    <TD className="text-right tabular-nums">{e.averageRank ? `#${e.averageRank}` : '—'}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </Card>

          <Card>
            <CardContent className="pt-5">
              <ChartFrame
                title="Mention rate over time"
                description={
                  project.competitors.length > MAX_TREND_COMPETITORS
                    ? `Your brand and the first ${MAX_TREND_COMPETITORS} competitors; the table lists all.`
                    : 'Your brand and each competitor'
                }
                legend={trendSeries.map((s) => ({ label: s.label, color: s.color }))}
                actions={
                  <NativeSelect
                    aria-label="Group by"
                    value={bucket}
                    onChange={(e) => setBucket(e.target.value as typeof bucket)}
                    className="h-8 w-28 text-[13px]"
                  >
                    <option value="day">By day</option>
                    <option value="week">By week</option>
                    <option value="month">By month</option>
                  </NativeSelect>
                }
                table={{
                  columns: [
                    'Period starting',
                    project.name,
                    ...project.competitors.map((c) => c.name),
                    'Successful answers',
                  ],
                  rows: (trend.data?.points ?? []).map((p) => [
                    formatDate(p.bucketStart),
                    formatPercent(p.brand),
                    ...project.competitors.map((c) => formatPercent(p.competitors[c.id] ?? null)),
                    p.observations,
                  ]),
                }}
              >
                {trend.isPending ? (
                  <LoadingBlock rows={5} />
                ) : trendRows.length < 2 ? (
                  <p className="py-10 text-center text-sm text-muted-foreground">
                    A trend needs answers in at least two periods.
                  </p>
                ) : (
                  <LineTrend
                    data={trendRows}
                    xKey="bucket"
                    series={trendSeries}
                    formatY={(v) => formatPercent(v)}
                    domain={[0, 1]}
                    formatX={(v) => formatDate(v, { month: 'short', day: 'numeric' })}
                    footer={(row) => `${row.observations} successful answers`}
                  />
                )}
              </ChartFrame>
            </CardContent>
          </Card>

          <Card>
            <CardHeaderRow
              title="Topic gaps"
              description="Prompts where at least one competitor is mentioned and your brand is not"
            />
            {gaps.isPending ? (
              <CardContent>
                <LoadingBlock />
              </CardContent>
            ) : !gaps.data?.length ? (
              <CardContent>
                <p className="text-sm text-muted-foreground">
                  No gaps in these answers: whenever a competitor was mentioned, so were you.
                </p>
              </CardContent>
            ) : (
              <Table>
                <THead>
                  <TR>
                    <TH>Prompt</TH>
                    <TH className="text-right">Gap rate</TH>
                    <TH>Competitors mentioned instead</TH>
                    <TH>Examples</TH>
                  </TR>
                </THead>
                <TBody>
                  {gaps.data.slice(0, 25).map((g) => (
                    <TR key={g.promptId}>
                      <TD className="max-w-[24rem]">{g.prompt}</TD>
                      <TD className="text-right tabular-nums">
                        {formatPercent(g.gapRate)}
                        <span className="block text-xs text-muted-foreground">
                          {g.brandAbsentWhileCompetitorsPresent} of {g.observations}
                        </span>
                      </TD>
                      <TD className="text-xs">
                        {g.competitorsMentioned.map((c) => `${c.name} (${c.count})`).join(', ')}
                      </TD>
                      <TD className="text-xs">
                        {g.sampleObservationIds.slice(0, 3).map((id, i) => (
                          <Link
                            key={id}
                            to={`/app/p/${project.id}/visibility/observations/${id}`}
                            className="mr-2 font-medium text-primary hover:underline"
                          >
                            Answer {i + 1}
                          </Link>
                        ))}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </Card>

          <Card>
            <CardHeaderRow
              title="Sources cited with each competitor"
              description="Domains cited in answers that mention the competitor: shared with your answers, or only with theirs"
            />
            <CardContent className="space-y-5">
              {comparison.data.sources.map((s) => (
                <div key={s.competitorId}>
                  <p className="text-sm font-medium">{s.name}</p>
                  <div className="mt-2 grid gap-3 sm:grid-cols-2">
                    <div>
                      <p className="text-xs text-muted-foreground">
                        Only with {s.name} ({s.onlyWithCompetitor.length})
                      </p>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {s.onlyWithCompetitor.length ? (
                          s.onlyWithCompetitor.slice(0, 20).map((d) => (
                            <Badge key={d} tone="warning">
                              {d}
                            </Badge>
                          ))
                        ) : (
                          <span className="text-xs text-muted-foreground">None</span>
                        )}
                      </div>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">
                        Shared with your answers ({s.shared.length})
                      </p>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {s.shared.length ? (
                          s.shared.slice(0, 20).map((d) => <Badge key={d}>{d}</Badge>)
                        ) : (
                          <span className="text-xs text-muted-foreground">None</span>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      )}

      <Card className="mt-5">
        <CardHeaderRow
          title="Public page metadata"
          description="Your latest crawl compared with a small, robots.txt-respecting snapshot of each competitor's public pages"
        />
        {jobs.length ? (
          <div className="space-y-2 px-5 pb-3">
            {jobs.map((j) => (
              <JobProgress
                key={j.jobId}
                jobId={j.jobId}
                label={`Snapshot of ${j.name}`}
                onFinished={() =>
                  void queryClient.invalidateQueries({ queryKey: ['competitors', project.id, 'metadata'] })
                }
                onDismiss={() => setJobs((prev) => prev.filter((x) => x.jobId !== j.jobId))}
              />
            ))}
          </div>
        ) : null}
        {metadata.isPending ? (
          <CardContent>
            <LoadingBlock />
          </CardContent>
        ) : metadata.isError ? (
          <CardContent>
            <ErrorState error={metadata.error} onRetry={() => void metadata.refetch()} />
          </CardContent>
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Site</TH>
                <TH className="text-right">Pages</TH>
                <TH className="text-right">With meta description</TH>
                <TH className="text-right">Avg. title length</TH>
                <TH className="text-right">Avg. words</TH>
                <TH className="text-right">FAQ content</TH>
                <TH>Structured data</TH>
                <TH className="sr-only">Actions</TH>
              </TR>
            </THead>
            <TBody>
              {metadata.data.map((m) => {
                const competitor = project.competitors.find((c) => c.domain === m.domain);
                return (
                  <TR key={m.domain}>
                    <TD>
                      <span className="font-medium">{m.name}</span>{' '}
                      {m.isBrand ? <Badge tone="primary">You</Badge> : null}
                      <span className="block text-xs text-muted-foreground">
                        {m.source === 'none'
                          ? 'No data yet'
                          : `${m.source === 'crawl' ? 'Crawl' : 'Snapshot'} · ${formatDate(m.fetchedAt)}`}
                      </span>
                    </TD>
                    <TD className="text-right tabular-nums">{m.source === 'none' ? '—' : m.pages}</TD>
                    <TD className="text-right tabular-nums">{formatPercent(m.withMetaDescription)}</TD>
                    <TD className="text-right tabular-nums">{formatNumber(m.averageTitleLength)}</TD>
                    <TD className="text-right tabular-nums">{formatNumber(m.averageWordCount)}</TD>
                    <TD className="text-right tabular-nums">{formatPercent(m.withFaqContent)}</TD>
                    <TD className="max-w-[14rem] text-xs">
                      {m.schemaTypes.length ? m.schemaTypes.join(', ') : '—'}
                    </TD>
                    <TD className="text-right">
                      {!m.isBrand && competitor && canSnapshot ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => snapshot.mutate(competitor)}
                          disabled={snapshot.isPending}
                        >
                          <RefreshCw /> Fetch
                        </Button>
                      ) : null}
                    </TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
        )}
      </Card>
    </>
  );
}
