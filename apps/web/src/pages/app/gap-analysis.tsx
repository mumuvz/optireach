import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, ListPlus, Lock, Plus, Radar, RefreshCw, Target } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { toast } from 'sonner';
import {
  GAP_ACTION_PRIORITY_LABELS,
  GAP_SOURCE_TYPE_LABELS,
  type GapAction,
  type GapAnalysisDto,
  type GapAnalysisResult,
  type GapBrand,
  type GapPageCheck,
  type GapSource,
} from '@surfaced/shared';
import { useProject } from '@/app/project-scope';
import { NeedsWebsite } from '@/components/app/needs-website';
import { ChartFrame, HBars } from '@/components/charts/charts';
import { SERIES } from '@/components/charts/palette';
import { BulkPromptsDialog } from '@/components/app/bulk-prompts-dialog';
import { JobProgress, MetricCard, PageHeader } from '@/components/app/page';
import { Badge, type BadgeTone } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeaderRow } from '@/components/ui/card';
import { Alert, EmptyState, ErrorState, LoadingBlock } from '@/components/ui/feedback';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { api, ApiError, errorMessage } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { formatDateTime, formatNumber, formatPercent } from '@/lib/format';

const PRIORITY_TONES: Record<GapAction['priority'], BadgeTone> = {
  1: 'danger',
  2: 'orange',
  3: 'warning',
  4: 'info',
};

const CHECK_LABELS: Record<GapPageCheck['status'], string> = {
  OK: 'Checked',
  HTTP_ERROR: 'Page returned an error',
  BLOCKED_BY_ROBOTS: 'robots.txt does not allow checks; open it yourself',
  UNSAFE_URL: 'Not a public web page',
  FETCH_FAILED: 'Could not be fetched',
  NOT_HTML: 'Not a web page (for example a PDF)',
};

function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname === '/' ? '' : u.pathname;
    return `${u.hostname.replace(/^www\./, '')}${path}`.slice(0, 80);
  } catch {
    return url.slice(0, 80);
  }
}

