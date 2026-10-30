import { useMutation, useQuery } from '@tanstack/react-query';
import { CalendarPlus, Copy, Download, ExternalLink, ListPlus, Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { toast } from 'sonner';
import {
  KEYWORD_PRIORITIES,
  TREND_DATA_TYPE_LABELS,
  type KeywordPriority,
  type TrendDirection,
  type TrendExportPart,
  type TrendPlacement,
  type TrendReportDto,
  type TrendTerm,
  type TrendTermStatus,
  trendDirection,
} from '@surfaced/shared';
import { useProject } from '@/app/project-scope';
import { ChartFrame, HBars, LineTrend, ShareBar } from '@/components/charts/charts';
import { SERIES, entityColor } from '@/components/charts/palette';
import { Badge, type BadgeTone } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeaderRow } from '@/components/ui/card';
import { Dialog, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/dialog';
import { Alert } from '@/components/ui/feedback';
import { Checkbox, Field, Input, NativeSelect } from '@/components/ui/form';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/menu';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api, errorMessage } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { formatDate, formatDateTime, formatNumber, formatPercent, formatRelative } from '@/lib/format';

const STATUS: Record<TrendTermStatus, { tone: BadgeTone; label: string }> = {
  present: { tone: 'success', label: 'Targeted' },
  partial: { tone: 'warning', label: 'Not targeted' },
  missing: { tone: 'danger', label: 'Missing' },
};

const DIRECTION: Record<TrendDirection, { tone: BadgeTone; label: string }> = {
  rising: { tone: 'success', label: 'Rising' },
  stable: { tone: 'neutral', label: 'Steady' },
  falling: { tone: 'warning', label: 'Falling' },
  no_data: { tone: 'neutral', label: 'No data' },
};

const ORIGIN: Record<string, string> = {
  keyword: 'Your term',
  top_query: 'Top related search',
  rising_query: 'Rising related search',
};

const FIELD_LABELS: Record<string, string> = {
  title: 'title',
  h1: 'main heading',
  address: 'address',
  heading: 'sub-heading',
  description: 'description',
};

const EXPORTS: { part: TrendExportPart; label: string }[] = [
  { part: 'interest', label: 'Interest over time' },
  { part: 'regions', label: 'Interest by region' },
  { part: 'related', label: 'Related queries and topics' },
  { part: 'terms', label: 'Your site and these searches' },
];

function ReportMeta({ report }: { report: TrendReportDto }) {
  const project = useProject();
  const sourceTone: BadgeTone =
    report.sourceType === 'FIXTURE' ? 'demo' : report.experimental ? 'warning' : 'neutral';
  return (
    <div className="flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground">
      <Badge tone={sourceTone}>{report.sourceLabel}</Badge>
      {report.freshness === 'stale' ? <Badge tone="warning">Older than the cache period</Badge> : null}
      {report.city ? <Badge tone="info">Searches mentioning {report.city}</Badge> : null}
      {report.cached ? <Badge tone="info">Reused recent data</Badge> : null}
      {report.trigger === 'SCHEDULED' ? <Badge tone="neutral">Scheduled refresh</Badge> : null}
      <span>
        {report.sourceType === 'CSV' ? 'Imported' : 'Retrieved'}{' '}
        {formatDateTime(report.fetchedAt ?? report.createdAt)}
        {report.fetchedAt ? ` (${formatRelative(report.fetchedAt)})` : ''}
      </span>
      <span aria-hidden>·</span>
      <a
        href={report.exploreUrl}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-1 text-primary hover:underline"
      >
        Check on Google Trends <ExternalLink className="size-3.5" />
      </a>
      <div className="ml-auto">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="outline">
              <Download /> Export CSV
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            {EXPORTS.map((e) => (
              <DropdownMenuItem
                key={e.part}
                onSelect={() =>
                  void api
                    .download(
                      `/projects/${project.id}/trends/reports/${report.id}/export`,
                      { part: e.part },
                      `trends-${e.part}.csv`,
                    ) // prettier-ignore
                    .catch((err) => toast.error('Could not export', { description: errorMessage(err) }))
                }
              >
                {e.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

function InterestCharts({ report }: { report: TrendReportDto }) {
  const interest = report.data?.interest;
  if (!interest) return null;
  const hourly = interest.dates.some((d) => d.includes('T'));
  const rows: Record<string, string | number | null>[] = interest.dates.map((date, i) => ({
    date,
    ...Object.fromEntries(interest.series.map((s, k) => [`s${k}`, s.values[i] ?? null])),
  }));
  const series = interest.series.map((s, k) => ({ key: `s${k}`, label: s.keyword, color: entityColor(k) }));
  const lastPartial = interest.partial?.at(-1);
  return (
    <Card>
      <CardContent className="grid gap-6 pt-5 lg:grid-cols-[2fr_1fr]">
        <ChartFrame
          title="Interest over time"
          description={`Relative interest: 100 is the peak of all terms in this period and place.${lastPartial ? ' The last period is still incomplete.' : ''}`}
          legend={series.map((s) => ({ label: s.label, color: s.color, kind: 'line' as const }))}
          table={{
            columns: ['Period', ...interest.series.map((s) => s.keyword)],
            rows: rows.map((r, i) => [
              `${String(r.date)}${interest.partial?.[i] ? ' (incomplete)' : ''}`,
              ...interest.series.map((_, k) => (r[`s${k}`] as number | null) ?? '—'),
            ]),
          }}
        >
          <LineTrend
            data={rows}
            xKey="date"
            series={series}
            formatY={(v) => `${Math.round(v)}`}
            domain={[0, 100]}
            formatX={(v) => (hourly ? formatDateTime(v) : formatDate(v, { month: 'short', day: 'numeric' }))}
          />
        </ChartFrame>
        <ChartFrame
          title="Average interest"
          description="Over the whole period, with the direction of each term"
          table={{
            columns: ['Term', 'Average', 'Direction'],
            rows: interest.series.map((s) => [s.keyword, s.average ?? '—', DIRECTION[trendDirection(s.values, interest.partial)].label]), // prettier-ignore
          }}
        >
          <HBars
            data={[...interest.series]
              .sort((a, b) => (b.average ?? 0) - (a.average ?? 0))
              .map((s) => ({ key: s.keyword, label: s.keyword, value: s.average }))}
            formatValue={(v) => `${Math.round(v)}`}
            color={SERIES[0]}
            max={100}
          />
          <ul className="mt-2 flex flex-wrap gap-2">
            {interest.series.map((s) => {
              const d = DIRECTION[trendDirection(s.values, interest.partial)];
              return (
                <li key={s.keyword}>
                  <Badge tone={d.tone}>
                    {s.keyword}: {d.label}
                  </Badge>
                </li>
              );
            })}
          </ul>
        </ChartFrame>
      </CardContent>
    </Card>
  );
}

function RegionalInterest({ report }: { report: TrendReportDto }) {
  const regions = report.data?.regions;
  if (!regions?.regions.length) return null;
  const share = regions.comparison === 'share';
  const top = [...regions.regions]
    .filter((r) => r.values.some((v) => (v ?? 0) > 0))
    .sort((a, b) => (share ? 0 : (b.values[0] ?? 0) - (a.values[0] ?? 0)))
    .slice(0, 15);
  const place =
    regions.resolution === 'COUNTRY' ? 'country' : regions.resolution === 'CITY' ? 'city' : 'region';
  return (
    <Card>
      <CardContent className="pt-5">
        <ChartFrame
          title={`Interest by ${place}`}
          description={
            share
              ? 'How each place’s searches split between your terms (they add up to 100%). Compare terms within a place, not places with each other.'
              : `100 is the ${place} where “${regions.keywords[0]}” is the largest share of all searches.`
          }
          legend={
            share
              ? regions.keywords.map((k, i) => ({ label: k, color: entityColor(i), kind: 'rect' as const }))
              : undefined
          }
          table={{
            columns: [place.charAt(0).toUpperCase() + place.slice(1), ...regions.keywords],
            rows: regions.regions.map((r) => [
              r.name,
              ...r.values.map((v) => (v === null ? '—' : share ? `${v}%` : v)),
            ]),
          }}
        >
          {share ? (
            <ul className="grid gap-2">
              {top.map((r) => (
                <li
                  key={r.geoCode ?? r.name}
                  className="grid grid-cols-[minmax(6rem,12rem)_1fr] items-center gap-3 text-sm"
                >
                  <span className="truncate">{r.name}</span>
                  <ShareBar
                    label={r.name}
                    segments={regions.keywords.map((k, i) => ({ key: k, label: k, share: (r.values[i] ?? 0) / 100, color: entityColor(i) }))} // prettier-ignore
                  />
                </li>
              ))}
            </ul>
          ) : (
            <HBars
              data={top.map((r) => ({ key: r.geoCode ?? r.name, label: r.name, value: r.values[0] ?? null }))}
              formatValue={(v) => `${Math.round(v)}`}
              color={SERIES[0]}
              max={100}
            />
          )}
        </ChartFrame>
      </CardContent>
    </Card>
  );
}

function ItemList({ title, items }: { title: string; items: [string, string][] }) {
  return (
    <div>
      <p className="mb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">{title}</p>
      {items.length ? (
        <ol className="space-y-1 text-sm">
          {items.map(([q, v]) => (
            <li key={q} className="flex justify-between gap-2">
              <span className="break-words">{q}</span>
              <span className="shrink-0 text-muted-foreground tabular-nums">{v}</span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="text-sm text-muted-foreground">None</p>
      )}
    </div>
  );
}

function RelatedSearches({ report }: { report: TrendReportDto }) {
  const related = report.data?.related ?? [];
  const topics = report.data?.topics ?? [];
  if (!related.length && !topics.length) return null;
  return (
    <Card>
      <CardHeaderRow
        title="What else people search"
        description="From Google Trends. Top: most searched (100 = most). Rising: fastest growing (Breakout = over 5,000%)."
      />
      <CardContent>
        <Tabs defaultValue={related.length ? 'queries' : 'topics'}>
          <TabsList>
            <TabsTrigger value="queries" disabled={!related.length}>
              {TREND_DATA_TYPE_LABELS.related_queries}
            </TabsTrigger>
            <TabsTrigger value="topics" disabled={!topics.length}>
              {TREND_DATA_TYPE_LABELS.related_topics}
            </TabsTrigger>
          </TabsList>
          <TabsContent value="queries" className="mt-4 grid gap-5 md:grid-cols-2">
            {related.map((group, g) => (
              <div key={`${group.keyword ?? 'all'}-${g}`} className="grid gap-3">
                <h3 className="text-sm font-semibold">{group.keyword ?? 'Your terms'}</h3>
                <div className="grid gap-3 sm:grid-cols-2">
                  <ItemList title="Top" items={group.top.slice(0, 10).map((q) => [q.query, `${q.value}`])} />
                  <ItemList title="Rising" items={group.rising.slice(0, 10).map((q) => [q.query, q.value])} />
                </div>
              </div>
            ))}
          </TabsContent>
          <TabsContent value="topics" className="mt-4 grid gap-5 md:grid-cols-2">
            {topics.map((group, g) => (
              <div key={`${group.keyword ?? 'all'}-${g}`} className="grid gap-3">
                <h3 className="text-sm font-semibold">{group.keyword ?? 'Your terms'}</h3>
                <div className="grid gap-3 sm:grid-cols-2">
                  <ItemList
                    title="Top"
                    items={group.top
                      .slice(0, 10)
                      .map((t) => [`${t.topic}${t.type ? ` (${t.type})` : ''}`, `${t.value}`])}
                  />
                  <ItemList
                    title="Rising"
                    items={group.rising
                      .slice(0, 10)
                      .map((t) => [`${t.topic}${t.type ? ` (${t.type})` : ''}`, t.value])}
                  />
                </div>
              </div>
            ))}
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}

function Placements({ report, placements }: { report: TrendReportDto; placements: TrendPlacement[] }) {
  const project = useProject();
  const canSave = useCan('recommendation.update');
  const [saved, setSaved] = useState<Set<string>>(new Set());
  const save = useMutation({
    mutationFn: (p: TrendPlacement) =>
      api.post<{ created: boolean }>(`/projects/${project.id}/trends/reports/${report.id}/recommendations`, { term: p.term }), // prettier-ignore
    onSuccess: (r, p) => {
      setSaved((prev) => new Set(prev).add(p.term));
      toast.success(r.created ? 'Added to recommendations' : 'Recommendation updated');
    },
    onError: (e) => toast.error('Could not save', { description: errorMessage(e) }),
  });
  if (!placements.length) return null;
  return (
    <Card>
      <CardHeaderRow
        title={`Where to add them (${placements.length})`}
        description="AI suggestions for searches your pages do not target yet. Every page and section named here exists on your site; the wording is a starting point: check every claim before publishing."
      />
      <CardContent>
        <ol className="grid gap-4">
          {placements.map((p) => (
            <li key={p.term} className="rounded-lg border p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <h3 className="font-medium">“{p.term}”</h3>
                  <p className="mt-1 text-sm break-words">
                    {p.action === 'add_to_page' && p.pageUrl ? (
                      <>
                        Add to{' '}
                        <a
                          href={p.pageUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="break-all text-primary hover:underline"
                        >
                          {p.pageTitle ?? p.pageUrl}
                        </a>
                        {p.section ? <> in the section “{p.section}”</> : null}
                        {p.newSection ? <> under a new heading “{p.newSection}”</> : null} as{' '}
                        {p.spot.replace('_', ' ')}.
                      </>
                    ) : (
                      <>
                        Create a new page{p.newSection ? <> titled “{p.newSection}”</> : null} (
                        {p.spot.replace('_', ' ')}).
                      </>
                    )}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      void navigator.clipboard
                        .writeText(p.suggestedText)
                        .then(() => toast.success('Copied'))
                        .catch(() => toast.error('Could not copy'))
                    }
                  >
                    <Copy /> Copy text
                  </Button>
                  {canSave ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={saved.has(p.term)}
                      loading={save.isPending && save.variables?.term === p.term}
                      onClick={() => save.mutate(p)}
                    >
                      <Plus /> {saved.has(p.term) ? 'Added' : 'Add to recommendations'}
                    </Button>
                  ) : null}
                </div>
              </div>
              <blockquote className="mt-3 border-l-2 pl-3 text-sm">{p.suggestedText}</blockquote>
              <p className="mt-2 text-[13px] text-muted-foreground">{p.reason}</p>
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}

function SaveKeywordsDialog({
  report,
  terms,
  open,
  onOpenChange,
  onSaved,
}: {
  report: TrendReportDto;
  terms: string[];
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSaved: () => void;
}) {
  const project = useProject();
  const groups = useQuery({
    queryKey: ['keyword-groups', project.id],
    queryFn: () =>
      api.get<{ lists: { id: string; name: string }[] }>(`/projects/${project.id}/keyword-groups`),
    enabled: open,
  });
  const [listId, setListId] = useState('');
  const [listName, setListName] = useState('');
  const [priority, setPriority] = useState<KeywordPriority>('MEDIUM');
  const save = useMutation({
    mutationFn: () =>
      api.post<{ created: number; skipped: number }>(
        `/projects/${project.id}/trends/reports/${report.id}/keywords`,
        {
          terms,
          priority,
          ...(listId === '__new'
            ? { listName: listName.trim() || 'Keyword trends' }
            : listId
              ? { listId }
              : {}),
        },
      ),
    onSuccess: (r) => {
      toast.success(`Saved ${r.created} keyword${r.created === 1 ? '' : 's'}${r.skipped ? ` (${r.skipped} already tracked)` : ''}`); // prettier-ignore
      onSaved();
      onOpenChange(false);
    },
    onError: (e) => toast.error('Could not save keywords', { description: errorMessage(e) }),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader
          title={`Save ${terms.length} term${terms.length === 1 ? '' : 's'} to keywords`}
          description="They are added as keyword ideas, with where and when the trend was seen in their notes."
        />
        <Field label="Keyword list" optional>
          <NativeSelect value={listId} onChange={(e) => setListId(e.target.value)}>
            <option value="">No list</option>
            {(groups.data?.lists ?? []).map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
            <option value="__new">New list…</option>
          </NativeSelect>
        </Field>
        {listId === '__new' ? (
          <Field label="New list name">
            <Input
              value={listName}
              onChange={(e) => setListName(e.target.value)}
              placeholder="Keyword trends"
            />
          </Field>
        ) : null}
        <Field label="Priority">
          <NativeSelect value={priority} onChange={(e) => setPriority(e.target.value as KeywordPriority)}>
            {KEYWORD_PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {p.charAt(0) + p.slice(1).toLowerCase()}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} loading={save.isPending}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PlanContentDialog({
  report,
  term,
  onOpenChange,
}: {
  report: TrendReportDto;
  term: TrendTerm | null;
  onOpenChange: (v: boolean) => void;
}) {
  const project = useProject();
  const navigate = useNavigate();
  const canTask = useCan('task.manage');
  const [dueDate, setDueDate] = useState('');
  const plan = useMutation({
    mutationFn: () =>
      api.post<{ briefId: string; taskId: string | null }>(
        `/projects/${project.id}/trends/reports/${report.id}/briefs`,
        {
          term: term!.term,
          dueDate: dueDate || undefined,
        },
      ),
    onSuccess: (r) => {
      toast.success(r.taskId ? 'Brief and task created' : 'Content brief created', {
        action: { label: 'Open content', onClick: () => void navigate(`/app/p/${project.id}/content`) },
      });
      onOpenChange(false);
      setDueDate('');
    },
    onError: (e) => toast.error('Could not plan content', { description: errorMessage(e) }),
  });
  return (
    <Dialog open={Boolean(term)} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader
          title={`Plan content for “${term?.term ?? ''}”`}
          description="Creates a content brief with the trend, your Search Console figures, related searches and any placement suggestion in its notes."
        />
        {canTask ? (
          <Field label="Due date" optional description="Adds a content task with this due date.">
            <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </Field>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => plan.mutate()} loading={plan.isPending}>
            Create brief
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TermsTable({ report }: { report: TrendReportDto }) {
  const analysis = report.analysis!;
  const canSaveKeywords = useCan('keyword.manage');
  const canPlan = useCan('content.edit');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [saveOpen, setSaveOpen] = useState(false);
  const [planning, setPlanning] = useState<TrendTerm | null>(null);
  const allSelected = selected.size > 0 && selected.size === analysis.terms.length;
  const gscConnected = analysis.method.searchConsole?.connected ?? false;
  const showGsc = analysis.terms.some((t) => t.searchConsole) || gscConnected;
  return (
    <Card>
      <CardHeaderRow
        title={`Your site and these searches (${analysis.terms.length})`}
        description={`Checked ${formatNumber(analysis.method.pagesChecked)} pages of your latest audit${analysis.method.crawlFinishedAt ? ` (${formatDate(analysis.method.crawlFinishedAt)})` : ''}. Targeted means a page has the phrase in its title, main heading or address.`}
        actions={
          canSaveKeywords ? (
            <Button size="sm" variant="outline" disabled={!selected.size} onClick={() => setSaveOpen(true)}>
              <ListPlus /> Save {selected.size || ''} to keywords
            </Button>
          ) : undefined
        }
      />
      <CardContent className="overflow-x-auto">
        <Table>
          <THead>
            <TR>
              {canSaveKeywords ? (
                <TH className="w-8">
                  <Checkbox
                    aria-label="Select all terms"
                    checked={allSelected}
                    onCheckedChange={(v) =>
                      setSelected(v ? new Set(analysis.terms.map((t) => t.term)) : new Set())
                    }
                  />
                </TH>
              ) : null}
              <TH>Search</TH>
              <TH className="text-right">Interest</TH>
              <TH>Trend</TH>
              {showGsc ? <TH className="text-right">Search Console</TH> : null}
              <TH>Your site</TH>
              <TH>Where it appears</TH>
              {canPlan ? <TH className="sr-only">Actions</TH> : null}
            </TR>
          </THead>
          <TBody>
            {analysis.terms.map((t) => (
              <TR key={t.term}>
                {canSaveKeywords ? (
                  <TD className="align-top">
                    <Checkbox
                      aria-label={`Select ${t.term}`}
                      checked={selected.has(t.term)}
                      onCheckedChange={(v) =>
                        setSelected((prev) => {
                          const next = new Set(prev);
                          if (v) next.add(t.term);
                          else next.delete(t.term);
                          return next;
                        })
                      }
                    />
                  </TD>
                ) : null}
                <TD className="align-top">
                  <div className="font-medium">{t.term}</div>
                  <div className="text-xs text-muted-foreground">{ORIGIN[t.origin]}</div>
                </TD>
                <TD className="text-right align-top tabular-nums">
                  {t.rising ?? (t.interest === null ? '—' : Math.round(t.interest))}
                </TD>
                <TD className="align-top">
                  {t.direction ? (
                    <Badge tone={DIRECTION[t.direction].tone}>{DIRECTION[t.direction].label}</Badge>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TD>
                {showGsc ? (
                  <TD className="text-right align-top text-sm tabular-nums">
                    {t.searchConsole ? (
                      <>
                        <div>{formatNumber(t.searchConsole.impressions)} impr.</div>
                        <div className="text-xs text-muted-foreground">
                          {formatNumber(t.searchConsole.clicks)} clicks · CTR{' '}
                          {formatPercent(t.searchConsole.ctr, 1)} · pos. {t.searchConsole.position}
                        </div>
                      </>
                    ) : (
                      <span className="text-muted-foreground">No impressions</span>
                    )}
                  </TD>
                ) : null}
                <TD className="align-top">
                  <Badge tone={STATUS[t.status].tone}>{STATUS[t.status].label}</Badge>
                </TD>
                <TD className="align-top text-sm">
                  {t.pages.length ? (
                    <ul className="space-y-1">
                      {t.pages.slice(0, 3).map((p) => (
                        <li key={p.url}>
                          <a
                            href={p.url}
                            target="_blank"
                            rel="noreferrer"
                            className="break-all text-primary hover:underline"
                          >
                            {p.url.replace(/^https?:\/\/(www\.)?/, '')}
                          </a>{' '}
                          <span className="text-xs text-muted-foreground">
                            ({p.fields.map((f) => FIELD_LABELS[f]).join(', ')})
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : t.missingWords.length ? (
                    <span className="text-muted-foreground">
                      Not on your pages: {t.missingWords.join(', ')}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">Words appear separately, never together</span>
                  )}
                </TD>
                {canPlan ? (
                  <TD className="align-top">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setPlanning(t)}
                      aria-label={`Plan content for ${t.term}`}
                    >
                      <CalendarPlus /> Plan
                    </Button>
                  </TD>
                ) : null}
              </TR>
            ))}
          </TBody>
        </Table>
        {showGsc ? (
          <p className="mt-3 text-xs text-muted-foreground">
            Search Console figures are your own measured impressions and clicks
            {analysis.method.searchConsole?.rangeStart
              ? ` (${analysis.method.searchConsole.rangeStart} to ${analysis.method.searchConsole.rangeEnd})`
              : ''}
            ; Google Trends interest is a relative index. They are shown side by side and never combined.
          </p>
        ) : null}
      </CardContent>
      <SaveKeywordsDialog
        report={report}
        terms={[...selected]}
        open={saveOpen}
        onOpenChange={setSaveOpen}
        onSaved={() => setSelected(new Set())}
      />
      <PlanContentDialog report={report} term={planning} onOpenChange={(v) => !v && setPlanning(null)} />
    </Card>
  );
}

export function TrendReportView({ report }: { report: TrendReportDto }) {
  const project = useProject();
  const analysis = report.analysis;
  const notes = useMemo(() => [...new Set(report.limitations)], [report.limitations]);
  return (
    <div className="grid gap-5">
      <ReportMeta report={report} />
      {report.partial ? (
        <Alert tone="warning" title="Some of the requested data could not be fetched">
          <ul className="list-disc space-y-1 pl-5">
            {notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </Alert>
      ) : (
        <details className="text-[13px] text-muted-foreground">
          <summary className="cursor-pointer">About this data</summary>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </details>
      )}
      <InterestCharts report={report} />
      <RegionalInterest report={report} />
      <RelatedSearches report={report} />
      {analysis ? (
        <>
          <Placements report={report} placements={analysis.placements} />
          <TermsTable report={report} />
          {analysis.notes.length ? (
            <ul className="list-disc space-y-1 pl-5 text-[13px] text-muted-foreground">
              {analysis.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          ) : null}
          {analysis.method.pagesChecked === 0 ? (
            <Button asChild variant="outline" className="justify-self-start">
              <Link to={`/app/p/${project.id}/audits`}>Run a website audit</Link>
            </Button>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
