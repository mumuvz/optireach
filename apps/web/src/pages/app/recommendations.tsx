import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, ListChecks, RefreshCw } from 'lucide-react';
import { Dialog as RadixDialog } from 'radix-ui';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { toast } from 'sonner';
import {
  ISSUE_SEVERITIES,
  RECOMMENDATION_CATEGORIES,
  RECOMMENDATION_CATEGORY_LABELS,
  RECOMMENDATION_EFFORT_LABELS,
  RECOMMENDATION_EFFORTS,
  RECOMMENDATION_OWNER_ROLE_LABELS,
  RECOMMENDATION_OWNER_ROLES,
  RECOMMENDATION_STATUSES,
  RECOMMENDATION_STATUS_LABELS,
  type RecommendationCategory,
  type RecommendationEffort,
  type RecommendationOwnerRole,
  type RecommendationStatus,
  type WorkspaceMemberDto,
} from '@surfaced/shared';
import { useRecommendations } from '@/app/hooks';
import { useProject } from '@/app/project-scope';
import { useWorkspaceId } from '@/app/queries';
import { Evidence } from '@/components/app/evidence';
import { ExportPdfButton } from '@/components/app/export-pdf-button';
import { PageHeader } from '@/components/app/page';
import { Badge, SeverityBadge, StatusBadge, humanize } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { SheetContent } from '@/components/ui/dialog';
import { EmptyState, ErrorState, LoadingBlock } from '@/components/ui/feedback';
import { Label, NativeSelect, Textarea } from '@/components/ui/form';
import { Pagination, TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api, errorMessage } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { formatDateTime, formatNumber, formatRelative } from '@/lib/format';
import type { RecommendationDto } from '@/lib/types';

const NEXT_ACTIONS: Record<RecommendationStatus, { to: RecommendationStatus; label: string }[]> = {
  OPEN: [
    { to: 'PLANNED', label: 'Plan' },
    { to: 'IN_PROGRESS', label: 'Start' },
    { to: 'BLOCKED', label: 'Block' },
    { to: 'DISMISSED', label: 'Dismiss' },
  ],
  PLANNED: [
    { to: 'IN_PROGRESS', label: 'Start' },
    { to: 'BLOCKED', label: 'Block' },
    { to: 'OPEN', label: 'Back to open' },
  ],
  IN_PROGRESS: [
    { to: 'AWAITING_APPROVAL', label: 'Request approval' },
    { to: 'COMPLETED', label: 'Mark complete' },
    { to: 'BLOCKED', label: 'Block' },
    { to: 'OPEN', label: 'Back to open' },
  ],
  AWAITING_APPROVAL: [
    { to: 'COMPLETED', label: 'Mark complete' },
    { to: 'IN_PROGRESS', label: 'Back to in progress' },
  ],
  COMPLETED: [
    { to: 'VERIFIED', label: 'Verify the fix' },
    { to: 'OPEN', label: 'Reopen' },
  ],
  VERIFIED: [{ to: 'OPEN', label: 'Reopen' }],
  DISMISSED: [{ to: 'OPEN', label: 'Reopen' }],
  BLOCKED: [
    { to: 'IN_PROGRESS', label: 'Unblock & start' },
    { to: 'OPEN', label: 'Unblock' },
  ],
};

