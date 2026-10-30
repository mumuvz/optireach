import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, ShieldCheck } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { toast } from 'sonner';
import {
  APPROVAL_ENTITY_LABELS,
  APPROVAL_STATUS_LABELS,
  type ApprovalEntityType,
  type ApprovalRequestDetailDto,
  type ApprovalRequestDto,
  type ApprovalStatus,
} from '@surfaced/shared';
import { useWorkspaceId } from '@/app/queries';
import { PageHeader, QueryState } from '@/components/app/page';
import { StatusBadge, humanize } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Alert, EmptyState } from '@/components/ui/feedback';
import { Label, NativeSelect, Textarea } from '@/components/ui/form';
import { Pagination, TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api, errorMessage } from '@/lib/api';
import { useMe } from '@/lib/auth';
import { formatDateTime, formatRelative } from '@/lib/format';

const entityLabel = (type: string) => APPROVAL_ENTITY_LABELS[type as ApprovalEntityType] ?? humanize(type);
const statusLabel = (status: ApprovalStatus) => APPROVAL_STATUS_LABELS[status] ?? humanize(status);

/** Renders the approved content: nested objects as labeled rows, before/after pairs side by side. */
export function SnapshotView({ value, depth = 0 }: { value: unknown; depth?: number }): ReactNode {
  if (value === null || value === undefined || value === '')
    return <span className="text-muted-foreground">Empty</span>;
  if (typeof value !== 'object')
    return <span className="text-sm break-words whitespace-pre-wrap">{String(value)}</span>;
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="text-muted-foreground">None</span>;
    return (
      <ul className="space-y-1.5">
        {value.map((item, i) => (
          <li key={i} className="rounded-md border border-border p-2">
            <SnapshotView value={item} depth={depth + 1} />
          </li>
        ))}
      </ul>
    );
  }
  const record = value as Record<string, unknown>;
  if ('before' in record && 'after' in record && Object.keys(record).length <= 3) {
    return (
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="rounded-md border border-border bg-muted/40 p-2">
          <p className="mb-1 text-xs font-medium text-muted-foreground">Current</p>
          <SnapshotView value={record.before} depth={depth + 1} />
        </div>
        <div className="rounded-md border border-primary/30 bg-accent/30 p-2">
          <p className="mb-1 text-xs font-medium text-muted-foreground">Proposed</p>
          <SnapshotView value={record.after} depth={depth + 1} />
        </div>
      </div>
    );
  }
  return (
    <dl className={depth === 0 ? 'divide-y divide-border' : 'space-y-1.5'}>
      {Object.entries(record).map(([key, v]) => (
        <div
          key={key}
          className={depth === 0 ? 'grid gap-1 py-2.5 sm:grid-cols-[12rem_1fr]' : 'grid gap-0.5'}
        >
          <dt className="text-xs font-medium text-muted-foreground">
            {humanize(key.replace(/([a-z])([A-Z])/g, '$1_$2'))}
          </dt>
          <dd className="min-w-0">
            <SnapshotView value={v} depth={depth + 1} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

function ApprovalTable({ rows, showWorkspace }: { rows: ApprovalRequestDto[]; showWorkspace: boolean }) {
  return (
    <Table>
      <THead>
        <TR>
          <TH>Request</TH>
          {showWorkspace ? <TH>Workspace</TH> : null}
          <TH>Requested</TH>
          <TH>Status</TH>
        </TR>
      </THead>
      <TBody>
        {rows.map((a) => (
          <TR key={a.id}>
            <TD>
              <Link to={`/app/approvals/${a.id}`} className="font-medium hover:text-primary">
                {a.title}
              </Link>
              <span className="block text-xs text-muted-foreground">{entityLabel(a.entityType)}</span>
            </TD>
            {showWorkspace ? <TD className="text-sm">{a.workspaceName}</TD> : null}
            <TD className="text-xs text-muted-foreground">
              {a.requestedBy?.name ?? 'System'} · {formatRelative(a.requestedAt)}
            </TD>
            <TD>
              <StatusBadge status={a.status} label={statusLabel(a.status)} />
              {a.canDecide ? (
                <span className="ml-2 text-xs font-medium text-primary">Your decision</span>
              ) : null}
            </TD>
          </TR>
        ))}
      </TBody>
    </Table>
  );
}

export function ApprovalsPage() {
  const workspaceId = useWorkspaceId();
  const [tab, setTab] = useState<'mine' | 'workspace'>('mine');
  const [status, setStatus] = useState<string>('PENDING');
  const [page, setPage] = useState(1);
  const query = useQuery({
    queryKey: ['approvals', tab, workspaceId, status, page],
    queryFn: () =>
      api.page<ApprovalRequestDto>(
        '/approvals',
        tab === 'mine'
          ? { decidable: true, page, pageSize: 25 }
          : { workspaceId, status: status || undefined, page, pageSize: 25 },
      ),
    enabled: tab === 'mine' || Boolean(workspaceId),
    placeholderData: keepPreviousData,
  });
  return (
    <>
      <PageHeader
        title="Approvals"
        description="Changes to Business Profiles, product data, websites and published content wait here until the client decides. Approving authorizes publishing exactly the content shown."
      />
      <Tabs
        value={tab}
        onValueChange={(v) => {
          setTab(v as 'mine' | 'workspace');
          setPage(1);
        }}
      >
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <TabsList>
            <TabsTrigger value="mine">Waiting for my decision</TabsTrigger>
            <TabsTrigger value="workspace">All in this workspace</TabsTrigger>
          </TabsList>
          {tab === 'workspace' ? (
            <div className="flex items-center gap-2">
              <Label htmlFor="approval-status" className="text-sm">
                Status
              </Label>
              <NativeSelect
                id="approval-status"
                value={status}
                onChange={(e) => {
                  setStatus(e.target.value);
                  setPage(1);
                }}
                className="h-9 w-48"
              >
                <option value="">All statuses</option>
                {(
                  ['PENDING', 'APPROVED', 'CHANGES_REQUESTED', 'REJECTED', 'WITHDRAWN', 'SUPERSEDED'] as const
                ).map((s) => (
                  <option key={s} value={s}>
                    {statusLabel(s)}
                  </option>
                ))}
              </NativeSelect>
            </div>
          ) : null}
        </div>
      </Tabs>
      <Card>
        <QueryState query={query}>
          {(data) =>
            data.items.length ? (
              <>
                <ApprovalTable rows={data.items} showWorkspace={tab === 'mine'} />
                <Pagination meta={data.meta} onPage={setPage} />
              </>
            ) : (
              <CardContent>
                <EmptyState
                  icon={CheckCircle2}
                  title={tab === 'mine' ? 'Nothing is waiting for your decision' : 'No approval requests'}
                  description={
                    tab === 'mine'
                      ? 'Requests that you are entitled to decide appear here, across every workspace you can reach.'
                      : 'Requests appear when someone proposes a change that will be published outside Surfaced.'
                  }
                />
              </CardContent>
            )
          }
        </QueryState>
      </Card>
    </>
  );
}

export function ApprovalDetailPage() {
  const { approvalId } = useParams();
  const queryClient = useQueryClient();
  const me = useMe();
  const [note, setNote] = useState('');
  const query = useQuery({
    queryKey: ['approval', approvalId],
    queryFn: () => api.get<ApprovalRequestDetailDto>(`/approvals/${approvalId}`),
    enabled: Boolean(approvalId),
  });
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['approval', approvalId] });
    void queryClient.invalidateQueries({ queryKey: ['approvals'] });
  };
  const decide = useMutation({
    mutationFn: (decision: 'APPROVED' | 'REJECTED' | 'CHANGES_REQUESTED') =>
      api.post(`/approvals/${approvalId}/decision`, { decision, note: note.trim() || undefined }),
    onSuccess: (_d, decision) => {
      toast.success(
        decision === 'APPROVED' ? 'Approved' : decision === 'REJECTED' ? 'Rejected' : 'Changes requested',
      );
      setNote('');
      refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const withdraw = useMutation({
    mutationFn: () => api.post(`/approvals/${approvalId}/withdraw`),
    onSuccess: () => {
      toast.success('Request withdrawn');
      refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <QueryState query={query} rows={6}>
      {(a) => (
        <>
          <PageHeader
            title={a.title}
            breadcrumbs={[{ label: 'Approvals', to: '/app/approvals' }, { label: entityLabel(a.entityType) }]}
            description={`${entityLabel(a.entityType)} in ${a.workspaceName}. Requested by ${a.requestedBy?.name ?? 'the system'} ${formatRelative(a.requestedAt)}.`}
            actions={<StatusBadge status={a.status} label={statusLabel(a.status)} />}
          />
          <div className="grid gap-5 lg:grid-cols-[1fr_22rem]">
            <Card>
              <CardContent className="space-y-4 pt-5">
                {a.summary ? <p className="text-sm leading-relaxed">{a.summary}</p> : null}
                <div>
                  <h2 className="mb-2 text-sm font-semibold">What will be published</h2>
                  <SnapshotView value={a.snapshot} />
                </div>
                <p className="flex items-start gap-2 text-xs text-muted-foreground">
                  <ShieldCheck className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                  The approval covers this exact content (fingerprint {a.snapshotHash.slice(0, 12)}). If
                  anything changes before publishing, a new approval is needed.
                </p>
              </CardContent>
            </Card>
            <div className="space-y-5">
              <Card>
                <CardContent className="space-y-3 pt-5">
                  {a.status === 'PENDING' && a.canDecide ? (
                    <>
                      <Label htmlFor="decision-note">Note for the team</Label>
                      <Textarea
                        id="decision-note"
                        rows={3}
                        value={note}
                        onChange={(e) => setNote(e.target.value)}
                        maxLength={2000}
                        placeholder="Required when you request changes or reject"
                      />
                      <div className="flex flex-wrap gap-2">
                        <Button
                          loading={decide.isPending && decide.variables === 'APPROVED'}
                          onClick={() => decide.mutate('APPROVED')}
                        >
                          Approve
                        </Button>
                        <Button
                          variant="outline"
                          disabled={!note.trim()}
                          loading={decide.isPending && decide.variables === 'CHANGES_REQUESTED'}
                          onClick={() => decide.mutate('CHANGES_REQUESTED')}
                        >
                          Request changes
                        </Button>
                        <Button
                          variant="ghost"
                          disabled={!note.trim()}
                          loading={decide.isPending && decide.variables === 'REJECTED'}
                          onClick={() => decide.mutate('REJECTED')}
                        >
                          Reject
                        </Button>
                      </div>
                    </>
                  ) : a.status === 'PENDING' ? (
                    <Alert tone="info" title="Waiting for the client">
                      Owners, admins and client users of this workspace decide this request
                      {a.requestedBy?.id === me.data?.user.id ? ', not the person who requested it' : ''}.
                    </Alert>
                  ) : (
                    <div className="text-sm">
                      <p>
                        {statusLabel(a.status)}
                        {a.decidedBy ? ` by ${a.decidedBy.name}` : ''}
                        {a.decidedAt ? ` on ${formatDateTime(a.decidedAt)}` : ''}
                        {a.decidedVia === 'AGENCY_DELEGATED' ? ' (approval delegated to the agency)' : ''}.
                      </p>
                      {a.decisionNote ? (
                        <p className="mt-2 rounded-md bg-muted p-2 text-[13px]">{a.decisionNote}</p>
                      ) : null}
                    </div>
                  )}
                  {a.status === 'PENDING' && a.requestedBy?.id === me.data?.user.id ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      loading={withdraw.isPending}
                      onClick={() => withdraw.mutate()}
                    >
                      Withdraw request
                    </Button>
                  ) : null}
                </CardContent>
              </Card>
              {a.history.length ? (
                <Card>
                  <CardContent className="pt-5">
                    <h2 className="mb-2 text-sm font-semibold">Earlier requests for the same item</h2>
                    <ul className="space-y-2 text-sm">
                      {a.history.map((h) => (
                        <li key={h.id} className="flex items-start justify-between gap-2">
                          <Link to={`/app/approvals/${h.id}`} className="hover:text-primary">
                            {formatDateTime(h.requestedAt)}
                          </Link>
                          <StatusBadge status={h.status} label={statusLabel(h.status)} />
                        </li>
                      ))}
                    </ul>
                  </CardContent>
                </Card>
              ) : null}
            </div>
          </div>
        </>
      )}
    </QueryState>
  );
}

export default ApprovalsPage;