export default function GapAnalysisPage() {
  const project = useProject();
  const queryClient = useQueryClient();
  const canRun = useCan('competitor.snapshot');
  const canManagePrompts = useCan('prompt.manage');
  const [bulkOpen, setBulkOpen] = useState(false);
  const latest = useQuery({
    queryKey: ['gap-analysis', project.id],
    queryFn: () => api.get<GapAnalysisDto | null>(`/projects/${project.id}/gap-analyses/latest`),
    retry: false,
    refetchInterval: (query) =>
      query.state.data && ['QUEUED', 'RUNNING'].includes(query.state.data.status) ? 3000 : false,
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['gap-analysis', project.id] });
  const start = useMutation({
    mutationFn: () => api.post<{ jobId: string }>(`/projects/${project.id}/gap-analyses`),
    onSuccess: () => void refresh(),
    onError: (e) => toast.error('Could not start the analysis', { description: errorMessage(e) }),
  });

  const analysis = latest.data ?? null;
  const running = analysis ? ['QUEUED', 'RUNNING'].includes(analysis.status) : false;
  const gated = latest.error instanceof ApiError && latest.error.code === 'PLAN_LIMIT_REACHED';
  const noWebsite = !project.websiteUrl;
  const runButton =
    canRun && !noWebsite ? (
      <Button onClick={() => start.mutate()} loading={start.isPending} disabled={running || gated}>
        <RefreshCw /> {analysis?.result ? 'Run again' : 'Run analysis'}
      </Button>
    ) : null;
  const header = (
    <>
      <PageHeader
        title="Competitor gaps"
        description="Why AI answers recommend other brands, and what you can do about it. Built from your stored AI answers, your latest crawl and live checks of the pages AI cites."
        actions={
          <div className="flex flex-wrap gap-2">
            {canManagePrompts ? (
              <Button variant="outline" onClick={() => setBulkOpen(true)}>
                <ListPlus /> Add keywords in bulk
              </Button>
            ) : null}
            {runButton}
          </div>
        }
      />
      <BulkPromptsDialog open={bulkOpen} onOpenChange={setBulkOpen} />
    </>
  );

  if (latest.isLoading)
    return (
      <>
        {header}
        <LoadingBlock rows={6} />
      </>
    );
  if (noWebsite)
    return (
      <>
        {header}
        <NeedsWebsite
          feature="Competitor gaps"
          description="It reads your website and the pages AI answers cite, to show why AI recommends other brands and what to fix."
        />
      </>
    );
  if (gated)
    return (
      <>
        {header}
        <EmptyState
          icon={Lock}
          title="Competitor gaps are part of the Growth and Agency plans"
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

  const result = analysis?.status === 'SUCCEEDED' ? analysis.result : null;
  return (
    <>
      {header}
      {running && analysis?.jobId ? (
        <div className="mb-5">
          <JobProgress
            jobId={analysis.jobId}
            label="Analyzing AI answers"
            onFinished={() => void refresh()}
          />
        </div>
      ) : null}
      {analysis?.status === 'FAILED' ? (
        <Alert tone="danger" title="The last analysis failed" className="mb-5">
          {analysis.errorMessage ?? 'Unknown error.'} Run it again; if it keeps failing, check the job in the
          admin area.
        </Alert>
      ) : null}
      {!analysis ? (
        <EmptyState
          icon={Target}
          title="Find out why AI recommends other brands"
          description="The analysis reads your stored AI answers: which brands they recommend, the reasons they give and the websites they cite. It then checks your site and those pages, and turns the evidence into a prioritized plan. Run AI visibility checks with a real provider first."
          action={
            <div className="flex flex-wrap justify-center gap-2">
              {runButton}
              <Button asChild variant="outline">
                <Link to={`/app/p/${project.id}/visibility`}>
                  <Radar /> AI Visibility
                </Link>
              </Button>
            </div>
          }
        />
      ) : null}
      {result && analysis ? <Report analysis={analysis} result={result} /> : null}
    </>
  );
}

function Report({ analysis, result }: { analysis: GapAnalysisDto; result: GapAnalysisResult }) {
  const project = useProject();
  const others = result.brands.filter((b) => !b.isYou && b.answers > 0);
  const leader = others[0];
  return (
    <div className="grid gap-5">
      {analysis.newAnswersSince > 0 ? (
        <Alert tone="info" title="New AI answers since this analysis">
          {formatNumber(analysis.newAnswersSince)} answer{analysis.newAnswersSince === 1 ? '' : 's'} arrived
          after this analysis started. Run it again to include them.
        </Alert>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          label={`${project.name} named`}
          value={`${formatNumber(result.you.answers)} of ${formatNumber(result.answers)}`}
          sub={`${formatPercent(result.you.mentionRate)} of answers`}
          tone={result.you.answers === 0 ? 'danger' : 'default'}
        />
        <MetricCard
          label="Most-named brand"
          value={leader ? leader.name : '—'}
          sub={
            leader
              ? `${formatNumber(leader.answers)} answers · ${formatPercent(leader.mentionRate)}`
              : 'No brands named'
          }
        />
        <MetricCard
          label="Brands AI recommends"
          value={formatNumber(others.length)}
          sub={`${formatNumber(others.filter((b) => !b.tracked).length)} not tracked`}
        />
        <MetricCard
          label="Your site cited"
          value={formatNumber(result.you.citedAnswers)}
          sub="answers citing your pages"
        />
      </div>
      <p className="text-[13px] text-muted-foreground">
        {formatNumber(result.answers)} real AI answers from the last {result.window.days} days, analyzed{' '}
        {formatDateTime(analysis.finishedAt)}.{' '}
        {result.method.brandDetection === 'ai_extraction'
          ? `Brands and reasons were extracted by ${result.method.extractionModel ?? 'an AI model'} and every quote was checked word for word against the stored answer.`
          : 'Brands were found where an answer names a website it cites.'}{' '}
        {result.method.liveChecks ? 'robots.txt, your homepage and cited pages were checked live.' : ''}
        {result.demoAnswersExcluded
          ? ` ${formatNumber(result.demoAnswersExcluded)} demo answers were left out.`
          : ''}
      </p>
      {result.notes.length ? (
        <ul className="list-disc space-y-1 pl-5 text-[13px] text-muted-foreground">
          {result.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      ) : null}

      <ActionPlan analysis={analysis} result={result} />
      <WhoAiRecommends result={result} />
      <Reasons result={result} />
      <Questions result={result} />
      <Sources result={result} />
      <Readiness result={result} />
      <p className="text-[13px] text-muted-foreground">
        AI answers vary between runs, providers and users, and these checks sample them. Nothing here
        guarantees that an assistant will recommend {project.name}; follow-up checks show whether changes
        help.
      </p>
    </div>
  );
}

function ActionPlan({ analysis, result }: { analysis: GapAnalysisDto; result: GapAnalysisResult }) {
  const project = useProject();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const canSave = useCan('recommendation.update');
  const canManageCompetitors = useCan('competitor.manage');
  const canUpdateProject = useCan('project.update');
  const [done, setDone] = useState<Set<string>>(new Set());
  const markDone = (key: string) => setDone((prev) => new Set(prev).add(key));

  const save = useMutation({
    mutationFn: (action: GapAction) =>
      api.post<{ created: boolean }>(`/projects/${project.id}/gap-analyses/${analysis.id}/recommendations`, {
        actionKey: action.key,
      }),
    onSuccess: (r, action) => {
      markDone(`rec:${action.key}`);
      toast.success(r.created ? 'Added to recommendations' : 'Recommendation updated', {
        action: { label: 'Open', onClick: () => void navigate(`/app/p/${project.id}/recommendations`) },
      });
    },
    onError: (e) => toast.error('Could not save the recommendation', { description: errorMessage(e) }),
  });
  const track = useMutation({
    mutationFn: (brand: { name: string; domain: string }) =>
      api.post(`/projects/${project.id}/competitors`, { name: brand.name, domain: brand.domain }),
    onSuccess: (_r, brand) => {
      markDone(`track:${brand.name}`);
      toast.success(`${brand.name} is now tracked`, {
        description: 'Link it to your prompts and run AI checks again to include it in the charts.',
      });
      void queryClient.invalidateQueries({ queryKey: ['project', project.id] });
    },
    onError: (e) => toast.error('Could not add the competitor', { description: errorMessage(e) }),
  });
  const alias = useMutation({
    mutationFn: (brand: GapBrand) => {
      const spelling = brand.aliasSuggestion!;
      if (brand.isYou)
        return api.patch(`/projects/${project.id}`, { brandAliases: [...project.brandAliases, spelling] });
      const competitor = project.competitors.find((c) => c.id === brand.competitorId);
      return api.patch(`/projects/${project.id}/competitors/${brand.competitorId}`, {
        aliases: [...(competitor?.aliases ?? []), spelling],
      });
    },
    onSuccess: (_r, brand) => {
      markDone(`alias:${brand.key}`);
      toast.success(`Added “${brand.aliasSuggestion}” as an alias of ${brand.name}`);
      void queryClient.invalidateQueries({ queryKey: ['project', project.id] });
    },
    onError: (e) => toast.error('Could not add the alias', { description: errorMessage(e) }),
  });

  const trackedDomains = new Set(project.competitors.map((c) => c.domain));
  return (
    <Card>
      <CardHeaderRow
        title="Action plan"
        description="Each step says which evidence it comes from. Fix-first items block AI from reading your site; the rest are ordered by how much evidence supports them."
      />
      <CardContent>
        {result.actions.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No gaps were found in these answers. Keep tracking prompts and run this again after new AI checks.
          </p>
        ) : (
          <ol className="grid gap-4">
            {result.actions.map((action) => (
              <li key={action.key} className="rounded-lg border p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="mb-1 flex flex-wrap items-center gap-2">
                      <Badge tone={PRIORITY_TONES[action.priority]}>
                        {GAP_ACTION_PRIORITY_LABELS[action.priority]}
                      </Badge>
                    </div>
                    <h3 className="font-medium break-words">{action.title}</h3>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {action.link ? (
                      <Button asChild size="sm" variant="outline">
                        <Link to={`/app/p/${project.id}/${action.link.path}`}>{action.link.label}</Link>
                      </Button>
                    ) : null}
                    {canSave ? (
                      <Button
                        size="sm"
                        variant="outline"
                        loading={save.isPending && save.variables?.key === action.key}
                        disabled={done.has(`rec:${action.key}`)}
                        onClick={() => save.mutate(action)}
                      >
                        <Plus /> {done.has(`rec:${action.key}`) ? 'Added' : 'Add to recommendations'}
                      </Button>
                    ) : null}
                  </div>
                </div>
                <p className="mt-2 text-sm break-words text-muted-foreground">
                  <span className="font-medium text-foreground">Why: </span>
                  {action.why}
                </p>
                <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm">
                  {action.steps.map((step) => (
                    <li key={step}>{step}</li>
                  ))}
                </ol>
                {action.trackBrands?.length ? (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {action.trackBrands.map((b) => {
                      const tracked =
                        done.has(`track:${b.name}`) || (b.domain !== null && trackedDomains.has(b.domain));
                      return (
                        <Button
                          key={b.name}
                          size="sm"
                          variant="outline"
                          disabled={!canManageCompetitors || !b.domain || tracked}
                          title={
                            b.domain
                              ? undefined
                              : 'No website was cited for this brand; add it in project settings.'
                          }
                          loading={track.isPending && track.variables?.name === b.name}
                          onClick={() => b.domain && track.mutate({ name: b.name, domain: b.domain })}
                        >
                          {tracked
                            ? `${b.name} tracked`
                            : `Track ${b.name}${b.domain ? '' : ' (no website)'}`}
                        </Button>
                      );
                    })}
                  </div>
                ) : null}
                {action.key === 'aliases' ? (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {result.brands
                      .filter((b) => b.tracked && b.aliasSuggestion)
                      .map((b) => (
                        <Button
                          key={b.key}
                          size="sm"
                          variant="outline"
                          disabled={
                            done.has(`alias:${b.key}`) ||
                            (b.isYou ? !canUpdateProject : !canManageCompetitors)
                          }
                          loading={alias.isPending && alias.variables?.key === b.key}
                          onClick={() => alias.mutate(b)}
                        >
                          {done.has(`alias:${b.key}`)
                            ? `“${b.aliasSuggestion}” added`
                            : `Add “${b.aliasSuggestion}” to ${b.name}`}
                        </Button>
                      ))}
                  </div>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}

function WhoAiRecommends({ result }: { result: GapAnalysisResult }) {
  const shown = result.brands.filter((b) => b.isYou || b.answers > 0).slice(0, 15);
  return (
    <Card>
      <CardHeaderRow
        title="Who AI recommends"
        description={`Brands named in the ${formatNumber(result.answers)} answers, including brands you do not track. Quotes are copied from the answers.`}
      />
      <CardContent className="grid gap-5">
        <ChartFrame
          title="Answers naming each brand"
          description="Share of answers analyzed"
          table={{
            columns: ['Brand', 'Answers', 'Share', 'Own site cited in'],
            rows: shown.map((b) => [b.name, b.answers, formatPercent(b.mentionRate), b.citedAnswers]),
          }}
        >
          <HBars
            data={shown.map((b) => ({
              key: b.key,
              label: b.isYou ? `${b.name} (you)` : b.name,
              value: b.mentionRate,
              note: `${b.answers} answers`,
            }))}
            formatValue={(v) => formatPercent(v)}
            color={SERIES[0]}
            emphasisKey={result.you.key}
            max={1}
          />
        </ChartFrame>
        <Table>
          <THead>
            <TR>
              <TH>Brand</TH>
              <TH className="text-right">Named in</TH>
              <TH>Reasons the answers give</TH>
            </TR>
          </THead>
          <TBody>
            {shown.map((b) => (
              <TR key={b.key}>
                <TD className="align-top">
                  <div className="font-medium">{b.name}</div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {b.isYou ? (
                      <Badge tone="primary">You</Badge>
                    ) : b.tracked ? (
                      <Badge>Tracked</Badge>
                    ) : (
                      <Badge tone="warning">Not tracked</Badge>
                    )}
                    {b.domain ? <span className="text-xs text-muted-foreground">{b.domain}</span> : null}
                  </div>
                </TD>
                <TD className="text-right align-top tabular-nums">
                  {formatNumber(b.answers)}
                  <div className="text-xs text-muted-foreground">{formatPercent(b.mentionRate)}</div>
                </TD>
                <TD className="align-top">
                  {b.reasons.length ? (
                    <ul className="space-y-1 text-sm">
                      {b.reasons.slice(0, 4).map((r) => (
                        <li key={r.attribute}>
                          <span className="font-medium">{r.attribute}</span>
                          {r.quotes[0] ? (
                            <span className="text-muted-foreground"> — “{r.quotes[0].text}”</span>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  ) : b.quotes[0] ? (
                    <p className="text-sm text-muted-foreground">“{b.quotes[0].text}”</p>
                  ) : (
                    <span className="text-sm text-muted-foreground">
                      {b.isYou ? 'Not named in these answers.' : '—'}
                    </span>
                  )}
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function Reasons({ result }: { result: GapAnalysisResult }) {
  const project = useProject();
  if (!result.attributes.length) return null;
  return (
    <Card>
      <CardHeaderRow
        title="What other brands are recommended for"
        description={`Reasons the answers give for other brands, and whether the same words appear on ${project.domain} (homepage text and page titles or headings). A keyword check, not proof that you offer it.`}
      />
      <CardContent>
        <Table>
          <THead>
            <TR>
              <TH>Reason</TH>
              <TH className="text-right">Answers</TH>
              <TH>Brands</TH>
              <TH>On your site</TH>
            </TR>
          </THead>
          <TBody>
            {result.attributes.map((a) => (
              <TR key={a.attribute}>
                <TD className="align-top">
                  <div className="font-medium">{a.attribute}</div>
                  {a.example ? <div className="text-xs text-muted-foreground">“{a.example}”</div> : null}
                </TD>
                <TD className="text-right align-top tabular-nums">{formatNumber(a.answers)}</TD>
                <TD className="align-top text-sm">{a.brands.join(', ')}</TD>
                <TD className="align-top text-sm">
                  {a.onYourSite === true ? (
                    <a
                      href={a.matchedOn ?? undefined}
                      target="_blank"
                      rel="noreferrer"
                      className="text-primary hover:underline"
                    >
                      Mentioned
                    </a>
                  ) : a.onYourSite === false ? (
                    <Badge tone="warning">Not found</Badge>
                  ) : (
                    <span className="text-muted-foreground">Not checked</span>
                  )}
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function Questions({ result }: { result: GapAnalysisResult }) {
  return (
    <Card>
      <CardHeaderRow
        title="Questions you track"
        description="Who each question's answers named, and the page of your latest crawl whose address, title or main heading matches it best."
      />
      <CardContent>
        <Table>
          <THead>
            <TR>
              <TH>Question</TH>
              <TH className="text-right">You named</TH>
              <TH>Brands named</TH>
              <TH>Your page</TH>
            </TR>
          </THead>
          <TBody>
            {result.prompts.map((p) => (
              <TR key={p.promptId}>
                <TD className="max-w-xs align-top font-medium break-words">{p.prompt}</TD>
                <TD className="text-right align-top tabular-nums">
                  {formatNumber(p.youNamed)} of {formatNumber(p.answers)}
                </TD>
                <TD className="align-top text-sm">
                  {p.brandsNamed.length
                    ? p.brandsNamed
                        .slice(0, 6)
                        .map((b) => `${b.name} (${b.answers})`)
                        .join(', ')
                    : 'No brand named'}
                </TD>
                <TD className="align-top text-sm">
                  {p.yourPage ? (
                    <a
                      href={p.yourPage.url}
                      target="_blank"
                      rel="noreferrer"
                      className="break-all text-primary hover:underline"
                    >
                      {shortUrl(p.yourPage.url)}
                    </a>
                  ) : p.pageMatchAvailable ? (
                    <Badge tone="warning">No page targets this</Badge>
                  ) : (
                    <span className="text-muted-foreground">Run an audit to check</span>
                  )}
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function CheckResult({ check }: { check: GapPageCheck }) {
  if (check.status !== 'OK')
    return <span className="text-muted-foreground">{CHECK_LABELS[check.status]}</span>;
  return (
    <span>
      {check.brandsOnPage.length ? `Names ${check.brandsOnPage.join(', ')}` : 'Names none of these brands'}
      {' · '}
      {check.youOnPage ? (
        <span className="text-emerald-700 dark:text-emerald-300">
          you are on it{check.linksToYou ? ' (linked)' : ''}
        </span>
      ) : (
        <span className="text-amber-800 dark:text-amber-300">you are not on it</span>
      )}
    </span>
  );
}

function Sources({ result }: { result: GapAnalysisResult }) {
  const sources = result.sources.filter((s) => s.type !== 'FILE_HOST').slice(0, 25);
  if (!sources.length) return null;
  const typeTone = (s: GapSource): BadgeTone =>
    s.type === 'OWN_SITE'
      ? 'primary'
      : s.type === 'COMPARISON_ARTICLE' || s.type === 'REVIEW_DIRECTORY'
        ? 'info'
        : 'neutral';
  return (
    <Card>
      <CardHeaderRow
        title="Websites AI relies on"
        description="Domains cited in the answers, by type. Article, directory and discussion pages were opened live (robots.txt respected) to see which brands they name."
      />
      <CardContent>
        <Table>
          <THead>
            <TR>
              <TH>Website</TH>
              <TH className="text-right">Answers</TH>
              <TH>Brands in those answers</TH>
              <TH>Live check</TH>
            </TR>
          </THead>
          <TBody>
            {sources.map((s) => (
              <TR key={s.domain}>
                <TD className="align-top">
                  <div className="font-medium break-all">{s.domain}</div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    <Badge tone={typeTone(s)}>{GAP_SOURCE_TYPE_LABELS[s.type]}</Badge>
                    {s.brand && s.type !== 'OWN_SITE' ? (
                      <span className="text-xs text-muted-foreground">{s.brand}</span>
                    ) : null}
                  </div>
                  {s.comparisonPages.length ? (
                    <div className="mt-1 text-xs text-muted-foreground">Own comparison page cited</div>
                  ) : null}
                </TD>
                <TD className="text-right align-top tabular-nums">{formatNumber(s.answers)}</TD>
                <TD className="align-top text-sm">{s.brandsInAnswers.slice(0, 6).join(', ') || '—'}</TD>
                <TD className="align-top text-sm">
                  {s.checks.length ? (
                    <ul className="space-y-1">
                      {s.checks.map((c) => (
                        <li key={c.url}>
                          <a
                            href={c.url}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 break-all text-primary hover:underline"
                          >
                            {shortUrl(c.url)} <ExternalLink className="size-3 shrink-0" />
                          </a>
                          <div className="text-xs">
                            <CheckResult check={c} />
                          </div>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <a
                      href={s.urls[0]?.url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 break-all text-primary hover:underline"
                    >
                      {s.urls[0] ? shortUrl(s.urls[0].url) : s.domain}{' '}
                      <ExternalLink className="size-3 shrink-0" />
                    </a>
                  )}
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function Readiness({ result }: { result: GapAnalysisResult }) {
  const project = useProject();
  const { robots, homepage, audit } = result.readiness;
  return (
    <Card>
      <CardHeaderRow
        title="Can AI read your site?"
        description="Checked live when the analysis ran, plus your latest audit."
      />
      <CardContent className="grid gap-5 lg:grid-cols-3">
        <div>
          <h3 className="mb-2 text-sm font-medium">robots.txt for AI crawlers</h3>
          {robots.status === 'not_checked' ? (
            <p className="text-sm text-muted-foreground">Not checked.</p>
          ) : (
            <ul className="space-y-1.5 text-sm">
              {robots.agents.map((a) => (
                <li key={a.agent} className="flex items-start justify-between gap-2">
                  <span title={a.purpose}>{a.label}</span>
                  {a.allowed === true ? (
                    <Badge tone="success">Allowed</Badge>
                  ) : a.allowed === false ? (
                    <Badge tone={a.search ? 'danger' : 'warning'}>Blocked</Badge>
                  ) : (
                    <Badge>Unknown</Badge>
                  )}
                </li>
              ))}
            </ul>
          )}
          {robots.status === 'missing' ? (
            <p className="mt-2 text-xs text-muted-foreground">No robots.txt: every crawler is allowed.</p>
          ) : null}
          {robots.error ? <p className="mt-2 text-xs text-destructive">{robots.error}</p> : null}
        </div>
        <div>
          <h3 className="mb-2 text-sm font-medium">Homepage without JavaScript</h3>
          {homepage.status === 'OK' ? (
            <dl className="grid gap-1 text-sm">
              <div>
                <dt className="inline text-muted-foreground">Words: </dt>
                <dd className="inline tabular-nums">{formatNumber(homepage.wordCount)}</dd>
              </div>
              <div>
                <dt className="inline text-muted-foreground">Title: </dt>
                <dd className="inline break-words">{homepage.title ?? 'none'}</dd>
              </div>
              <div>
                <dt className="inline text-muted-foreground">Main heading: </dt>
                <dd className="inline break-words">{homepage.h1 ?? 'none'}</dd>
              </div>
              <div>
                <dt className="inline text-muted-foreground">Structured data: </dt>
                <dd className="inline">{homepage.schemaTypes.join(', ') || 'none'}</dd>
              </div>
            </dl>
          ) : (
            <p className="text-sm text-muted-foreground">
              {homepage.status === 'NOT_CHECKED' ? 'Not checked.' : (homepage.error ?? homepage.status)}
            </p>
          )}
        </div>
        <div>
          <h3 className="mb-2 text-sm font-medium">Latest audit</h3>
          {audit ? (
            <div className="text-sm">
              <p>
                Site health {audit.score ?? '—'}/100 · {formatNumber(audit.pagesAnalyzed)} pages ·{' '}
                {formatDateTime(audit.finishedAt)}
              </p>
              {audit.issues.length ? (
                <ul className="mt-2 list-disc space-y-1 pl-5 text-muted-foreground">
                  {audit.issues.map((i) => (
                    <li key={i.ruleId}>
                      {i.title}: {formatNumber(i.count)}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-2 text-muted-foreground">No open issues that affect AI readability.</p>
              )}
              <Button asChild size="sm" variant="outline" className="mt-3">
                <Link to={`/app/p/${project.id}/issues`}>Open issues</Link>
              </Button>
            </div>
          ) : (
            <Button asChild size="sm" variant="outline">
              <Link to={`/app/p/${project.id}/audits`}>Run an audit</Link>
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
