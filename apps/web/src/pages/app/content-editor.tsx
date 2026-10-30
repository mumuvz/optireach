import { listMarkdownSections, renderMarkdown } from '@surfaced/shared/markdown';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, History, Link2, Plus, RotateCcw, Save, Sparkles, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import {
  CONTENT_STATUS_LABELS,
  type ContentStatus,
  type JobDto,
  type WorkspaceMemberDto,
} from '@surfaced/shared';
import { useProject } from '@/app/project-scope';
import { useWorkspaceId } from '@/app/queries';
import { JobProgress, PageHeader } from '@/components/app/page';
import { Badge, EstimateBadge, StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeaderRow } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/dialog';
import { Alert, ErrorState, LoadingBlock } from '@/components/ui/feedback';
import { Field, Input, Label, NativeSelect, Textarea } from '@/components/ui/form';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api, ApiError, errorMessage } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { formatDateTime, formatNumber } from '@/lib/format';
import type { ContentDocumentDto } from '@/lib/types';

interface FaqItem {
  question: string;
  answer: string;
}

interface VersionDto {
  id: string;
  versionNumber: number;
  title: string;
  body: string;
  metaTitle: string | null;
  metaDescription: string | null;
  faqs: FaqItem[];
  internalLinks: { url: string; anchorText: string; reason?: string }[];
  schemaJsonLd: Record<string, unknown> | null;
  wordCount: number;
  source: string;
  provider: string | null;
  model: string | null;
  isDevAdapter: boolean;
  note: string | null;
  createdAt: string;
}

interface DocumentDetail extends ContentDocumentDto {
  currentVersion: VersionDto | null;
  recentJobs: JobDto[];
  generation: { provider: string; configured: boolean; isDevAdapter: boolean; detail: string };
}

interface VersionSummary {
  id: string;
  versionNumber: number;
  title: string;
  wordCount: number;
  source: string;
  provider: string | null;
  model: string | null;
  isDevAdapter: boolean;
  note: string | null;
  createdAt: string;
  createdBy: string | null;
}

const isAiSource = (source: string) => source === 'AI_GENERATION' || source === 'AI_SECTION';

const TRANSITION_LABELS: Record<string, string> = {
  IN_REVIEW: 'Submit for review',
  APPROVED: 'Approve',
  PUBLISHED: 'Mark as published',
  DRAFT: 'Move back to draft',
  ARCHIVED: 'Archive',
};

const MODES: { mode: 'outline' | 'article' | 'meta' | 'faq' | 'schema'; label: string; hint: string }[] = [
  { mode: 'outline', label: 'Outline', hint: 'Headings and key points from the brief' },
  { mode: 'article', label: 'Full draft', hint: 'A complete draft following the outline' },
  { mode: 'meta', label: 'Meta tags', hint: 'Meta title and description' },
  { mode: 'faq', label: 'FAQ', hint: 'Questions and short answers' },
  { mode: 'schema', label: 'JSON-LD', hint: 'Article and FAQ structured data (no AI)' },
];

interface Draft {
  title: string;
  body: string;
  metaTitle: string;
  metaDescription: string;
  faqs: FaqItem[];
}

function toDraft(v: VersionDto | null, fallbackTitle: string): Draft {
  return {
    title: v?.title ?? fallbackTitle,
    body: v?.body ?? '',
    metaTitle: v?.metaTitle ?? '',
    metaDescription: v?.metaDescription ?? '',
    faqs: v?.faqs ?? [],
  };
}

