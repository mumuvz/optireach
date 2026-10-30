import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { Link, useNavigate } from 'react-router';
import { toast } from 'sonner';
import {
  INDUSTRIES,
  competitorInputSchema,
  countryOptions,
  languageOptions,
  type CompetitorInput,
} from '@surfaced/shared';
import type { z } from 'zod';
import { useProject } from '@/app/project-scope';
import { usePlanLimits } from '@/app/queries';
import { PageHeader } from '@/components/app/page';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeaderRow } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/dialog';
import { Alert, LoadingBlock } from '@/components/ui/feedback';
import { Checkbox, Field, Input, Label, NativeSelect, Textarea } from '@/components/ui/form';
import { MultiSelect, TagInput } from '@/components/ui/multi-select';
import { api, ApiError, errorMessage } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { formatNumber, formatRelative } from '@/lib/format';

interface GeneralForm {
  name: string;
  /** Only editable (and sent) when the business has no website yet; adding one enables website features. */
  websiteUrl: string;
  description: string;
  industry: string;
  targetCountries: string[];
  targetLanguages: string[];
  brandVoice: string;
  brandAliases: string[];
  primaryKeywords: string[];
  auditSchedule: 'MANUAL' | 'WEEKLY' | 'MONTHLY';
  /** Crawl every reachable page (no project cap). */
  allPages: boolean;
  maxPages: number;
  /** Follow links at any click depth. */
  anyDepth: boolean;
  maxDepth: number;
  includeSubdomains: boolean;
  crawlDelayMs: number;
}

