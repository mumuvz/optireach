import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, Send, Sparkles, Star, Trash2, Upload } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import type { BusinessReviewDto, ReviewReplyDto } from '@surfaced/shared';
import { Badge, StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/dialog';
import { Alert } from '@/components/ui/feedback';
import { Input, Textarea } from '@/components/ui/form';
import { api, errorMessage } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { formatDate, formatDateTime } from '@/lib/format';

export function Stars({ rating }: { rating: number | null }) {
  if (rating === null) return <span className="text-xs text-muted-foreground">No rating</span>;
  return (
    <span className="inline-flex items-center gap-0.5" role="img" aria-label={`${rating} out of 5 stars`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <Star
          key={n}
          aria-hidden
          className={
            n <= rating ? 'size-3.5 fill-amber-500 text-amber-500' : 'size-3.5 text-muted-foreground/40'
          }
        />
      ))}
    </span>
  );
}

function originLabel(reply: ReviewReplyDto): string {
  if (reply.origin === 'HUMAN') return `Written by ${reply.createdBy?.name ?? 'a team member'}`;
  if (reply.model === 'dev-template') return 'Development template (not AI-generated)';
  return `AI draft (${reply.model ?? 'model'}), check before sending`;
}

const EDITABLE = new Set(['DRAFT', 'AWAITING_APPROVAL', 'FAILED']);

