import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MessageSquarePlus, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import {
  LOCAL_POST_CTA_LABELS,
  LOCAL_POST_CTA_TYPES,
  LOCAL_POST_STATUS_LABELS,
  type LocalPostCtaType,
  type LocalPostDto,
  type LocationDto,
} from '@surfaced/shared';
import { useProject } from '@/app/project-scope';
import { PageHeader } from '@/components/app/page';
import { EstimateBadge, StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeaderRow } from '@/components/ui/card';
import { Dialog, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/dialog';
import { Alert, EmptyState, ErrorState, LoadingBlock } from '@/components/ui/feedback';
import { Field, Input, NativeSelect, Textarea } from '@/components/ui/form';
import { api, errorMessage } from '@/lib/api';
import { useCan } from '@/lib/auth';
import type { LlmProviderStatusDto } from '@/lib/types';

const UNPUBLISHED = ['DRAFT', 'AWAITING_APPROVAL', 'SCHEDULED', 'FAILED'];

function CreateDialog({
  open,
  onOpenChange,
  locationId,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  locationId: string;
}) {
  const project = useProject();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<'write' | 'ai'>('write');
  const [summary, setSummary] = useState('');
  const [topic, setTopic] = useState('');
  const [provider, setProvider] = useState('');
  const [ctaType, setCtaType] = useState<LocalPostCtaType>('NONE');
  const [ctaUrl, setCtaUrl] = useState('');
  const [scheduledAt, setScheduledAt] = useState('');

  const providers = useQuery({
    queryKey: ['local-post-providers', project.id],
    queryFn: () => api.get<LlmProviderStatusDto[]>(`/projects/${project.id}/local/post-providers`),
    enabled: open,
  });
  const configured = (providers.data ?? []).filter((p) => p.configured);
  const effectiveProvider = provider || configured.find((p) => p.isDefault)?.key || configured[0]?.key || '';

  const create = useMutation({
    mutationFn: () =>
      api.post(`/projects/${project.id}/local/posts`, {
        locationId,
        generate: mode === 'ai',
        summary: mode === 'write' ? summary.trim() : undefined,
        topic: mode === 'ai' ? topic.trim() || undefined : undefined,
        provider: mode === 'ai' ? effectiveProvider || undefined : undefined,
        ctaType,
        ctaUrl: ctaType === 'NONE' ? null : ctaUrl.trim() || null,
        scheduledAt: scheduledAt ? new Date(scheduledAt).toISOString() : null,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['local-posts', project.id] });
      onOpenChange(false);
      setSummary('');
      setTopic('');
      setCtaUrl('');
      setCtaType('NONE');
      setScheduledAt('');
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader
          title="New Business Profile post"
          description="Draft a post for Google. It is published only after it is approved; AI drafts are suggestions you edit, never auto-posted."
        />
        <div className="grid gap-4">
          <div className="flex gap-2">
            <Button variant={mode === 'write' ? 'primary' : 'outline'} size="sm" onClick={() => setMode('write')}>
              Write it
            </Button>
            <Button variant={mode === 'ai' ? 'primary' : 'outline'} size="sm" onClick={() => setMode('ai')}>
              <Sparkles /> Draft with AI
            </Button>
          </div>
          {mode === 'ai' ? (
            <>
              {configured.length > 1 ? (
                <Field label="Run on">
                  <NativeSelect value={effectiveProvider} onChange={(e) => setProvider(e.target.value)}>
                    {configured.map((p) => (
                      <option key={p.key} value={p.key}>
                        {p.label}
                        {p.isDefault ? ' (default)' : ''}
                      </option>
                    ))}
                  </NativeSelect>
                </Field>
              ) : null}
              <Field label="What is the post about?" description="The AI drafts from this; review and edit before publishing.">
                <Input value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="e.g. weekend gold-exchange offer" />
              </Field>
            </>
          ) : (
            <Field label="Post text" description="Up to 1500 characters. No links or phone numbers in the text — use a button below.">
              <Textarea rows={5} value={summary} onChange={(e) => setSummary(e.target.value)} maxLength={1500} />
            </Field>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Button" optional>
              <NativeSelect value={ctaType} onChange={(e) => setCtaType(e.target.value as LocalPostCtaType)}>
                {LOCAL_POST_CTA_TYPES.map((c) => (
                  <option key={c} value={c}>
                    {LOCAL_POST_CTA_LABELS[c]}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            {ctaType !== 'NONE' ? (
              <Field label="Button link">
                <Input type="url" placeholder="https://" value={ctaUrl} onChange={(e) => setCtaUrl(e.target.value)} />
              </Field>
            ) : null}
          </div>
          <Field label="Schedule for" optional description="Leave empty to publish as soon as it is approved.">
            <Input type="datetime-local" value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)} />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => create.mutate()}
            loading={create.isPending}
            disabled={mode === 'write' ? summary.trim().length === 0 : false}
          >
            Create draft
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PostCard({ post }: { post: LocalPostDto }) {
  const project = useProject();
  const queryClient = useQueryClient();
  const canPublish = useCan('local.publish');
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['local-posts', project.id] });
  const act = useMutation({
    mutationFn: (action: 'request-approval' | 'publish' | 'discard') =>
      action === 'discard'
        ? api.delete(`/projects/${project.id}/local/posts/${post.id}`)
        : api.post(`/projects/${project.id}/local/posts/${post.id}/${action}`),
    onSuccess: () => void invalidate(),
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Card>
      <CardContent className="grid gap-2">
        <div className="flex items-center justify-between gap-2">
          <StatusBadge status={post.status} label={LOCAL_POST_STATUS_LABELS[post.status as never] ?? post.status} />
          {post.origin === 'AI' ? <EstimateBadge label="AI draft" /> : null}
        </div>
        <p className="whitespace-pre-wrap text-sm">{post.summary}</p>
        {post.ctaType && post.ctaType !== 'NONE' ? (
          <p className="text-xs text-muted-foreground">
            Button: {LOCAL_POST_CTA_LABELS[post.ctaType as never] ?? post.ctaType}
            {post.ctaUrl ? ` → ${post.ctaUrl}` : ''}
          </p>
        ) : null}
        {post.scheduledAt ? (
          <p className="text-xs text-muted-foreground">Scheduled for {new Date(post.scheduledAt).toLocaleString()}</p>
        ) : null}
        {post.status === 'PUBLISHED' && post.searchUrl ? (
          <a href={post.searchUrl} target="_blank" rel="noreferrer" className="text-xs text-primary hover:underline">
            View on Google
          </a>
        ) : null}
        {post.publishError ? <Alert tone="danger">{post.publishError}</Alert> : null}
        {UNPUBLISHED.includes(post.status) ? (
          <div className="flex flex-wrap gap-2 pt-1">
            {['DRAFT', 'FAILED'].includes(post.status) ? (
              <Button size="sm" variant="outline" onClick={() => act.mutate('request-approval')} loading={act.isPending}>
                Request approval
              </Button>
            ) : null}
            {canPublish && ['AWAITING_APPROVAL', 'SCHEDULED', 'FAILED'].includes(post.status) ? (
              <Button size="sm" onClick={() => act.mutate('publish')} loading={act.isPending}>
                {post.scheduledAt && new Date(post.scheduledAt).getTime() > Date.now() ? 'Schedule' : 'Publish'}
              </Button>
            ) : null}
            <Button size="sm" variant="ghost" onClick={() => act.mutate('discard')} loading={act.isPending}>
              Discard
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

export default function LocalPostsPage() {
  const project = useProject();
  const canManage = useCan('local.manage');
  const [dialog, setDialog] = useState(false);
  const [locationId, setLocationId] = useState<string>('');

  const locations = useQuery({
    queryKey: ['locations', project.id],
    queryFn: () => api.get<LocationDto[]>(`/projects/${project.id}/locations`),
  });
  const active = locationId || locations.data?.[0]?.id || '';
  const posts = useQuery({
    queryKey: ['local-posts', project.id, active],
    queryFn: () => api.get<LocalPostDto[]>(`/projects/${project.id}/local/posts?locationId=${active}`),
    enabled: Boolean(active),
  });

  return (
    <>
      <PageHeader
        title="Business Profile posts"
        description="Draft, schedule and publish Google Business Profile posts. Every post is approved before it is published to Google; nothing is posted automatically without an approved draft."
        actions={
          canManage && active ? (
            <Button onClick={() => setDialog(true)}>
              <MessageSquarePlus /> New post
            </Button>
          ) : null
        }
      />
      {locations.isPending ? (
        <LoadingBlock rows={3} />
      ) : locations.isError ? (
        <ErrorState error={locations.error} onRetry={() => void locations.refetch()} />
      ) : (locations.data?.length ?? 0) === 0 ? (
        <Card>
          <CardContent>
            <EmptyState
              icon={MessageSquarePlus}
              title="Add a location first"
              description="Business Profile posts are published to a location’s Google profile. Add a location, then connect its Business Profile."
            />
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-5">
          {(locations.data?.length ?? 0) > 1 ? (
            <Card>
              <CardHeaderRow
                title="Location"
                actions={
                  <NativeSelect
                    value={active}
                    onChange={(e) => setLocationId(e.target.value)}
                    className="h-8 w-56 text-[13px]"
                    aria-label="Location"
                  >
                    {locations.data?.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name}
                      </option>
                    ))}
                  </NativeSelect>
                }
              />
            </Card>
          ) : null}
          {posts.isPending ? (
            <LoadingBlock rows={3} />
          ) : posts.isError ? (
            <ErrorState error={posts.error} onRetry={() => void posts.refetch()} />
          ) : (posts.data?.length ?? 0) === 0 ? (
            <Card>
              <CardContent>
                <EmptyState
                  icon={MessageSquarePlus}
                  title="No posts yet"
                  description="Draft your first Business Profile post — write it yourself or let AI suggest one — then send it for approval."
                  action={canManage ? <Button onClick={() => setDialog(true)}>New post</Button> : undefined}
                />
              </CardContent>
            </Card>
          ) : (
            <div className="grid gap-3">
              {posts.data?.map((p) => <PostCard key={p.id} post={p} />)}
            </div>
          )}
        </div>
      )}
      {active ? (
        <CreateDialog open={dialog} onOpenChange={setDialog} locationId={active} />
      ) : null}
    </>
  );
}