export default function ContentEditorPage() {
  const project = useProject();
  const { documentId } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const workspaceId = useWorkspaceId();
  const canEdit = useCan('content.edit');
  const canGenerate = useCan('content.generate');
  const canDelete = useCan('content.delete');
  const doc = useQuery({
    queryKey: ['content-doc', documentId],
    queryFn: () => api.get<DocumentDetail>(`/content/documents/${documentId}`),
  });
  const versions = useQuery({
    queryKey: ['content-doc', documentId, 'versions'],
    queryFn: () => api.get<VersionSummary[]>(`/content/documents/${documentId}/versions`),
  });
  const links = useQuery({
    queryKey: ['content-doc', documentId, 'links'],
    queryFn: () =>
      api.get<{
        suggestions: { url: string; anchorText: string; reason?: string }[];
        crawledAt: string | null;
      }>(`/content/documents/${documentId}/internal-links`),
  });
  const members = useQuery({
    queryKey: ['members', workspaceId],
    queryFn: () => api.get<WorkspaceMemberDto[]>(`/workspaces/${workspaceId}/members`),
    enabled: Boolean(workspaceId),
  });

  const [draft, setDraft] = useState<Draft | null>(null);
  const [baseVersionId, setBaseVersionId] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [jobId, setJobId] = useState<string | null>(null);
  const [section, setSection] = useState('');
  const [instructions, setInstructions] = useState('');
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  // Load the latest version into the editor when it changes (initial load, generation, restore).
  const current = doc.data?.currentVersion ?? null;
  useEffect(() => {
    if (!doc.data) return;
    const id = doc.data.currentVersion?.id ?? 'none';
    if (id !== baseVersionId) {
      setDraft(toDraft(doc.data.currentVersion, doc.data.title));
      setBaseVersionId(id);
    }
  }, [doc.data, baseVersionId]);

  const dirty = useMemo(() => {
    if (!draft) return false;
    return JSON.stringify(draft) !== JSON.stringify(toDraft(current, doc.data?.title ?? ''));
  }, [draft, current, doc.data?.title]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['content-doc', documentId] });
    await queryClient.invalidateQueries({ queryKey: ['content', project.id] });
  };
  const save = useMutation({
    mutationFn: () =>
      api.post<VersionDto>(`/content/documents/${documentId}/versions`, {
        title: draft!.title,
        body: draft!.body,
        metaTitle: draft!.metaTitle || undefined,
        metaDescription: draft!.metaDescription || undefined,
        faqs: draft!.faqs.filter((f) => f.question.trim() && f.answer.trim()),
        internalLinks: current?.internalLinks ?? [],
        schemaJsonLd: current?.schemaJsonLd ?? undefined,
        note: note || undefined,
      }),
    onSuccess: async (v) => {
      toast.success(`Saved as version ${v.versionNumber}`);
      setNote('');
      await refresh();
    },
    onError: (e) =>
      toast.error('Could not save', {
        description:
          e instanceof ApiError && e.code === 'VALIDATION_ERROR'
            ? Object.values(e.fieldErrors).join(' ')
            : errorMessage(e),
      }),
  });
  const generate = useMutation({
    mutationFn: (input: { mode: string; sectionHeading?: string; instructions?: string }) =>
      api.post<{ jobId: string }>(`/content/documents/${documentId}/generate`, input),
    onSuccess: (r) => setJobId(r.jobId),
    onError: (e) => toast.error('Could not start generation', { description: errorMessage(e) }),
  });
  const transition = useMutation({
    mutationFn: (status: string) => api.patch(`/content/documents/${documentId}`, { status }),
    onSuccess: async () => {
      toast.success('Status updated');
      await refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const assign = useMutation({
    mutationFn: (assigneeId: string | null) => api.patch(`/content/documents/${documentId}`, { assigneeId }),
    onSuccess: () => void refresh(),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const restore = useMutation({
    mutationFn: (versionId: string) =>
      api.post<VersionDto>(`/content/documents/${documentId}/versions/${versionId}/restore`),
    onSuccess: async (v) => {
      toast.success(`Restored as version ${v.versionNumber}`);
      await refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  if (doc.isPending || !draft) return <LoadingBlock rows={10} />;
  if (doc.isError) return <ErrorState error={doc.error} onRetry={() => void doc.refetch()} />;
  const d = doc.data;
  const editable = d.editable && canEdit;
  const gen = d.generation;
  const sections = listMarkdownSections(draft.body);
  const set = (patch: Partial<Draft>) => setDraft((prev) => (prev ? { ...prev, ...patch } : prev));
  const insertLink = (url: string, anchor: string) => {
    const el = bodyRef.current;
    const md = `[${anchor}](${url})`;
    if (!el) return set({ body: `${draft.body}\n\n${md}` });
    const start = el.selectionStart ?? draft.body.length;
    const end = el.selectionEnd ?? start;
    set({ body: `${draft.body.slice(0, start)}${md}${draft.body.slice(end)}` });
  };
  const words = draft.body.split(/\s+/).filter(Boolean).length;

  return (
    <>
      <PageHeader
        title={d.title}
        documentTitle="Content editor"
        breadcrumbs={[{ label: 'Content Studio', to: `/app/p/${project.id}/content` }, { label: 'Editor' }]}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <StatusBadge status={d.status} label={CONTENT_STATUS_LABELS[d.status as ContentStatus]} />
            <span>Version {d.latestVersion}</span>
            {current?.isDevAdapter ? (
              <Badge tone="warning">Development template text</Badge>
            ) : current && isAiSource(current.source) ? (
              <EstimateBadge label="AI draft — review before publishing" />
            ) : null}
            {dirty ? <Badge tone="info">Unsaved changes</Badge> : null}
          </span>
        }
        actions={
          <>
            <Button
              variant="outline"
              onClick={() =>
                api
                  .download(`/content/documents/${documentId}/export`, { format: 'md' }, 'document.md')
                  .catch((e: unknown) => toast.error(errorMessage(e)))
              }
            >
              <Download /> Markdown
            </Button>
            <Button
              variant="outline"
              onClick={() =>
                api
                  .download(`/content/documents/${documentId}/export`, { format: 'html' }, 'document.html')
                  .catch((e: unknown) => toast.error(errorMessage(e)))
              }
            >
              <Download /> HTML
            </Button>
            {editable ? (
              <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!dirty}>
                <Save /> Save version
              </Button>
            ) : null}
          </>
        }
      />
      {!d.editable ? (
        <Alert
          tone="info"
          className="mb-5"
          title={`This document is ${CONTENT_STATUS_LABELS[d.status as ContentStatus].toLowerCase()}`}
        >
          Move it back to draft to edit it. Approved and published content is locked so reviewers see exactly
          what they approved.
        </Alert>
      ) : null}
      {gen.isDevAdapter ? (
        <Alert tone="warning" className="mb-5" title="Development adapter">
          {gen.detail} Configure OPENAI_API_KEY with LLM_PROVIDER=openai for AI-generated drafts.
        </Alert>
      ) : !gen.configured ? (
        <Alert tone="warning" className="mb-5" title="Content generation is not configured">
          {gen.detail} You can still write and edit by hand. JSON-LD generation works without an AI provider.
        </Alert>
      ) : null}
      {jobId ? (
        <div className="mb-5">
          <JobProgress
            jobId={jobId}
            label="Generating content"
            onFinished={(job) => {
              if (job.status === 'SUCCEEDED') {
                if (dirty)
                  toast.warning('A new version was generated', {
                    description:
                      'Your unsaved edits were replaced by the generated version. Earlier versions stay in the history.',
                  });
                void refresh();
              }
            }}
            onDismiss={() => setJobId(null)}
          />
        </div>
      ) : null}

      <div className="grid gap-5 xl:grid-cols-[1fr_22rem]">
        <div className="space-y-5">
          <Card>
            <CardContent className="space-y-4 pt-5">
              <Field label="Title">
                <Input
                  value={draft.title}
                  onChange={(e) => set({ title: e.target.value })}
                  disabled={!editable}
                />
              </Field>
              <Tabs defaultValue="write">
                <div className="flex items-center justify-between gap-2">
                  <TabsList>
                    <TabsTrigger value="write">Write</TabsTrigger>
                    <TabsTrigger value="preview">Preview</TabsTrigger>
                  </TabsList>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {formatNumber(words)} words
                  </span>
                </div>
                <TabsContent value="write">
                  <Textarea
                    ref={bodyRef}
                    value={draft.body}
                    onChange={(e) => set({ body: e.target.value })}
                    disabled={!editable}
                    rows={24}
                    aria-label="Body (Markdown)"
                    placeholder="Write in Markdown, or generate an outline from the brief."
                    className="font-mono text-[13px] leading-6"
                  />
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    Markdown. Raw HTML is escaped in previews and exports. Resolve every [SOURCE NEEDED]
                    marker before publishing.
                  </p>
                </TabsContent>
                <TabsContent value="preview">
                  {draft.body.trim() ? (
                    <div
                      className="prose-content rounded-lg border border-border p-5"
                      dangerouslySetInnerHTML={{ __html: renderMarkdown(draft.body) }}
                    />
                  ) : (
                    <p className="py-10 text-center text-sm text-muted-foreground">Nothing to preview yet.</p>
                  )}
                </TabsContent>
              </Tabs>
            </CardContent>
          </Card>

          <Card>
            <CardHeaderRow
              title="Search appearance"
              description="Meta title and description used by search engines and shown in exports"
            />
            <CardContent className="grid gap-4">
              <Field
                label="Meta title"
                description={`${draft.metaTitle.length} characters · aim for about 60 or fewer`}
              >
                <Input
                  value={draft.metaTitle}
                  onChange={(e) => set({ metaTitle: e.target.value })}
                  disabled={!editable}
                  maxLength={255}
                />
              </Field>
              <Field
                label="Meta description"
                description={`${draft.metaDescription.length} characters · aim for 120–160`}
              >
                <Textarea
                  rows={2}
                  value={draft.metaDescription}
                  onChange={(e) => set({ metaDescription: e.target.value })}
                  disabled={!editable}
                  maxLength={500}
                />
              </Field>
            </CardContent>
          </Card>

          <Card>
            <CardHeaderRow
              title="FAQ"
              description="Only add questions that appear on the page; FAQ structured data must match visible content."
              actions={
                editable ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => set({ faqs: [...draft.faqs, { question: '', answer: '' }] })}
                    disabled={draft.faqs.length >= 20}
                  >
                    <Plus /> Add question
                  </Button>
                ) : null
              }
            />
            <CardContent className="space-y-3">
              {draft.faqs.length === 0 ? (
                <p className="text-sm text-muted-foreground">No questions yet.</p>
              ) : null}
              {draft.faqs.map((f, i) => (
                <div key={i} className="grid gap-2 rounded-lg border border-border p-3">
                  <div className="flex gap-2">
                    <Input
                      aria-label={`Question ${i + 1}`}
                      value={f.question}
                      placeholder="Question"
                      disabled={!editable}
                      onChange={(e) =>
                        set({
                          faqs: draft.faqs.map((x, j) => (j === i ? { ...x, question: e.target.value } : x)),
                        })
                      }
                    />
                    {editable ? (
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Remove question ${i + 1}`}
                        onClick={() => set({ faqs: draft.faqs.filter((_, j) => j !== i) })}
                      >
                        <Trash2 />
                      </Button>
                    ) : null}
                  </div>
                  <Textarea
                    aria-label={`Answer ${i + 1}`}
                    rows={2}
                    value={f.answer}
                    placeholder="Answer"
                    disabled={!editable}
                    onChange={(e) =>
                      set({
                        faqs: draft.faqs.map((x, j) => (j === i ? { ...x, answer: e.target.value } : x)),
                      })
                    }
                  />
                </div>
              ))}
            </CardContent>
          </Card>

          {current?.schemaJsonLd ? (
            <Card>
              <CardHeaderRow
                title="Structured data (JSON-LD)"
                description="Generated from this version. Review it; markup must describe what the page shows."
              />
              <CardContent>
                <pre className="max-h-72 overflow-auto rounded-lg bg-muted p-3 text-xs">
                  {JSON.stringify(current.schemaJsonLd, null, 2)}
                </pre>
              </CardContent>
            </Card>
          ) : null}
        </div>

        <div className="space-y-5">
          <Card>
            <CardHeaderRow title="Workflow" />
            <CardContent className="space-y-3">
              <div className="flex flex-wrap gap-2">
                {d.allowedTransitions.length ? (
                  d.allowedTransitions.map((to) => (
                    <Button
                      key={to}
                      size="sm"
                      variant={to === 'APPROVED' || to === 'IN_REVIEW' ? 'primary' : 'outline'}
                      onClick={() => transition.mutate(to)}
                      disabled={transition.isPending || (dirty && to !== 'DRAFT')}
                    >
                      {TRANSITION_LABELS[to] ?? to}
                    </Button>
                  ))
                ) : (
                  <p className="text-sm text-muted-foreground">No status changes available for your role.</p>
                )}
              </div>
              {dirty ? (
                <p className="text-xs text-muted-foreground">Save your changes before changing the status.</p>
              ) : null}
              <p className="text-xs text-muted-foreground">
                “Mark as published” records that you published the content yourself; Surfaced never publishes
                to your site.
              </p>
              <div className="grid gap-1.5 pt-2">
                <Label htmlFor="assignee">Assignee</Label>
                <NativeSelect
                  id="assignee"
                  value={d.assignee?.id ?? ''}
                  onChange={(e) => assign.mutate(e.target.value || null)}
                  disabled={!canEdit || assign.isPending}
                >
                  <option value="">Unassigned</option>
                  {members.data?.map((m) => (
                    <option key={m.userId} value={m.userId}>
                      {m.name}
                    </option>
                  ))}
                </NativeSelect>
              </div>
              {d.approvedBy ? (
                <p className="text-xs text-muted-foreground">
                  Approved by {d.approvedBy.name} · {formatDateTime(d.approvedAt)}
                </p>
              ) : null}
            </CardContent>
          </Card>

          {canGenerate ? (
            <Card>
              <CardHeaderRow
                title="Generate"
                description="Each generation creates a new version; nothing is overwritten."
              />
              <CardContent className="space-y-3">
                <div className="grid gap-2">
                  {MODES.map((m) => (
                    <Button
                      key={m.mode}
                      variant="outline"
                      className="h-auto justify-start py-2 text-left"
                      disabled={
                        !editable ||
                        generate.isPending ||
                        Boolean(jobId) ||
                        (m.mode !== 'schema' && !gen.configured)
                      }
                      onClick={() =>
                        generate.mutate({ mode: m.mode, instructions: instructions || undefined })
                      }
                    >
                      <Sparkles />
                      <span>
                        <span className="block font-medium">{m.label}</span>
                        <span className="block text-xs font-normal text-muted-foreground">{m.hint}</span>
                      </span>
                    </Button>
                  ))}
                </div>
                <div className="grid gap-2 border-t border-border pt-3">
                  <Label htmlFor="section">Regenerate one section</Label>
                  <NativeSelect
                    id="section"
                    value={section}
                    onChange={(e) => setSection(e.target.value)}
                    disabled={!sections.length || !editable}
                  >
                    <option value="">{sections.length ? 'Choose a section' : 'No sections yet'}</option>
                    {sections.map((s) => (
                      <option key={`${s.level}-${s.heading}`} value={s.heading}>
                        {'— '.repeat(Math.max(0, s.level - 2))}
                        {s.heading}
                      </option>
                    ))}
                  </NativeSelect>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!section || !editable || !gen.configured || Boolean(jobId)}
                    onClick={() =>
                      generate.mutate({
                        mode: 'section',
                        sectionHeading: section,
                        instructions: instructions || undefined,
                      })
                    }
                  >
                    Regenerate section
                  </Button>
                </div>
                <Field
                  label="Instructions"
                  optional
                  description="Applied to the next generation, e.g. “shorter, more practical”."
                >
                  <Textarea
                    rows={2}
                    value={instructions}
                    onChange={(e) => setInstructions(e.target.value)}
                    maxLength={2000}
                  />
                </Field>
                {dirty ? (
                  <p className="text-xs text-amber-700">
                    Save first: a generation creates a new version from the last saved one.
                  </p>
                ) : null}
              </CardContent>
            </Card>
          ) : null}

          <Card>
            <CardHeaderRow
              title="Internal links"
              description={
                links.data?.crawledAt
                  ? `From the crawl of ${formatDateTime(links.data.crawledAt)}`
                  : 'From your latest crawl'
              }
            />
            <CardContent>
              {links.isPending ? (
                <LoadingBlock />
              ) : !links.data?.crawledAt ? (
                <p className="text-sm text-muted-foreground">
                  Run an audit first; suggestions only use pages found on your site.{' '}
                  <Link
                    to={`/app/p/${project.id}/audits`}
                    className="font-medium text-primary hover:underline"
                  >
                    Website audit
                  </Link>
                </p>
              ) : links.data.suggestions.length === 0 ? (
                <p className="text-sm text-muted-foreground">No closely related pages were found.</p>
              ) : (
                <ul className="space-y-2.5">
                  {links.data.suggestions.map((s) => (
                    <li key={s.url} className="text-sm">
                      <p className="font-medium">{s.anchorText}</p>
                      <p className="truncate font-mono text-xs text-muted-foreground">{s.url}</p>
                      {editable ? (
                        <Button variant="link" size="sm" onClick={() => insertLink(s.url, s.anchorText)}>
                          <Link2 /> Insert at cursor
                        </Button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeaderRow title="Versions" />
            <CardContent className="space-y-3">
              {editable ? (
                <Field label="Note for the next save" optional>
                  <Input
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    maxLength={500}
                    placeholder="e.g. tightened the introduction"
                  />
                </Field>
              ) : null}
              <ol className="max-h-96 space-y-2 overflow-y-auto">
                {(versions.data ?? []).map((v) => (
                  <li
                    key={v.id}
                    className="flex items-start justify-between gap-2 rounded-lg border border-border p-2.5 text-sm"
                  >
                    <span className="min-w-0">
                      <span className="flex items-center gap-1.5 font-medium">
                        <History className="size-3.5 text-muted-foreground" aria-hidden /> v{v.versionNumber}
                        {v.isDevAdapter ? (
                          <Badge tone="warning">Template</Badge>
                        ) : isAiSource(v.source) ? (
                          <Badge tone="info">AI</Badge>
                        ) : null}
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        {formatDateTime(v.createdAt)}
                        {v.createdBy ? ` · ${v.createdBy}` : ''} · {formatNumber(v.wordCount)} words
                      </span>
                      {v.note ? <span className="block text-xs">{v.note}</span> : null}
                    </span>
                    {editable && v.versionNumber !== d.latestVersion ? (
                      <ConfirmDialog
                        title={`Restore version ${v.versionNumber}?`}
                        description="Its content is saved as a new version. No version is deleted."
                        confirmLabel="Restore"
                        onConfirm={() => restore.mutateAsync(v.id)}
                        trigger={
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`Restore version ${v.versionNumber}`}
                          >
                            <RotateCcw />
                          </Button>
                        }
                      />
                    ) : null}
                  </li>
                ))}
              </ol>
            </CardContent>
          </Card>

          {canDelete ? (
            <ConfirmDialog
              title="Delete this document?"
              description="All versions are deleted. This cannot be undone."
              confirmLabel="Delete document"
              destructive
              onConfirm={async () => {
                await api.delete(`/content/documents/${documentId}`);
                await queryClient.invalidateQueries({ queryKey: ['content', project.id] });
                toast.success('Document deleted');
                void navigate(`/app/p/${project.id}/content`);
              }}
              trigger={
                <Button variant="outline" className="w-full text-destructive">
                  <Trash2 /> Delete document
                </Button>
              }
            />
          ) : null}
        </div>
      </div>
    </>
  );
}
