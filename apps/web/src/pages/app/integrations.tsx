import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  CircleDashed,
  Plug,
  RefreshCw,
  Unplug,
  XCircle,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import type { DiagnosticCheck, DiagnosticStatus, IntegrationDiagnosticsDto } from '@surfaced/shared';
import { useProject } from '@/app/project-scope';
import { ChartFrame, LineTrend } from '@/components/charts/charts';
import { SERIES } from '@/components/charts/palette';
import { JobProgress, MetricCard, PageHeader } from '@/components/app/page';
import { Badge, StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeaderRow } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/dialog';
import { Alert, ErrorState, LoadingBlock } from '@/components/ui/feedback';
import { Label, NativeSelect } from '@/components/ui/form';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { api, errorMessage } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { formatDate, formatDateTime, formatNumber, formatPercent, urlPath } from '@/lib/format';

interface IntegrationEntry {
  provider: string;
  name: string;
  description: string;
  availability: 'implemented' | 'planned';
  configured: boolean;
  setup: string;
  integration: {
    id: string;
    status: string;
    externalAccount: string | null;
    siteUrl: string | null;
    connectedAt: string | null;
    lastSyncAt: string | null;
    lastSyncStatus: string | null;
    lastError: string | null;
  } | null;
}

interface GscMetrics {
  daily: { date: string; clicks: number; impressions: number; ctr: number; position: number }[];
  totals: { clicks: number; impressions: number; ctr: number | null; position: number | null };
  topRange: { from: string; to: string } | null;
  topQueries: { query: string; clicks: number; impressions: number; ctr: number; position: number }[];
  topPages: { page: string; clicks: number; impressions: number; ctr: number; position: number }[];
}