function CompetitorsCard() {
  const project = useProject();
  const queryClient = useQueryClient();
  const canManage = useCan('competitor.manage');
  const limits = usePlanLimits();
  const form = useForm<CompetitorInput, unknown, z.output<typeof competitorInputSchema>>({
    resolver: zodResolver(competitorInputSchema),
    defaultValues: { name: '', domain: '', aliases: [] },
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['project', project.id] });
  const add = useMutation({
    mutationFn: (v: z.output<typeof competitorInputSchema>) =>
      api.post(`/projects/${project.id}/competitors`, v),
    onSuccess: () => {
      toast.success('Competitor added');
      form.reset({ name: '', domain: '', aliases: [] });
      void refresh();
    },
    onError: (error) => {
      if (error instanceof ApiError && Object.keys(error.fieldErrors).length)
        for (const [k, m] of Object.entries(error.fieldErrors))
          form.setError(k as keyof CompetitorInput, { message: m });
      else toast.error(errorMessage(error));
    },
  });
  const remove = async (id: string) => {
    await api.delete(`/projects/${project.id}/competitors/${id}`);
    toast.success('Competitor removed');
    await refresh();
  };
  const atLimit = limits ? project.competitors.length >= limits.competitorsPerProject : false;
  return (
    <Card id="competitors" className="scroll-mt-20">
      <CardHeaderRow
        title="Competitors"
        description={
          limits
            ? `${project.competitors.length} of ${limits.competitorsPerProject} on your plan. Names and aliases are matched in AI answers; domains in citations.`
            : undefined
        }
      />
      <CardContent className="space-y-4">
        {project.competitors.length ? (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {project.competitors.map((c) => (
              <li key={c.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
                <span className="min-w-0">
                  <span className="block text-sm font-medium">{c.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {c.domain}
                    {c.aliases.length ? ` · also: ${c.aliases.join(', ')}` : ''}
                  </span>
                </span>
                {canManage ? (
                  <ConfirmDialog
                    title={`Remove ${c.name}?`}
                    description="Past observations keep their stored answers, but this competitor is no longer tracked or compared."
                    confirmLabel="Remove"
                    destructive
                    onConfirm={() => remove(c.id).catch((e: unknown) => toast.error(errorMessage(e)))}
                    trigger={
                      <Button variant="ghost" size="icon-sm" aria-label={`Remove ${c.name}`}>
                        <Trash2 />
                      </Button>
                    }
                  />
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No competitors yet.</p>
        )}
        {canManage ? (
          <form
            onSubmit={form.handleSubmit((v) => add.mutate(v))}
            className="grid gap-3 rounded-lg border border-dashed border-border p-3"
            noValidate
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Name" error={form.formState.errors.name?.message}>
                <Input {...form.register('name')} />
              </Field>
              <Field label="Domain" error={form.formState.errors.domain?.message}>
                <Input placeholder="competitor.com" {...form.register('domain')} />
              </Field>
            </div>
            <Field
              label="Other names"
              optional
              description="Abbreviations or product names people use. Press Enter after each."
            >
              <Controller
                control={form.control}
                name="aliases"
                render={({ field }) => (
                  <TagInput value={field.value ?? []} onChange={field.onChange} max={10} maxLength={120} />
                )}
              />
            </Field>
            <div>
              <Button type="submit" size="sm" loading={add.isPending} disabled={atLimit}>
                <Plus /> Add competitor
              </Button>
              {atLimit ? (
                <span className="ml-3 text-xs text-muted-foreground">
                  Plan limit reached.{' '}
                  <Link to="/app/billing" className="font-medium text-primary hover:underline">
                    Upgrade
                  </Link>
                </span>
              ) : null}
            </div>
          </form>
        ) : null}
      </CardContent>
    </Card>
  );
}

function HistoryCard() {
  const project = useProject();
  const history = useQuery({
    queryKey: ['project', project.id, 'history'],
    queryFn: () =>
      api.get<{ type: string; title: string; detail: string; at: string; link: string }[]>(
        `/projects/${project.id}/history`,
      ),
  });
  return (
    <Card>
      <CardHeaderRow
        title="Activity"
        description="Audits, visibility runs, reports, content and settings changes"
      />
      <CardContent>
        {history.isPending ? (
          <LoadingBlock />
        ) : history.data?.length ? (
          <ol className="space-y-2.5">
            {history.data.slice(0, 20).map((h, i) => (
              <li key={`${h.at}-${i}`} className="flex items-start justify-between gap-3 text-sm">
                <Link to={h.link} className="min-w-0 hover:text-primary">
                  <span className="block truncate">{h.title}</span>
                  {h.detail ? <span className="block text-xs text-muted-foreground">{h.detail}</span> : null}
                </Link>
                <span className="shrink-0 text-xs text-muted-foreground">{formatRelative(h.at)}</span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-sm text-muted-foreground">No activity yet.</p>
        )}
      </CardContent>
    </Card>
  );
}

export default function ProjectSettingsPage() {
  const project = useProject();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const canUpdate = useCan('project.update');
  const canDelete = useCan('project.delete');
  const limits = usePlanLimits();
  const [confirmName, setConfirmName] = useState('');
  const countries = useMemo(() => countryOptions().map((o) => ({ value: o.code, label: o.name })), []);
  const languages = useMemo(() => languageOptions().map((o) => ({ value: o.code, label: o.name })), []);
  const form = useForm<GeneralForm>({
    values: {
      name: project.name,
      websiteUrl: project.websiteUrl ?? '',
      description: project.description ?? '',
      industry: project.industry ?? '',
      targetCountries: project.targetCountries,
      targetLanguages: project.targetLanguages,
      brandVoice: project.brandVoice ?? '',
      brandAliases: project.brandAliases,
      primaryKeywords: project.primaryKeywords,
      auditSchedule: project.auditSchedule,
      allPages: project.crawlSettings.maxPages === null,
      maxPages: project.crawlSettings.maxPages ?? 1000,
      anyDepth: project.crawlSettings.maxDepth === null,
      maxDepth: project.crawlSettings.maxDepth ?? 10,
      includeSubdomains: project.crawlSettings.includeSubdomains,
      crawlDelayMs: project.crawlSettings.crawlDelayMs,
    },
  });
  const save = useMutation({
    mutationFn: (v: GeneralForm) =>
      api.patch(`/projects/${project.id}`, {
        name: v.name,
        // A website can be added, but not changed here (changing the audited site means a new project).
        ...(!project.websiteUrl && v.websiteUrl.trim() ? { websiteUrl: v.websiteUrl.trim() } : {}),
        description: v.description.trim() || null,
        industry: v.industry || null,
        targetCountries: v.targetCountries,
        targetLanguages: v.targetLanguages,
        brandVoice: v.brandVoice.trim() || null,
        brandAliases: v.brandAliases,
        primaryKeywords: v.primaryKeywords,
        auditSchedule: v.auditSchedule,
        crawlSettings: {
          maxPages: v.allPages ? null : Number(v.maxPages),
          maxDepth: v.anyDepth ? null : Number(v.maxDepth),
          includeSubdomains: v.includeSubdomains,
          crawlDelayMs: Number(v.crawlDelayMs),
        },
      }),
    onSuccess: () => {
      toast.success('Project settings saved');
      void queryClient.invalidateQueries({ queryKey: ['project', project.id] });
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
    onError: (error) => {
      if (error instanceof ApiError && Object.keys(error.fieldErrors).length) {
        for (const [k, m] of Object.entries(error.fieldErrors))
          form.setError(k.replace('crawlSettings.', '') as keyof GeneralForm, { message: m });
      } else toast.error(errorMessage(error));
    },
  });
  const e = form.formState.errors;
  const pageCap = limits?.pagesPerAudit;

  return (
    <>
      <PageHeader title="Project settings" description={project.domain} />
      {!canUpdate ? (
        <Alert tone="info" className="mb-5">
          Only owners and admins can change project settings.
        </Alert>
      ) : null}
      <div className="grid gap-5 xl:grid-cols-[1.4fr_1fr]">
        <form onSubmit={form.handleSubmit((v) => save.mutate(v))} className="space-y-5" noValidate>
          <fieldset disabled={!canUpdate} className="space-y-5">
            <Card>
              <CardHeaderRow title="Business profile" />
              <CardContent className="grid gap-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Business name" error={e.name?.message}>
                    <Input {...form.register('name', { required: 'Enter the business name' })} />
                  </Field>
                  <Field label="Industry" optional error={e.industry?.message}>
                    <NativeSelect {...form.register('industry')}>
                      <option value="">Not set</option>
                      {INDUSTRIES.map((i) => (
                        <option key={i.key} value={i.key}>
                          {i.label}
                        </option>
                      ))}
                    </NativeSelect>
                  </Field>
                </div>
                <div id="website" className="scroll-mt-20">
                  {project.websiteUrl ? (
                    <Field label="Website" description="To audit a different site, create a new project.">
                      <Input value={project.websiteUrl} readOnly disabled />
                    </Field>
                  ) : (
                    <Field
                      label="Website"
                      optional
                      error={e.websiteUrl?.message}
                      description="Add the business website to enable website audits, SEO comparison and competitor gap checks. Everything else works without one."
                    >
                      <Input
                        placeholder="example.com"
                        inputMode="url"
                        autoComplete="url"
                        {...form.register('websiteUrl')}
                      />
                    </Field>
                  )}
                </div>
                <Field label="Description" optional error={e.description?.message}>
                  <Textarea rows={3} {...form.register('description')} />
                </Field>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Target countries" error={e.targetCountries?.message}>
                    <Controller
                      control={form.control}
                      name="targetCountries"
                      render={({ field }) => (
                        <MultiSelect
                          options={countries}
                          value={field.value}
                          onChange={field.onChange}
                          max={25}
                        />
                      )}
                    />
                  </Field>
                  <Field label="Languages" error={e.targetLanguages?.message}>
                    <Controller
                      control={form.control}
                      name="targetLanguages"
                      render={({ field }) => (
                        <MultiSelect
                          options={languages}
                          value={field.value}
                          onChange={field.onChange}
                          max={10}
                        />
                      )}
                    />
                  </Field>
                </div>
                <Field
                  label="Other brand names"
                  optional
                  description="Aliases matched in AI answers, e.g. product names or abbreviations."
                >
                  <Controller
                    control={form.control}
                    name="brandAliases"
                    render={({ field }) => (
                      <TagInput value={field.value} onChange={field.onChange} max={10} maxLength={120} />
                    )}
                  />
                </Field>
                <Field label="Primary keywords" optional>
                  <Controller
                    control={form.control}
                    name="primaryKeywords"
                    render={({ field }) => (
                      <TagInput value={field.value} onChange={field.onChange} max={50} />
                    )}
                  />
                </Field>
                <Field label="Brand voice" optional error={e.brandVoice?.message}>
                  <Textarea rows={2} {...form.register('brandVoice')} />
                </Field>
              </CardContent>
            </Card>
            <Card>
              <CardHeaderRow
                title="Crawling and schedule"
                description={
                  pageCap
                    ? `Your plan crawls up to ${formatNumber(pageCap)} pages per audit; higher values are capped.`
                    : 'Audits crawl every page reachable through links and sitemaps, following robots.txt. Set a cap only to keep audits shorter.'
                }
              />
              <CardContent className="grid gap-4 sm:grid-cols-2">
                <div className="grid gap-2">
                  <Field label="Pages to crawl" error={e.maxPages?.message}>
                    <Input
                      type="number"
                      min={1}
                      max={pageCap ?? 10_000_000}
                      disabled={form.watch('allPages')}
                      aria-label="Maximum pages"
                      {...form.register('maxPages', { valueAsNumber: true })}
                    />
                  </Field>
                  <label className="flex items-center gap-2 text-sm">
                    <Controller
                      control={form.control}
                      name="allPages"
                      render={({ field }) => (
                        <Checkbox checked={field.value} onCheckedChange={(v) => field.onChange(v === true)} />
                      )}
                    />
                    Crawl every page
                  </label>
                </div>
                <div className="grid gap-2">
                  <Field
                    label="Link depth"
                    error={e.maxDepth?.message}
                    description="Clicks from the start page"
                  >
                    <Input
                      type="number"
                      min={0}
                      max={100}
                      disabled={form.watch('anyDepth')}
                      aria-label="Maximum link depth"
                      {...form.register('maxDepth', { valueAsNumber: true })}
                    />
                  </Field>
                  <label className="flex items-center gap-2 text-sm">
                    <Controller
                      control={form.control}
                      name="anyDepth"
                      render={({ field }) => (
                        <Checkbox checked={field.value} onCheckedChange={(v) => field.onChange(v === true)} />
                      )}
                    />
                    Any depth
                  </label>
                </div>
                <Field
                  label="Delay between requests (ms)"
                  error={e.crawlDelayMs?.message}
                  description="robots.txt Crawl-delay still applies"
                >
                  <Input
                    type="number"
                    min={0}
                    max={10000}
                    step={50}
                    {...form.register('crawlDelayMs', { valueAsNumber: true })}
                  />
                </Field>
                <Field
                  label="Audit schedule"
                  error={e.auditSchedule?.message}
                  description={
                    limits && !limits.scheduledAudits
                      ? 'Scheduled audits are available on paid plans.'
                      : undefined
                  }
                >
                  <NativeSelect {...form.register('auditSchedule')}>
                    <option value="MANUAL">Manual only</option>
                    <option value="WEEKLY" disabled={!limits?.scheduledAudits}>
                      Weekly
                    </option>
                    <option value="MONTHLY" disabled={!limits?.scheduledAudits}>
                      Monthly
                    </option>
                  </NativeSelect>
                </Field>
                <div className="flex items-center gap-2.5 sm:col-span-2">
                  <Controller
                    control={form.control}
                    name="includeSubdomains"
                    render={({ field }) => (
                      <Checkbox
                        id="subdomains"
                        checked={field.value}
                        onCheckedChange={(v) => field.onChange(v === true)}
                      />
                    )}
                  />
                  <Label htmlFor="subdomains" className="font-normal">
                    Include subdomains (e.g. blog.{project.domain})
                  </Label>
                </div>
              </CardContent>
            </Card>
          </fieldset>
          {canUpdate ? (
            <Button type="submit" loading={save.isPending} disabled={!form.formState.isDirty}>
              Save settings
            </Button>
          ) : null}
        </form>
        <div className="space-y-5">
          <CompetitorsCard />
          <HistoryCard />
          {canDelete ? (
            <Card className="border-red-200">
              <CardHeaderRow
                title="Delete project"
                description="Deletes all audits, prompts, observations, content, keywords and reports of this project. This cannot be undone."
              />
              <CardContent className="grid gap-3">
                <Field label={`Type ${project.name} to confirm`}>
                  <Input value={confirmName} onChange={(e) => setConfirmName(e.target.value)} />
                </Field>
                <ConfirmDialog
                  title={`Delete ${project.name}?`}
                  description="All data of this project is permanently deleted."
                  confirmLabel="Delete project"
                  destructive
                  onConfirm={async () => {
                    try {
                      await api.delete(`/projects/${project.id}`);
                      await queryClient.invalidateQueries({ queryKey: ['projects'] });
                      toast.success('Project deleted');
                      void navigate('/app/projects');
                    } catch (error) {
                      toast.error(errorMessage(error));
                    }
                  }}
                  trigger={
                    <Button variant="destructive" disabled={confirmName !== project.name}>
                      <Trash2 /> Delete project
                    </Button>
                  }
                />
              </CardContent>
            </Card>
          ) : null}
        </div>
      </div>
    </>
  );
}