function Detail({ id, onClose }: { id: string; onClose: () => void }) {
  const project = useProject();
  const workspaceId = useWorkspaceId();
  const queryClient = useQueryClient();
  const canUpdate = useCan('recommendation.update');
  const [reason, setReason] = useState('');
  const rec = useQuery({
    queryKey: ['recommendation', id],
    queryFn: () => api.get<RecommendationDto>(`/recommendations/${id}`),
  });
  const members = useQuery({
    queryKey: ['members', workspaceId],
    queryFn: () => api.get<WorkspaceMemberDto[]>(`/workspaces/${workspaceId}/members`),
    enabled: Boolean(workspaceId),
  });
  const update = useMutation({
    mutationFn: (body: {
      status?: RecommendationStatus;
      assigneeId?: string | null;
      ownerRole?: string | null;
      effort?: string | null;
      verification?: string | null;
      dismissedReason?: string;
      blockedReason?: string;
    }) => api.patch<RecommendationDto>(`/recommendations/${id}`, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['recommendation', id] });
      void queryClient.invalidateQueries({ queryKey: ['recommendations', project.id] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  if (rec.isPending) return <LoadingBlock className="p-6" rows={6} />;
  if (rec.isError) return <ErrorState className="m-6" error={rec.error} onRetry={() => void rec.refetch()} />;
  const r = rec.data;
  return (
    <div className="flex flex-col gap-5 p-6">
      <div className="pr-6">
        <RadixDialog.Title className="text-lg leading-snug font-semibold">{r.title}</RadixDialog.Title>
        <RadixDialog.Description className="mt-2 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <SeverityBadge severity={r.severity} />
          <StatusBadge
            status={r.status}
            label={RECOMMENDATION_STATUS_LABELS[r.status as RecommendationStatus]}
          />
          <span>{RECOMMENDATION_CATEGORY_LABELS[r.category as RecommendationCategory] ?? r.category}</span>
          <span>· from {humanize(r.source)}</span>
        </RadixDialog.Description>
      </div>
      <section>
        <h3 className="text-sm font-semibold">Expected benefit</h3>
        <p className="mt-1 text-sm leading-relaxed">
          <Badge
            tone={r.benefitLevel === 'HIGH' ? 'success' : r.benefitLevel === 'MEDIUM' ? 'info' : 'neutral'}
            className="mr-1.5"
          >
            {humanize(r.benefitLevel)}
          </Badge>
          {r.expectedBenefit}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          A qualitative estimate; results depend on your site and on search engines and AI providers.
        </p>
      </section>
      <section>
        <h3 className="text-sm font-semibold">Proposed fix</h3>
        <p className="mt-1 text-sm leading-relaxed">{r.proposedFix}</p>
      </section>
      {r.verification ? (
        <section>
          <h3 className="text-sm font-semibold">How to verify</h3>
          <p className="mt-1 text-sm leading-relaxed">{r.verification}</p>
        </section>
      ) : null}
      <div className="flex flex-wrap gap-2 text-xs">
        {r.ownerRole ? (
          <Badge tone="neutral">Owner: {RECOMMENDATION_OWNER_ROLE_LABELS[r.ownerRole as RecommendationOwnerRole] ?? r.ownerRole}</Badge> // prettier-ignore
        ) : null}
        {r.effort ? (
          <Badge tone="neutral">Effort: {RECOMMENDATION_EFFORT_LABELS[r.effort as RecommendationEffort]?.split(' (')[0] ?? r.effort}</Badge> // prettier-ignore
        ) : null}
        {r.blockedReason ? <Badge tone="warning">Blocked: {r.blockedReason}</Badge> : null}
      </div>
      {r.relatedUrl ? (
        <a
          href={r.relatedUrl}
          target="_blank"
          rel="noopener noreferrer nofollow"
          className="inline-flex items-center gap-1 font-mono text-xs break-all text-primary hover:underline"
        >
          {r.relatedUrl} <ExternalLink className="size-3 shrink-0" aria-hidden />
        </a>
      ) : null}
      <section>
        <h3 className="mb-1 text-sm font-semibold">Evidence</h3>
        <Evidence value={r.evidence} />
      </section>
      {canUpdate ? (
        <section className="space-y-3 border-t border-border pt-4">
          <div className="grid gap-1.5">
            <Label htmlFor="rec-assignee">Assignee</Label>
            <NativeSelect
              id="rec-assignee"
              value={r.assignee?.id ?? ''}
              onChange={(e) => update.mutate({ assigneeId: e.target.value || null })}
              disabled={update.isPending}
            >
              <option value="">Unassigned</option>
              {members.data?.map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.name}
                </option>
              ))}
            </NativeSelect>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="rec-owner">Owner</Label>
              <NativeSelect
                id="rec-owner"
                value={r.ownerRole ?? ''}
                onChange={(e) => update.mutate({ ownerRole: e.target.value || null })}
                disabled={update.isPending}
              >
                <option value="">Not set</option>
                {RECOMMENDATION_OWNER_ROLES.map((o) => (
                  <option key={o} value={o}>
                    {RECOMMENDATION_OWNER_ROLE_LABELS[o]}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="rec-effort">Effort</Label>
              <NativeSelect
                id="rec-effort"
                value={r.effort ?? ''}
                onChange={(e) => update.mutate({ effort: e.target.value || null })}
                disabled={update.isPending}
              >
                <option value="">Not set</option>
                {RECOMMENDATION_EFFORTS.map((ef) => (
                  <option key={ef} value={ef}>
                    {RECOMMENDATION_EFFORT_LABELS[ef]}
                  </option>
                ))}
              </NativeSelect>
            </div>
          </div>
          {['OPEN', 'PLANNED', 'IN_PROGRESS'].includes(r.status) ? (
            <div className="grid gap-1.5">
              <Label htmlFor="rec-reason">Reason (for dismissing or blocking)</Label>
              <Textarea
                id="rec-reason"
                rows={2}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                maxLength={500}
                placeholder="Why it is blocked, or why you are dismissing it"
              />
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {NEXT_ACTIONS[r.status as RecommendationStatus].map((a) => {
              const needsReason = a.to === 'BLOCKED' && !reason.trim();
              return (
                <Button
                  key={a.to}
                  size="sm"
                  variant={a.to === 'DISMISSED' || a.to === 'BLOCKED' ? 'outline' : 'primary'}
                  disabled={needsReason}
                  loading={update.isPending && update.variables?.status === a.to}
                  onClick={() =>
                    update.mutate({
                      status: a.to,
                      dismissedReason: a.to === 'DISMISSED' && reason ? reason : undefined,
                      blockedReason: a.to === 'BLOCKED' ? reason : undefined,
                    })
                  }
                >
                  {a.label}
                </Button>
              );
            })}
          </div>
          {r.dismissedReason ? (
            <p className="text-xs text-muted-foreground">Dismissed: {r.dismissedReason}</p>
          ) : null}
          <p className="text-xs text-muted-foreground">
            Created {formatDateTime(r.createdAt)}
            {r.completedAt ? ` · completed ${formatDateTime(r.completedAt)}` : ''}
            {r.verifiedAt
              ? ` · verified ${formatDateTime(r.verifiedAt)}${r.verifiedBy ? ` by ${r.verifiedBy.name}` : ''}`
              : ''}
            . Audit recommendations complete automatically when a re-crawl confirms the fix; mark them
            Verified to confirm.
          </p>
        </section>
      ) : null}
      <Button variant="ghost" onClick={onClose}>
        Close
      </Button>
    </div>
  );
}

export default function RecommendationsPage() {
  const project = useProject();
  const queryClient = useQueryClient();
  const canUpdate = useCan('recommendation.update');
  const [params, setParams] = useSearchParams();
  const [status, setStatus] = useState('OPEN');
  const [category, setCategory] = useState('');
  const [severity, setSeverity] = useState('');
  const [page, setPage] = useState(1);
  const openId = params.get('open');
  const recs = useRecommendations(project.id, {
    page,
    pageSize: 25,
    status: status === 'ALL' ? undefined : status,
    category: category || undefined,
    severity: severity || undefined,
  });
  const regenerate = useMutation({
    mutationFn: () =>
      api.post<{
        audit: { created: number; updated: number; autoCompleted: number };
        visibility: { created: number; updated: number; autoCompleted: number };
        local: { created: number; updated: number; autoCompleted: number };
      }>(`/projects/${project.id}/recommendations/regenerate`),
    onSuccess: (r) => {
      const sum = (k: 'created' | 'updated' | 'autoCompleted') =>
        r.audit[k] + r.visibility[k] + r.local[k];
      toast.success('Recommendations refreshed', {
        description: `${sum('created')} new, ${sum('updated')} updated, ${sum('autoCompleted')} completed automatically.`,
      });
      void queryClient.invalidateQueries({ queryKey: ['recommendations', project.id] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const counts = recs.data?.data.byStatus ?? {};
  const setOpen = (id: string | null) => setParams(id ? { open: id } : {}, { replace: true });
  return (
    <>
      <PageHeader
        title="Recommendations"
        description="Prioritized actions from audit findings and AI visibility gaps. Each one links to its evidence; nothing is changed on your site automatically."
        actions={
          <>
            <ExportPdfButton module="recommendations" />
            {canUpdate ? (
              <Button variant="outline" onClick={() => regenerate.mutate()} loading={regenerate.isPending}>
                <RefreshCw /> Refresh from latest data
              </Button>
            ) : null}
          </>
        }
      />
      <Tabs value={status} onValueChange={(v) => (setPage(1), setStatus(v))}>
        <TabsList className="mb-4">
          {RECOMMENDATION_STATUSES.map((s) => (
            <TabsTrigger key={s} value={s}>
              {RECOMMENDATION_STATUS_LABELS[s]}{' '}
              <span className="text-muted-foreground tabular-nums">{formatNumber(counts[s] ?? 0)}</span>
            </TabsTrigger>
          ))}
          <TabsTrigger value="ALL">All</TabsTrigger>
        </TabsList>
      </Tabs>
      <Card>
        <div className="flex flex-wrap gap-2 p-4">
          <NativeSelect
            aria-label="Category"
            value={category}
            onChange={(e) => (setPage(1), setCategory(e.target.value))}
            className="w-56"
          >
            <option value="">All categories</option>
            {RECOMMENDATION_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {RECOMMENDATION_CATEGORY_LABELS[c]}
              </option>
            ))}
          </NativeSelect>
          <NativeSelect
            aria-label="Severity"
            value={severity}
            onChange={(e) => (setPage(1), setSeverity(e.target.value))}
            className="w-40"
          >
            <option value="">All severities</option>
            {ISSUE_SEVERITIES.map((s) => (
              <option key={s} value={s}>
                {humanize(s)}
              </option>
            ))}
          </NativeSelect>
        </div>
        {recs.isPending ? (
          <LoadingBlock className="px-5 pb-5" rows={6} />
        ) : recs.isError ? (
          <ErrorState className="mx-5 mb-5" error={recs.error} onRetry={() => void recs.refetch()} />
        ) : recs.data.data.items.length === 0 ? (
          <EmptyState
            className="mx-5 mb-5"
            icon={ListChecks}
            title="Nothing here"
            description="Recommendations are generated from completed audits and AI visibility observations."
          />
        ) : (
          <>
            <Table>
              <THead>
                <TR>
                  <TH>Recommendation</TH>
                  <TH>Severity</TH>
                  <TH>Benefit</TH>
                  <TH>Status</TH>
                  <TH>Assignee</TH>
                  <TH>Updated</TH>
                </TR>
              </THead>
              <TBody>
                {recs.data.data.items.map((r) => (
                  <TR key={r.id}>
                    <TD className="max-w-[28rem]">
                      <button
                        type="button"
                        onClick={() => setOpen(r.id)}
                        className="text-left font-medium hover:text-primary"
                      >
                        {r.title}
                      </button>
                      <span className="block text-xs text-muted-foreground">
                        {RECOMMENDATION_CATEGORY_LABELS[r.category as RecommendationCategory] ?? r.category}
                      </span>
                    </TD>
                    <TD>
                      <SeverityBadge severity={r.severity} />
                    </TD>
                    <TD className="text-xs">{humanize(r.benefitLevel)}</TD>
                    <TD>
                      <StatusBadge
                        status={r.status}
                        label={RECOMMENDATION_STATUS_LABELS[r.status as RecommendationStatus]}
                      />
                    </TD>
                    <TD className="text-xs">
                      {r.assignee?.name ?? <span className="text-muted-foreground">—</span>}
                    </TD>
                    <TD className="text-xs text-muted-foreground">{formatRelative(r.updatedAt)}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
            <Pagination meta={recs.data.meta} onPage={setPage} />
          </>
        )}
      </Card>
      <RadixDialog.Root open={Boolean(openId)} onOpenChange={(v) => !v && setOpen(null)}>
        <SheetContent className="w-[min(100vw-1rem,34rem)]">
          {openId ? <Detail id={openId} onClose={() => setOpen(null)} /> : null}
        </SheetContent>
      </RadixDialog.Root>
    </>
  );
}
