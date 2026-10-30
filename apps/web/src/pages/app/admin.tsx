import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RotateCcw, Search } from 'lucide-react';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { toast } from 'sonner';
import {
  BACKGROUND_JOB_TYPES,
  JOB_STATUSES,
  planLimitsSchema,
  type PlanLimits,
  type ProviderCostLineDto,
  type ProviderRateDto,
} from '@surfaced/shared';
import { MetricCard, PageHeader } from '@/components/app/page';
import { Badge, StatusBadge, humanize } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeaderRow } from '@/components/ui/card';
import { Dialog, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/dialog';
import { Alert, ErrorState, LoadingBlock } from '@/components/ui/feedback';
import { Field, Input, NativeSelect, Switch, Textarea } from '@/components/ui/form';
import { Pagination, TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api, ApiError, errorMessage } from '@/lib/api';
import { formatCurrency, formatDateTime, formatNumber, formatRelative } from '@/lib/format';

interface Overview {
  users: { total: number; verified: number; disabled: number };
  workspaces: number;
  projects: number;
  subscriptions: { planKey: string; planName: string; total: number; byStatus: Record<string, number> }[];
  jobs: { active: number; last24hByStatus: Record<string, number> };
  usage: { periodKey: string; metrics: { metric: string; label: string; used: number }[] };
  emails: { last7dByStatus: Record<string, number> };
}

function OverviewTab() {
  const q = useQuery({
    queryKey: ['admin', 'overview'],
    queryFn: () => api.get<Overview>('/admin/overview'),
  });
  if (q.isPending) return <LoadingBlock rows={6} />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const d = q.data;
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <MetricCard
          label="Users"
          value={formatNumber(d.users.total)}
          sub={`${formatNumber(d.users.verified)} verified · ${formatNumber(d.users.disabled)} disabled`}
        />
        <MetricCard label="Workspaces" value={formatNumber(d.workspaces)} />
        <MetricCard label="Projects" value={formatNumber(d.projects)} />
        <MetricCard
          label="Active jobs"
          value={formatNumber(d.jobs.active)}
          sub={`${formatNumber(d.jobs.last24hByStatus.FAILED ?? 0)} failed in 24 h`}
          tone={d.jobs.last24hByStatus.FAILED ? 'warning' : undefined}
        />
        <MetricCard
          label="Emails (7 days)"
          value={formatNumber(Object.values(d.emails.last7dByStatus).reduce((a, b) => a + b, 0))}
          sub={
            Object.entries(d.emails.last7dByStatus)
              .map(([k, v]) => `${humanize(k)} ${v}`)
              .join(' · ') || 'None'
          }
        />
      </div>
      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeaderRow title="Subscriptions by plan" />
          <Table>
            <THead>
              <TR>
                <TH>Plan</TH>
                <TH className="text-right">Workspaces</TH>
                <TH>By status</TH>
              </TR>
            </THead>
            <TBody>
              {d.subscriptions.map((s) => (
                <TR key={s.planKey}>
                  <TD className="font-medium">{s.planName}</TD>
                  <TD className="text-right tabular-nums">{formatNumber(s.total)}</TD>
                  <TD className="text-xs">
                    {Object.entries(s.byStatus)
                      .map(([k, v]) => `${humanize(k)} ${v}`)
                      .join(' · ') || '—'}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>
        <Card>
          <CardHeaderRow title={`Usage in ${d.usage.periodKey}`} />
          <Table>
            <TBody>
              {d.usage.metrics.map((m) => (
                <TR key={m.metric}>
                  <TD>{m.label}</TD>
                  <TD className="text-right tabular-nums">{formatNumber(m.used)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>
      </div>
    </div>
  );
}

interface AdminUser {
  id: string;
  email: string;
  name: string;
  platformRole: string;
  emailVerified: boolean;
  disabledAt: string | null;
  disabledReason: string | null;
  deletionRequestedAt: string | null;
  lastLoginAt: string | null;
  createdAt: string;
  workspaceCount: number;
}

function UsersTab() {
  const queryClient = useQueryClient();
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [disabling, setDisabling] = useState<AdminUser | null>(null);
  const [reason, setReason] = useState('');
  const users = useQuery({
    queryKey: ['admin', 'users', search, status, page],
    queryFn: () =>
      api.page<AdminUser>('/admin/users', {
        q: search || undefined,
        status: status || undefined,
        page,
        pageSize: 25,
      }),
    placeholderData: keepPreviousData,
  });
  const update = useMutation({
    mutationFn: ({ id, disabled, reason: why }: { id: string; disabled: boolean; reason?: string }) =>
      api.patch<{ revokedSessions: number }>(`/admin/users/${id}`, { disabled, reason: why }),
    onSuccess: (r, v) => {
      toast.success(
        v.disabled ? `User disabled · ${r.revokedSessions} session(s) signed out` : 'User re-enabled',
      );
      setDisabling(null);
      setReason('');
      void queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
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
            placeholder="Search name or email"
            aria-label="Search users"
            className="pl-8"
          />
        </form>
        <NativeSelect
          aria-label="Status"
          value={status}
          onChange={(e) => (setPage(1), setStatus(e.target.value))}
          className="w-52"
        >
          <option value="">All users</option>
          <option value="active">Active</option>
          <option value="disabled">Disabled</option>
          <option value="deletion_requested">Deletion requested</option>
        </NativeSelect>
      </div>
      {users.isPending ? (
        <LoadingBlock className="px-5 pb-5" />
      ) : users.isError ? (
        <ErrorState className="mx-5 mb-5" error={users.error} />
      ) : (
        <>
          <Table>
            <THead>
              <TR>
                <TH>User</TH>
                <TH>Status</TH>
                <TH className="text-right">Workspaces</TH>
                <TH>Last login</TH>
                <TH>Joined</TH>
                <TH className="sr-only">Actions</TH>
              </TR>
            </THead>
            <TBody>
              {users.data.items.map((u) => (
                <TR key={u.id}>
                  <TD>
                    <span className="font-medium">{u.name}</span>{' '}
                    {u.platformRole === 'ADMIN' ? <Badge tone="primary">Admin</Badge> : null}
                    <span className="block text-xs text-muted-foreground">{u.email}</span>
                  </TD>
                  <TD className="text-xs">
                    {u.disabledAt ? (
                      <Badge tone="danger" title={u.disabledReason ?? undefined}>
                        Disabled
                      </Badge>
                    ) : (
                      <Badge tone="success">Active</Badge>
                    )}{' '}
                    {!u.emailVerified ? <Badge>Unverified</Badge> : null}
                    {u.deletionRequestedAt ? <Badge tone="warning">Deletion requested</Badge> : null}
                  </TD>
                  <TD className="text-right tabular-nums">{u.workspaceCount}</TD>
                  <TD className="text-xs text-muted-foreground">{formatRelative(u.lastLoginAt)}</TD>
                  <TD className="text-xs text-muted-foreground">{formatDateTime(u.createdAt)}</TD>
                  <TD className="text-right">
                    {u.disabledAt ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => update.mutate({ id: u.id, disabled: false })}
                        disabled={update.isPending}
                      >
                        Re-enable
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-destructive"
                        onClick={() => setDisabling(u)}
                      >
                        Disable
                      </Button>
                    )}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
          <Pagination meta={users.data.meta} onPage={setPage} />
        </>
      )}
      <Dialog open={Boolean(disabling)} onOpenChange={(v) => !v && setDisabling(null)}>
        <DialogContent size="sm">
          <DialogHeader
            title={`Disable ${disabling?.name ?? ''}?`}
            description="They are signed out everywhere and cannot sign in until re-enabled. Their data is kept."
          />
          <Field label="Reason" description="Recorded in the audit log.">
            <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
          </Field>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDisabling(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={!reason.trim()}
              loading={update.isPending}
              onClick={() => disabling && update.mutate({ id: disabling.id, disabled: true, reason })}
            >
              Disable user
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function WorkspacesTab() {
  const queryClient = useQueryClient();
  const toggleProvider = useMutation({
    mutationFn: (v: { id: string; isServiceProvider: boolean }) =>
      api.patch(`/admin/workspaces/${v.id}/service-provider`, { isServiceProvider: v.isServiceProvider }),
    onSuccess: () => {
      toast.success('Managed-services provider updated');
      void queryClient.invalidateQueries({ queryKey: ['admin', 'workspaces'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const list = useQuery({
    queryKey: ['admin', 'workspaces', search, page],
    queryFn: () =>
      api.page<{
        id: string;
        name: string;
        slug: string;
        createdAt: string;
        plan: { key: string; name: string } | null;
        subscriptionStatus: string | null;
        billingProvider: string | null;
        owners: { email: string }[];
        memberCount: number;
        projectCount: number;
        isServiceProvider: boolean;
      }>('/admin/workspaces', { q: search || undefined, page, pageSize: 25 }),
    placeholderData: keepPreviousData,
  });
  return (
    <Card>
      <form
        className="relative m-4 max-w-md"
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
          placeholder="Search name or slug"
          aria-label="Search workspaces"
          className="pl-8"
        />
      </form>
      {list.isPending ? (
        <LoadingBlock className="px-5 pb-5" />
      ) : list.isError ? (
        <ErrorState className="mx-5 mb-5" error={list.error} />
      ) : (
        <>
          <Table>
            <THead>
              <TR>
                <TH>Workspace</TH>
                <TH>Plan</TH>
                <TH>Owners</TH>
                <TH className="text-right">Members</TH>
                <TH className="text-right">Projects</TH>
                <TH>Managed services</TH>
                <TH>Created</TH>
              </TR>
            </THead>
            <TBody>
              {list.data.items.map((w) => (
                <TR key={w.id}>
                  <TD>
                    <span className="font-medium">{w.name}</span>
                    <span className="block font-mono text-xs text-muted-foreground">{w.slug}</span>
                  </TD>
                  <TD className="text-xs">
                    {w.plan?.name ?? '—'}{' '}
                    {w.subscriptionStatus ? <StatusBadge status={w.subscriptionStatus} /> : null}
                    {w.billingProvider ? (
                      <span className="block text-muted-foreground">{humanize(w.billingProvider)}</span>
                    ) : null}
                  </TD>
                  <TD className="text-xs">{w.owners.map((o) => o.email).join(', ')}</TD>
                  <TD className="text-right tabular-nums">{w.memberCount}</TD>
                  <TD className="text-right tabular-nums">{w.projectCount}</TD>
                  <TD>
                    <Switch
                      aria-label={`Managed-services provider: ${w.name}`}
                      checked={w.isServiceProvider}
                      disabled={toggleProvider.isPending}
                      onCheckedChange={(v) => toggleProvider.mutate({ id: w.id, isServiceProvider: v })}
                    />
                  </TD>
                  <TD className="text-xs text-muted-foreground">{formatDateTime(w.createdAt)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
          <Pagination meta={list.data.meta} onPage={setPage} />
        </>
      )}
    </Card>
  );
}

function JobsTab() {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState('FAILED');
  const [type, setType] = useState('');
  const [page, setPage] = useState(1);
  const jobs = useQuery({
    queryKey: ['admin', 'jobs', status, type, page],
    queryFn: () =>
      api.page<{
        id: string;
        type: string;
        status: string;
        queueName: string;
        attempts: number;
        maxAttempts: number;
        error: string | null;
        message: string | null;
        createdAt: string;
        finishedAt: string | null;
        retryable: boolean;
        workspaceId: string | null;
      }>('/admin/jobs', {
        status: status || undefined,
        type: type || undefined,
        page,
        pageSize: 25,
      }),
    placeholderData: keepPreviousData,
  });
  const retry = useMutation({
    mutationFn: (id: string) => api.post(`/admin/jobs/${id}/retry`),
    onSuccess: () => {
      toast.success('Job queued for retry');
      void queryClient.invalidateQueries({ queryKey: ['admin', 'jobs'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Card>
      <div className="flex flex-wrap gap-2 p-4">
        <NativeSelect
          aria-label="Status"
          value={status}
          onChange={(e) => (setPage(1), setStatus(e.target.value))}
          className="w-40"
        >
          <option value="">All statuses</option>
          {JOB_STATUSES.map((s) => (
            <option key={s} value={s}>
              {humanize(s)}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect
          aria-label="Type"
          value={type}
          onChange={(e) => (setPage(1), setType(e.target.value))}
          className="w-52"
        >
          <option value="">All types</option>
          {BACKGROUND_JOB_TYPES.map((t) => (
            <option key={t} value={t}>
              {humanize(t)}
            </option>
          ))}
        </NativeSelect>
      </div>
      {jobs.isPending ? (
        <LoadingBlock className="px-5 pb-5" />
      ) : jobs.isError ? (
        <ErrorState className="mx-5 mb-5" error={jobs.error} />
      ) : (
        <>
          <Table>
            <THead>
              <TR>
                <TH>Job</TH>
                <TH>Status</TH>
                <TH>Attempts</TH>
                <TH>Error</TH>
                <TH>Created</TH>
                <TH className="sr-only">Actions</TH>
              </TR>
            </THead>
            <TBody>
              {jobs.data.items.map((j) => (
                <TR key={j.id}>
                  <TD>
                    <span className="font-medium">{humanize(j.type)}</span>
                    <span className="block font-mono text-xs text-muted-foreground">
                      {j.queueName} · {j.id}
                    </span>
                  </TD>
                  <TD>
                    <StatusBadge status={j.status} />
                  </TD>
                  <TD className="tabular-nums">
                    {j.attempts}/{j.maxAttempts}
                  </TD>
                  <TD className="max-w-[22rem] text-xs text-destructive">
                    <span className="line-clamp-2" title={j.error ?? undefined}>
                      {j.error ?? ''}
                    </span>
                  </TD>
                  <TD className="text-xs text-muted-foreground">{formatDateTime(j.createdAt)}</TD>
                  <TD className="text-right">
                    {j.retryable ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => retry.mutate(j.id)}
                        disabled={retry.isPending}
                      >
                        <RotateCcw /> Retry
                      </Button>
                    ) : null}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
          <Pagination meta={jobs.data.meta} onPage={setPage} />
        </>
      )}
      <p className="px-5 pb-4 text-xs text-muted-foreground">
        Only report, Search Console sync, competitor snapshot and email jobs can be retried here. Audits and
        AI runs are started again from the project so plan limits are re-checked.
      </p>
    </Card>
  );
}

interface AdminPlan {
  key: string;
  name: string;
  description: string;
  currency: string;
  priceMonthly: number;
  priceYearly: number;
  limits: PlanLimits;
  features: string[];
  highlighted: boolean;
  isActive: boolean;
  sortOrder: number;
  stripePriceMonthlyId: string | null;
  stripePriceYearlyId: string | null;
  razorpayPlanMonthlyId: string | null;
  razorpayPlanYearlyId: string | null;
  subscriptionCount: number;
}

function PlanEditor({ plan, onClose }: { plan: AdminPlan; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [state, setState] = useState({
    name: plan.name,
    description: plan.description,
    priceMonthly: String(plan.priceMonthly),
    priceYearly: String(plan.priceYearly),
    features: plan.features.join('\n'),
    limits: JSON.stringify(plan.limits, null, 2),
    isActive: plan.isActive,
    highlighted: plan.highlighted,
    stripePriceMonthlyId: plan.stripePriceMonthlyId ?? '',
    stripePriceYearlyId: plan.stripePriceYearlyId ?? '',
    razorpayPlanMonthlyId: plan.razorpayPlanMonthlyId ?? '',
    razorpayPlanYearlyId: plan.razorpayPlanYearlyId ?? '',
  });
  const [limitsError, setLimitsError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => {
      let limits: unknown;
      try {
        limits = JSON.parse(state.limits);
      } catch {
        throw new Error('Limits must be valid JSON.');
      }
      const parsed = planLimitsSchema.safeParse(limits);
      if (!parsed.success)
        throw new Error(
          `Invalid limits: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
        );
      return api.patch(`/admin/plans/${plan.key}`, {
        name: state.name,
        description: state.description,
        priceMonthly: Number(state.priceMonthly),
        priceYearly: Number(state.priceYearly),
        features: state.features
          .split('\n')
          .map((f) => f.trim())
          .filter(Boolean),
        limits: parsed.data,
        isActive: state.isActive,
        highlighted: state.highlighted,
        stripePriceMonthlyId: state.stripePriceMonthlyId || null,
        stripePriceYearlyId: state.stripePriceYearlyId || null,
        razorpayPlanMonthlyId: state.razorpayPlanMonthlyId || null,
        razorpayPlanYearlyId: state.razorpayPlanYearlyId || null,
      });
    },
    onSuccess: () => {
      toast.success('Plan updated');
      void queryClient.invalidateQueries({ queryKey: ['admin', 'plans'] });
      void queryClient.invalidateQueries({ queryKey: ['billing', 'plans'] });
      onClose();
    },
    onError: (e) =>
      setLimitsError(
        e instanceof ApiError && e.code === 'VALIDATION_ERROR'
          ? Object.entries(e.fieldErrors)
              .map(([k, m]) => `${k}: ${m}`)
              .join('; ')
          : errorMessage(e),
      ),
  });
  const set = (patch: Partial<typeof state>) => setState((s) => ({ ...s, ...patch }));
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent size="xl">
        <DialogHeader
          title={`Edit ${plan.name} (${plan.key})`}
          description={`${plan.subscriptionCount} subscription(s). Limit changes apply immediately to every workspace on this plan.`}
        />
        <div className="grid gap-4 md:grid-cols-2">
          <div className="grid gap-4">
            <Field label="Name">
              <Input value={state.name} onChange={(e) => set({ name: e.target.value })} />
            </Field>
            <Field label="Description">
              <Textarea
                rows={2}
                value={state.description}
                onChange={(e) => set({ description: e.target.value })}
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label={`Monthly price (${plan.currency})`}>
                <Input
                  type="number"
                  min={0}
                  step="0.01"
                  value={state.priceMonthly}
                  onChange={(e) => set({ priceMonthly: e.target.value })}
                />
              </Field>
              <Field label={`Yearly price (${plan.currency})`}>
                <Input
                  type="number"
                  min={0}
                  step="0.01"
                  value={state.priceYearly}
                  onChange={(e) => set({ priceYearly: e.target.value })}
                />
              </Field>
            </div>
            <Field label="Feature bullets" description="One per line">
              <Textarea rows={5} value={state.features} onChange={(e) => set({ features: e.target.value })} />
            </Field>
            <div className="flex gap-6">
              <label className="flex items-center gap-2 text-sm">
                <Switch
                  checked={state.isActive}
                  onCheckedChange={(v) => set({ isActive: v })}
                  disabled={plan.key === 'FREE'}
                />{' '}
                Active
              </label>
              <label className="flex items-center gap-2 text-sm">
                <Switch checked={state.highlighted} onCheckedChange={(v) => set({ highlighted: v })} />{' '}
                Highlighted
              </label>
            </div>
          </div>
          <div className="grid gap-4">
            <Field label="Limits (JSON, validated)">
              <Textarea
                rows={14}
                value={state.limits}
                onChange={(e) => set({ limits: e.target.value })}
                className="font-mono text-xs"
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Stripe monthly price ID" optional>
                <Input
                  value={state.stripePriceMonthlyId}
                  onChange={(e) => set({ stripePriceMonthlyId: e.target.value })}
                />
              </Field>
              <Field label="Stripe yearly price ID" optional>
                <Input
                  value={state.stripePriceYearlyId}
                  onChange={(e) => set({ stripePriceYearlyId: e.target.value })}
                />
              </Field>
              <Field label="Razorpay monthly plan ID" optional>
                <Input
                  value={state.razorpayPlanMonthlyId}
                  onChange={(e) => set({ razorpayPlanMonthlyId: e.target.value })}
                />
              </Field>
              <Field label="Razorpay yearly plan ID" optional>
                <Input
                  value={state.razorpayPlanYearlyId}
                  onChange={(e) => set({ razorpayPlanYearlyId: e.target.value })}
                />
              </Field>
            </div>
          </div>
        </div>
        {limitsError ? <Alert tone="danger">{limitsError}</Alert> : null}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => (setLimitsError(null), save.mutate())} loading={save.isPending}>
            Save plan
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PlansTab() {
  const plans = useQuery({
    queryKey: ['admin', 'plans'],
    queryFn: () => api.get<AdminPlan[]>('/admin/plans'),
  });
  const [editing, setEditing] = useState<AdminPlan | null>(null);
  if (plans.isPending) return <LoadingBlock />;
  if (plans.isError) return <ErrorState error={plans.error} />;
  return (
    <Card>
      <Table>
        <THead>
          <TR>
            <TH>Plan</TH>
            <TH className="text-right">Monthly</TH>
            <TH className="text-right">Yearly</TH>
            <TH className="text-right">Subscriptions</TH>
            <TH>Payment IDs</TH>
            <TH className="sr-only">Actions</TH>
          </TR>
        </THead>
        <TBody>
          {plans.data.map((p) => (
            <TR key={p.key}>
              <TD>
                <span className="font-medium">{p.name}</span> {!p.isActive ? <Badge>Inactive</Badge> : null}{' '}
                {p.highlighted ? <Badge tone="primary">Highlighted</Badge> : null}
                <span className="block font-mono text-xs text-muted-foreground">{p.key}</span>
              </TD>
              <TD className="text-right tabular-nums">{formatCurrency(p.priceMonthly, p.currency)}</TD>
              <TD className="text-right tabular-nums">{formatCurrency(p.priceYearly, p.currency)}</TD>
              <TD className="text-right tabular-nums">{p.subscriptionCount}</TD>
              <TD className="text-xs">
                {p.stripePriceMonthlyId || p.razorpayPlanMonthlyId ? (
                  <Badge tone="success">Configured</Badge>
                ) : p.priceMonthly > 0 ? (
                  <Badge tone="warning">Missing</Badge>
                ) : (
                  <span className="text-muted-foreground">Not needed</span>
                )}
              </TD>
              <TD className="text-right">
                <Button size="sm" variant="ghost" onClick={() => setEditing(p)}>
                  Edit
                </Button>
              </TD>
            </TR>
          ))}
        </TBody>
      </Table>
      {editing ? <PlanEditor plan={editing} onClose={() => setEditing(null)} /> : null}
    </Card>
  );
}

function UsageTab() {
  const [period, setPeriod] = useState(new Date().toISOString().slice(0, 7));
  const usage = useQuery({
    queryKey: ['admin', 'usage', period],
    queryFn: () =>
      api.get<{
        periodKey: string;
        totals: { metric: string; label: string; used: number }[];
        workspaces: {
          workspaceId: string;
          workspaceName: string | null;
          billableEvents: number;
          metrics: Record<string, number>;
        }[];
      }>('/admin/usage', { period }),
    placeholderData: keepPreviousData,
  });
  return (
    <div className="space-y-5">
      <Field label="Month (UTC)" className="max-w-48">
        <Input type="month" value={period} onChange={(e) => e.target.value && setPeriod(e.target.value)} />
      </Field>
      {usage.isPending ? (
        <LoadingBlock />
      ) : usage.isError ? (
        <ErrorState error={usage.error} />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {usage.data.totals.map((t) => (
              <MetricCard key={t.metric} label={t.label} value={formatNumber(t.used)} />
            ))}
          </div>
          <Card>
            <CardHeaderRow
              title="By workspace"
              description="Ordered by number of billable events (top 100)"
            />
            <Table>
              <THead>
                <TR>
                  <TH>Workspace</TH>
                  <TH className="text-right">Events</TH>
                  {usage.data.totals.map((t) => (
                    <TH key={t.metric} className="text-right">
                      {t.label}
                    </TH>
                  ))}
                </TR>
              </THead>
              <TBody>
                {usage.data.workspaces.map((w) => (
                  <TR key={w.workspaceId}>
                    <TD className="font-medium">{w.workspaceName ?? w.workspaceId}</TD>
                    <TD className="text-right tabular-nums">{formatNumber(w.billableEvents)}</TD>
                    {usage.data.totals.map((t) => (
                      <TD key={t.metric} className="text-right tabular-nums">
                        {formatNumber(w.metrics[t.metric] ?? 0)}
                      </TD>
                    ))}
                  </TR>
                ))}
              </TBody>
            </Table>
          </Card>
        </>
      )}
    </div>
  );
}

interface SystemStatus {
  environment: string;
  checks: { database: boolean; queue: boolean; redis: boolean | null };
  queues: Record<string, { queued: number; running: number; failedLast24h: number }>;
  providers: {
    llm: { provider: string; configured: boolean; model: string };
    visibility: { key: string; label: string; status: string; detail: string }[];
    demoMode: boolean;
    keywordData: { provider: string };
    billing: { provider: string; stripeConfigured: boolean; razorpayConfigured: boolean };
    email: { provider: string; smtpConfigured: boolean };
    pdf: { renderer: string };
    storage: { driver: string };
    integrations: { provider: string; name: string; availability: string; configured: boolean }[];
  };
}

function SystemTab() {
  const q = useQuery({
    queryKey: ['admin', 'system'],
    queryFn: () => api.get<SystemStatus>('/admin/system'),
    refetchInterval: 30_000,
  });
  if (q.isPending) return <LoadingBlock />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const s = q.data;
  const ok = (v: boolean | null) =>
    v === null ? (
      <Badge>Not used</Badge>
    ) : v ? (
      <Badge tone="success">OK</Badge>
    ) : (
      <Badge tone="danger">Down</Badge>
    );
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Card>
        <CardHeaderRow title="Dependencies" description={`Environment: ${s.environment}`} />
        <CardContent className="grid gap-2 text-sm">
          <p className="flex justify-between">MySQL {ok(s.checks.database)}</p>
          <p className="flex justify-between">Job queue {ok(s.checks.queue)}</p>
          <p className="flex justify-between">Redis (rate limits) {ok(s.checks.redis)}</p>
        </CardContent>
      </Card>
      <Card>
        <CardHeaderRow title="Queues" description="From job records" />
        <Table>
          <THead>
            <TR>
              <TH>Queue</TH>
              <TH className="text-right">Queued</TH>
              <TH className="text-right">Running</TH>
              <TH className="text-right">Failed (24 h)</TH>
            </TR>
          </THead>
          <TBody>
            {Object.entries(s.queues).length ? (
              Object.entries(s.queues).map(([name, v]) => (
                <TR key={name}>
                  <TD className="font-mono text-xs">{name}</TD>
                  <TD className="text-right tabular-nums">{v.queued}</TD>
                  <TD className="text-right tabular-nums">{v.running}</TD>
                  <TD className="text-right tabular-nums">{v.failedLast24h}</TD>
                </TR>
              ))
            ) : (
              <TR>
                <TD colSpan={4} className="text-sm text-muted-foreground">
                  No queued, running or recently failed jobs.
                </TD>
              </TR>
            )}
          </TBody>
        </Table>
      </Card>
      <Card className="lg:col-span-2">
        <CardHeaderRow title="Providers" description="Configuration status only; secrets are never shown." />
        <CardContent className="grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
          <p className="flex justify-between gap-3">
            Content LLM ({s.providers.llm.provider}){' '}
            {s.providers.llm.configured ? (
              <Badge tone="success">{s.providers.llm.model}</Badge>
            ) : (
              <Badge tone="warning">Not configured</Badge>
            )}
          </p>
          <p className="flex justify-between gap-3">
            AI demo mode {s.providers.demoMode ? <Badge tone="demo">On</Badge> : <Badge>Off</Badge>}
          </p>
          {s.providers.visibility.map((v) => (
            <p key={v.key} className="flex justify-between gap-3" title={v.detail}>
              {v.label}{' '}
              <StatusBadge
                status={
                  v.status === 'configured' ? 'ACTIVE' : v.status === 'demo' ? 'PAUSED' : 'DISCONNECTED'
                }
                label={humanize(v.status)}
              />
            </p>
          ))}
          <p className="flex justify-between gap-3">
            Billing ({s.providers.billing.provider}){' '}
            <span className="text-xs text-muted-foreground">
              Stripe {s.providers.billing.stripeConfigured ? 'configured' : 'not configured'} · Razorpay{' '}
              {s.providers.billing.razorpayConfigured ? 'configured' : 'not configured'}
            </span>
          </p>
          <p className="flex justify-between gap-3">
            Email ({s.providers.email.provider}){' '}
            {s.providers.email.provider === 'console' ? (
              <Badge tone="warning">Local files only</Badge>
            ) : s.providers.email.smtpConfigured ? (
              <Badge tone="success">SMTP</Badge>
            ) : (
              <Badge tone="warning">SMTP not configured</Badge>
            )}
          </p>
          <p className="flex justify-between gap-3">
            PDF renderer <Badge>{s.providers.pdf.renderer}</Badge>
          </p>
          <p className="flex justify-between gap-3">
            Keyword data <Badge>{s.providers.keywordData.provider}</Badge>
          </p>
          <p className="flex justify-between gap-3">
            Storage <Badge>{s.providers.storage.driver}</Badge>
          </p>
          {s.providers.integrations.map((i) => (
            <p key={i.provider} className="flex justify-between gap-3">
              {i.name}{' '}
              {i.availability === 'planned' ? (
                <Badge>Planned</Badge>
              ) : i.configured ? (
                <Badge tone="success">Configured</Badge>
              ) : (
                <Badge tone="warning">Not configured</Badge>
              )}
            </p>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

function AuditLogsTab() {
  const [action, setAction] = useState('');
  const [filter, setFilter] = useState('');
  const [page, setPage] = useState(1);
  const logs = useQuery({
    queryKey: ['admin', 'audit-logs', filter, page],
    queryFn: () =>
      api.page<{
        id: string;
        action: string;
        actor: { name: string; email: string } | null;
        workspace: { name: string } | null;
        targetType: string | null;
        targetId: string | null;
        ipAddress: string | null;
        createdAt: string;
      }>('/admin/audit-logs', { action: filter || undefined, page, pageSize: 50 }),
    placeholderData: keepPreviousData,
  });
  return (
    <Card>
      <form
        className="m-4 flex max-w-md gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setPage(1);
          setFilter(action.trim());
        }}
      >
        <Input
          value={action}
          onChange={(e) => setAction(e.target.value)}
          placeholder="Action prefix, e.g. admin. or billing."
          aria-label="Filter by action"
        />
        <Button type="submit" variant="outline">
          Filter
        </Button>
      </form>
      {logs.isPending ? (
        <LoadingBlock className="px-5 pb-5" />
      ) : logs.isError ? (
        <ErrorState className="mx-5 mb-5" error={logs.error} />
      ) : (
        <>
          <Table>
            <THead>
              <TR>
                <TH>When</TH>
                <TH>Action</TH>
                <TH>Actor</TH>
                <TH>Workspace</TH>
                <TH>Target</TH>
              </TR>
            </THead>
            <TBody>
              {logs.data.items.map((l) => (
                <TR key={l.id}>
                  <TD className="text-xs whitespace-nowrap">{formatDateTime(l.createdAt)}</TD>
                  <TD className="font-mono text-xs">{l.action}</TD>
                  <TD className="text-xs">{l.actor ? l.actor.email : 'System'}</TD>
                  <TD className="text-xs">{l.workspace?.name ?? '—'}</TD>
                  <TD className="font-mono text-xs text-muted-foreground">
                    {l.targetType ? `${l.targetType}:${l.targetId ?? ''}` : '—'}
                  </TD>
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

function ProviderCostsTab() {
  const queryClient = useQueryClient();
  const rates = useQuery({
    queryKey: ['admin', 'provider-rates'],
    queryFn: () => api.get<ProviderRateDto[]>('/admin/provider-rates'),
  });
  const costs = useQuery({
    queryKey: ['admin', 'provider-costs'],
    queryFn: () =>
      api.get<{ from: string; to: string; lines: ProviderCostLineDto[] }>('/admin/provider-costs'),
  });
  const [form, setForm] = useState({
    provider: 'openai',
    operation: '',
    unit: 'input_token',
    price: '',
    unitQuantity: '1000000',
    currency: 'USD',
    effectiveFrom: new Date().toISOString().slice(0, 10),
    note: '',
  });
  const set = (key: keyof typeof form, value: string) => setForm((f) => ({ ...f, [key]: value }));
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['admin', 'provider-rates'] });
    void queryClient.invalidateQueries({ queryKey: ['admin', 'provider-costs'] });
  };
  const create = useMutation({
    mutationFn: () =>
      api.post('/admin/provider-rates', {
        provider: form.provider.trim(),
        operation: form.operation.trim() || null,
        unit: form.unit,
        price: Number(form.price),
        unitQuantity: Number(form.unitQuantity),
        currency: form.currency.trim().toUpperCase(),
        effectiveFrom: form.effectiveFrom,
        note: form.note || undefined,
      }),
    onSuccess: () => {
      toast.success('Rate added');
      set('price', '');
      refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/provider-rates/${id}`),
    onSuccess: refresh,
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <div className="grid gap-5">
      <Card>
        <CardHeaderRow
          title="Estimated provider costs this month"
          description="From recorded provider calls and the rates below. Calls without a matching rate are counted but not priced."
        />
        {costs.isPending ? (
          <LoadingBlock className="px-5 pb-5" />
        ) : costs.isError ? (
          <ErrorState className="mx-5 mb-5" error={costs.error} />
        ) : costs.data.lines.length ? (
          <Table>
            <THead>
              <TR>
                <TH>Provider · operation</TH>
                <TH className="text-right">Calls</TH>
                <TH className="text-right">Tokens in / out</TH>
                <TH className="text-right">Estimated cost</TH>
                <TH className="text-right">Not priced</TH>
              </TR>
            </THead>
            <TBody>
              {costs.data.lines.map((l) => (
                <TR key={`${l.provider}-${l.operation}`}>
                  <TD className="text-sm">
                    {l.provider} · <span className="text-muted-foreground">{l.operation}</span>
                  </TD>
                  <TD className="text-right tabular-nums">{formatNumber(l.calls)}</TD>
                  <TD className="text-right text-xs tabular-nums">
                    {formatNumber(l.inputTokens)} / {formatNumber(l.outputTokens)}
                  </TD>
                  <TD className="text-right tabular-nums">
                    {Object.entries(l.cost).length
                      ? Object.entries(l.cost)
                          .map(([currency, amount]) => formatCurrency(amount, currency))
                          .join(' + ')
                      : '—'}
                  </TD>
                  <TD className="text-right tabular-nums">
                    {l.unpricedCalls ? formatNumber(l.unpricedCalls) : '—'}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        ) : (
          <CardContent>
            <p className="text-sm text-muted-foreground">No provider calls recorded this month.</p>
          </CardContent>
        )}
      </Card>
      <Card>
        <CardHeaderRow
          title="Provider rates"
          description="Your contracted unit prices. A rate applies from its date; an operation-specific rate overrides a provider-wide one."
        />
        <CardContent className="space-y-4">
          <form
            className="grid gap-3 sm:grid-cols-4 lg:grid-cols-8 lg:items-end"
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate();
            }}
          >
            <Field label="Provider">
              <Input value={form.provider} onChange={(e) => set('provider', e.target.value)} />
            </Field>
            <Field label="Operation (optional)">
              <Input
                value={form.operation}
                onChange={(e) => set('operation', e.target.value)}
                placeholder="all"
              />
            </Field>
            <Field label="Unit">
              <NativeSelect value={form.unit} onChange={(e) => set('unit', e.target.value)}>
                <option value="input_token">Input tokens</option>
                <option value="output_token">Output tokens</option>
                <option value="request">Requests</option>
              </NativeSelect>
            </Field>
            <Field label="Price">
              <Input
                type="number"
                step="any"
                min={0}
                value={form.price}
                onChange={(e) => set('price', e.target.value)}
              />
            </Field>
            <Field label="Per units">
              <Input
                type="number"
                min={1}
                value={form.unitQuantity}
                onChange={(e) => set('unitQuantity', e.target.value)}
              />
            </Field>
            <Field label="Currency">
              <Input value={form.currency} onChange={(e) => set('currency', e.target.value)} maxLength={3} />
            </Field>
            <Field label="From">
              <Input
                type="date"
                value={form.effectiveFrom}
                onChange={(e) => set('effectiveFrom', e.target.value)}
              />
            </Field>
            <Button type="submit" loading={create.isPending} disabled={form.price === ''}>
              Add rate
            </Button>
          </form>
          {rates.isPending ? (
            <LoadingBlock />
          ) : rates.isError ? (
            <ErrorState error={rates.error} />
          ) : rates.data.length ? (
            <Table>
              <THead>
                <TR>
                  <TH>Provider · operation</TH>
                  <TH>Unit</TH>
                  <TH className="text-right">Price</TH>
                  <TH>From</TH>
                  <TH className="sr-only">Actions</TH>
                </TR>
              </THead>
              <TBody>
                {rates.data.map((r) => (
                  <TR key={r.id}>
                    <TD className="text-sm">
                      {r.provider} ·{' '}
                      <span className="text-muted-foreground">{r.operation ?? 'all operations'}</span>
                    </TD>
                    <TD className="text-sm">{humanize(r.unit)}</TD>
                    <TD className="text-right text-sm tabular-nums">
                      {formatCurrency(r.price, r.currency)} per {formatNumber(r.unitQuantity)}
                    </TD>
                    <TD className="text-xs text-muted-foreground">{formatDateTime(r.effectiveFrom)}</TD>
                    <TD className="text-right">
                      <Button variant="ghost" size="sm" onClick={() => remove.mutate(r.id)}>
                        Delete
                      </Button>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          ) : (
            <Alert tone="info" title="No rates configured">
              Provider usage is still recorded. Add your contracted prices to see estimated costs and service
              margins.
            </Alert>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

const TABS = [
  'overview',
  'users',
  'workspaces',
  'jobs',
  'plans',
  'usage',
  'costs',
  'system',
  'audit',
] as const;

export default function AdminPage() {
  const [params, setParams] = useSearchParams();
  const tab = (TABS as readonly string[]).includes(params.get('tab') ?? '')
    ? (params.get('tab') as (typeof TABS)[number])
    : 'overview';
  return (
    <>
      <PageHeader
        title="Platform admin"
        description="Visible to platform administrators only. Every change is recorded in the audit log."
      />
      <Tabs
        value={tab}
        onValueChange={(v) => setParams(v === 'overview' ? {} : { tab: v }, { replace: true })}
      >
        <TabsList className="mb-5">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="users">Users</TabsTrigger>
          <TabsTrigger value="workspaces">Workspaces</TabsTrigger>
          <TabsTrigger value="jobs">Jobs</TabsTrigger>
          <TabsTrigger value="plans">Plans</TabsTrigger>
          <TabsTrigger value="usage">Usage</TabsTrigger>
          <TabsTrigger value="costs">Provider costs</TabsTrigger>
          <TabsTrigger value="system">System</TabsTrigger>
          <TabsTrigger value="audit">Audit log</TabsTrigger>
        </TabsList>
        <TabsContent value="overview" className="mt-0">
          <OverviewTab />
        </TabsContent>
        <TabsContent value="users" className="mt-0">
          <UsersTab />
        </TabsContent>
        <TabsContent value="workspaces" className="mt-0">
          <WorkspacesTab />
        </TabsContent>
        <TabsContent value="jobs" className="mt-0">
          <JobsTab />
        </TabsContent>
        <TabsContent value="plans" className="mt-0">
          <PlansTab />
        </TabsContent>
        <TabsContent value="usage" className="mt-0">
          <UsageTab />
        </TabsContent>
        <TabsContent value="costs" className="mt-0">
          <ProviderCostsTab />
        </TabsContent>
        <TabsContent value="system" className="mt-0">
          <SystemTab />
        </TabsContent>
        <TabsContent value="audit" className="mt-0">
          <AuditLogsTab />
        </TabsContent>
      </Tabs>
    </>
  );
}
