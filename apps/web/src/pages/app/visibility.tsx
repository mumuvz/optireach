import { zodResolver } from '@hookform/resolvers/zod';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ClipboardPaste, ListPlus, Pause, Play, Plus, Radar, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { Link, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import {
  PROMPT_FREQUENCIES,
  VISIBILITY_PROVIDERS,
  countryOptions,
  isFrequencyAllowed,
  languageOptions,
  observationProviderLabel,
  promptInputSchema,
  type PromptInput,
  type VisibilityProviderKey,
} from '@surfaced/shared';
import type { z } from 'zod';
import {
  DEFAULT_VISIBILITY_FILTER,
  filterQuery,
  useCitationDomains,
  usePrompts,
  useVisibilitySummary,
  useVisibilityTrend,
  type VisibilityFilterState,
} from '@/app/hooks';
import { useProject } from '@/app/project-scope';
import { usePlanLimits } from '@/app/queries';
import { ChartFrame, HBars, LineTrend, ShareBar } from '@/components/charts/charts';
import { DEEMPHASIS, SERIES, entityColor } from '@/components/charts/palette';
import { BulkPromptsDialog } from '@/components/app/bulk-prompts-dialog';
import { ExportPdfButton } from '@/components/app/export-pdf-button';
import { ManualObservationDialog } from '@/components/app/manual-observation-dialog';
import { JobProgress, MetricCard, PageHeader } from '@/components/app/page';
import { FilterRow, useProviderStatuses } from '@/components/app/visibility-filters';
import { Badge, EstimateBadge, StatusBadge, humanize } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeaderRow } from '@/components/ui/card';
import { ConfirmDialog, Dialog, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/dialog';
import { Alert, EmptyState, ErrorState, LoadingBlock } from '@/components/ui/feedback';
import { Checkbox, Field, Input, Label, NativeSelect, Switch, Textarea } from '@/components/ui/form';
import { MultiSelect } from '@/components/ui/multi-select';
import { Pagination, TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api, ApiError, errorMessage } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { formatDate, formatDateTime, formatNumber, formatPercent, formatRelative } from '@/lib/format';
import type { ObservationRow, PromptDto, VisibilityRunDto } from '@/lib/types';

function OverviewTab({ filter }: { filter: VisibilityFilterState }) {
  const project = useProject();
  const [bucket, setBucket] = useState<'day' | 'week' | 'month'>('week');
  const summary = useVisibilitySummary(project.id, filter);
  const trend = useVisibilityTrend(project.id, filter, bucket);
  const citations = useCitationDomains(project.id, filter);
  if (summary.isPending) return <LoadingBlock rows={8} />;
  if (summary.isError) return <ErrorState error={summary.error} onRetry={() => void summary.refetch()} />;
  const m = summary.data.metrics;
  const n = m.totals.successful;
  const stale = summary.isPlaceholderData;
  if (m.totals.observations === 0) {
    return (
      <EmptyState
        icon={Radar}
        title="No observations for these filters"
        description="Add prompts and run checks, or widen the date range. Every metric here is calculated from stored AI answers."
        action={
          <Button asChild size="sm">
            <Link to="?tab=prompts">Manage prompts</Link>
          </Button>
        }
      />
    );
  }
  const entities = [
    { id: 'brand', name: project.name },
    ...project.competitors.map((c) => ({ id: c.id, name: c.name })),
  ];
  const sovSegments = (() => {
    const all = [
      { key: 'brand', label: project.name, share: m.shareOfVoice.brand ?? 0, color: entityColor(0) },
      ...m.shareOfVoice.competitors.map((c) => ({
        key: c.id,
        label: c.name,
        share: c.share ?? 0,
        color: entityColor(
          Math.max(
            1,
            entities.findIndex((e) => e.id === c.id),
          ),
        ),
      })),
    ];
    if (all.length <= 6) return all;
    const head = all.slice(0, 5);
    const rest = all.slice(5).reduce((sum, s) => sum + s.share, 0);
    return [...head, { key: 'other', label: 'Other competitors', share: rest, color: DEEMPHASIS }];
  })();
  const trendRows = (trend.data?.points ?? []).map((p) => ({
    bucket: p.bucketStart,
    mentionRate: p.mentionRate,
    citationRate: p.citationRate,
    shareOfVoice: p.shareOfVoice,
    successful: p.successful,
    observations: p.observations,
  }));
  const trendSeries = [
    { key: 'mentionRate', label: 'Mention rate', color: SERIES[0] },
    { key: 'citationRate', label: 'Citation rate', color: SERIES[1] },
    { key: 'shareOfVoice', label: 'Share of voice', color: SERIES[2] },
  ];
  const domains = citations.data ?? [];
  return (
    <div className={stale ? 'opacity-60 transition-opacity' : undefined}>
      {summary.data.notes.length ? (
        <Alert tone="info" className="mb-5" title="About this data">
          <ul className="list-disc space-y-0.5 pl-4">
            {summary.data.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </Alert>
      ) : null}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MetricCard
          label="Mention rate"
          value={formatPercent(m.mentionRate)}
          sub={`${formatNumber(m.brandMentions)} of ${formatNumber(n)} successful answers`}
          help="Successful answers that mention your brand by name, alias or domain ÷ successful answers."
        />
        <MetricCard
          label="Citation rate"
          value={formatPercent(m.citationRate)}
          sub={`${formatNumber(m.brandCitations)} answers cite your domain`}
          help="Successful answers that cite at least one URL on your domain ÷ successful answers."
        />
        <MetricCard
          label="Share of voice"
          value={formatPercent(m.shareOfVoice.brand)}
          sub="Brand mentions ÷ brand + competitor mentions"
          help="Each answer counts once per brand. Depends on which competitors you track."
        />
        <MetricCard
          label="Observations"
          value={formatNumber(m.totals.observations)}
          sub={`${formatNumber(m.totals.failed)} failed calls (excluded from rates)`}
          tone={m.totals.failed ? 'warning' : undefined}
        />
      </div>

      <Card className="mt-5">
        <CardContent className="pt-5">
          <ChartFrame
            title="Visibility over time"
            description="Rates per period from successful answers; a gap means no successful answers in that period."
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
                'Mention rate',
                'Citation rate',
                'Share of voice',
                'Successful / total',
              ],
              rows: trendRows.map((r) => [
                formatDate(r.bucket),
                formatPercent(r.mentionRate),
                formatPercent(r.citationRate),
                formatPercent(r.shareOfVoice),
                `${r.successful} / ${r.observations}`,
              ]),
            }}
          >
            {trend.isPending ? (
              <LoadingBlock rows={5} />
            ) : trendRows.length < 2 ? (
              <p className="py-10 text-center text-sm text-muted-foreground">
                A trend needs observations in at least two periods.
              </p>
            ) : (
              <LineTrend
                data={trendRows}
                xKey="bucket"
                series={trendSeries}
                formatY={(v) => formatPercent(v)}
                domain={[0, 1]}
                formatX={(v) => formatDate(v, { month: 'short', day: 'numeric' })}
                footer={(row) => `${row.successful} successful of ${row.observations} answers`}
              />
            )}
          </ChartFrame>
        </CardContent>
      </Card>

      <div className="mt-5 grid gap-5 xl:grid-cols-2">
        <Card>
          <CardContent className="pt-5">
            <ChartFrame
              title="Mention rate by brand"
              description={`Same ${formatNumber(n)} successful answers for every brand`}
              table={{
                columns: ['Brand', 'Mention rate', 'Citation rate', 'Answers mentioning'],
                rows: [
                  [
                    project.name,
                    formatPercent(m.mentionRate),
                    formatPercent(m.citationRate),
                    m.brandMentions,
                  ],
                  ...m.competitors.map((c) => [
                    c.name,
                    formatPercent(c.mentionRate),
                    formatPercent(c.citationRate),
                    c.mentions,
                  ]),
                ],
              }}
            >
              <HBars
                data={[
                  { key: 'brand', label: project.name, value: m.mentionRate, note: 'mention rate' },
                  ...m.competitors.map((c) => ({
                    key: c.id,
                    label: c.name,
                    value: c.mentionRate,
                    note: 'mention rate',
                  })),
                ]}
                formatValue={(v) => formatPercent(v)}
                color={SERIES[0]}
                emphasisKey="brand"
                max={1}
              />
            </ChartFrame>
            {project.competitors.length === 0 ? (
              <p className="mt-2 text-xs text-muted-foreground">
                Add competitors in project settings to compare.
              </p>
            ) : null}
            <p className="mt-3 text-[13px] text-muted-foreground">
              Only tracked brands are shown here.{' '}
              <Link to={`/app/p/${project.id}/gaps`} className="font-medium text-primary hover:underline">
                See every brand AI recommends, why, and what to do
              </Link>
              .
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-5">
            <ChartFrame
              title="Share of voice"
              description="Mentions across tracked brands, each answer counted once per brand"
              legend={sovSegments.map((s) => ({
                label: s.label,
                color: s.color,
                kind: 'rect',
                value: formatPercent(s.share),
              }))}
              table={{
                columns: ['Brand', 'Share of voice'],
                rows: sovSegments.map((s) => [s.label, formatPercent(s.share)]),
              }}
            >
              {m.shareOfVoice.brand === null ? (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  No tracked brand was mentioned in these answers.
                </p>
              ) : (
                <ShareBar segments={sovSegments} label="Share of voice" />
              )}
            </ChartFrame>
          </CardContent>
        </Card>
      </div>

      <Card className="mt-5">
        <CardContent className="pt-5">
          <ChartFrame
            title="Most cited domains"
            description="Domains cited in successful answers. Your own domain is highlighted."
            table={{
              columns: ['Domain', 'Citations', 'Share', 'Sample URL'],
              rows: domains.map((d) => [
                d.domain,
                d.citations,
                formatPercent(d.share),
                d.sampleUrls[0]?.url ?? '—',
              ]),
            }}
          >
            {citations.isPending ? (
              <LoadingBlock rows={5} />
            ) : domains.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                No citations in these answers. Model-only providers usually return none.
              </p>
            ) : (
              <HBars
                data={domains.slice(0, 12).map((d) => ({
                  key: d.domain,
                  label: d.isOwnedDomain ? `${d.domain} (your site)` : d.domain,
                  value: d.citations,
                  note: d.isOwnedDomain
                    ? 'citations · your site'
                    : d.competitorId
                      ? 'citations · competitor'
                      : 'citations',
                }))}
                formatValue={(v) => formatNumber(v)}
                color={SERIES[0]}
                emphasisKey={domains.find((d) => d.isOwnedDomain)?.domain ?? '__none__'}
              />
            )}
          </ChartFrame>
        </CardContent>
      </Card>
    </div>
  );
}

