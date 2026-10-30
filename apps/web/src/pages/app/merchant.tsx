import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  ExternalLink,
  FileUp,
  MinusCircle,
  Plug,
  RefreshCw,
  Trash2,
  XCircle,
} from 'lucide-react';
import { Fragment, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import {
  PRODUCT_FEED_MAX_CHARS,
  PRODUCT_PROGRAMS,
  PRODUCT_PROGRAM_LABELS,
  countryName,
  countryOptions,
  languageName,
  type MerchantAccountDto,
  type MerchantChecklistItem,
  type MerchantStatusDto,
  type ProductDto,
  type ProductFeedImportResultDto,
  type ProductFeedPreviewDto,
  type ProductIssue,
} from '@surfaced/shared';
import { useProject } from '@/app/project-scope';
import { JobProgress, MetricCard, PageHeader } from '@/components/app/page';
import { Badge, StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeaderRow } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/dialog';
import { Alert, ErrorState, LoadingBlock } from '@/components/ui/feedback';
import { Input, Label, NativeSelect } from '@/components/ui/form';
import { Pagination, TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api, errorMessage } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { formatDateTime, formatNumber } from '@/lib/format';

const STATUS_ICON: Record<
  MerchantChecklistItem['status'],
  { icon: typeof CheckCircle2; className: string; label: string }
> = {
  done: { icon: CheckCircle2, className: 'text-emerald-600', label: 'Done' },
  todo: { icon: XCircle, className: 'text-amber-600', label: 'To do' },
  unknown: { icon: CircleHelp, className: 'text-muted-foreground', label: 'Not known yet' },
  not_applicable: { icon: MinusCircle, className: 'text-muted-foreground', label: 'Does not apply' },
};

const SEVERITY_TONE = { error: 'danger', warning: 'warning', suggestion: 'info' } as const;

function Checklist({ items, onConnect }: { items: MerchantChecklistItem[]; onConnect: () => void }) {
  return (
    <Card>
      <CardHeaderRow
        title="What your products need to appear on Google"
        description="From what is known; items Surfaced cannot check yet say so."
      />
      <CardContent>
        <ul className="divide-y divide-border">
          {items.map((item) => {
            const meta = STATUS_ICON[item.status];
            const Icon = meta.icon;
            return (
              <li key={item.key} className="flex gap-3 py-3">
                <Icon className={`mt-0.5 size-4 shrink-0 ${meta.className}`} aria-label={meta.label} />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{item.title}</p>
                  <p className="text-[13px] text-muted-foreground">{item.detail}</p>
                </div>
                {item.action ? (
                  item.action.href === '#connect' ? (
                    <Button size="sm" variant="outline" onClick={onConnect}>
                      {item.action.label}
                    </Button>
                  ) : (
                    <Button asChild size="sm" variant="outline">
                      <a href={item.action.href} target="_blank" rel="noreferrer">
                        {item.action.label} <ExternalLink />
                      </a>
                    </Button>
                  )
                ) : null}
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}

function IssueList({ issues }: { issues: ProductIssue[] }) {
  if (!issues.length) return <p className="text-sm text-muted-foreground">No issues found.</p>;
  return (
    <ul className="space-y-2">
      {issues.map((i, n) => (
        <li key={`${i.code}-${n}`} className="text-sm">
          <span className="flex flex-wrap items-center gap-2">
            <Badge tone={SEVERITY_TONE[i.severity]}>{i.severity}</Badge>
            <span className="font-medium">{i.message}</span>
            <Badge tone={i.source === 'GOOGLE' ? 'primary' : 'neutral'}>
              {i.source === 'GOOGLE' ? 'Reported by Google' : 'Surfaced check'}
            </Badge>
          </span>
          {i.fix ? <span className="mt-0.5 block text-[13px] text-muted-foreground">{i.fix}</span> : null}
          <span className="mt-0.5 block text-xs text-muted-foreground">
            {i.programs.length
              ? `Affects: ${i.programs.map((p) => PRODUCT_PROGRAM_LABELS[p].split(' (')[0]).join(', ')}`
              : 'Affects all programs'}
            {i.countries.length ? ` · ${i.countries.join(', ')}` : ''}
            {i.attribute ? ` · attribute ${i.attribute}` : ''}
          </span>
        </li>
      ))}
    </ul>
  );
}

function FeedImport({ status }: { status: MerchantStatusDto }) {
  const project = useProject();
  const queryClient = useQueryClient();
  const canManage = useCan('commerce.manage');
  const [file, setFile] = useState<{ name: string; content: string } | null>(null);
  const [country, setCountry] = useState(project.targetCountries[0] ?? 'IN');
  const [language, setLanguage] = useState(project.targetLanguages[0] ?? 'en');
  const [mode, setMode] = useState<'replace' | 'merge'>('replace');
  const [preview, setPreview] = useState<ProductFeedPreviewDto | null>(null);
  const body = file ? { fileName: file.name, content: file.content, country, language, mode } : null;
  const previewMutation = useMutation({
    mutationFn: () =>
      api.post<ProductFeedPreviewDto>(`/projects/${project.id}/merchant/import/preview`, body),
    onSuccess: setPreview,
    onError: (e) => toast.error(errorMessage(e)),
  });
  const importMutation = useMutation({
    mutationFn: () => api.post<ProductFeedImportResultDto>(`/projects/${project.id}/merchant/import`, body),
    onSuccess: (r) => {
      toast.success(`Imported ${formatNumber(r.imported + r.updated)} products`, {
        description: [r.removed ? `${formatNumber(r.removed)} removed` : null, r.skipped ? `${formatNumber(r.skipped)} not imported (plan limit)` : null].filter(Boolean).join(' · ') || undefined, // prettier-ignore
      });
      setFile(null);
      setPreview(null);
      void queryClient.invalidateQueries({ queryKey: ['merchant', project.id] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const countries = countryOptions().filter(
    (c) => project.targetCountries.includes(c.code) || c.code === country,
  );
  return (
    <Card>
      <CardHeaderRow
        title="Import a product feed"
        description="A CSV or TSV file in Google’s product data format (column names such as id, title, link, price), or a Shopify product export. The file is checked before anything is saved."
      />
      <CardContent className="space-y-4">
        {!status.plan.ecommerce ? (
          <Alert tone="warning" title="Your plan does not include product feeds">
            You can preview a file to see its checks. Importing products and connecting Merchant Center need
            the Starter plan or higher.{' '}
            <Link to="/app/billing" className="font-medium underline">
              See plans
            </Link>
          </Alert>
        ) : null}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="grid gap-1.5 sm:col-span-2">
            <Label htmlFor="feed-file">Feed file</Label>
            <Input
              id="feed-file"
              type="file"
              accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                setPreview(null);
                if (!f) return setFile(null);
                const content = await f.text();
                if (content.length > PRODUCT_FEED_MAX_CHARS) {
                  toast.error(
                    'The file is larger than 20 MB. Split it by category and import each part with “Add or update”.',
                  );
                  return setFile(null);
                }
                setFile({ name: f.name, content });
              }}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="feed-country">Country sold in</Label>
            <NativeSelect id="feed-country" value={country} onChange={(e) => setCountry(e.target.value)}>
              {(countries.length ? countries : countryOptions()).map((c) => (
                <option key={c.code} value={c.code}>
                  {c.name}
                </option>
              ))}
            </NativeSelect>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="feed-language">Language of the data</Label>
            <NativeSelect id="feed-language" value={language} onChange={(e) => setLanguage(e.target.value)}>
              {[...new Set([...project.targetLanguages, language])].map((l) => (
                <option key={l} value={l}>
                  {languageName(l)}
                </option>
              ))}
            </NativeSelect>
          </div>
        </div>
        <fieldset className="flex flex-wrap gap-4 text-sm">
          <legend className="sr-only">Import mode</legend>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="feed-mode"
              checked={mode === 'replace'}
              onChange={() => setMode('replace')}
            />
            Replace the catalog for {countryName(country)} (products not in the file are removed)
          </label>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="feed-mode"
              checked={mode === 'merge'}
              onChange={() => setMode('merge')}
            />
            Add or update only
          </label>
        </fieldset>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            onClick={() => previewMutation.mutate()}
            disabled={!file}
            loading={previewMutation.isPending}
          >
            Check the file
          </Button>
          {canManage && status.plan.ecommerce ? (
            <Button
              onClick={() => importMutation.mutate()}
              disabled={!file || !preview || preview.products === 0}
              loading={importMutation.isPending}
            >
              <FileUp /> Import {preview ? `${formatNumber(preview.products)} products` : ''}
            </Button>
          ) : null}
        </div>
        {preview ? (
          <div className="space-y-3 rounded-md border border-border p-4" aria-live="polite">
            <p className="text-sm">
              <span className="font-medium">
                {preview.format === 'SHOPIFY_CSV'
                  ? 'Shopify export'
                  : preview.format === 'GOOGLE_TSV'
                    ? 'Google format (TSV)'
                    : 'Google format (CSV)'}
              </span>
              : {formatNumber(preview.products)} products from {formatNumber(preview.rows)} rows.{' '}
              {formatNumber(preview.summary.errors)} with errors, {formatNumber(preview.summary.warnings)}{' '}
              with warnings, {formatNumber(preview.summary.ok)} without issues.
            </p>
            {preview.ignoredColumns.length ? (
              <p className="text-xs text-muted-foreground">
                Columns not read: {preview.ignoredColumns.join(', ')}
              </p>
            ) : null}
            {preview.rowErrors.length ? (
              <Alert tone="warning" title={`${preview.rowErrors.length} rows were skipped`}>
                <ul className="list-inside list-disc">
                  {preview.rowErrors.slice(0, 5).map((r) => (
                    <li key={r.row}>
                      Row {r.row}: {r.message}
                    </li>
                  ))}
                </ul>
              </Alert>
            ) : null}
            {preview.sample.length ? (
              <details>
                <summary className="cursor-pointer text-sm font-medium">
                  First {preview.sample.length} products and their checks
                </summary>
                <ul className="mt-3 space-y-3">
                  {preview.sample.map((p) => (
                    <li key={p.offerId} className="rounded-md bg-muted/40 p-3">
                      <p className="text-sm font-medium">{p.title ?? p.offerId}</p>
                      <IssueList issues={p.issues} />
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
            <ul className="space-y-1 text-xs text-muted-foreground">
              {preview.limitations.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {status.lastImport ? (
          <p className="text-xs text-muted-foreground">
            Last import: {status.lastImport.fileName}, {formatNumber(status.lastImport.products)} products,{' '}
            {formatDateTime(status.lastImport.createdAt)}.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function Products({ status }: { status: MerchantStatusDto }) {
  const project = useProject();
  const queryClient = useQueryClient();
  const canManage = useCan('commerce.manage');
  const [filter, setFilter] = useState<'all' | 'errors' | 'warnings' | 'ok'>('all');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<string | null>(null);
  const products = useQuery({
    queryKey: ['merchant', project.id, 'products', filter, q, page],
    queryFn: () =>
      api.page<ProductDto>(`/projects/${project.id}/merchant/products`, {
        filter,
        q: q || undefined,
        page,
        pageSize: 25,
      }),
    placeholderData: keepPreviousData,
  });
  const s = status.products;
  return (
    <Card>
      <CardHeaderRow
        title="Products"
        description="Surfaced’s checks follow Google’s product data specification; issues Google reported (when Merchant Center is connected) are labeled."
        actions={
          canManage && s.bySource.FEED_IMPORT ? (
            <ConfirmDialog
              title="Remove the imported products?"
              description="Products imported from feed files are removed from Surfaced. Merchant Center is not changed."
              confirmLabel="Remove"
              destructive
              onConfirm={async () => {
                await api.delete(`/projects/${project.id}/merchant/feed-products`);
                toast.success('Imported products removed');
                void queryClient.invalidateQueries({ queryKey: ['merchant', project.id] });
              }}
              trigger={
                <Button size="sm" variant="ghost">
                  <Trash2 /> Remove imported
                </Button>
              }
            />
          ) : null
        }
      />
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <MetricCard
            label="Products"
            value={formatNumber(s.total)}
            sub={Object.entries(s.bySource)
              .map(
                ([k, n]) =>
                  `${formatNumber(n)} ${k === 'MERCHANT_API' ? 'from Merchant Center' : 'from feeds'}`,
              )
              .join(' · ')}
          />
          <MetricCard
            label="With errors"
            value={formatNumber(s.errors)}
            tone={s.errors ? 'danger' : 'default'}
            help="Errors are likely to keep a product from showing."
          />
          <MetricCard
            label="With warnings"
            value={formatNumber(s.warnings)}
            tone={s.warnings ? 'warning' : 'default'}
          />
          <MetricCard label="Without issues" value={formatNumber(s.ok)} tone="success" />
        </div>
        <ul className="grid gap-1 text-sm sm:grid-cols-3">
          {PRODUCT_PROGRAMS.map((p) => (
            <li key={p} className="rounded-md border border-border px-3 py-2">
              <span className="block text-xs text-muted-foreground">{PRODUCT_PROGRAM_LABELS[p]}</span>
              <span className="tabular-nums">{formatNumber(s.blockedByProgram[p])} likely blocked</span>
            </li>
          ))}
        </ul>
        {s.topIssues.length ? (
          <div>
            <p className="mb-1 text-sm font-medium">Most common issues</p>
            <ul className="space-y-1 text-sm">
              {s.topIssues.map((i) => (
                <li key={i.code} className="flex flex-wrap items-center gap-2">
                  <Badge tone={SEVERITY_TONE[i.severity]}>{i.severity}</Badge>
                  {i.message}
                  <span className="text-muted-foreground">({formatNumber(i.products)} products)</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <div className="flex flex-wrap items-center gap-3">
          <Tabs
            value={filter}
            onValueChange={(v) => {
              setFilter(v as typeof filter);
              setPage(1);
            }}
          >
            <TabsList>
              <TabsTrigger value="all">All</TabsTrigger>
              <TabsTrigger value="errors">Errors</TabsTrigger>
              <TabsTrigger value="warnings">Warnings</TabsTrigger>
              <TabsTrigger value="ok">No issues</TabsTrigger>
            </TabsList>
          </Tabs>
          <Input
            className="max-w-xs"
            placeholder="Search title or id"
            aria-label="Search products"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setPage(1);
            }}
          />
        </div>
        {products.isError ? (
          <ErrorState error={products.error} onRetry={() => void products.refetch()} />
        ) : !products.data ? (
          <LoadingBlock rows={4} />
        ) : products.data.items.length ? (
          <div className="overflow-x-auto rounded-md border border-border">
            <Table>
              <THead>
                <TR>
                  <TH className="w-8">
                    <span className="sr-only">Details</span>
                  </TH>
                  <TH>Product</TH>
                  <TH>Price</TH>
                  <TH>Availability</TH>
                  <TH>Status</TH>
                  <TH>Source</TH>
                </TR>
              </THead>
              <TBody>
                {products.data.items.map((p) => (
                  <Fragment key={p.id}>
                    <TR>
                      <TD>
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          aria-expanded={open === p.id}
                          aria-label={`Issues of ${p.title ?? p.offerId}`}
                          onClick={() => setOpen(open === p.id ? null : p.id)}
                        >
                          {open === p.id ? <ChevronDown /> : <ChevronRight />}
                        </Button>
                      </TD>
                      <TD>
                        <span className="block font-medium">
                          {p.title ?? <span className="text-muted-foreground">No title</span>}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {p.offerId} · {p.feedLabel}
                        </span>
                      </TD>
                      <TD className="tabular-nums">
                        {p.price ? `${formatNumber(p.price.amount)} ${p.price.currency}` : '—'}
                      </TD>
                      <TD>{p.availability?.replace(/_/g, ' ') ?? '—'}</TD>
                      <TD>
                        <Badge
                          tone={
                            p.status === 'errors' ? 'danger' : p.status === 'warnings' ? 'warning' : 'success'
                          }
                        >
                          {p.status === 'errors'
                            ? `${p.errorCount} errors`
                            : p.status === 'warnings'
                              ? `${p.warningCount} warnings`
                              : 'No issues'}
                        </Badge>
                      </TD>
                      <TD className="text-xs text-muted-foreground">
                        {p.source === 'MERCHANT_API' ? 'Merchant Center' : 'Feed file'}
                      </TD>
                    </TR>
                    {open === p.id ? (
                      <TR>
                        <TD />
                        <TD colSpan={5} className="space-y-2 pb-4">
                          <IssueList issues={p.issues} />
                          {p.googleStatus?.length ? (
                            <p className="text-xs text-muted-foreground">
                              Google:{' '}
                              {p.googleStatus
                                .map(
                                  (g) =>
                                    `${g.context.toLowerCase().replace(/_/g, ' ')} approved in ${g.approvedCountries.join(', ') || 'none'}${g.disapprovedCountries.length ? `, disapproved in ${g.disapprovedCountries.join(', ')}` : ''}`,
                                )
                                .join('; ')}
                            </p>
                          ) : null}
                          {p.link ? (
                            <a
                              href={p.link}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                            >
                              Landing page <ExternalLink className="size-3" aria-hidden />
                            </a>
                          ) : null}
                        </TD>
                      </TR>
                    ) : null}
                  </Fragment>
                ))}
              </TBody>
            </Table>
            <Pagination meta={products.data.meta} onPage={setPage} />
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            {s.total ? 'No products match.' : 'No products yet. Import a feed or connect Merchant Center.'}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function Connection({ status, onSynced }: { status: MerchantStatusDto; onSynced: () => void }) {
  const project = useProject();
  const queryClient = useQueryClient();
  const canConnect = useCan('integration.manage');
  const canManage = useCan('commerce.manage');
  const [jobId, setJobId] = useState<string | null>(null);
  const integration = status.integration;
  const connected = integration?.status === 'CONNECTED' || integration?.status === 'ERROR';
  const accounts = useQuery({
    queryKey: ['merchant', project.id, 'accounts'],
    queryFn: () => api.get<MerchantAccountDto[]>(`/projects/${project.id}/merchant/accounts`),
    enabled: Boolean(connected && canManage),
    retry: false,
  });
  const connect = useMutation({
    mutationFn: () =>
      api.post<{ url: string }>(`/projects/${project.id}/integrations/google-merchant-center/connect`),
    onSuccess: (r) => window.location.assign(r.url),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const choose = useMutation({
    mutationFn: (accountId: string) =>
      api.put<{ jobId: string }>(`/projects/${project.id}/merchant/account`, { accountId }),
    onSuccess: (r) => {
      setJobId(r.jobId);
      void queryClient.invalidateQueries({ queryKey: ['merchant', project.id] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const sync = useMutation({
    mutationFn: () => api.post<{ jobId: string }>(`/projects/${project.id}/merchant/sync`),
    onSuccess: (r) => setJobId(r.jobId),
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Card id="merchant-connection">
      <CardHeaderRow
        title={
          <span className="flex items-center gap-2">
            Google Merchant Center{' '}
            {integration ? <StatusBadge status={integration.status} /> : <Badge>Not connected</Badge>}
          </span>
        }
        description={
          integration
            ? `${integration.externalAccount ? `Connected as ${integration.externalAccount}` : 'Connected'}${integration.lastSyncAt ? ` · last sync ${formatDateTime(integration.lastSyncAt)}` : ''}`
            : 'Read products, Google’s approval status and item issues, and account settings. Surfaced never changes Merchant Center data.'
        }
        actions={
          status.configured ? (
            !connected ? (
              canConnect ? (
                <Button onClick={() => connect.mutate()} loading={connect.isPending}>
                  <Plug /> {integration?.status === 'NEEDS_REAUTH' ? 'Reconnect' : 'Connect with Google'}
                </Button>
              ) : null
            ) : canManage && integration.accountId && status.plan.ecommerce ? (
              <Button
                variant="outline"
                onClick={() => sync.mutate()}
                loading={sync.isPending}
                disabled={Boolean(jobId)}
              >
                <RefreshCw /> Sync now
              </Button>
            ) : null
          ) : null
        }
      />
      <CardContent className="space-y-3">
        {!status.configured ? (
          <Alert tone="warning" title="Not configured on this server">
            {status.setup}
          </Alert>
        ) : null}
        {integration?.lastError ? (
          <Alert
            tone={integration.lastSyncStatus === 'PARTIAL' ? 'warning' : 'danger'}
            title={integration.lastSyncStatus === 'PARTIAL' ? 'Partly synced' : 'Last sync failed'}
          >
            {integration.lastError}
          </Alert>
        ) : null}
        {connected && canManage ? (
          <div className="grid max-w-md gap-1.5">
            <Label htmlFor="mc-account">Account</Label>
            <NativeSelect
              id="mc-account"
              value={integration.accountId ?? ''}
              onChange={(e) => e.target.value && choose.mutate(e.target.value)}
              disabled={accounts.isPending || choose.isPending}
            >
              <option value="">{accounts.isPending ? 'Loading accounts…' : 'Choose an account'}</option>
              {accounts.data?.map((a) => (
                <option key={a.accountId} value={a.accountId}>
                  {a.accountName} ({a.accountId})
                </option>
              ))}
            </NativeSelect>
            {accounts.isError ? (
              <p className="text-[13px] text-destructive">{errorMessage(accounts.error)}</p>
            ) : null}
          </div>
        ) : connected ? (
          <p className="text-sm">{integration.accountName ?? 'No account chosen'}</p>
        ) : null}
        {status.account ? (
          <p className="text-xs text-muted-foreground">
            Free listings: {status.account.freeListings?.state.toLowerCase().replace(/_/g, ' ') ?? 'unknown'}{' '}
            · account issues: {status.account.issues.length} · read {formatDateTime(status.account.syncedAt)}
          </p>
        ) : null}
        {jobId ? (
          <JobProgress
            jobId={jobId}
            label="Merchant Center sync"
            onFinished={() => {
              onSynced();
            }}
            onDismiss={() => setJobId(null)}
          />
        ) : null}
      </CardContent>
    </Card>
  );
}

export default function MerchantPage() {
  const project = useProject();
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const status = useQuery({
    queryKey: ['merchant', project.id, 'status'],
    queryFn: () => api.get<MerchantStatusDto>(`/projects/${project.id}/merchant`),
  });
  useEffect(() => {
    if (params.get('connected') === 'google-merchant-center') {
      toast.success('Google Merchant Center connected', { description: 'Choose the account to read.' });
      setParams({}, { replace: true });
    }
  }, [params, setParams]);
  const header = (
    <PageHeader
      title="Merchant Center & products"
      description="Check product data for free listings, Shopping ads and local listings, by country, and see what Google reports when Merchant Center is connected."
      breadcrumbs={[{ label: 'Local', to: `/app/p/${project.id}/local` }, { label: 'Merchant Center' }]}
    />
  );
  if (status.isPending)
    return (
      <>
        {header}
        <LoadingBlock rows={6} />
      </>
    );
  if (status.isError)
    return (
      <>
        {header}
        <ErrorState error={status.error} onRetry={() => void status.refetch()} />
      </>
    );
  const s = status.data;
  return (
    <>
      {header}
      <div className="space-y-5">
        <div className="grid gap-5 xl:grid-cols-2">
          <Checklist
            items={s.checklist}
            onConnect={() =>
              document.getElementById('merchant-connection')?.scrollIntoView({ behavior: 'smooth' })
            }
          />
          <div className="space-y-5">
            <Connection
              status={s}
              onSynced={() => void queryClient.invalidateQueries({ queryKey: ['merchant', project.id] })}
            />
            {!s.hasWebsite ? (
              <Alert tone="info" title="Selling without a website">
                Online free listings and Shopping ads need product pages on a website you own. In-store
                products can appear in free local listings through a linked Business Profile and local
                inventory; check in Merchant Center whether Google can host a storefront page for your
                country.
              </Alert>
            ) : null}
          </div>
        </div>
        <FeedImport status={s} />
        <Products status={s} />
        <ul className="space-y-1 text-xs text-muted-foreground">
          {s.limitations.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      </div>
    </>
  );
}