function SearchConsoleData({ projectId }: { projectId: string }) {
  const metrics = useQuery({
    queryKey: ['gsc', projectId],
    queryFn: () => api.get<GscMetrics>(`/projects/${projectId}/search-console`),
  });
  if (metrics.isPending) return <LoadingBlock rows={6} />;
  if (metrics.isError) return <ErrorState error={metrics.error} onRetry={() => void metrics.refetch()} />;
  const m = metrics.data;
  if (!m.daily.length)
    return (
      <p className="text-sm text-muted-foreground">
        No Search Console data has been synced yet. Choose a property and sync.
      </p>
    );
  const rows = m.daily.map((d) => ({ date: d.date, clicks: d.clicks, impressions: d.impressions }));
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MetricCard
          label="Clicks"
          value={formatNumber(m.totals.clicks)}
          sub="Last 90 days (2-day data delay)"
        />
        <MetricCard label="Impressions" value={formatNumber(m.totals.impressions)} />
        <MetricCard label="Average CTR" value={formatPercent(m.totals.ctr, 1)} />
        <MetricCard
          label="Average position"
          value={m.totals.position ? m.totals.position.toFixed(1) : '—'}
          help="Impression-weighted average position, as reported by Google."
        />
      </div>
      <div className="grid gap-5 xl:grid-cols-2">
        <ChartFrame
          title="Clicks per day"
          table={{ columns: ['Date', 'Clicks'], rows: rows.map((r) => [r.date, r.clicks]) }}
        >
          <LineTrend
            data={rows}
            xKey="date"
            series={[{ key: 'clicks', label: 'Clicks', color: SERIES[0] }]}
            formatY={(v) => formatNumber(v, { notation: 'compact' })}
            formatX={(v) => formatDate(v, { month: 'short', day: 'numeric' })}
            height={200}
          />
        </ChartFrame>
        <ChartFrame
          title="Impressions per day"
          table={{ columns: ['Date', 'Impressions'], rows: rows.map((r) => [r.date, r.impressions]) }}
        >
          <LineTrend
            data={rows}
            xKey="date"
            series={[{ key: 'impressions', label: 'Impressions', color: SERIES[0] }]}
            formatY={(v) => formatNumber(v, { notation: 'compact' })}
            formatX={(v) => formatDate(v, { month: 'short', day: 'numeric' })}
            height={200}
          />
        </ChartFrame>
      </div>
      <div className="grid gap-5 xl:grid-cols-2">
        {[
          { title: 'Top queries', items: m.topQueries.map((q) => ({ key: q.query, ...q })) },
          { title: 'Top pages', items: m.topPages.map((p) => ({ key: urlPath(p.page), ...p })) },
        ].map((section) => (
          <div key={section.title}>
            <p className="mb-2 text-sm font-semibold">
              {section.title}{' '}
              {m.topRange ? (
                <span className="font-normal text-muted-foreground">
                  · {formatDate(m.topRange.from)} – {formatDate(m.topRange.to)}
                </span>
              ) : null}
            </p>
            <div className="max-h-96 overflow-y-auto rounded-lg border border-border">
              <Table>
                <THead>
                  <TR>
                    <TH>{section.title === 'Top queries' ? 'Query' : 'Page'}</TH>
                    <TH className="text-right">Clicks</TH>
                    <TH className="text-right">Impr.</TH>
                    <TH className="text-right">Pos.</TH>
                  </TR>
                </THead>
                <TBody>
                  {section.items.slice(0, 25).map((row) => (
                    <TR key={row.key}>
                      <TD className="max-w-[16rem] truncate text-xs" title={row.key}>
                        {row.key}
                      </TD>
                      <TD className="text-right text-xs tabular-nums">{formatNumber(row.clicks)}</TD>
                      <TD className="text-right text-xs tabular-nums">{formatNumber(row.impressions)}</TD>
                      <TD className="text-right text-xs tabular-nums">{row.position.toFixed(1)}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function SearchConsoleCard({ entry }: { entry: IntegrationEntry }) {
  const project = useProject();
  const queryClient = useQueryClient();
  const canManage = useCan('integration.manage');
  const [jobId, setJobId] = useState<string | null>(null);
  const integration = entry.integration;
  const connected = integration && (integration.status === 'CONNECTED' || integration.status === 'ERROR');
  const sites = useQuery({
    queryKey: ['gsc-sites', integration?.id],
    queryFn: () =>
      api.get<{ siteUrl: string; permissionLevel: string }[]>(`/integrations/${integration!.id}/gsc/sites`),
    enabled: Boolean(connected && canManage),
    retry: false,
  });
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['integrations', project.id] });
    void queryClient.invalidateQueries({ queryKey: ['gsc', project.id] });
  };
  const connect = useMutation({
    mutationFn: () =>
      api.post<{ url: string }>(`/projects/${project.id}/integrations/google-search-console/connect`),
    onSuccess: (r) => window.location.assign(r.url),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const choose = useMutation({
    mutationFn: (siteUrl: string) => api.patch(`/integrations/${integration!.id}`, { siteUrl }),
    onSuccess: () => {
      toast.success('Property selected');
      refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const sync = useMutation({
    mutationFn: () => api.post<{ jobId: string }>(`/integrations/${integration!.id}/sync`),
    onSuccess: (r) => setJobId(r.jobId),
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Card>
      <CardHeaderRow
        title={
          <span className="flex items-center gap-2">
            {entry.name} {integration ? <StatusBadge status={integration.status} /> : null}
          </span>
        }
        description={entry.description}
        actions={
          canManage && entry.configured ? (
            !integration || integration.status === 'DISCONNECTED' ? (
              <Button onClick={() => connect.mutate()} loading={connect.isPending}>
                <Plug /> Connect with Google
              </Button>
            ) : integration.status === 'NEEDS_REAUTH' ? (
              <Button onClick={() => connect.mutate()} loading={connect.isPending}>
                <Plug /> Reconnect
              </Button>
            ) : (
              <>
                <Button
                  variant="outline"
                  onClick={() => sync.mutate()}
                  loading={sync.isPending}
                  disabled={!integration.siteUrl || Boolean(jobId)}
                >
                  <RefreshCw /> Sync now
                </Button>
                <ConfirmDialog
                  title="Disconnect Google Search Console?"
                  description="Access is revoked at Google and the stored tokens are deleted. Synced data stays in your reports."
                  confirmLabel="Disconnect"
                  destructive
                  onConfirm={async () => {
                    await api.delete(`/integrations/${integration.id}`);
                    toast.success('Disconnected');
                    refresh();
                  }}
                  trigger={
                    <Button variant="ghost" size="icon" aria-label="Disconnect">
                      <Unplug />
                    </Button>
                  }
                />
              </>
            )
          ) : null
        }
      />
      <CardContent className="space-y-4">
        {!entry.configured ? (
          <Alert tone="warning" title="Not configured on this server">
            {entry.setup}
          </Alert>
        ) : null}
        {integration?.status === 'NEEDS_REAUTH' ? (
          <Alert tone="warning">Google access expired or was revoked. Reconnect to keep syncing.</Alert>
        ) : null}
        {integration?.lastError ? (
          <Alert tone="danger" title="Last sync failed">
            {integration.lastError}
          </Alert>
        ) : null}
        {connected ? (
          <div className="grid gap-4 sm:grid-cols-[1fr_auto] sm:items-end">
            <div className="grid gap-1.5">
              <Label htmlFor="gsc-site">Property</Label>
              {canManage ? (
                <NativeSelect
                  id="gsc-site"
                  value={integration.siteUrl ?? ''}
                  onChange={(e) => e.target.value && choose.mutate(e.target.value)}
                  disabled={sites.isPending || choose.isPending}
                >
                  <option value="">{sites.isPending ? 'Loading properties…' : 'Choose a property'}</option>
                  {sites.data?.map((s) => (
                    <option key={s.siteUrl} value={s.siteUrl}>
                      {s.siteUrl} ({s.permissionLevel.replace('site', '').toLowerCase()})
                    </option>
                  ))}
                </NativeSelect>
              ) : (
                <p className="text-sm">{integration.siteUrl ?? 'No property selected'}</p>
              )}
              {sites.isError ? (
                <p className="text-[13px] text-destructive">{errorMessage(sites.error)}</p>
              ) : null}
            </div>
            <p className="text-xs text-muted-foreground">
              {integration.externalAccount ? `Connected as ${integration.externalAccount}` : null}
              {integration.lastSyncAt
                ? ` · last sync ${formatDateTime(integration.lastSyncAt)}`
                : ' · not synced yet'}
            </p>
          </div>
        ) : null}
        {jobId ? (
          <JobProgress
            jobId={jobId}
            label="Search Console sync"
            onFinished={refresh}
            onDismiss={() => setJobId(null)}
          />
        ) : null}
        {connected && integration.siteUrl ? <SearchConsoleData projectId={project.id} /> : null}
      </CardContent>
    </Card>
  );
}

/** Business Profile and Merchant Center: connection here; everything else lives on their own pages. */
function PageIntegrationCard({
  entry,
  slug,
  to,
  pageLabel,
  disconnectDescription,
}: {
  entry: IntegrationEntry;
  slug: string;
  to: string;
  pageLabel: string;
  disconnectDescription: string;
}) {
  const project = useProject();
  const queryClient = useQueryClient();
  const canManage = useCan('integration.manage');
  const integration = entry.integration;
  const connected = integration && (integration.status === 'CONNECTED' || integration.status === 'ERROR');
  const connect = useMutation({
    mutationFn: () => api.post<{ url: string }>(`/projects/${project.id}/integrations/${slug}/connect`),
    onSuccess: (r) => window.location.assign(r.url),
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Card>
      <CardHeaderRow
        title={
          <span className="flex items-center gap-2">
            {entry.name} {integration ? <StatusBadge status={integration.status} /> : null}
          </span>
        }
        description={entry.description}
        actions={
          <>
            <Button asChild variant="outline">
              <Link to={`/app/p/${project.id}/${to}`}>
                {pageLabel} <ArrowRight />
              </Link>
            </Button>
            {canManage && entry.configured ? (
              !connected ? (
                <Button onClick={() => connect.mutate()} loading={connect.isPending}>
                  <Plug /> {integration?.status === 'NEEDS_REAUTH' ? 'Reconnect' : 'Connect with Google'}
                </Button>
              ) : (
                <ConfirmDialog
                  title={`Disconnect ${entry.name}?`}
                  description={disconnectDescription}
                  confirmLabel="Disconnect"
                  destructive
                  onConfirm={async () => {
                    await api.delete(`/integrations/${integration.id}`);
                    toast.success('Disconnected');
                    void queryClient.invalidateQueries({ queryKey: ['integrations', project.id] });
                    void queryClient.invalidateQueries({ queryKey: ['gbp', project.id] });
                    void queryClient.invalidateQueries({ queryKey: ['merchant', project.id] });
                  }}
                  trigger={
                    <Button variant="ghost" size="icon" aria-label={`Disconnect ${entry.name}`}>
                      <Unplug />
                    </Button>
                  }
                />
              )
            ) : null}
          </>
        }
      />
      <CardContent className="space-y-3">
        {!entry.configured || !connected ? (
          <Alert
            tone={entry.configured ? 'info' : 'warning'}
            title={entry.configured ? 'Before connecting' : 'Not configured on this server'}
          >
            {entry.setup}
          </Alert>
        ) : null}
        {integration?.lastError ? (
          <Alert tone="danger" title="Last sync">
            <span className="whitespace-pre-line">{integration.lastError}</span>
          </Alert>
        ) : null}
        {connected ? (
          <p className="text-xs text-muted-foreground">
            {integration.externalAccount ? `Connected as ${integration.externalAccount}` : 'Connected'}
            {integration.lastSyncAt
              ? ` · last sync ${formatDateTime(integration.lastSyncAt)}`
              : ' · not synced yet'}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

const DIAGNOSTIC_STATUS: Record<DiagnosticStatus, { icon: typeof CheckCircle2; cls: string; label: string }> =
  {
    ok: { icon: CheckCircle2, cls: 'text-emerald-600 dark:text-emerald-400', label: 'OK' },
    warning: { icon: AlertTriangle, cls: 'text-amber-600 dark:text-amber-400', label: 'Needs attention' },
    error: { icon: XCircle, cls: 'text-red-600 dark:text-red-400', label: 'Error' },
    off: { icon: CircleDashed, cls: 'text-muted-foreground', label: 'Not set up' },
  };
const DIAGNOSTIC_CATEGORIES: { key: DiagnosticCheck['category']; label: string }[] = [
  { key: 'connections', label: 'Connections' },
  { key: 'ai', label: 'AI' },
  { key: 'local', label: 'Local search' },
  { key: 'infrastructure', label: 'Infrastructure' },
];

/** One consolidated health view across connections, AI, local search and background jobs. */
function DiagnosticsPanel({ projectId }: { projectId: string }) {
  const diag = useQuery({
    queryKey: ['integration-diagnostics', projectId],
    queryFn: () => api.get<IntegrationDiagnosticsDto>(`/projects/${projectId}/integrations/diagnostics`),
  });
  if (diag.isPending) return <LoadingBlock rows={4} />;
  if (diag.isError) return <ErrorState error={diag.error} onRetry={() => void diag.refetch()} />;
  const { checks, summary } = diag.data;
  const chips: [DiagnosticStatus, number][] = [
    ['error', summary.error],
    ['warning', summary.warning],
    ['off', summary.off],
    ['ok', summary.ok],
  ];
  return (
    <Card>
      <CardHeaderRow
        title="Diagnostics"
        description="Everything the workspace relies on, in one place: what is set up, what is working, and what to fix."
        actions={
          <div className="flex flex-wrap gap-1.5">
            {chips
              .filter(([, n]) => n > 0)
              .map(([status, n]) => {
                const meta = DIAGNOSTIC_STATUS[status];
                return (
                  <span
                    key={status}
                    className={`inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs font-medium ${meta.cls}`}
                  >
                    <meta.icon className="size-3.5" /> {n} {meta.label}
                  </span>
                );
              })}
          </div>
        }
      />
      <CardContent className="space-y-4">
        {DIAGNOSTIC_CATEGORIES.map(({ key, label }) => {
          const items = checks.filter((c) => c.category === key);
          if (!items.length) return null;
          return (
            <div key={key}>
              <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {label}
              </p>
              <ul className="grid gap-1.5">
                {items.map((c) => {
                  const meta = DIAGNOSTIC_STATUS[c.status];
                  return (
                    <li
                      key={c.key}
                      className="flex items-start gap-2.5 rounded-md border border-border px-3 py-2"
                    >
                      <meta.icon className={`mt-0.5 size-4 shrink-0 ${meta.cls}`} aria-label={meta.label} />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium">{c.title}</p>
                        <p className="text-sm text-muted-foreground">{c.detail}</p>
                        {c.fix && c.status !== 'ok' ? (
                          <p className="mt-0.5 text-xs text-foreground">
                            <span className="font-medium">Fix:</span> {c.fix}
                          </p>
                        ) : c.enables ? (
                          <p className="mt-0.5 text-xs text-muted-foreground">Enables: {c.enables}</p>
                        ) : null}
                      </div>
                      {c.link && c.status !== 'ok' ? (
                        <Button asChild size="sm" variant="ghost" className="shrink-0">
                          <Link to={c.link}>
                            Set up <ArrowRight />
                          </Link>
                        </Button>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

export default function IntegrationsPage() {
  const project = useProject();
  const [params, setParams] = useSearchParams();
  const integrations = useQuery({
    queryKey: ['integrations', project.id],
    queryFn: () => api.get<IntegrationEntry[]>(`/projects/${project.id}/integrations`),
  });
  useEffect(() => {
    if (params.get('connected') === 'google-search-console') {
      toast.success('Google Search Console connected', { description: 'Choose the property to sync.' });
      setParams({}, { replace: true });
    }
  }, [params, setParams]);
  const error = params.get('integrationError');
  return (
    <>
      <PageHeader
        title="Integrations"
        description="Bring first-party data into the same workspace. Only official APIs are used, and you can disconnect at any time."
      />
      {error ? (
        <Alert tone="danger" className="mb-5" title="The connection was not completed">
          {error}
        </Alert>
      ) : null}
      <div className="mb-5">
        <DiagnosticsPanel projectId={project.id} />
      </div>
      {integrations.isPending ? (
        <LoadingBlock rows={6} />
      ) : integrations.isError ? (
        <ErrorState error={integrations.error} onRetry={() => void integrations.refetch()} />
      ) : (
        <div className="space-y-5">
          {integrations.data
            .filter((e) => e.availability === 'implemented')
            .map((e) =>
              e.provider === 'GOOGLE_SEARCH_CONSOLE' ? (
                <SearchConsoleCard key={e.provider} entry={e} />
              ) : e.provider === 'GOOGLE_BUSINESS_PROFILE' ? (
                <PageIntegrationCard
                  key={e.provider}
                  entry={e}
                  slug="google-business-profile"
                  to="local/profile"
                  pageLabel="Open Business Profile"
                  disconnectDescription="Access is revoked at Google and the Business Profile data stored in Surfaced (profile, metrics, reviews) is deleted. Links to your locations, reply drafts and approvals are kept."
                />
              ) : e.provider === 'GOOGLE_MERCHANT_CENTER' ? (
                <PageIntegrationCard
                  key={e.provider}
                  entry={e}
                  slug="google-merchant-center"
                  to="local/merchant"
                  pageLabel="Open Merchant Center"
                  disconnectDescription="Access is revoked at Google. Products already read stay in Surfaced until you remove them or import a feed; Merchant Center itself is not changed."
                />
              ) : null,
            )}
          <div className="grid gap-4 md:grid-cols-3">
            {integrations.data
              .filter((e) => e.availability === 'planned')
              .map((e) => (
                <Card key={e.provider} className="p-5">
                  <p className="flex items-center gap-2 font-semibold">
                    {e.name} <Badge>Planned</Badge>
                  </p>
                  <p className="mt-2 text-sm text-muted-foreground">{e.description}</p>
                  <p className="mt-2 text-xs text-muted-foreground">{e.setup}</p>
                </Card>
              ))}
          </div>
        </div>
      )}
    </>
  );
}
