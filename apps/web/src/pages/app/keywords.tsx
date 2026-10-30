import { zodResolver } from '@hookform/resolvers/zod';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, FolderPlus, Lightbulb, Plus, Search, Trash2, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import {
  KEYWORD_PRIORITIES,
  KEYWORD_STATUSES,
  KEYWORD_STATUS_LABELS,
  SEARCH_INTENTS,
  SEARCH_INTENT_LABELS,
  countryName,
  keywordInputSchema,
  type JobDto,
  type KeywordInput,
  type KeywordStatus,
  type SearchIntent,
} from '@surfaced/shared';
import type { z } from 'zod';
import { useProject } from '@/app/project-scope';
import { ExportPdfButton } from '@/components/app/export-pdf-button';
import { JobProgress, PageHeader } from '@/components/app/page';
import { KeywordOpportunities } from '@/components/keywords/opportunities';
import { Badge, EstimateBadge, humanize } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeaderRow } from '@/components/ui/card';
import { ConfirmDialog, Dialog, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/dialog';
import { Alert, EmptyState, ErrorState, LoadingBlock } from '@/components/ui/feedback';
import { Checkbox, Field, Input, NativeSelect, Textarea } from '@/components/ui/form';
import { Pagination, TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api, ApiError, errorMessage } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { formatNumber } from '@/lib/format';
import type { LlmProviderStatusDto } from '@/lib/types';

interface KeywordDto {
  id: string;
  phrase: string;
  intent: SearchIntent | null;
  country: string;
  language: string;
  priority: string;
  status: KeywordStatus;
  isPrimary: boolean;
  relatedQuestions: string[];
  targetUrl: string | null;
  notes: string | null;
  source: string;
  list: { id: string; name: string } | null;
  cluster: { id: string; name: string } | null;
  metrics: {
    searchVolume: number | null;
    difficulty: number | null;
    cpc: string | null;
    currency: string | null;
    source: string;
    fetchedAt: string | null;
  } | null;
}

interface Group {
  id: string;
  name: string;
  description: string | null;
  keywordCount: number;
}

interface Suggestion {
  phrase: string;
  intent: SearchIntent;
  relatedQuestions: string[];
  rationale: string;
  alreadyTracked: boolean;
}

function useGroups(projectId: string) {
  return useQuery({
    queryKey: ['keywords', projectId, 'groups'],
    queryFn: () => api.get<{ lists: Group[]; clusters: Group[] }>(`/projects/${projectId}/keyword-groups`),
  });
}

function KeywordDialog({
  open,
  onOpenChange,
  keyword,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  keyword?: KeywordDto;
}) {
  const project = useProject();
  const groups = useGroups(project.id);
  const queryClient = useQueryClient();
  const form = useForm<KeywordInput, unknown, z.output<typeof keywordInputSchema>>({
    resolver: zodResolver(keywordInputSchema),
    values: keyword
      ? {
          phrase: keyword.phrase,
          intent: keyword.intent ?? undefined,
          country: keyword.country,
          language: keyword.language,
          priority: keyword.priority as KeywordInput['priority'],
          status: keyword.status,
          listId: keyword.list?.id,
          clusterId: keyword.cluster?.id,
          relatedQuestions: keyword.relatedQuestions,
          targetUrl: keyword.targetUrl ?? undefined,
          notes: keyword.notes ?? undefined,
          isPrimary: keyword.isPrimary,
        }
      : {
          phrase: '',
          country: project.targetCountries[0] ?? 'US',
          language: project.targetLanguages[0] ?? 'en',
          priority: 'MEDIUM',
          status: 'IDEA',
          relatedQuestions: [],
          isPrimary: false,
        },
  });
  const save = useMutation({
    mutationFn: (v: z.output<typeof keywordInputSchema>) =>
      keyword
        ? api.patch(`/keywords/${keyword.id}`, {
            ...v,
            listId: v.listId ?? null,
            clusterId: v.clusterId ?? null,
            intent: v.intent ?? null,
            targetUrl: v.targetUrl ?? null,
            notes: v.notes ?? null,
          })
        : api.post(`/projects/${project.id}/keywords`, v),
    onSuccess: () => {
      toast.success(keyword ? 'Keyword updated' : 'Keyword added');
      void queryClient.invalidateQueries({ queryKey: ['keywords', project.id] });
      onOpenChange(false);
    },
    onError: (error) => {
      if (error instanceof ApiError)
        for (const [k, m] of Object.entries(error.fieldErrors))
          form.setError(k as keyof KeywordInput, { message: m });
    },
  });
  const e = form.formState.errors;
  const general =
    save.isError && !(save.error instanceof ApiError && Object.keys(save.error.fieldErrors).length)
      ? errorMessage(save.error)
      : null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader title={keyword ? 'Edit keyword' : 'Add keyword'} />
        <form onSubmit={form.handleSubmit((v) => save.mutate(v))} className="grid gap-4" noValidate>
          <Field label="Keyword" error={e.phrase?.message}>
            <Input autoFocus {...form.register('phrase')} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Intent" optional>
              <NativeSelect {...form.register('intent', { setValueAs: (v: string) => v || undefined })}>
                <option value="">Not set</option>
                {SEARCH_INTENTS.map((i) => (
                  <option key={i} value={i}>
                    {SEARCH_INTENT_LABELS[i]}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field label="Priority">
              <NativeSelect {...form.register('priority')}>
                {KEYWORD_PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {humanize(p)}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field label="Status">
              <NativeSelect {...form.register('status')}>
                {KEYWORD_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {KEYWORD_STATUS_LABELS[s]}
                  </option>
                ))}
              </NativeSelect>
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="List" optional>
              <NativeSelect {...form.register('listId', { setValueAs: (v: string) => v || undefined })}>
                <option value="">No list</option>
                {groups.data?.lists.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field label="Topic cluster" optional>
              <NativeSelect {...form.register('clusterId', { setValueAs: (v: string) => v || undefined })}>
                <option value="">No cluster</option>
                {groups.data?.clusters.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </NativeSelect>
            </Field>
          </div>
          <Field label="Target URL" optional error={e.targetUrl?.message}>
            <Input
              type="url"
              placeholder="https://"
              {...form.register('targetUrl', { setValueAs: (v: string) => v || undefined })}
            />
          </Field>
          <Field label="Notes" optional error={e.notes?.message}>
            <Textarea rows={2} {...form.register('notes', { setValueAs: (v: string) => v || undefined })} />
          </Field>
          {general ? <Alert tone="danger">{general}</Alert> : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={save.isPending}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ImportDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const project = useProject();
  const queryClient = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [csv, setCsv] = useState('');
  const [fileName, setFileName] = useState('');
  const run = useMutation({
    mutationFn: () =>
      api.post<{
        totalRows: number;
        created: number;
        skipped: number;
        errors: { line: number; message: string }[];
      }>(`/projects/${project.id}/keywords/import`, {
        csv,
        defaultCountry: project.targetCountries[0] ?? 'US',
        defaultLanguage: project.targetLanguages[0] ?? 'en',
      }),
    onSuccess: (r) => {
      toast.success(`Imported ${r.created} keyword(s)`, {
        description: r.skipped ? `${r.skipped} duplicate(s) skipped.` : undefined,
      });
      void queryClient.invalidateQueries({ queryKey: ['keywords', project.id] });
    },
  });
  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        onOpenChange(v);
        if (!v) {
          setCsv('');
          setFileName('');
          run.reset();
        }
      }}
    >
      <DialogContent size="lg">
        <DialogHeader
          title="Import keywords from CSV"
          description="Columns: keyword (required), intent, priority, status, country, language, cluster, list, target_url, questions, notes. Search volume columns are ignored unless they come from a connected data provider."
        />
        <input
          ref={fileRef}
          type="file"
          accept=".csv,text/csv"
          className="sr-only"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            if (file.size > 1_000_000) {
              toast.error('The file is larger than 1 MB. Split it into smaller files.');
              return;
            }
            setFileName(file.name);
            setCsv(await file.text());
          }}
        />
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="outline" onClick={() => fileRef.current?.click()}>
            <Upload /> Choose CSV file
          </Button>
          <span className="text-sm text-muted-foreground">{fileName || 'No file selected'}</span>
        </div>
        <Textarea
          rows={6}
          value={csv}
          onChange={(e) => setCsv(e.target.value)}
          placeholder={'keyword,intent,priority\nbest crm for agencies,commercial,high'}
          aria-label="CSV content"
          className="font-mono text-xs"
        />
        {run.data ? (
          <Alert
            tone={run.data.errors.length ? 'warning' : 'success'}
            title={`${run.data.created} created · ${run.data.skipped} skipped of ${run.data.totalRows} rows`}
          >
            {run.data.errors.length ? (
              <ul className="mt-1 max-h-32 list-disc overflow-y-auto pl-4 text-xs">
                {run.data.errors.map((err) => (
                  <li key={`${err.line}-${err.message}`}>
                    Line {err.line}: {err.message}
                  </li>
                ))}
              </ul>
            ) : null}
          </Alert>
        ) : null}
        {run.isError ? <Alert tone="danger">{errorMessage(run.error)}</Alert> : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button onClick={() => run.mutate()} disabled={!csv.trim()} loading={run.isPending}>
            Import
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function IdeasDialog({
  open,
  onOpenChange,
  providers,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  providers: LlmProviderStatusDto[];
}) {
  const project = useProject();
  const queryClient = useQueryClient();
  const [seed, setSeed] = useState('');
  const [jobId, setJobId] = useState<string | null>(null);
  const [result, setResult] = useState<{
    suggestions: Suggestion[];
    label: string;
    isDevAdapter: boolean;
  } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Which provider to run on. Empty means the server default; a chosen one lets you run the same seed on each
  // provider and compare the ideas. Only configured providers are offered.
  const configured = providers.filter((p) => p.configured);
  const [provider, setProvider] = useState('');
  const effectiveProvider = provider || configured.find((p) => p.isDefault)?.key || configured[0]?.key || '';
  const start = useMutation({
    mutationFn: () =>
      api.post<{ jobId: string }>(`/projects/${project.id}/keywords/suggest`, {
        seed: seed.trim() || undefined,
        country: project.targetCountries[0] ?? 'US',
        language: project.targetLanguages[0] ?? 'en',
        count: 20,
        provider: effectiveProvider || undefined,
      }),
    onSuccess: (r) => {
      setResult(null);
      setSelected(new Set());
      setJobId(r.jobId);
    },
  });
  const add = useMutation({
    mutationFn: () =>
      api.post(`/projects/${project.id}/keywords/bulk`, {
        source: 'AI_SUGGESTION',
        keywords: (result?.suggestions ?? [])
          .filter((s) => selected.has(s.phrase))
          .map((s) => ({
            phrase: s.phrase,
            intent: s.intent,
            country: project.targetCountries[0] ?? 'US',
            language: project.targetLanguages[0] ?? 'en',
            relatedQuestions: s.relatedQuestions.slice(0, 20),
          })),
      }),
    onSuccess: () => {
      toast.success(`Added ${selected.size} keyword idea(s)`);
      void queryClient.invalidateQueries({ queryKey: ['keywords', project.id] });
      onOpenChange(false);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const onFinished = (job: JobDto) => {
    if (job.status === 'SUCCEEDED')
      setResult(job.result as { suggestions: Suggestion[]; label: string; isDevAdapter: boolean });
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader
          title="AI keyword ideas"
          description="Ideas are generated by an AI model and are not measured: there is no search volume, difficulty or CPC behind them."
        />
        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            start.mutate();
          }}
        >
          {configured.length > 1 ? (
            <Field
              label="Run on"
              description="Generate the same ideas on each provider to compare them. Volume, difficulty and CPC are never produced, whichever provider runs."
            >
              <NativeSelect
                value={effectiveProvider}
                onChange={(e) => setProvider(e.target.value)}
                aria-label="AI provider"
              >
                {configured.map((p) => (
                  <option key={p.key} value={p.key}>
                    {p.label}
                    {p.model ? ` · ${p.model}` : ''}
                    {p.isDefault ? ' (default)' : ''}
                  </option>
                ))}
              </NativeSelect>
            </Field>
          ) : null}
          <div className="flex gap-2">
            <Input
              value={seed}
              onChange={(e) => setSeed(e.target.value)}
              placeholder="Topic (optional), e.g. backpacking tents. Leave empty for your whole business."
              aria-label="Seed topic"
            />
            <Button type="submit" loading={start.isPending}>
              Generate
            </Button>
          </div>
        </form>
        {start.isError ? <Alert tone="danger">{errorMessage(start.error)}</Alert> : null}
        {jobId && !result ? (
          <JobProgress jobId={jobId} label="Generating ideas" onFinished={onFinished} />
        ) : null}
        {result ? (
          <div className="grid gap-3">
            <p className="flex items-center gap-2 text-sm">
              <EstimateBadge label={result.isDevAdapter ? 'Development templates' : 'AI ideas'} />{' '}
              {result.label}
            </p>
            <ul className="max-h-80 divide-y divide-border overflow-y-auto rounded-lg border border-border">
              {result.suggestions.map((s) => (
                <li key={s.phrase} className="flex gap-3 p-3">
                  <Checkbox
                    checked={selected.has(s.phrase)}
                    disabled={s.alreadyTracked}
                    onCheckedChange={(v) =>
                      setSelected((prev) => {
                        const next = new Set(prev);
                        if (v) next.add(s.phrase);
                        else next.delete(s.phrase);
                        return next;
                      })
                    }
                    aria-label={`Select ${s.phrase}`}
                    className="mt-0.5"
                  />
                  <div className="min-w-0 text-sm">
                    <p className="font-medium">
                      {s.phrase}{' '}
                      <span className="text-xs font-normal text-muted-foreground">
                        {SEARCH_INTENT_LABELS[s.intent]}
                      </span>
                      {s.alreadyTracked ? <Badge className="ml-2">Already tracked</Badge> : null}
                    </p>
                    <p className="text-[13px] text-muted-foreground">{s.rationale}</p>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button onClick={() => add.mutate()} disabled={!selected.size} loading={add.isPending}>
            Add {selected.size || ''} selected
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function GroupsPanel({
  active,
  onSelect,
}: {
  active: { kind: 'list' | 'cluster'; id: string } | null;
  onSelect: (v: { kind: 'list' | 'cluster'; id: string } | null) => void;
}) {
  const project = useProject();
  const groups = useGroups(project.id);
  const canManage = useCan('keyword.manage');
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'list' | 'cluster'>('list');
  const create = useMutation({
    mutationFn: () => api.post(`/projects/${project.id}/keyword-groups/${kind}`, { name }),
    onSuccess: () => {
      setName('');
      void queryClient.invalidateQueries({ queryKey: ['keywords', project.id, 'groups'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const remove = async (k: 'list' | 'cluster', id: string) => {
    await api.delete(`/projects/${project.id}/keyword-groups/${k}/${id}`);
    if (active?.id === id) onSelect(null);
    await queryClient.invalidateQueries({ queryKey: ['keywords', project.id] });
  };
  const section = (title: string, k: 'list' | 'cluster', items: Group[]) => (
    <div>
      <p className="mb-1.5 text-xs font-medium text-muted-foreground">{title}</p>
      {items.length ? (
        <ul className="space-y-0.5">
          {items.map((g) => (
            <li key={g.id} className="group flex items-center gap-1">
              <button
                type="button"
                onClick={() => onSelect(active?.id === g.id ? null : { kind: k, id: g.id })}
                className={cn(
                  'flex min-w-0 flex-1 items-center justify-between rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted',
                  active?.id === g.id && 'bg-accent text-accent-foreground',
                )}
                aria-pressed={active?.id === g.id}
              >
                <span className="truncate">{g.name}</span>
                <span className="text-xs text-muted-foreground tabular-nums">{g.keywordCount}</span>
              </button>
              {canManage ? (
                <ConfirmDialog
                  title={`Delete "${g.name}"?`}
                  description="The keywords stay; only the grouping is removed."
                  confirmLabel="Delete"
                  destructive
                  onConfirm={() => remove(k, g.id).catch((e: unknown) => toast.error(errorMessage(e)))}
                  trigger={
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="opacity-60 group-hover:opacity-100"
                      aria-label={`Delete ${g.name}`}
                    >
                      <Trash2 />
                    </Button>
                  }
                />
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="px-2 text-xs text-muted-foreground">None yet</p>
      )}
    </div>
  );
  return (
    <Card>
      <CardHeaderRow title="Lists and clusters" />
      <CardContent className="space-y-4">
        {groups.isPending ? (
          <LoadingBlock />
        ) : groups.isError ? (
          <ErrorState error={groups.error} />
        ) : (
          <>
            {section('Lists', 'list', groups.data.lists)}
            {section('Topic clusters', 'cluster', groups.data.clusters)}
          </>
        )}
        {canManage ? (
          <form
            className="grid gap-2 border-t border-border pt-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim()) create.mutate();
            }}
          >
            <div className="flex gap-2">
              <NativeSelect
                aria-label="Group type"
                value={kind}
                onChange={(e) => setKind(e.target.value as 'list' | 'cluster')}
                className="w-28"
              >
                <option value="list">List</option>
                <option value="cluster">Cluster</option>
              </NativeSelect>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Name"
                aria-label="Group name"
              />
            </div>
            <Button
              type="submit"
              size="sm"
              variant="outline"
              loading={create.isPending}
              disabled={!name.trim()}
            >
              <FolderPlus /> Create
            </Button>
          </form>
        ) : null}
      </CardContent>
    </Card>
  );
}

export default function KeywordsPage() {
  const project = useProject();
  const queryClient = useQueryClient();
  const canManage = useCan('keyword.manage');
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  const [intent, setIntent] = useState('');
  const [status, setStatus] = useState('');
  const [group, setGroup] = useState<{ kind: 'list' | 'cluster'; id: string } | null>(null);
  const [dialog, setDialog] = useState<'add' | 'import' | 'ideas' | null>(null);
  const [editing, setEditing] = useState<KeywordDto | undefined>();
  const providerStatus = useQuery({
    queryKey: ['keywords-provider'],
    queryFn: () =>
      api.get<{
        keywordData: { configured: boolean; detail: string };
        suggestions: { configured: boolean; isDevAdapter: boolean; detail: string };
        llmProviders: LlmProviderStatusDto[];
      }>('/keywords/provider-status'),
  });
  const keywords = useQuery({
    queryKey: ['keywords', project.id, 'list', page, search, intent, status, group?.id ?? ''],
    queryFn: () =>
      api.page<KeywordDto>(`/projects/${project.id}/keywords`, {
        page,
        pageSize: 50,
        q: search || undefined,
        intent: intent || undefined,
        status: status || undefined,
        listId: group?.kind === 'list' ? group.id : undefined,
        clusterId: group?.kind === 'cluster' ? group.id : undefined,
      }),
    placeholderData: keepPreviousData,
  });
  const remove = async (k: KeywordDto) => {
    await api.delete(`/keywords/${k.id}`);
    toast.success('Keyword deleted');
    await queryClient.invalidateQueries({ queryKey: ['keywords', project.id] });
  };
  return (
    <>
      <PageHeader
        title="Keyword research"
        description="Organize the topics you want to be found and cited for. Measured metrics appear only when a licensed data provider is connected."
        actions={
          <>
            <ExportPdfButton module="keywords" />
            <Button
              variant="outline"
              onClick={() =>
                api
                  .download(`/projects/${project.id}/keywords/export`, undefined, 'keywords.csv')
                  .catch((e: unknown) => toast.error(errorMessage(e)))
              }
            >
              <Download /> Export CSV
            </Button>
            {canManage ? (
              <>
                <Button variant="outline" onClick={() => setDialog('import')}>
                  <Upload /> Import CSV
                </Button>
                <Button
                  variant="outline"
                  onClick={() => setDialog('ideas')}
                  disabled={providerStatus.data ? !providerStatus.data.suggestions.configured : false}
                  title={providerStatus.data?.suggestions.detail}
                >
                  <Lightbulb /> AI ideas
                </Button>
                <Button
                  onClick={() => {
                    setEditing(undefined);
                    setDialog('add');
                  }}
                >
                  <Plus /> Add keyword
                </Button>
              </>
            ) : null}
          </>
        }
      />
      {providerStatus.data && !providerStatus.data.keywordData.configured ? (
        <Alert tone="info" className="mb-5">
          {providerStatus.data.keywordData.detail}
        </Alert>
      ) : null}
      <Tabs defaultValue="keywords">
        <TabsList className="mb-4">
          <TabsTrigger value="keywords">Keywords</TabsTrigger>
          <TabsTrigger value="opportunities">Opportunities</TabsTrigger>
        </TabsList>
        <TabsContent value="opportunities">
          <KeywordOpportunities />
        </TabsContent>
        <TabsContent value="keywords">
          <div className="grid gap-5 lg:grid-cols-[16rem_1fr]">
            <GroupsPanel active={group} onSelect={(g) => (setPage(1), setGroup(g))} />
            <Card>
              <div className="flex flex-wrap gap-2 p-4">
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
                    placeholder="Search keywords"
                    aria-label="Search keywords"
                    className="pl-8"
                  />
                </form>
                <NativeSelect
                  aria-label="Intent"
                  value={intent}
                  onChange={(e) => (setPage(1), setIntent(e.target.value))}
                  className="w-40"
                >
                  <option value="">All intents</option>
                  {SEARCH_INTENTS.map((i) => (
                    <option key={i} value={i}>
                      {SEARCH_INTENT_LABELS[i]}
                    </option>
                  ))}
                </NativeSelect>
                <NativeSelect
                  aria-label="Status"
                  value={status}
                  onChange={(e) => (setPage(1), setStatus(e.target.value))}
                  className="w-40"
                >
                  <option value="">All statuses</option>
                  {KEYWORD_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {KEYWORD_STATUS_LABELS[s]}
                    </option>
                  ))}
                </NativeSelect>
              </div>
              {keywords.isPending ? (
                <LoadingBlock className="px-5 pb-5" rows={6} />
              ) : keywords.isError ? (
                <ErrorState
                  className="mx-5 mb-5"
                  error={keywords.error}
                  onRetry={() => void keywords.refetch()}
                />
              ) : keywords.data.items.length === 0 ? (
                <EmptyState
                  className="mx-5 mb-5"
                  title="No keywords here yet"
                  description="Add keywords one by one, import a CSV file, or generate AI ideas to review."
                />
              ) : (
                <div className={keywords.isPlaceholderData ? 'opacity-60' : undefined}>
                  <Table>
                    <THead>
                      <TR>
                        <TH>Keyword</TH>
                        <TH>Intent</TH>
                        <TH>Priority</TH>
                        <TH>Status</TH>
                        <TH>Group</TH>
                        <TH className="text-right">Search volume</TH>
                        <TH className="sr-only">Actions</TH>
                      </TR>
                    </THead>
                    <TBody>
                      {keywords.data.items.map((k) => (
                        <TR key={k.id}>
                          <TD>
                            <span className="font-medium">{k.phrase}</span>
                            {k.isPrimary ? (
                              <Badge tone="primary" className="ml-2">
                                Primary
                              </Badge>
                            ) : null}
                            {k.source === 'AI_SUGGESTION' ? (
                              <EstimateBadge label="AI idea" className="ml-2" />
                            ) : null}
                            <span className="block text-xs text-muted-foreground">
                              {countryName(k.country)} · {k.language}
                            </span>
                          </TD>
                          <TD className="text-xs">{k.intent ? SEARCH_INTENT_LABELS[k.intent] : '—'}</TD>
                          <TD className="text-xs">{humanize(k.priority)}</TD>
                          <TD className="text-xs">{KEYWORD_STATUS_LABELS[k.status]}</TD>
                          <TD className="text-xs text-muted-foreground">
                            {[k.list?.name, k.cluster?.name].filter(Boolean).join(' · ') || '—'}
                          </TD>
                          <TD
                            className="text-right text-xs tabular-nums"
                            title={
                              k.metrics
                                ? `Source: ${k.metrics.source}`
                                : 'No licensed data provider connected'
                            }
                          >
                            {k.metrics ? (
                              formatNumber(k.metrics.searchVolume)
                            ) : (
                              <span className="text-muted-foreground">Not measured</span>
                            )}
                          </TD>
                          <TD>
                            {canManage ? (
                              <div className="flex justify-end gap-1">
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => {
                                    setEditing(k);
                                    setDialog('add');
                                  }}
                                >
                                  Edit
                                </Button>
                                <ConfirmDialog
                                  title={`Delete "${k.phrase}"?`}
                                  description="This keyword is removed from all lists and clusters."
                                  confirmLabel="Delete"
                                  destructive
                                  onConfirm={() =>
                                    remove(k).catch((e: unknown) => toast.error(errorMessage(e)))
                                  }
                                  trigger={
                                    <Button variant="ghost" size="icon-sm" aria-label={`Delete ${k.phrase}`}>
                                      <Trash2 />
                                    </Button>
                                  }
                                />
                              </div>
                            ) : null}
                          </TD>
                        </TR>
                      ))}
                    </TBody>
                  </Table>
                  <Pagination meta={keywords.data.meta} onPage={setPage} />
                </div>
              )}
            </Card>
          </div>
        </TabsContent>
      </Tabs>
      <KeywordDialog
        open={dialog === 'add'}
        onOpenChange={(v) => setDialog(v ? 'add' : null)}
        keyword={editing}
      />
      <ImportDialog open={dialog === 'import'} onOpenChange={(v) => setDialog(v ? 'import' : null)} />
      <IdeasDialog
        open={dialog === 'ideas'}
        onOpenChange={(v) => setDialog(v ? 'ideas' : null)}
        providers={providerStatus.data?.llmProviders ?? []}
      />
    </>
  );
}