type PromptFormIn = PromptInput;

function PromptDialog({
  open,
  onOpenChange,
  prompt,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  prompt?: PromptDto;
}) {
  const project = useProject();
  const providers = useProviderStatuses();
  const limits = usePlanLimits();
  const queryClient = useQueryClient();
  const countries = useMemo(() => countryOptions().map((o) => ({ value: o.code, label: o.name })), []);
  const languages = useMemo(() => languageOptions().map((o) => ({ value: o.code, label: o.name })), []);
  const configured = (providers.data?.providers ?? [])
    .filter((p) => p.configured)
    .map((p) => p.key as VisibilityProviderKey);
  const form = useForm<PromptFormIn, unknown, z.output<typeof promptInputSchema>>({
    resolver: zodResolver(promptInputSchema),
    values: prompt
      ? {
          text: prompt.text,
          intent: prompt.intent ?? '',
          country: prompt.country,
          city: prompt.city,
          language: prompt.language,
          targetBrand: prompt.targetBrand,
          competitorIds: prompt.competitorIds,
          providers: prompt.providers as VisibilityProviderKey[],
          frequency: prompt.frequency as PromptFormIn['frequency'],
          status: prompt.status as PromptFormIn['status'],
        }
      : {
          text: '',
          intent: '',
          country: project.targetCountries[0] ?? 'US',
          city: null,
          language: project.targetLanguages[0] ?? 'en',
          targetBrand: project.name,
          competitorIds: project.competitors.map((c) => c.id),
          providers: configured.length ? [configured.find((k) => k !== 'mock_demo') ?? configured[0]!] : [],
          frequency: 'WEEKLY',
          status: 'ACTIVE',
        },
  });
  const save = useMutation({
    mutationFn: (values: z.output<typeof promptInputSchema>) =>
      prompt
        ? api.patch<PromptDto>(`/prompts/${prompt.id}`, values)
        : api.post<PromptDto>(`/projects/${project.id}/prompts`, values),
    onSuccess: () => {
      toast.success(prompt ? 'Prompt updated' : 'Prompt added');
      void queryClient.invalidateQueries({ queryKey: ['prompts', project.id] });
      onOpenChange(false);
      form.reset();
    },
    onError: (error) => {
      if (error instanceof ApiError)
        for (const [k, msg] of Object.entries(error.fieldErrors))
          form.setError(k as keyof PromptFormIn, { message: msg });
    },
  });
  const errors = form.formState.errors;
  const generalError =
    save.isError && !(save.error instanceof ApiError && Object.keys(save.error.fieldErrors).length)
      ? errorMessage(save.error)
      : null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader
          title={prompt ? 'Edit prompt' : 'Track a prompt'}
          description="Write the question the way a customer would ask an AI assistant. Each run asks every selected provider once."
        />
        <form onSubmit={form.handleSubmit((v) => save.mutate(v))} className="grid gap-4" noValidate>
          <Field label="Prompt" error={errors.text?.message}>
            <Textarea
              rows={3}
              placeholder="What is the best lightweight tent for two people?"
              {...form.register('text')}
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Country" error={errors.country?.message}>
              <NativeSelect {...form.register('country')}>
                {countries.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field label="Language" error={errors.language?.message}>
              <NativeSelect {...form.register('language')}>
                {languages.map((l) => (
                  <option key={l.value} value={l.value}>
                    {l.label}
                  </option>
                ))}
              </NativeSelect>
            </Field>
          </div>
          <Field
            label="City"
            optional
            description="For local questions. OpenAI web search receives it as an approximate location, and Google AI Mode (licensed provider) uses the business location in that city; providers that cannot use it say so on each answer."
            error={errors.city?.message}
          >
            <Input
              placeholder="Surat"
              {...form.register('city', {
                setValueAs: (v: string | null) => (v && v.trim() ? v.trim() : null),
              })}
            />
          </Field>
          <fieldset className="grid gap-2">
            <legend className="mb-1 text-sm font-medium">Providers</legend>
            <Controller
              control={form.control}
              name="providers"
              render={({ field }) => (
                <div className="grid gap-2">
                  {(providers.data?.providers ?? []).map((p) => {
                    const key = p.key as VisibilityProviderKey;
                    const checked = field.value.includes(key);
                    return (
                      <label
                        key={p.key}
                        className={`flex items-start gap-3 rounded-lg border p-3 ${p.configured ? 'border-border' : 'border-dashed border-border opacity-70'}`}
                      >
                        <Checkbox
                          checked={checked}
                          disabled={!p.configured}
                          onCheckedChange={(v) =>
                            field.onChange(v ? [...field.value, key] : field.value.filter((x) => x !== key))
                          }
                          className="mt-0.5"
                        />
                        <span className="min-w-0 text-sm">
                          <span className="flex flex-wrap items-center gap-2 font-medium">
                            {p.label}
                            {p.status === 'demo' ? (
                              <Badge tone="demo">Demo data</Badge>
                            ) : !p.configured ? (
                              <Badge>Not configured</Badge>
                            ) : null}
                          </span>
                          <span className="block text-[13px] text-muted-foreground">
                            {p.configured ? VISIBILITY_PROVIDERS[key]?.description : p.detail}
                          </span>
                        </span>
                      </label>
                    );
                  })}
                </div>
              )}
            />
            {errors.providers ? (
              <p className="text-[13px] text-destructive">
                {errors.providers.message ?? errors.providers.root?.message}
              </p>
            ) : null}
          </fieldset>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Frequency"
              error={errors.frequency?.message}
              description={limits ? undefined : 'Checking your plan…'}
            >
              <NativeSelect {...form.register('frequency')}>
                {PROMPT_FREQUENCIES.map((f) => (
                  <option key={f} value={f} disabled={limits ? !isFrequencyAllowed(limits, f) : false}>
                    {f === 'MANUAL' ? 'Manual only' : humanize(f)}
                    {limits && !isFrequencyAllowed(limits, f) ? ' (upgrade)' : ''}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field
              label="Intent"
              optional
              error={errors.intent?.message}
              description="Your own label, e.g. comparison or purchase."
            >
              <Input {...form.register('intent')} />
            </Field>
          </div>
          {project.competitors.length ? (
            <Field label="Competitors to compare" error={errors.competitorIds?.message}>
              <Controller
                control={form.control}
                name="competitorIds"
                render={({ field }) => (
                  <MultiSelect
                    options={project.competitors.map((c) => ({ value: c.id, label: c.name }))}
                    value={field.value ?? []}
                    onChange={field.onChange}
                    placeholder="All competitors"
                  />
                )}
              />
            </Field>
          ) : null}
          <div className="flex items-center gap-2.5">
            <Controller
              control={form.control}
              name="status"
              render={({ field }) => (
                <Switch
                  id="prompt-active"
                  checked={field.value !== 'PAUSED'}
                  onCheckedChange={(v) => field.onChange(v ? 'ACTIVE' : 'PAUSED')}
                />
              )}
            />
            <Label htmlFor="prompt-active" className="font-normal">
              Active (included in runs and schedules)
            </Label>
          </div>
          {generalError ? <Alert tone="danger">{generalError}</Alert> : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={save.isPending}>
              {prompt ? 'Save prompt' : 'Add prompt'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function PromptsTab({ onRun }: { onRun: (jobId: string) => void }) {
  const project = useProject();
  const prompts = usePrompts(project.id, 1, 100);
  const canManage = useCan('prompt.manage');
  const canRun = useCan('visibility.run');
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<PromptDto | undefined>();
  const [open, setOpen] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const toggle = useMutation({
    mutationFn: (p: PromptDto) =>
      api.patch(`/prompts/${p.id}`, { status: p.status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE' }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['prompts', project.id] }),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const runOne = useMutation({
    mutationFn: (p: PromptDto) => api.post<{ jobId: string; plannedChecks: number }>(`/prompts/${p.id}/run`),
    onSuccess: (r) => {
      toast.success(`Running ${r.plannedChecks} check(s)`);
      onRun(r.jobId);
    },
    onError: (e) => toast.error('Could not start the check', { description: errorMessage(e) }),
  });
  const remove = async (p: PromptDto) => {
    await api.delete(`/prompts/${p.id}`);
    toast.success('Prompt deleted');
    await queryClient.invalidateQueries({ queryKey: ['prompts', project.id] });
    await queryClient.invalidateQueries({ queryKey: ['visibility', project.id] });
  };
  return (
    <Card>
      <CardHeaderRow
        title="Tracked prompts"
        description={prompts.data ? `${formatNumber(prompts.data.meta.total)} prompts` : undefined}
        actions={
          canManage ? (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => setBulkOpen(true)}>
                <ListPlus /> Add in bulk
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  setEditing(undefined);
                  setOpen(true);
                }}
              >
                <Plus /> Add prompt
              </Button>
            </div>
          ) : null
        }
      />
      {prompts.isPending ? (
        <CardContent>
          <LoadingBlock />
        </CardContent>
      ) : prompts.isError ? (
        <CardContent>
          <ErrorState error={prompts.error} onRetry={() => void prompts.refetch()} />
        </CardContent>
      ) : prompts.data.items.length === 0 ? (
        <CardContent>
          <EmptyState
            icon={Radar}
            title="No prompts yet"
            description="Add the questions your customers ask AI assistants, such as “best invoicing software for freelancers”."
          />
        </CardContent>
      ) : (
        <Table>
          <THead>
            <TR>
              <TH>Prompt</TH>
              <TH>Locale</TH>
              <TH>Providers</TH>
              <TH>Schedule</TH>
              <TH>Last run</TH>
              <TH className="sr-only">Actions</TH>
            </TR>
          </THead>
          <TBody>
            {prompts.data.items.map((p) => (
              <TR key={p.id}>
                <TD className="max-w-[24rem]">
                  <p className="font-medium">{p.text}</p>
                  {p.intent ? <p className="text-xs text-muted-foreground">{p.intent}</p> : null}
                </TD>
                <TD className="text-xs whitespace-nowrap">
                  {p.city ? `${p.city}, ` : ''}
                  {p.country} · {p.language}
                </TD>
                <TD>
                  <div className="flex flex-wrap gap-1">
                    {p.providers.map((k) => (
                      <Badge key={k} tone={k === 'mock_demo' ? 'demo' : 'neutral'}>
                        {observationProviderLabel(k)}
                      </Badge>
                    ))}
                  </div>
                </TD>
                <TD className="text-xs">
                  <StatusBadge status={p.status} />
                  <span className="mt-1 block text-muted-foreground">
                    {p.frequency === 'MANUAL'
                      ? 'Manual'
                      : `${humanize(p.frequency)}${p.nextRunAt ? ` · next ${formatRelative(p.nextRunAt)}` : ''}`}
                  </span>
                </TD>
                <TD className="text-xs text-muted-foreground">{formatRelative(p.lastRunAt)}</TD>
                <TD>
                  <div className="flex justify-end gap-1">
                    {canRun ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => runOne.mutate(p)}
                        disabled={runOne.isPending}
                        aria-label={`Run now: ${p.text}`}
                      >
                        <Play /> Run
                      </Button>
                    ) : null}
                    {canManage ? (
                      <>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={() => toggle.mutate(p)}
                          aria-label={p.status === 'ACTIVE' ? 'Pause prompt' : 'Resume prompt'}
                        >
                          {p.status === 'ACTIVE' ? <Pause /> : <Play />}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setEditing(p);
                            setOpen(true);
                          }}
                        >
                          Edit
                        </Button>
                        <ConfirmDialog
                          title="Delete this prompt?"
                          description="Its observations are deleted too, and metrics are recalculated without them."
                          confirmLabel="Delete prompt"
                          destructive
                          onConfirm={() => remove(p).catch((e: unknown) => toast.error(errorMessage(e)))}
                          trigger={
                            <Button variant="ghost" size="icon-sm" aria-label="Delete prompt">
                              <Trash2 />
                            </Button>
                          }
                        />
                      </>
                    ) : null}
                  </div>
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
      <PromptDialog open={open} onOpenChange={setOpen} prompt={editing} />
      <BulkPromptsDialog open={bulkOpen} onOpenChange={setBulkOpen} />
    </Card>
  );
}

function RunsTab() {
  const project = useProject();
  const [page, setPage] = useState(1);
  const runs = useQuery({
    queryKey: ['visibility', project.id, 'runs', page],
    queryFn: () =>
      api.page<VisibilityRunDto>(`/projects/${project.id}/ai-visibility/runs`, { page, pageSize: 20 }),
    placeholderData: keepPreviousData,
    refetchInterval: (q) =>
      q.state.data?.items.some((r) => r.status === 'QUEUED' || r.status === 'RUNNING') ? 3000 : false,
  });
  if (runs.isPending) return <LoadingBlock />;
  if (runs.isError) return <ErrorState error={runs.error} onRetry={() => void runs.refetch()} />;
  if (!runs.data.items.length)
    return (
      <EmptyState
        title="No runs yet"
        description="Runs appear here when prompts are checked, manually or on a schedule."
      />
    );
  return (
    <Card>
      <Table>
        <THead>
          <TR>
            <TH>Started</TH>
            <TH>Trigger</TH>
            <TH>Status</TH>
            <TH className="text-right">Prompts</TH>
            <TH className="text-right">Succeeded</TH>
            <TH className="text-right">Failed</TH>
          </TR>
        </THead>
        <TBody>
          {runs.data.items.map((r) => (
            <TR key={r.id}>
              <TD>
                {formatDateTime(r.createdAt)}
                {r.isDemo ? (
                  <Badge tone="demo" className="ml-2">
                    Demo
                  </Badge>
                ) : null}
              </TD>
              <TD className="text-muted-foreground">{humanize(r.trigger)}</TD>
              <TD>
                <StatusBadge status={r.status} />
                {r.errorMessage ? (
                  <p className="mt-1 max-w-xs text-xs text-destructive">{r.errorMessage}</p>
                ) : null}
              </TD>
              <TD className="text-right tabular-nums">{r.promptCount}</TD>
              <TD className="text-right tabular-nums">{r.successCount}</TD>
              <TD className="text-right tabular-nums">{r.failureCount}</TD>
            </TR>
          ))}
        </TBody>
      </Table>
      <Pagination meta={runs.data.meta} onPage={setPage} />
    </Card>
  );
}

function ObservationsTab({ filter }: { filter: VisibilityFilterState }) {
  const project = useProject();
  const canManage = useCan('prompt.manage');
  const prompts = usePrompts(project.id, 1, 100);
  const [recording, setRecording] = useState(false);
  const [page, setPage] = useState(1);
  const [mentioned, setMentioned] = useState('');
  const [status, setStatus] = useState('');
  const query = useQuery({
    queryKey: ['visibility', project.id, 'observations', filter, page, mentioned, status],
    queryFn: () =>
      api.page<ObservationRow>(`/projects/${project.id}/ai-visibility/observations`, {
        ...filterQuery(filter),
        page,
        pageSize: 25,
        mentioned: mentioned || undefined,
        status: status || undefined,
      }),
    placeholderData: keepPreviousData,
  });
  return (
    <Card>
      <div className="flex flex-wrap gap-2 p-4">
        <NativeSelect
          aria-label="Brand mentioned"
          value={mentioned}
          onChange={(e) => (setPage(1), setMentioned(e.target.value))}
          className="w-48"
        >
          <option value="">Mentioned or not</option>
          <option value="true">Brand mentioned</option>
          <option value="false">Brand not mentioned</option>
        </NativeSelect>
        <NativeSelect
          aria-label="Status"
          value={status}
          onChange={(e) => (setPage(1), setStatus(e.target.value))}
          className="w-40"
        >
          <option value="">All results</option>
          <option value="SUCCEEDED">Succeeded</option>
          <option value="FAILED">Failed</option>
        </NativeSelect>
        {canManage && prompts.data?.items.length ? (
          <Button size="sm" variant="outline" className="ml-auto" onClick={() => setRecording(true)}>
            <ClipboardPaste /> Record what an AI showed
          </Button>
        ) : null}
      </div>
      {recording && prompts.data ? (
        <ManualObservationDialog open={recording} onOpenChange={setRecording} prompts={prompts.data.items} />
      ) : null}
      {query.isPending ? (
        <LoadingBlock className="px-5 pb-5" />
      ) : query.isError ? (
        <ErrorState className="mx-5 mb-5" error={query.error} onRetry={() => void query.refetch()} />
      ) : query.data.items.length === 0 ? (
        <EmptyState className="mx-5 mb-5" title="No observations match" />
      ) : (
        <div className={query.isPlaceholderData ? 'opacity-60' : undefined}>
          <Table>
            <THead>
              <TR>
                <TH>Observed</TH>
                <TH>Prompt</TH>
                <TH>Provider</TH>
                <TH>Brand</TH>
                <TH className="text-right">Citations</TH>
                <TH>Sentiment</TH>
              </TR>
            </THead>
            <TBody>
              {query.data.items.map((o) => (
                <TR key={o.id}>
                  <TD className="text-xs whitespace-nowrap">
                    <Link
                      to={`/app/p/${project.id}/visibility/observations/${o.id}`}
                      className="font-medium hover:text-primary"
                    >
                      {formatDateTime(o.observedAt)}
                    </Link>
                  </TD>
                  <TD className="max-w-[20rem]">
                    <span className="line-clamp-2 text-[13px]">{o.promptText}</span>
                    <span className="text-xs text-muted-foreground">
                      {o.city ? `${o.city}, ` : ''}
                      {o.country} · {o.language}
                    </span>
                  </TD>
                  <TD className="text-xs">
                    {observationProviderLabel(o.provider)}
                    {o.isDemo ? (
                      <Badge tone="demo" className="ml-1.5">
                        Demo
                      </Badge>
                    ) : o.captureMethod === 'MANUAL' ? (
                      <Badge tone="info" className="ml-1.5">
                        Manual
                      </Badge>
                    ) : o.captureMethod === 'LICENSED_PROVIDER' ? (
                      <Badge className="ml-1.5">Licensed data</Badge>
                    ) : null}
                  </TD>
                  <TD className="text-xs">
                    {o.status === 'FAILED' ? (
                      <Badge tone="danger">Failed{o.errorCode ? ` · ${o.errorCode}` : ''}</Badge>
                    ) : o.brandMentioned ? (
                      <Badge tone="success">Mentioned{o.brandRank ? ` · #${o.brandRank}` : ''}</Badge>
                    ) : (
                      <Badge>Not mentioned</Badge>
                    )}
                    {o.brandCited ? (
                      <Badge tone="primary" className="ml-1">
                        Cited
                      </Badge>
                    ) : null}
                  </TD>
                  <TD className="text-right tabular-nums">{o.citationCount}</TD>
                  <TD className="text-xs">
                    {o.sentiment ? (
                      <span className="flex items-center gap-1.5">
                        {humanize(o.sentiment)}{' '}
                        {o.sentimentSource === 'AI_ESTIMATE' ? (
                          <EstimateBadge />
                        ) : o.sentimentSource === 'DEMO_FIXTURE' ? (
                          <Badge tone="demo">Demo</Badge>
                        ) : null}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
          <Pagination meta={query.data.meta} onPage={setPage} />
        </div>
      )}
    </Card>
  );
}

export default function VisibilityPage() {
  const project = useProject();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'overview';
  const [filter, setFilter] = useState<VisibilityFilterState>(DEFAULT_VISIBILITY_FILTER);
  const [jobId, setJobId] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const canRun = useCan('visibility.run');
  const providers = useProviderStatuses();
  const runAll = useMutation({
    mutationFn: () =>
      api.post<{ jobId: string; plannedChecks: number }>(`/projects/${project.id}/ai-visibility/runs`, {}),
    onSuccess: (r) => {
      toast.success(`Running ${r.plannedChecks} check(s)`);
      setJobId(r.jobId);
    },
    onError: (e) => toast.error('Could not start the run', { description: errorMessage(e) }),
  });
  const configured = providers.data?.providers.filter((p) => p.configured) ?? [];
  const onlyDemo = configured.length > 0 && configured.every((p) => p.status === 'demo');

  return (
    <>
      <PageHeader
        title="AI visibility"
        description="How AI assistants answer the prompts you track: whether they mention and cite your brand, and who they recommend instead."
        actions={
          <>
            <ExportPdfButton module="visibility" />
            {canRun ? (
              <Button onClick={() => runAll.mutate()} loading={runAll.isPending}>
                <Play /> Run active prompts
              </Button>
            ) : null}
          </>
        }
      />
      {providers.data && configured.length === 0 ? (
        <Alert tone="warning" className="mb-5" title="No AI provider is configured on this server">
          Set OPENAI_API_KEY (or PERPLEXITY_API_KEY) on the API and worker to run real checks. Until then,
          prompts can be added but not run.
        </Alert>
      ) : onlyDemo ? (
        <Alert tone="info" className="mb-5" title="Only the demo provider is available">
          Results from the demo provider are deterministic fixtures, labeled as demo data. Configure OpenAI or
          Perplexity for real answers.
        </Alert>
      ) : null}
      {jobId ? (
        <div className="mb-5">
          <JobProgress
            jobId={jobId}
            label="AI visibility run"
            onFinished={() => {
              void queryClient.invalidateQueries({ queryKey: ['visibility', project.id] });
              void queryClient.invalidateQueries({ queryKey: ['prompts', project.id] });
            }}
            onDismiss={() => setJobId(null)}
          />
        </div>
      ) : null}
      <Tabs
        value={tab}
        onValueChange={(v) => setParams(v === 'overview' ? {} : { tab: v }, { replace: true })}
      >
        <TabsList className="mb-4">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="prompts">Prompts</TabsTrigger>
          <TabsTrigger value="observations">Observations</TabsTrigger>
          <TabsTrigger value="runs">Runs</TabsTrigger>
        </TabsList>
        {tab === 'overview' || tab === 'observations' ? (
          <FilterRow
            value={filter}
            onChange={setFilter}
            countries={project.targetCountries}
            languages={project.targetLanguages}
          />
        ) : null}
        <TabsContent value="overview" className="mt-0">
          <OverviewTab filter={filter} />
        </TabsContent>
        <TabsContent value="prompts" className="mt-0">
          <PromptsTab onRun={setJobId} />
        </TabsContent>
        <TabsContent value="observations" className="mt-0">
          <ObservationsTab filter={filter} />
        </TabsContent>
        <TabsContent value="runs" className="mt-0">
          <RunsTab />
        </TabsContent>
      </Tabs>
    </>
  );
}
