import { zodResolver } from '@hookform/resolvers/zod';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LogOut, Monitor, Plus, Trash2, UserPlus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useNavigate, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import {
  ROLE_DESCRIPTIONS,
  ROLE_LABELS,
  WORKSPACE_ROLES,
  accountDeletionSchema,
  changePasswordSchema,
  invitableRoles,
  invitationCreateSchema,
  type AgencyLinkDto,
  type InvitationDto,
  type NotificationPrefs,
  type WorkspaceMemberDto,
  type WorkspaceRole,
} from '@surfaced/shared';
import type { z } from 'zod';
import {
  useParticipants,
  usePlanLimits,
  useSwitchWorkspace,
  useWorkspace,
  useWorkspaceId,
} from '@/app/queries';
import { PageHeader } from '@/components/app/page';
import { Badge, StatusBadge, humanize } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeaderRow } from '@/components/ui/card';
import { ConfirmDialog, Dialog, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/dialog';
import { Alert, ErrorState, LoadingBlock } from '@/components/ui/feedback';
import { Checkbox, Field, Input, Label, NativeSelect, Switch, Textarea } from '@/components/ui/form';
import { Pagination, TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api, ApiError, errorMessage } from '@/lib/api';
import { ME_KEY, useCan, useCurrentMembership, useMe } from '@/lib/auth';
import { formatDateTime, formatRelative } from '@/lib/format';

// ---------------- Account ----------------

function ProfileCard() {
  const me = useMe();
  const queryClient = useQueryClient();
  const [name, setName] = useState(me.data?.user.name ?? '');
  useEffect(() => setName(me.data?.user.name ?? ''), [me.data?.user.name]);
  const save = useMutation({
    mutationFn: () => api.patch('/users/me', { name }),
    onSuccess: () => {
      toast.success('Profile updated');
      void queryClient.invalidateQueries({ queryKey: ME_KEY });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const user = me.data?.user;
  return (
    <Card>
      <CardHeaderRow title="Profile" />
      <CardContent>
        <form
          className="grid gap-4 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
          </Field>
          <Field
            label="Email"
            description={
              user?.emailVerified ? 'Verified' : 'Not verified yet — check your inbox for the link.'
            }
          >
            <Input value={user?.email ?? ''} readOnly disabled />
          </Field>
          <div className="sm:col-span-2">
            <Button type="submit" loading={save.isPending} disabled={!name.trim() || name === user?.name}>
              Save profile
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function PasswordCard() {
  const form = useForm<z.input<typeof changePasswordSchema>, unknown, z.output<typeof changePasswordSchema>>({
    resolver: zodResolver(changePasswordSchema),
    defaultValues: { currentPassword: '', newPassword: '' },
  });
  const change = useMutation({
    mutationFn: (v: z.output<typeof changePasswordSchema>) => api.post('/users/me/password', v),
    onSuccess: () => {
      toast.success('Password changed', { description: 'Your other sessions were signed out.' });
      form.reset();
    },
    onError: (error) => {
      if (error instanceof ApiError && Object.keys(error.fieldErrors).length)
        for (const [k, m] of Object.entries(error.fieldErrors))
          form.setError(k as 'currentPassword' | 'newPassword', { message: m });
      else toast.error(errorMessage(error));
    },
  });
  return (
    <Card>
      <CardHeaderRow title="Password" description="Changing your password signs out your other sessions." />
      <CardContent>
        <form
          onSubmit={form.handleSubmit((v) => change.mutate(v))}
          className="grid gap-4 sm:grid-cols-2"
          noValidate
        >
          <Field label="Current password" error={form.formState.errors.currentPassword?.message}>
            <Input type="password" autoComplete="current-password" {...form.register('currentPassword')} />
          </Field>
          <Field
            label="New password"
            error={form.formState.errors.newPassword?.message}
            description="At least 10 characters."
          >
            <Input type="password" autoComplete="new-password" {...form.register('newPassword')} />
          </Field>
          <div className="sm:col-span-2">
            <Button type="submit" loading={change.isPending}>
              Change password
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

const PREF_LABELS: Record<keyof NotificationPrefs, { label: string; description: string }> = {
  auditCompleted: { label: 'Audit completed', description: 'An email when an audit you can see finishes.' },
  reportReady: { label: 'Report ready', description: 'An email when a report you requested is generated.' },
  weeklySummary: {
    label: 'Weekly summary',
    description: 'A Monday email with what changed in your projects.',
  },
  billing: {
    label: 'Billing',
    description: 'Payment failures, plan changes and renewals (owners and admins).',
  },
};

function NotificationsCard() {
  const me = useMe();
  const queryClient = useQueryClient();
  const prefs = me.data?.user.notificationPrefs;
  const update = useMutation({
    mutationFn: (patch: Partial<NotificationPrefs>) =>
      api.patch('/users/me/preferences', { notificationPrefs: patch }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ME_KEY }),
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Card>
      <CardHeaderRow
        title="Email notifications"
        description="In-app notifications are always shown in the bell menu."
      />
      <CardContent className="divide-y divide-border">
        {(Object.keys(PREF_LABELS) as (keyof NotificationPrefs)[]).map((key) => (
          <div key={key} className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0">
            <div>
              <Label htmlFor={`pref-${key}`}>{PREF_LABELS[key].label}</Label>
              <p className="mt-0.5 text-[13px] text-muted-foreground">{PREF_LABELS[key].description}</p>
            </div>
            <Switch
              id={`pref-${key}`}
              checked={prefs?.[key] ?? true}
              disabled={!prefs || update.isPending}
              onCheckedChange={(v) => update.mutate({ [key]: v })}
            />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

interface SessionDto {
  id: string;
  current: boolean;
  userAgent: string | null;
  ipAddress: string | null;
  createdAt: string;
  lastSeenAt: string;
}

function describeAgent(ua: string | null): string {
  if (!ua) return 'Unknown device';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Firefox\//.test(ua)
      ? 'Firefox'
      : /Chrome\//.test(ua)
        ? 'Chrome'
        : /Safari\//.test(ua)
          ? 'Safari'
          : 'Browser';
  const os = /Windows/.test(ua)
    ? 'Windows'
    : /Mac OS X/.test(ua)
      ? 'macOS'
      : /Android/.test(ua)
        ? 'Android'
        : /iPhone|iPad/.test(ua)
          ? 'iOS'
          : /Linux/.test(ua)
            ? 'Linux'
            : '';
  return [browser, os].filter(Boolean).join(' on ');
}

function SessionsCard() {
  const queryClient = useQueryClient();
  const sessions = useQuery({
    queryKey: ['sessions'],
    queryFn: () => api.get<SessionDto[]>('/users/me/sessions'),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.delete(`/users/me/sessions/${id}`),
    onSuccess: () => {
      toast.success('Session signed out');
      void queryClient.invalidateQueries({ queryKey: ['sessions'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Card>
      <CardHeaderRow title="Active sessions" />
      <CardContent>
        {sessions.isPending ? (
          <LoadingBlock />
        ) : sessions.isError ? (
          <ErrorState error={sessions.error} />
        ) : (
          <ul className="divide-y divide-border">
            {sessions.data.map((s) => (
              <li key={s.id} className="flex items-center justify-between gap-3 py-2.5">
                <span className="flex items-center gap-3">
                  <Monitor className="size-4 text-muted-foreground" aria-hidden />
                  <span>
                    <span className="block text-sm font-medium">
                      {describeAgent(s.userAgent)}{' '}
                      {s.current ? <Badge tone="success">This device</Badge> : null}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {s.ipAddress ?? 'Unknown IP'} · active {formatRelative(s.lastSeenAt)}
                    </span>
                  </span>
                </span>
                {!s.current ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => revoke.mutate(s.id)}
                    disabled={revoke.isPending}
                  >
                    <LogOut /> Sign out
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function DeletionCard() {
  const me = useMe();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const form = useForm<
    z.input<typeof accountDeletionSchema>,
    unknown,
    z.output<typeof accountDeletionSchema>
  >({
    resolver: zodResolver(accountDeletionSchema),
    defaultValues: { password: '', confirm: '' as 'DELETE', reason: '' },
  });
  const request = useMutation({
    mutationFn: (v: z.output<typeof accountDeletionSchema>) => api.post('/users/me/deletion-request', v),
    onSuccess: () => {
      setOpen(false);
      toast.success('Account deletion scheduled', {
        description: 'You can cancel it during the next 14 days.',
      });
      void queryClient.invalidateQueries({ queryKey: ME_KEY });
    },
    onError: (error) => {
      if (error instanceof ApiError && Object.keys(error.fieldErrors).length)
        for (const [k, m] of Object.entries(error.fieldErrors))
          form.setError(k as 'password', { message: m });
    },
  });
  const pending = Boolean(me.data?.user.deletionRequestedAt);
  return (
    <Card className="border-red-200">
      <CardHeaderRow
        title="Delete account"
        description="Your account and the workspaces where you are the only member are deleted 14 days after the request. You can cancel during that time."
      />
      <CardContent>
        {pending ? (
          <p className="text-sm">
            Deletion requested {formatDateTime(me.data?.user.deletionRequestedAt)}. Use the banner at the top
            of the page to cancel it.
          </p>
        ) : (
          <Dialog open={open} onOpenChange={setOpen}>
            <Button variant="destructive" onClick={() => setOpen(true)}>
              <Trash2 /> Request account deletion
            </Button>
            <DialogContent size="sm">
              <DialogHeader
                title="Delete your account?"
                description="If you own a workspace with other members, transfer ownership first. Paid subscriptions must be cancelled before the deletion can complete."
              />
              <form onSubmit={form.handleSubmit((v) => request.mutate(v))} className="grid gap-4" noValidate>
                <Field label="Password" error={form.formState.errors.password?.message}>
                  <Input type="password" autoComplete="current-password" {...form.register('password')} />
                </Field>
                <Field label="Type DELETE to confirm" error={form.formState.errors.confirm?.message}>
                  <Input {...form.register('confirm')} />
                </Field>
                <Field label="Anything we should know?" optional>
                  <Textarea rows={2} {...form.register('reason')} />
                </Field>
                {request.isError &&
                !(request.error instanceof ApiError && Object.keys(request.error.fieldErrors).length) ? (
                  <Alert tone="danger">{errorMessage(request.error)}</Alert>
                ) : null}
                <DialogFooter>
                  <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                    Cancel
                  </Button>
                  <Button type="submit" variant="destructive" loading={request.isPending}>
                    Schedule deletion
                  </Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------- Workspace ----------------

function WorkspaceCard() {
  const workspace = useWorkspace();
  const workspaceId = useWorkspaceId();
  const queryClient = useQueryClient();
  const canUpdate = useCan('workspace.update');
  const limits = usePlanLimits();
  const [name, setName] = useState('');
  const [brandName, setBrandName] = useState('');
  const [accent, setAccent] = useState('#4f46e5');
  const [logoUrl, setLogoUrl] = useState('');
  const [supportEmail, setSupportEmail] = useState('');
  const [hidePoweredBy, setHidePoweredBy] = useState(false);
  const [whiteLabel, setWhiteLabel] = useState(false);
  useEffect(() => {
    if (!workspace.data) return;
    setName(workspace.data.name);
    setWhiteLabel(Boolean(workspace.data.whiteLabel?.enabled));
    setBrandName(workspace.data.whiteLabel?.brandName ?? '');
    setAccent(workspace.data.whiteLabel?.accentColor ?? '#4f46e5');
    setLogoUrl(workspace.data.whiteLabel?.logoUrl ?? '');
    setSupportEmail(workspace.data.whiteLabel?.supportEmail ?? '');
    setHidePoweredBy(Boolean(workspace.data.whiteLabel?.hidePoweredBy));
  }, [workspace.data]);
  const save = useMutation({
    mutationFn: () =>
      api.patch(`/workspaces/${workspaceId}`, {
        name,
        ...(limits?.whiteLabelReports
          ? {
              whiteLabel: {
                enabled: whiteLabel,
                brandName: brandName || undefined,
                accentColor: accent,
                logoUrl: logoUrl.trim() || undefined,
                supportEmail: supportEmail.trim() || undefined,
                hidePoweredBy,
              },
            }
          : {}),
      }),
    onSuccess: () => {
      toast.success('Workspace updated');
      void queryClient.invalidateQueries({ queryKey: ['workspace', workspaceId] });
      void queryClient.invalidateQueries({ queryKey: ME_KEY });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Card>
      <CardHeaderRow
        title="Workspace"
        description={
          workspace.data
            ? `${workspace.data.plan.name} plan · your role: ${ROLE_LABELS[workspace.data.role]}`
            : undefined
        }
      />
      <CardContent>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <fieldset disabled={!canUpdate} className="grid gap-4">
            <Field label="Workspace name">
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <div className="rounded-lg border border-border p-4">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <Label htmlFor="white-label">White-label reports</Label>
                  <p className="mt-0.5 text-[13px] text-muted-foreground">
                    {limits?.whiteLabelReports
                      ? 'Show your brand on reports and, for client workspaces you manage, in the client portal.'
                      : 'Available on the Agency plan.'}
                  </p>
                </div>
                <Switch
                  id="white-label"
                  checked={whiteLabel}
                  onCheckedChange={setWhiteLabel}
                  disabled={!limits?.whiteLabelReports || !canUpdate}
                />
              </div>
              {whiteLabel && limits?.whiteLabelReports ? (
                <div className="mt-4 grid gap-4 sm:grid-cols-2">
                  <Field label="Brand name">
                    <Input value={brandName} onChange={(e) => setBrandName(e.target.value)} maxLength={80} />
                  </Field>
                  <Field label="Accent color">
                    <Input
                      type="color"
                      value={accent}
                      onChange={(e) => setAccent(e.target.value)}
                      className="h-9 p-1"
                    />
                  </Field>
                  <Field
                    label="Logo URL (https)"
                    description="Shown instead of the Surfaced logo. Square images work best."
                  >
                    <Input
                      value={logoUrl}
                      onChange={(e) => setLogoUrl(e.target.value)}
                      placeholder="https://"
                    />
                  </Field>
                  <Field label="Support email" description="Shown to client users who need help.">
                    <Input
                      type="email"
                      value={supportEmail}
                      onChange={(e) => setSupportEmail(e.target.value)}
                    />
                  </Field>
                  <label className="flex items-center gap-2 text-sm sm:col-span-2">
                    <Checkbox checked={hidePoweredBy} onCheckedChange={(v) => setHidePoweredBy(v === true)} />
                    Hide the "Powered by Surfaced" note
                  </label>
                </div>
              ) : null}
            </div>
          </fieldset>
          {canUpdate ? (
            <div>
              <Button type="submit" loading={save.isPending}>
                Save workspace
              </Button>
            </div>
          ) : null}
        </form>
      </CardContent>
    </Card>
  );
}

function MembersCard() {
  const workspaceId = useWorkspaceId();
  const me = useMe();
  const membership = useCurrentMembership();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const canManage = useCan('members.manage');
  const canInvite = useCan('members.invite');
  const [inviteOpen, setInviteOpen] = useState(false);
  const members = useQuery({
    queryKey: ['members', workspaceId],
    queryFn: () => api.get<WorkspaceMemberDto[]>(`/workspaces/${workspaceId}/members`),
    enabled: Boolean(workspaceId),
  });
  const invitations = useQuery({
    queryKey: ['invitations', workspaceId],
    queryFn: () => api.get<InvitationDto[]>(`/workspaces/${workspaceId}/invitations`),
    enabled: Boolean(workspaceId && canInvite),
  });
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['members', workspaceId] });
    void queryClient.invalidateQueries({ queryKey: ['invitations', workspaceId] });
  };
  const changeRole = useMutation({
    mutationFn: ({ memberId, role }: { memberId: string; role: WorkspaceRole }) =>
      api.patch(`/workspaces/${workspaceId}/members/${memberId}`, { role }),
    onSuccess: () => {
      toast.success('Role updated');
      refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const myRole = membership?.role ?? 'MEMBER';
  const form = useForm<
    z.input<typeof invitationCreateSchema>,
    unknown,
    z.output<typeof invitationCreateSchema>
  >({ resolver: zodResolver(invitationCreateSchema), defaultValues: { email: '', role: 'MEMBER' } });
  const invite = useMutation({
    mutationFn: (v: z.output<typeof invitationCreateSchema>) =>
      api.post(`/workspaces/${workspaceId}/invitations`, v),
    onSuccess: () => {
      toast.success('Invitation sent');
      setInviteOpen(false);
      form.reset();
      refresh();
    },
    onError: (error) => {
      if (error instanceof ApiError && error.fieldErrors.email)
        form.setError('email', { message: error.fieldErrors.email });
    },
  });
  return (
    <Card>
      <CardHeaderRow
        title="Members"
        actions={
          canInvite ? (
            <Button size="sm" onClick={() => setInviteOpen(true)}>
              <UserPlus /> Invite
            </Button>
          ) : null
        }
      />
      {members.isPending ? (
        <CardContent>
          <LoadingBlock />
        </CardContent>
      ) : members.isError ? (
        <CardContent>
          <ErrorState error={members.error} />
        </CardContent>
      ) : (
        <Table>
          <THead>
            <TR>
              <TH>Member</TH>
              <TH>Role</TH>
              <TH className="sr-only">Actions</TH>
            </TR>
          </THead>
          <TBody>
            {members.data.map((m) => {
              const self = m.userId === me.data?.user.id;
              return (
                <TR key={m.id}>
                  <TD>
                    <span className="font-medium">{m.name}</span> {self ? <Badge>You</Badge> : null}
                    <span className="block text-xs text-muted-foreground">{m.email}</span>
                  </TD>
                  <TD>
                    {canManage && !self ? (
                      <NativeSelect
                        aria-label={`Role of ${m.name}`}
                        value={m.role}
                        onChange={(e) =>
                          changeRole.mutate({ memberId: m.id, role: e.target.value as WorkspaceRole })
                        }
                        className="h-8 w-32 text-[13px]"
                        disabled={changeRole.isPending || (m.role === 'OWNER' && myRole !== 'OWNER')}
                      >
                        {WORKSPACE_ROLES.map((r) => (
                          <option key={r} value={r} disabled={r === 'OWNER' && myRole !== 'OWNER'}>
                            {ROLE_LABELS[r]}
                          </option>
                        ))}
                      </NativeSelect>
                    ) : (
                      <span className="text-sm">{ROLE_LABELS[m.role]}</span>
                    )}
                  </TD>
                  <TD className="text-right">
                    {self || canManage ? (
                      <ConfirmDialog
                        title={self ? 'Leave this workspace?' : `Remove ${m.name}?`}
                        description={
                          self
                            ? 'You lose access to its projects. An owner can invite you again.'
                            : 'They lose access to this workspace immediately.'
                        }
                        confirmLabel={self ? 'Leave workspace' : 'Remove member'}
                        destructive
                        onConfirm={async () => {
                          try {
                            await api.delete(`/workspaces/${workspaceId}/members/${m.id}`);
                            if (self) {
                              await queryClient.invalidateQueries();
                              void navigate('/app');
                            } else {
                              toast.success('Member removed');
                              refresh();
                            }
                          } catch (error) {
                            toast.error(errorMessage(error));
                          }
                        }}
                        trigger={
                          <Button variant="ghost" size="sm">
                            {self ? 'Leave' : 'Remove'}
                          </Button>
                        }
                      />
                    ) : null}
                  </TD>
                </TR>
              );
            })}
          </TBody>
        </Table>
      )}
      {canInvite && invitations.data?.length ? (
        <CardContent className="border-t border-border pt-4">
          <p className="mb-2 text-sm font-medium">Pending invitations</p>
          <ul className="space-y-2">
            {invitations.data.map((i) => (
              <li key={i.id} className="flex items-center justify-between gap-3 text-sm">
                <span>
                  {i.email} <Badge>{ROLE_LABELS[i.role]}</Badge>
                  <span className="block text-xs text-muted-foreground">
                    Expires {formatDateTime(i.expiresAt)}
                  </span>
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    api
                      .delete(`/workspaces/${workspaceId}/invitations/${i.id}`)
                      .then(() => {
                        toast.success('Invitation revoked');
                        refresh();
                      })
                      .catch((e: unknown) => toast.error(errorMessage(e)))
                  }
                >
                  Revoke
                </Button>
              </li>
            ))}
          </ul>
        </CardContent>
      ) : null}
      <Dialog open={inviteOpen} onOpenChange={setInviteOpen}>
        <DialogContent size="sm">
          <DialogHeader
            title="Invite a teammate"
            description="They get an email with a link that expires in 7 days."
          />
          <form onSubmit={form.handleSubmit((v) => invite.mutate(v))} className="grid gap-4" noValidate>
            <Field label="Email" error={form.formState.errors.email?.message}>
              <Input type="email" autoFocus {...form.register('email')} />
            </Field>
            <Field
              label="Role"
              description={ROLE_DESCRIPTIONS[(form.watch('role') ?? 'MEMBER') as WorkspaceRole]}
            >
              <NativeSelect {...form.register('role')}>
                {invitableRoles(myRole).map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABELS[r]}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            {invite.isError && !(invite.error instanceof ApiError && invite.error.fieldErrors.email) ? (
              <Alert tone="danger">{errorMessage(invite.error)}</Alert>
            ) : null}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setInviteOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" loading={invite.isPending}>
                Send invitation
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function AgencyAccessCard() {
  const workspaceId = useWorkspaceId();
  const membership = useCurrentMembership();
  const queryClient = useQueryClient();
  const participants = useParticipants();
  const direct = membership?.via === 'DIRECT';
  const isOwner = direct && membership?.role === 'OWNER';
  const canRevoke = direct && (membership?.role === 'OWNER' || membership?.role === 'ADMIN');
  const [code, setCode] = useState('');
  const [delegate, setDelegate] = useState(false);
  const link = useQuery({
    queryKey: ['agency-link', workspaceId],
    queryFn: () => api.get<AgencyLinkDto | null>(`/workspaces/${workspaceId}/agency`),
    enabled: Boolean(workspaceId),
  });
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['agency-link', workspaceId] });
    void queryClient.invalidateQueries({ queryKey: ['participants', workspaceId] });
  };
  const request = useMutation({
    mutationFn: () =>
      api.post(`/workspaces/${workspaceId}/agency`, {
        agencyCode: code.trim(),
        approvalsDelegated: delegate,
      }),
    onSuccess: () => {
      toast.success('Request sent', { description: 'The agency gets access once it accepts.' });
      setCode('');
      refresh();
    },
  });
  const update = useMutation({
    mutationFn: (body: { approvalsDelegated?: boolean; accessRole?: 'ADMIN' | 'MEMBER' }) =>
      api.patch(`/workspaces/${workspaceId}/agency`, body),
    onSuccess: () => {
      toast.success('Agency access updated');
      refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const agencyTeam = participants.data?.filter((p) => p.via === 'AGENCY') ?? [];
  return (
    <Card>
      <CardHeaderRow
        title="Agency access"
        description="An agency can manage this workspace for you. You decide what it can do and can revoke access at any time."
      />
      <CardContent className="space-y-4">
        {link.isPending ? (
          <LoadingBlock />
        ) : link.data ? (
          <>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-medium">{link.data.agencyName}</span>
              <StatusBadge
                status={link.data.status}
                label={link.data.status === 'PENDING' ? 'Waiting for the agency' : 'Active'}
              />
              <Badge>
                {link.data.billingMode === 'AGENCY' ? 'Billed through the agency' : 'Your own plan'}
              </Badge>
            </div>
            {!direct ? (
              <p className="text-sm text-muted-foreground">
                You work in this workspace through {link.data.agencyName}.
              </p>
            ) : null}
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Agency access level">
                <NativeSelect
                  value={link.data.accessRole}
                  disabled={!isOwner || update.isPending}
                  onChange={(e) => update.mutate({ accessRole: e.target.value as 'ADMIN' | 'MEMBER' })}
                >
                  <option value="ADMIN">Admin: manages projects, integrations and work</option>
                  <option value="MEMBER">Member: works on projects only</option>
                </NativeSelect>
              </Field>
              <div className="flex items-start justify-between gap-4 rounded-lg border border-border p-3">
                <div>
                  <Label htmlFor="delegate-approvals">Agency may decide approvals</Label>
                  <p className="mt-0.5 text-[13px] text-muted-foreground">
                    When off, your owners, admins and client users approve every change before it is
                    published.
                  </p>
                </div>
                <Switch
                  id="delegate-approvals"
                  checked={link.data.approvalsDelegated}
                  disabled={!isOwner || update.isPending}
                  onCheckedChange={(v) => update.mutate({ approvalsDelegated: v })}
                />
              </div>
            </div>
            {agencyTeam.length ? (
              <div>
                <p className="mb-1.5 text-sm font-medium">Agency team with access</p>
                <ul className="grid gap-1 text-sm sm:grid-cols-2">
                  {agencyTeam.map((p) => (
                    <li key={p.userId}>
                      {p.name} <span className="text-xs text-muted-foreground">· {ROLE_LABELS[p.role]}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {canRevoke ? (
              <ConfirmDialog
                title={`Revoke access for ${link.data.agencyName}?`}
                description={
                  link.data.billingMode === 'AGENCY'
                    ? 'The agency team loses access immediately, and this workspace returns to its own plan (Free unless you upgrade).'
                    : 'The agency team loses access immediately. Your data stays in this workspace.'
                }
                confirmLabel="Revoke access"
                destructive
                onConfirm={async () => {
                  try {
                    await api.delete(`/workspaces/${workspaceId}/agency`);
                    toast.success('Agency access revoked');
                    refresh();
                  } catch (error) {
                    toast.error(errorMessage(error));
                  }
                }}
                trigger={
                  <Button variant="outline" size="sm">
                    {link.data.status === 'PENDING' ? 'Cancel request' : 'Revoke access'}
                  </Button>
                }
              />
            ) : null}
          </>
        ) : isOwner ? (
          <form
            className="grid gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              request.mutate();
            }}
          >
            <Field
              label="Agency code"
              description="Ask your agency for its code (shown on its Agency clients page)."
            >
              <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="acme-agency-1a2b" />
            </Field>
            <label className="flex items-start gap-2 text-sm">
              <Checkbox checked={delegate} onCheckedChange={(v) => setDelegate(v === true)} />
              <span>Let the agency decide approvals on our behalf</span>
            </label>
            {request.isError ? <Alert tone="danger">{errorMessage(request.error)}</Alert> : null}
            <div>
              <Button type="submit" loading={request.isPending} disabled={code.trim().length < 3}>
                Request agency management
              </Button>
            </div>
          </form>
        ) : (
          <p className="text-sm text-muted-foreground">
            No agency manages this workspace. Owners can add one.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

interface AuditLogRow {
  id: string;
  action: string;
  actor: { name: string; email: string } | null;
  targetType: string | null;
  createdAt: string;
}

function AuditLogCard() {
  const workspaceId = useWorkspaceId();
  const [page, setPage] = useState(1);
  const logs = useQuery({
    queryKey: ['audit-logs', workspaceId, page],
    queryFn: () => api.page<AuditLogRow>(`/workspaces/${workspaceId}/audit-logs`, { page, pageSize: 20 }),
    enabled: Boolean(workspaceId),
    placeholderData: keepPreviousData,
  });
  return (
    <Card>
      <CardHeaderRow
        title="Audit log"
        description="Important account, workspace, billing and project actions"
      />
      {logs.isPending ? (
        <CardContent>
          <LoadingBlock />
        </CardContent>
      ) : logs.isError ? (
        <CardContent>
          <ErrorState error={logs.error} />
        </CardContent>
      ) : (
        <>
          <Table>
            <THead>
              <TR>
                <TH>When</TH>
                <TH>Action</TH>
                <TH>By</TH>
              </TR>
            </THead>
            <TBody>
              {logs.data.items.map((l) => (
                <TR key={l.id}>
                  <TD className="text-xs whitespace-nowrap">{formatDateTime(l.createdAt)}</TD>
                  <TD className="text-xs">{humanize(l.action.replace(/\./g, ' · '))}</TD>
                  <TD className="text-xs">{l.actor?.name ?? 'System'}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
          <Pagination meta={logs.data.meta} onPage={setPage} />
        </>
      )}
    </Card>
  );
}

function CreateWorkspaceDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const [name, setName] = useState('');
  const switcher = useSwitchWorkspace();
  const navigate = useNavigate();
  const create = useMutation({
    mutationFn: () => api.post<{ id: string }>('/workspaces', { name }),
    onSuccess: async (ws) => {
      await switcher.mutateAsync(ws.id);
      toast.success('Workspace created');
      onOpenChange(false);
      void navigate('/app/projects/new?welcome=1');
    },
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader
          title="New workspace"
          description="Workspaces have their own members, projects and plan. New workspaces start on the Free plan."
        />
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <Field label="Name">
            <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          {create.isError ? <Alert tone="danger">{errorMessage(create.error)}</Alert> : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={create.isPending} disabled={name.trim().length < 2}>
              <Plus /> Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default function SettingsPage() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'workspace' || params.get('tab') === 'agency' ? 'workspace' : 'account';
  const canReadAuditLog = useCan('auditlog.read');
  const createOpen = params.get('create') === '1';
  return (
    <>
      <PageHeader title="Settings" />
      <Tabs
        value={tab}
        onValueChange={(v) => setParams(v === 'account' ? {} : { tab: v }, { replace: true })}
      >
        <TabsList className="mb-5">
          <TabsTrigger value="account">Account</TabsTrigger>
          <TabsTrigger value="workspace">Workspace</TabsTrigger>
        </TabsList>
        <TabsContent value="account" className="mt-0 grid max-w-3xl gap-5">
          <ProfileCard />
          <PasswordCard />
          <NotificationsCard />
          <SessionsCard />
          <DeletionCard />
        </TabsContent>
        <TabsContent value="workspace" className="mt-0 grid max-w-4xl gap-5">
          <div className="flex justify-end">
            <Button
              variant="outline"
              onClick={() => setParams({ tab: 'workspace', create: '1' }, { replace: true })}
            >
              <Plus /> New workspace
            </Button>
          </div>
          <WorkspaceCard />
          <MembersCard />
          <AgencyAccessCard />
          {canReadAuditLog ? <AuditLogCard /> : null}
        </TabsContent>
      </Tabs>
      <CreateWorkspaceDialog
        open={createOpen}
        onOpenChange={(v) =>
          setParams(v ? { tab: 'workspace', create: '1' } : { tab: 'workspace' }, { replace: true })
        }
      />
    </>
  );
}