/** A review with its Google reply, or the reply draft and its approval workflow. */
export function ReviewCard({
  projectId,
  review,
  onChanged,
}: {
  projectId: string;
  review: BusinessReviewDto;
  onChanged: () => void;
}) {
  const canManage = useCan('local.manage');
  const canPublish = useCan('local.publish');
  const queryClient = useQueryClient();
  const draft = review.draft;
  const [text, setText] = useState(draft?.comment ?? '');
  const [writing, setWriting] = useState(false);
  const [guidance, setGuidance] = useState('');
  const refresh = () => {
    onChanged();
    void queryClient.invalidateQueries({ queryKey: ['approvals'] });
  };
  const onError = (e: unknown) => toast.error(errorMessage(e));
  const create = useMutation({
    mutationFn: (body: { comment?: string; generate?: boolean; instructions?: string }) =>
      api.post<ReviewReplyDto>(`/projects/${projectId}/reviews/${review.id}/replies`, body),
    onSuccess: (r) => {
      setText(r.comment);
      setWriting(false);
      refresh();
    },
    onError,
  });
  const save = useMutation({
    mutationFn: () =>
      api.patch<ReviewReplyDto>(`/projects/${projectId}/review-replies/${draft!.id}`, { comment: text }),
    onSuccess: () => {
      toast.success('Draft saved');
      refresh();
    },
    onError,
  });
  const askApproval = useMutation({
    mutationFn: async () => {
      if (text !== draft!.comment)
        await api.patch(`/projects/${projectId}/review-replies/${draft!.id}`, { comment: text });
      return api.post<ReviewReplyDto>(`/projects/${projectId}/review-replies/${draft!.id}/request-approval`);
    },
    onSuccess: () => {
      toast.success('Sent for approval', {
        description: 'Approvers were notified. Nothing is published until it is approved.',
      });
      refresh();
    },
    onError,
  });
  const publish = useMutation({
    mutationFn: () => api.post<ReviewReplyDto>(`/projects/${projectId}/review-replies/${draft!.id}/publish`),
    onSuccess: () => {
      toast.success('Reply published on Google');
      refresh();
    },
    onError: (e) => {
      onError(e);
      refresh();
    },
  });
  const changed = draft ? text !== draft.comment : false;
  const editable = draft ? EDITABLE.has(draft.status) && canManage : false;
  const busy = create.isPending || save.isPending || askApproval.isPending || publish.isPending;

  return (
    <Card className="space-y-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Stars rating={review.starRating} />
          <span className="text-sm font-medium">
            {review.isAnonymous ? 'Anonymous' : (review.reviewerName ?? 'Google user')}
          </span>
          <span className="text-xs text-muted-foreground">{formatDate(review.createTime)}</span>
        </div>
        {review.reply ? <Badge tone="success">Answered</Badge> : <Badge tone="warning">No reply yet</Badge>}
      </div>
      {review.comment ? (
        <p className="text-sm whitespace-pre-line">{review.comment}</p>
      ) : (
        <p className="text-sm text-muted-foreground italic">Rating only, no text.</p>
      )}
      {review.reply ? (
        <div className="rounded-md border-l-2 border-primary/40 bg-muted/40 px-3 py-2">
          <p className="text-xs font-medium text-muted-foreground">
            Reply on Google{review.reply.updateTime ? ` · ${formatDate(review.reply.updateTime)}` : ''}
          </p>
          <p className="mt-1 text-sm whitespace-pre-line">{review.reply.comment}</p>
        </div>
      ) : null}

      {draft && draft.status !== 'PUBLISHED' ? (
        <div className="space-y-2 rounded-md border border-border p-3">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="font-medium">Reply draft</span>
            <StatusBadge status={draft.status} />
            {draft.approval ? (
              <Link to={`/app/approvals/${draft.approval.id}`} className="text-primary hover:underline">
                Approval: {draft.approval.status.toLowerCase().replace(/_/g, ' ')}
                {draft.approval.coversCurrentText ? '' : ' (for an earlier text)'}
              </Link>
            ) : null}
            <span className="text-muted-foreground">{originLabel(draft)}</span>
          </div>
          {editable ? (
            <Textarea
              rows={4}
              value={text}
              onChange={(e) => setText(e.target.value)}
              aria-label={`Reply to ${review.reviewerName ?? 'this review'}`}
              maxLength={4000}
            />
          ) : (
            <p className="text-sm whitespace-pre-line">{draft.comment}</p>
          )}
          {draft.status === 'FAILED' && draft.publishError ? (
            <Alert tone="danger" title="Publishing failed">
              {draft.publishError}
            </Alert>
          ) : null}
          {draft.status === 'AWAITING_APPROVAL' &&
          draft.approval?.status === 'APPROVED' &&
          !draft.canPublish ? (
            <p className="text-xs text-muted-foreground">
              The text changed after approval. Send it for approval again.
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {editable && changed ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => save.mutate()}
                loading={save.isPending}
                disabled={busy}
              >
                <Check /> Save
              </Button>
            ) : null}
            {editable &&
            (draft.status !== 'AWAITING_APPROVAL' || changed || !draft.approval?.coversCurrentText) ? (
              <Button
                size="sm"
                onClick={() => askApproval.mutate()}
                loading={askApproval.isPending}
                disabled={busy || !text.trim()}
              >
                <Send /> Send for approval
              </Button>
            ) : null}
            {draft.canPublish && !changed ? (
              canPublish ? (
                <ConfirmDialog
                  title="Publish this reply on Google?"
                  description="It appears publicly under the review. You can edit or remove it later in Business Profile."
                  confirmLabel="Publish"
                  onConfirm={async () => {
                    await publish.mutateAsync();
                  }}
                  trigger={
                    <Button size="sm" loading={publish.isPending} disabled={busy}>
                      <Upload /> Publish to Google
                    </Button>
                  }
                />
              ) : (
                <span className="self-center text-xs text-muted-foreground">
                  Approved. An owner or admin can publish it.
                </span>
              )
            ) : null}
            {canManage && draft.status !== 'PUBLISHING' ? (
              <ConfirmDialog
                title="Discard this draft?"
                description="The draft and any pending approval are withdrawn. Nothing changes on Google."
                confirmLabel="Discard"
                destructive
                onConfirm={async () => {
                  await api.delete(`/projects/${projectId}/review-replies/${draft.id}`);
                  setText('');
                  refresh();
                }}
                trigger={
                  <Button size="sm" variant="ghost" disabled={busy}>
                    <Trash2 /> Discard
                  </Button>
                }
              />
            ) : null}
          </div>
        </div>
      ) : draft?.status === 'PUBLISHED' && !review.reply ? (
        <p className="text-xs text-muted-foreground">
          Reply published {formatDateTime(draft.publishedAt)}; it shows here after the next sync.
        </p>
      ) : null}

      {!review.reply && (!draft || draft.status === 'PUBLISHED') && canManage ? (
        writing ? (
          <div className="space-y-2">
            <Textarea
              rows={4}
              value={text}
              onChange={(e) => setText(e.target.value)}
              aria-label="Your reply"
              maxLength={4000}
            />
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={() => create.mutate({ comment: text })}
                loading={create.isPending}
                disabled={!text.trim()}
              >
                Save draft
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setWriting(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <Input
              className="h-8 max-w-sm text-xs"
              placeholder="Guidance for the draft (optional), e.g. invite them back"
              value={guidance}
              onChange={(e) => setGuidance(e.target.value)}
              aria-label="Guidance for the AI draft"
              maxLength={500}
            />
            <Button
              size="sm"
              variant="outline"
              onClick={() => create.mutate({ generate: true, instructions: guidance.trim() || undefined })}
              loading={create.isPending}
            >
              <Sparkles /> Draft a reply
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setText('');
                setWriting(true);
              }}
            >
              Write a reply
            </Button>
          </div>
        )
      ) : null}
    </Card>
  );
}
