import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FilePlus, FileText, Plus, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { Link, useNavigate } from 'react-router';
import {
  CONTENT_STATUSES,
  CONTENT_STATUS_LABELS,
  SEARCH_INTENTS,
  SEARCH_INTENT_LABELS,
  contentBriefInputSchema,
  type ContentBriefInput,
  type JobDto,
  type SearchIntent,
} from '@surfaced/shared';
import type { z } from 'zod';
import { useDocuments } from '@/app/hooks';
import { useProject } from '@/app/project-scope';
import { ExportPdfButton } from '@/components/app/export-pdf-button';
import { JobProgress, PageHeader } from '@/components/app/page';
import { EstimateBadge, StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeaderRow } from '@/components/ui/card';
import { Dialog, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/dialog';
import { Alert, EmptyState, ErrorState, LoadingBlock } from '@/components/ui/feedback';
import { Field, Input, NativeSelect, Textarea } from '@/components/ui/form';
import { TagInput } from '@/components/ui/multi-select';
import { Pagination, TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { api, ApiError, errorMessage, type Paged } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { formatNumber, formatRelative } from '@/lib/format';
import type { ContentBriefDto, ContentDocumentDto, LlmProviderStatusDto } from '@/lib/types';

interface BriefProposal {
  title: string;
  primaryKeyword: string;
  secondaryKeywords: string[];
  searchIntent: SearchIntent;
  targetAudience: string;
  angle: string;
  wordCountTarget: number;
  questions: { question: string; intent: SearchIntent; rationale: string }[];
  outlineHeadings: string[];
}
interface BriefIdeasJobResult {
  proposal: BriefProposal;
  isDevAdapter: boolean;
  provider: string;
  model: string;
  label: string;
}

/** Folds the generated questions, angle and outline into the brief's writer notes (trimmed to the field cap). */
function proposalNotes(p: BriefProposal): string {
  return [
    p.angle ? `Angle: ${p.angle}` : '',
    p.questions.length
      ? `Key questions to answer:\n${p.questions.map((q) => `- ${q.question}`).join('\n')}`
      : '',
    p.outlineHeadings.length
      ? `Suggested outline:\n${p.outlineHeadings.map((h) => `- ${h}`).join('\n')}`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n')
    .slice(0, 4000);
}

function BriefDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const project = useProject();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const form = useForm<ContentBriefInput, unknown, z.output<typeof contentBriefInputSchema>>({
    resolver: zodResolver(contentBriefInputSchema),
    defaultValues: {
      title: '',
      primaryKeyword: '',
      secondaryKeywords: [],
      searchIntent: 'INFORMATIONAL',
      country: project.targetCountries[0] ?? 'US',
      language: project.targetLanguages[0] ?? 'en',
      brandVoice: project.brandVoice ?? undefined,
    },
  });
  const create = useMutation({
    mutationFn: async (v: z.output<typeof contentBriefInputSchema>) => {
      const brief = await api.post<ContentBriefDto>(`/projects/${project.id}/content/briefs`, v);
      const doc = await api.post<ContentDocumentDto>(`/projects/${project.id}/content/documents`, {
        title: brief.title,
        briefId: brief.id,
        targetUrl: v.targetUrl,
      });
      return doc;
    },
    onSuccess: (doc) => {
      void queryClient.invalidateQueries({ queryKey: ['content', project.id] });
      onOpenChange(false);
      void navigate(`/app/p/${project.id}/content/${doc.id}`);
    },
    onError: (error) => {
      if (error instanceof ApiError)
        for (const [k, m] of Object.entries(error.fieldErrors))
          form.setError(k as keyof ContentBriefInput, { message: m });
    },
  });
  const e = form.formState.errors;
  const general =
    create.isError && !(create.error instanceof ApiError && Object.keys(create.error.fieldErrors).length)
      ? errorMessage(create.error)
      : null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader
          title="New content brief"
          description="A brief guides every generation for one piece of content. A draft document is created from it."
        />
        <form onSubmit={form.handleSubmit((v) => create.mutate(v))} className="grid gap-4" noValidate>
          <Field label="Working title" error={e.title?.message}>
            <Input autoFocus {...form.register('title')} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Primary keyword" error={e.primaryKeyword?.message}>
              <Input {...form.register('primaryKeyword')} />
            </Field>
            <Field label="Search intent">
              <NativeSelect {...form.register('searchIntent')}>
                {SEARCH_INTENTS.map((i) => (
                  <option key={i} value={i}>
                    {SEARCH_INTENT_LABELS[i]}
                  </option>
                ))}
              </NativeSelect>
            </Field>
          </div>
          <Field label="Secondary keywords" optional description="Press Enter after each keyword.">
            <Controller
              control={form.control}
              name="secondaryKeywords"
              render={({ field }) => (
                <TagInput value={field.value ?? []} onChange={field.onChange} max={20} />
              )}
            />
          </Field>
          <Field label="Target audience" optional error={e.targetAudience?.message}>
            <Input
              placeholder="e.g. first-time backpackers planning a weekend trip"
              {...form.register('targetAudience', { setValueAs: (v: string) => v || undefined })}
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Target length (words)" optional error={e.wordCountTarget?.message}>
              <Input
                type="number"
                min={300}
                max={4000}
                step={100}
                {...form.register('wordCountTarget', {
                  setValueAs: (v: string) => (v ? Number(v) : undefined),
                })}
              />
            </Field>
            <Field label="Page URL (if it exists)" optional error={e.targetUrl?.message}>
              <Input
                type="url"
                placeholder="https://"
                {...form.register('targetUrl', { setValueAs: (v: string) => v || undefined })}
              />
            </Field>
          </div>
          <Field
            label="Notes for the writer"
            optional
            error={e.notes?.message}
            description="Facts to include, points to avoid, sources to cite."
          >
            <Textarea rows={3} {...form.register('notes', { setValueAs: (v: string) => v || undefined })} />
          </Field>
          {general ? <Alert tone="danger">{general}</Alert> : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={create.isPending}>
              Create brief and draft
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

type BriefForm = ContentBriefInput & { secondaryKeywords: string[]; notes: string };

function GenerateBriefDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const project = useProject();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [seed, setSeed] = useState('');
  const [provider, setProvider] = useState('');
  const [jobId, setJobId] = useState<string | null>(null);
  const [result, setResult] = useState<BriefIdeasJobResult | null>(null);
  const [brief, setBrief] = useState<BriefForm | null>(null);

  const providers = useQuery({
    queryKey: ['brief-providers', project.id],
    queryFn: () => api.get<LlmProviderStatusDto[]>(`/projects/${project.id}/content/brief-providers`),
    enabled: open,
  });
  const configured = (providers.data ?? []).filter((p) => p.configured);
  const effectiveProvider = provider || configured.find((p) => p.isDefault)?.key || configured[0]?.key || '';

  const start = useMutation({
    mutationFn: () =>
      api.post<{ jobId: string }>(`/projects/${project.id}/content/briefs/suggest`, {
        seed: seed.trim(),
        country: project.targetCountries[0] ?? 'US',
        language: project.targetLanguages[0] ?? 'en',
        questionCount: 6,
        provider: effectiveProvider || undefined,
      }),
    onSuccess: (r) => {
      setResult(null);
      setBrief(null);
      setJobId(r.jobId);
    },
  });

  const onFinished = (job: JobDto) => {
    if (job.status !== 'SUCCEEDED') return;
    const res = job.result as BriefIdeasJobResult;
    const p = res.proposal;
    setResult(res);
    setBrief({
      title: p.title,
      primaryKeyword: p.primaryKeyword,
      secondaryKeywords: p.secondaryKeywords,
      searchIntent: p.searchIntent,
      targetAudience: p.targetAudience || undefined,
      country: project.targetCountries[0] ?? 'US',
      language: project.targetLanguages[0] ?? 'en',
      wordCountTarget: p.wordCountTarget,
      notes: proposalNotes(p),
    });
  };

  const save = useMutation({
    mutationFn: async () => {
      if (!brief) throw new Error('No brief to save');
      const createdBrief = await api.post<ContentBriefDto>(`/projects/${project.id}/content/briefs`, brief);
      return api.post<ContentDocumentDto>(`/projects/${project.id}/content/documents`, {
        title: createdBrief.title,
        briefId: createdBrief.id,
      });
    },
    onSuccess: (doc) => {
      void queryClient.invalidateQueries({ queryKey: ['content', project.id] });
      onOpenChange(false);
      void navigate(`/app/p/${project.id}/content/${doc.id}`);
    },
  });

  const set = <K extends keyof BriefForm>(key: K, value: BriefForm[K]) =>
    setBrief((b) => (b ? { ...b, [key]: value } : b));

  const noProvider = providers.isSuccess && configured.length === 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader
          title="Generate a brief with AI"
          description="Describe a topic. The AI proposes the real questions people ask an AI assistant or search engine, and the brief fields to answer them — an editorial suggestion, not measured search data."
        />
        {noProvider ? (
          <Alert tone="warning">
            No AI provider is configured on the server, so briefs cannot be generated. You can still create one
            manually with “New brief”.
          </Alert>
        ) : null}
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
              description="Generate the same topic on each provider to compare the proposals."
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
              placeholder="Topic, e.g. cold brew coffee for offices"
              aria-label="Topic"
            />
            <Button type="submit" loading={start.isPending} disabled={noProvider || seed.trim().length < 2}>
              <Sparkles /> Generate
            </Button>
          </div>
        </form>
        {start.isError ? <Alert tone="danger">{errorMessage(start.error)}</Alert> : null}
        {jobId && !result ? (
          <JobProgress jobId={jobId} label="Generating the brief" onFinished={onFinished} />
        ) : null}
        {result && brief ? (
          <div className="grid max-h-[26rem] gap-4 overflow-y-auto pr-1">
            <p className="flex items-center gap-2 text-sm">
              <EstimateBadge label={result.isDevAdapter ? 'Development template' : 'AI proposal'} />
              {result.label}
            </p>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Working title" className="sm:col-span-2">
                <Input value={brief.title} onChange={(e) => set('title', e.target.value)} />
              </Field>
              <Field label="Primary keyword">
                <Input value={brief.primaryKeyword} onChange={(e) => set('primaryKeyword', e.target.value)} />
              </Field>
              <Field label="Search intent">
                <NativeSelect
                  value={brief.searchIntent}
                  onChange={(e) => set('searchIntent', e.target.value as SearchIntent)}
                >
                  {SEARCH_INTENTS.map((i) => (
                    <option key={i} value={i}>
                      {SEARCH_INTENT_LABELS[i]}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
            </div>
            <Field label="Secondary keywords" optional description="Press Enter after each keyword.">
              <TagInput
                value={brief.secondaryKeywords}
                onChange={(v) => set('secondaryKeywords', v)}
                max={20}
              />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Target audience" optional>
                <Input
                  value={brief.targetAudience ?? ''}
                  onChange={(e) => set('targetAudience', e.target.value || undefined)}
                />
              </Field>
              <Field label="Target length (words)" optional>
                <Input
                  type="number"
                  min={300}
                  max={4000}
                  step={100}
                  value={brief.wordCountTarget ?? ''}
                  onChange={(e) => set('wordCountTarget', e.target.value ? Number(e.target.value) : undefined)}
                />
              </Field>
            </div>
            {result.proposal.questions.length ? (
              <div className="rounded-lg border border-border p-3 text-sm">
                <p className="mb-1.5 font-medium">Questions the page should answer</p>
                <ul className="grid gap-1.5">
                  {result.proposal.questions.map((q) => (
                    <li key={q.question} className="text-muted-foreground">
                      <span className="text-foreground">{q.question}</span>{' '}
                      <span className="text-xs">{SEARCH_INTENT_LABELS[q.intent]}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            <Field
              label="Notes for the writer"
              optional
              description="The questions, angle and outline are saved here; edit freely before saving."
            >
              <Textarea rows={6} value={brief.notes} onChange={(e) => set('notes', e.target.value)} />
            </Field>
            {save.isError ? <Alert tone="danger">{errorMessage(save.error)}</Alert> : null}
          </div>
        ) : null}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          {result && brief ? (
            <Button onClick={() => save.mutate()} loading={save.isPending}>
              Save brief and draft
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function BlankDocumentDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const project = useProject();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [title, setTitle] = useState('');
  const create = useMutation({
    mutationFn: () => api.post<ContentDocumentDto>(`/projects/${project.id}/content/documents`, { title }),
    onSuccess: (doc) => {
      void queryClient.invalidateQueries({ queryKey: ['content', project.id] });
      onOpenChange(false);
      void navigate(`/app/p/${project.id}/content/${doc.id}`);
    },
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader
          title="New blank document"
          description="Write from scratch. You can generate sections later."
        />
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <Field
            label="Title"
            error={create.error instanceof ApiError ? create.error.fieldErrors.title : undefined}
          >
            <Input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} />
          </Field>
          {create.isError && !(create.error instanceof ApiError && create.error.fieldErrors.title) ? (
            <Alert tone="danger">{errorMessage(create.error)}</Alert>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={create.isPending} disabled={title.trim().length < 3}>
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default function ContentPage() {
  const project = useProject();
  const canEdit = useCan('content.edit');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [dialog, setDialog] = useState<'brief' | 'generate' | 'blank' | null>(null);
  const documents = useDocuments(project.id, { page, pageSize: 20, status: status || undefined });
  const briefs = useQuery({
    queryKey: ['content', project.id, 'briefs'],
    queryFn: () =>
      api.page<ContentBriefDto>(`/projects/${project.id}/content/briefs`, { pageSize: 50 }) as Promise<
        Paged<ContentBriefDto>
      >,
  });
  return (
    <>
      <PageHeader
        title="Content Studio"
        description="Briefs, drafts and approvals. Drafts never invent facts or sources, and nothing is published to your site automatically."
        actions={
          <>
            <ExportPdfButton module="content" />
            {canEdit ? (
              <>
                <Button variant="outline" onClick={() => setDialog('blank')}>
                  <FilePlus /> Blank document
                </Button>
                <Button variant="outline" onClick={() => setDialog('generate')}>
                  <Sparkles /> Generate with AI
                </Button>
                <Button onClick={() => setDialog('brief')}>
                  <Plus /> New brief
                </Button>
              </>
            ) : null}
          </>
        }
      />
      <div className="grid gap-5 xl:grid-cols-[1fr_20rem]">
        <Card>
          <CardHeaderRow
            title="Documents"
            actions={
              <NativeSelect
                aria-label="Status"
                value={status}
                onChange={(e) => (setPage(1), setStatus(e.target.value))}
                className="h-8 w-40 text-[13px]"
              >
                <option value="">All statuses</option>
                {CONTENT_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {CONTENT_STATUS_LABELS[s]}
                  </option>
                ))}
              </NativeSelect>
            }
          />
          {documents.isPending ? (
            <CardContent>
              <LoadingBlock rows={5} />
            </CardContent>
          ) : documents.isError ? (
            <CardContent>
              <ErrorState error={documents.error} onRetry={() => void documents.refetch()} />
            </CardContent>
          ) : documents.data.items.length === 0 ? (
            <CardContent>
              <EmptyState
                icon={FileText}
                title="No documents yet"
                description="Start with a brief: choose a keyword and audience, then generate an outline and a draft."
              />
            </CardContent>
          ) : (
            <>
              <Table>
                <THead>
                  <TR>
                    <TH>Title</TH>
                    <TH>Status</TH>
                    <TH className="text-right">Words</TH>
                    <TH>Assignee</TH>
                    <TH>Updated</TH>
                  </TR>
                </THead>
                <TBody>
                  {documents.data.items.map((d) => (
                    <TR key={d.id}>
                      <TD>
                        <Link
                          to={`/app/p/${project.id}/content/${d.id}`}
                          className="font-medium hover:text-primary"
                        >
                          {d.title}
                        </Link>
                        <span className="block text-xs text-muted-foreground">v{d.latestVersion}</span>
                      </TD>
                      <TD>
                        <StatusBadge
                          status={d.status}
                          label={CONTENT_STATUS_LABELS[d.status as keyof typeof CONTENT_STATUS_LABELS]}
                        />
                      </TD>
                      <TD className="text-right tabular-nums">{formatNumber(d.wordCount)}</TD>
                      <TD className="text-xs">
                        {d.assignee?.name ?? <span className="text-muted-foreground">Unassigned</span>}
                      </TD>
                      <TD className="text-xs text-muted-foreground">{formatRelative(d.updatedAt)}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
              <Pagination meta={documents.data.meta} onPage={setPage} />
            </>
          )}
        </Card>
        <Card>
          <CardHeaderRow
            title="Briefs"
            description={briefs.data ? `${briefs.data.meta.total} briefs` : undefined}
          />
          <CardContent>
            {briefs.isPending ? (
              <LoadingBlock />
            ) : briefs.data?.items.length ? (
              <ul className="space-y-3">
                {briefs.data.items.map((b) => (
                  <li key={b.id} className="text-sm">
                    <p className="font-medium">{b.title}</p>
                    <p className="text-xs text-muted-foreground">
                      {b.primaryKeyword} ·{' '}
                      {SEARCH_INTENT_LABELS[b.searchIntent as keyof typeof SEARCH_INTENT_LABELS] ??
                        b.searchIntent}{' '}
                      · {b.documentCount ?? 0} document(s)
                    </p>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">No briefs yet.</p>
            )}
          </CardContent>
        </Card>
      </div>
      <BriefDialog open={dialog === 'brief'} onOpenChange={(v) => setDialog(v ? 'brief' : null)} />
      <GenerateBriefDialog
        open={dialog === 'generate'}
        onOpenChange={(v) => setDialog(v ? 'generate' : null)}
      />
      <BlankDocumentDialog open={dialog === 'blank'} onOpenChange={(v) => setDialog(v ? 'blank' : null)} />
    </>
  );
}
