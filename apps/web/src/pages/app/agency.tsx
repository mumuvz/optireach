import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, Copy, Plus } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import type { AgencyLinkDto } from '@surfaced/shared';
import { useSwitchWorkspace, useWorkspaceId } from '@/app/queries';
import { MetricCard, PageHeader, QueryState } from '@/components/app/page';
import { Badge, StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ConfirmDialog, Dialog, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/dialog';
import { Alert, EmptyState } from '@/components/ui/feedback';
import { Checkbox, Field, Input, NativeSelect } from '@/components/ui/form';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { api, errorMessage } from '@/lib/api';
import { useCan, useCurrentMembership } from '@/lib/auth';
import { formatRelative } from '@/lib/format';

interface AgencyClientRow extends AgencyLinkDto {
  projects: number;
  pendingApprovals: number;
  openTasks: number;
  hasClientOwner: boolean;
}

interface AgencyOverview {
  agencyCode: string;
  eligibility: {
    eligible: boolean;
    isServiceProvider: boolean;
    planName: string;
    limit: number | null;
    used: number;
    reason: string | null;
  };
  clients: AgencyClientRow[];
}

function CreateClientDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const workspaceId = useWorkspaceId();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [billingMode, setBillingMode] = useState<'AGENCY' | 'CLIENT'>('AGENCY');
  const [approvalsDelegated, setApprovalsDelegated] = useState(false);
  const [contactEmail, setContactEmail] = useState('');
  const [contactRole, setContactRole] = useState<'CLIENT' | 'OWNER'>('CLIENT');
  const create = useMutation({
    mutationFn: () =>
      api.post(`/agency/${workspaceId}/clients`, {
        name,
        billingMode,
        approvalsDelegated,
        contactEmail: contactEmail || undefined,
        contactRole,
      }),
    onSuccess: () => {
      toast.success('Client workspace created', {
        description: contactEmail ? `An invitation was sent to ${contactEmail}.` : undefined,
      });
      void queryClient.invalidateQueries({ queryKey: ['agency', workspaceId] });
      void queryClient.invalidateQueries({ queryKey: ['me'] });
      onOpenChange(false);
      setName('');
      setContactEmail('');
    },
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader
          title="New client workspace"
          description="A separate workspace for one client: their own projects, approvals, reports and client users. Your team works in it through the agency."
        />
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <Field label="Client name">
            <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={120} />
          </Field>
          <Field
            label="Billing"
            description={
              billingMode === 'AGENCY'
                ? "The client workspace uses your agency's plan, and monthly allowances are shared."
                : 'The client workspace keeps its own plan (it starts on Free).'
            }
          >
            <NativeSelect
              value={billingMode}
              onChange={(e) => setBillingMode(e.target.value as 'AGENCY' | 'CLIENT')}
            >
              <option value="AGENCY">Billed to the agency</option>
              <option value="CLIENT">The client pays for its own plan</option>
            </NativeSelect>
          </Field>
          <label className="flex items-start gap-2 text-sm">
            <Checkbox
              checked={approvalsDelegated}
              onCheckedChange={(v) => setApprovalsDelegated(v === true)}
            />
            <span>
              The client delegates approvals to the agency
              <span className="block text-xs text-muted-foreground">
                Leave this off to have the client approve every change before it is published. The client can
                change it later.
              </span>
            </span>
          </label>
          <div className="grid gap-4 sm:grid-cols-[1fr_10rem]">
            <Field label="Invite the client (optional)" description="They receive an email invitation.">
              <Input type="email" value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} />
            </Field>
            <Field label="As">
              <NativeSelect
                value={contactRole}
                onChange={(e) => setContactRole(e.target.value as 'CLIENT' | 'OWNER')}
              >
                <option value="CLIENT">Client user</option>
                <option value="OWNER">Owner</option>
              </NativeSelect>
            </Field>
          </div>
          {create.isError ? <Alert tone="danger">{errorMessage(create.error)}</Alert> : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={create.isPending} disabled={name.trim().length < 2}>
              Create workspace
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default function AgencyPage() {
  const workspaceId = useWorkspaceId();
  const membership = useCurrentMembership();
  const canManage = useCan('agency.manage') && membership?.via === 'DIRECT';
  const queryClient = useQueryClient();
  const switcher = useSwitchWorkspace();
  const navigate = useNavigate();
  const [createOpen, setCreateOpen] = useState(false);
  const query = useQuery({
    queryKey: ['agency', workspaceId],
    queryFn: () => api.get<AgencyOverview>(`/agency/${workspaceId}/clients`),
    enabled: Boolean(workspaceId && canManage),
  });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['agency', workspaceId] });
  const accept = useMutation({
    mutationFn: (linkId: string) => api.post(`/agency/${workspaceId}/links/${linkId}/accept`),
    onSuccess: () => {
      toast.success('Client accepted');
      refresh();
      void queryClient.invalidateQueries({ queryKey: ['me'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const open = (clientWorkspaceId: string) =>
    switcher.mutate(clientWorkspaceId, {
      onSuccess: () => void navigate('/app'),
      onError: (e) => toast.error(errorMessage(e)),
    });

  if (!canManage)
    return (
      <>
        <PageHeader title="Agency" />
        <Alert tone="info" title="Agency features need owner or admin access">
          Client workspaces are managed by the owners and admins of an agency workspace.
        </Alert>
      </>
    );

  return (
    <>
      <PageHeader
        title="Agency clients"
        description="Separate client workspaces your team manages. Clients keep control: they can see who has access, decide approvals and revoke access at any time."
        actions={
          query.data?.eligibility.eligible ? (
            <Button onClick={() => setCreateOpen(true)}>
              <Plus /> New client
            </Button>
          ) : null
        }
      />
      <QueryState query={query} rows={5}>
        {(data) => (
          <div className="space-y-5">
            {!data.eligibility.eligible ? (
              <Alert tone="warning" title="Client workspaces are not available">
                {data.eligibility.reason}
              </Alert>
            ) : null}
            <div className="grid gap-4 sm:grid-cols-3">
              <MetricCard
                label="Client workspaces"
                value={data.eligibility.used}
                sub={
                  data.eligibility.limit === null
                    ? 'No limit (service provider)'
                    : `of ${data.eligibility.limit} on the ${data.eligibility.planName} plan`
                }
              />
              <MetricCard
                label="Waiting for client approval"
                value={data.clients.reduce((s, c) => s + c.pendingApprovals, 0)}
              />
              <Card className="p-4">
                <p className="text-[13px] font-medium text-muted-foreground">Agency code</p>
                <div className="mt-2 flex items-center gap-2">
                  <code className="truncate rounded bg-muted px-2 py-1 text-sm">{data.agencyCode}</code>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Copy agency code"
                    onClick={() =>
                      void navigator.clipboard
                        .writeText(data.agencyCode)
                        .then(() => toast.success('Agency code copied'))
                        .catch(() => toast.error('Copy failed'))
                    }
                  >
                    <Copy />
                  </Button>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  Clients enter it under Settings → Workspace → Agency access to request your management.
                </p>
              </Card>
            </div>
            <Card>
              {data.clients.length ? (
                <Table>
                  <THead>
                    <TR>
                      <TH>Client</TH>
                      <TH>Status</TH>
                      <TH>Billing</TH>
                      <TH>Work</TH>
                      <TH className="sr-only">Actions</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {data.clients.map((c) => (
                      <TR key={c.id}>
                        <TD>
                          <span className="font-medium">{c.clientName}</span>
                          <span className="block text-xs text-muted-foreground">
                            Access: {c.accessRole === 'ADMIN' ? 'admin' : 'member'} ·{' '}
                            {c.approvalsDelegated ? 'approvals delegated to you' : 'client approves'} · since{' '}
                            {formatRelative(c.acceptedAt ?? c.createdAt)}
                          </span>
                        </TD>
                        <TD>
                          <StatusBadge
                            status={c.status}
                            label={c.status === 'PENDING' ? 'Request pending' : undefined}
                          />
                          {!c.hasClientOwner && c.status === 'ACTIVE' ? (
                            <Badge className="ml-1.5">No client owner</Badge>
                          ) : null}
                        </TD>
                        <TD className="text-sm">{c.billingMode === 'AGENCY' ? 'Agency plan' : 'Own plan'}</TD>
                        <TD className="text-xs text-muted-foreground">
                          {c.projects} projects · {c.pendingApprovals} approvals · {c.openTasks} open tasks
                        </TD>
                        <TD className="text-right whitespace-nowrap">
                          {c.status === 'PENDING' ? (
                            <Button
                              size="sm"
                              loading={accept.isPending && accept.variables === c.id}
                              onClick={() => accept.mutate(c.id)}
                            >
                              Accept
                            </Button>
                          ) : (
                            <Button size="sm" variant="outline" onClick={() => open(c.clientWorkspaceId)}>
                              Open
                            </Button>
                          )}
                          {c.status === 'ACTIVE' && !c.hasClientOwner ? (
                            <ConfirmDialog
                              title={`Delete ${c.clientName}?`}
                              description="This deletes the client workspace and all of its projects, data and reports. It cannot be undone."
                              confirmLabel="Delete workspace"
                              destructive
                              onConfirm={async () => {
                                try {
                                  await api.delete(`/agency/${workspaceId}/clients/${c.clientWorkspaceId}`);
                                  toast.success('Client workspace deleted');
                                  refresh();
                                  void queryClient.invalidateQueries({ queryKey: ['me'] });
                                } catch (error) {
                                  toast.error(errorMessage(error));
                                }
                              }}
                              trigger={
                                <Button size="sm" variant="ghost" className="ml-1">
                                  Delete
                                </Button>
                              }
                            />
                          ) : (
                            <ConfirmDialog
                              title={
                                c.status === 'PENDING'
                                  ? `Decline ${c.clientName}?`
                                  : `End access to ${c.clientName}?`
                              }
                              description="Your team loses access immediately. The client keeps the workspace and its data."
                              confirmLabel={c.status === 'PENDING' ? 'Decline' : 'End access'}
                              destructive
                              onConfirm={async () => {
                                try {
                                  await api.delete(`/agency/${workspaceId}/links/${c.id}`);
                                  toast.success(c.status === 'PENDING' ? 'Request declined' : 'Access ended');
                                  refresh();
                                  void queryClient.invalidateQueries({ queryKey: ['me'] });
                                } catch (error) {
                                  toast.error(errorMessage(error));
                                }
                              }}
                              trigger={
                                <Button size="sm" variant="ghost" className="ml-1">
                                  {c.status === 'PENDING' ? 'Decline' : 'End access'}
                                </Button>
                              }
                            />
                          )}
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              ) : (
                <CardContent>
                  <EmptyState
                    icon={Building2}
                    title="No client workspaces yet"
                    description="Create a workspace for a client, or share your agency code so an existing customer can request your management."
                  />
                </CardContent>
              )}
            </Card>
          </div>
        )}
      </QueryState>
      <CreateClientDialog open={createOpen} onOpenChange={setCreateOpen} />
    </>
  );
}
