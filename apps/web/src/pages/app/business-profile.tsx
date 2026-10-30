import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  CheckCircle2,
  CircleHelp,
  ExternalLink,
  Link2,
  MinusCircle,
  Plug,
  RefreshCw,
  Sparkles,
  Unlink,
  XCircle,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import {
  PROFILE_DESCRIPTION_MAX,
  PROFILE_EDITABLE_FIELDS,
  PROFILE_FIELD_LABELS,
  type BusinessProfileLocationDto,
  type BusinessProfileStatusDto,
  type BusinessReviewDto,
  type LocationDto,
  type ProfileAccountDto,
  type ProfileAuditCheck,
  type ProfileEditableField,
  type ProfileLocationOptionDto,
} from '@surfaced/shared';
import { useProject } from '@/app/project-scope';
import { ChartFrame, LineTrend } from '@/components/charts/charts';
import { SERIES } from '@/components/charts/palette';
import { JobProgress, MetricCard, PageHeader } from '@/components/app/page';
import { ReviewCard, Stars } from '@/components/local/review-card';
import { Badge, StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeaderRow } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/dialog';
import { Alert, EmptyState, ErrorState, LoadingBlock } from '@/components/ui/feedback';
import { Field, Input, Label, NativeSelect, Textarea } from '@/components/ui/form';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api, errorMessage } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { formatDate, formatDateTime, formatNumber } from '@/lib/format';

const CHECK_ICON: Record<
  ProfileAuditCheck['status'],
  { icon: typeof CheckCircle2; className: string; label: string }
> = {
  pass: { icon: CheckCircle2, className: 'text-emerald-600', label: 'Passed' },
  fail: { icon: XCircle, className: 'text-red-600', label: 'Needs attention' },
  unknown: { icon: CircleHelp, className: 'text-muted-foreground', label: 'Not known yet' },
  not_applicable: { icon: MinusCircle, className: 'text-muted-foreground', label: 'Does not apply' },
};

function AuditList({ detail }: { detail: BusinessProfileLocationDto }) {
  const { audit } = detail;
  return (
    <Card>
      <CardHeaderRow
        title={
          <span className="flex flex-wrap items-center gap-2">
            Profile audit
            <Badge tone={audit.source === 'BUSINESS_PROFILE' ? 'primary' : 'neutral'}>
              {audit.source === 'BUSINESS_PROFILE'
                ? 'Live profile from Google'
                : 'Details entered in Surfaced'}
            </Badge>
          </span>
        }
        description={`${audit.passed} of ${audit.applicable} applicable checks pass. Checks that do not apply to this business are not counted.`}
      />
      <CardContent>
        <ul className="divide-y divide-border">
          {audit.checks.map((c) => {
            const meta = CHECK_ICON[c.status];
            const Icon = meta.icon;
            return (
              <li key={c.key} className="flex gap-3 py-3">
                <Icon className={`mt-0.5 size-4 shrink-0 ${meta.className}`} aria-label={meta.label} />
                <div className="min-w-0 space-y-1">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                    {c.title}
                    {c.status === 'fail' ? (
                      <Badge
                        tone={
                          c.severity === 'critical' ? 'danger' : c.severity === 'warning' ? 'warning' : 'info'
                        }
                      >
                        {c.severity}
                      </Badge>
                    ) : null}
                  </p>
                  <p className="text-[13px] text-muted-foreground">{c.evidence}</p>
                  {c.recommendation ? <p className="text-[13px]">{c.recommendation}</p> : null}
                  {c.verification ? (
                    <p className="text-xs text-muted-foreground">How to check: {c.verification}</p>
                  ) : null}
                  {c.reference ? (
                    <a
                      href={c.reference}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                    >
                      Google’s guidance <ExternalLink className="size-3" aria-hidden />
                    </a>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
        <ul className="mt-3 space-y-1 text-xs text-muted-foreground">
          {audit.limitations.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function ProfileSummary({ detail }: { detail: BusinessProfileLocationDto }) {
  const p = detail.profile;
  if (!p) return null;
  const rows: [string, string | null][] = [
    ['Name', p.title],
    ['Primary category', p.primaryCategory],
    ['Other categories', p.additionalCategories.join(', ') || null],
    ['Phone', p.primaryPhone],
    ['Website', p.websiteUri],
    [
      'Address',
      p.address
        ? [...p.address.lines, p.address.locality, p.address.postalCode].filter(Boolean).join(', ')
        : null,
    ],
    ['Service area', p.serviceArea?.places.join(', ') || null],
    [
      'Opening hours',
      p.regularHours.length ? `${new Set(p.regularHours.map((h) => h.day)).size} days set` : null,
    ],
    ['Description', p.description ? `${p.description.length} characters` : null],
  ];
  return (
    <Card>
      <CardHeaderRow
        title="Profile on Google"
        description={`As Google returned it on ${formatDateTime(detail.snapshotAt)}.`}
        actions={
          <div className="flex flex-wrap gap-2">
            {p.mapsUri ? (
              <Button asChild size="sm" variant="outline">
                <a href={p.mapsUri} target="_blank" rel="noreferrer">
                  Open on Maps <ExternalLink />
                </a>
              </Button>
            ) : null}
            {p.newReviewUri ? (
              <Button asChild size="sm" variant="ghost">
                <a href={p.newReviewUri} target="_blank" rel="noreferrer">
                  Review link <ExternalLink />
                </a>
              </Button>
            ) : null}
          </div>
        }
      />
      <CardContent>
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[10rem_1fr]">
          {rows.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-muted-foreground">{k}</dt>
              <dd className="min-w-0 break-words">
                {v ?? <span className="text-muted-foreground">Not set</span>}
              </dd>
            </div>
          ))}
        </dl>
        {p.hasVoiceOfMerchant === false ? (
          <Alert tone="warning" className="mt-4" title="Edits will not go live">
            Google reports that the connected account does not control this profile (no Voice of Merchant).
            Verify the profile or connect the owner’s account.
          </Alert>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** Propose edits to the profile's own fields; published to Google only after a LOCATION_CHANGE approval. */
function ProfileEdits({
  projectId,
  detail,
  onChanged,
}: {
  projectId: string;
  detail: BusinessProfileLocationDto;
  onChanged: () => void;
}) {
  const p = detail.profile;
  const change = detail.profileChange;
  const canManage = useCan('local.manage');
  const canPublish = useCan('local.publish');
  const current: Record<ProfileEditableField, string> = {
    title: p?.title ?? '',
    primaryPhone: p?.primaryPhone ?? '',
    websiteUri: p?.websiteUri ?? '',
    description: p?.description ?? '',
  };
  const editable = !change || ['DRAFT', 'AWAITING_APPROVAL', 'FAILED'].includes(change.status);
  const [values, setValues] = useState<Record<ProfileEditableField, string>>({
    ...current,
    ...(change?.fields ?? {}),
  });
  const changed = PROFILE_EDITABLE_FIELDS.filter((f) => values[f].trim() !== current[f].trim());
  const body = () => Object.fromEntries(changed.map((f) => [f, values[f].trim()]));

  const save = useMutation({
    mutationFn: () =>
      change && editable
        ? api.patch(`/projects/${projectId}/profile-changes/${change.id}`, body())
        : api.post(`/projects/${projectId}/locations/${detail.location.id}/profile-changes`, body()),
    onSuccess: () => {
      toast.success('Proposal saved');
      onChanged();
    },
    onError: (e) => toast.error('Could not save the proposal', { description: errorMessage(e) }),
  });
  const act = useMutation({
    mutationFn: (action: 'request-approval' | 'publish') =>
      api.post(`/projects/${projectId}/profile-changes/${change!.id}/${action}`),
    onSuccess: (_d, action) => {
      toast.success(action === 'publish' ? 'Published to Google' : 'Sent for approval');
      onChanged();
    },
    onError: (e) => toast.error('Action failed', { description: errorMessage(e) }),
  });
  const discard = useMutation({
    mutationFn: () => api.delete(`/projects/${projectId}/profile-changes/${change!.id}`),
    onSuccess: onChanged,
    onError: (e) => toast.error('Could not discard', { description: errorMessage(e) }),
  });

  if (!p || !canManage) return null;
  return (
    <Card>
      <CardHeaderRow
        title="Suggest profile edits"
        description="Change the business name, phone, website or description. Nothing is sent to Google until an approver approves the exact values."
        actions={change && change.status !== 'DISCARDED' ? <StatusBadge status={change.status} /> : undefined}
      />
      <CardContent className="space-y-4">
        {change?.status === 'PUBLISHED' ? (
          <Alert tone="success" title="Changes published to Google">
            The latest sync will show the updated values. Edit again to propose further changes.
          </Alert>
        ) : null}
        {change?.publishError ? (
          <Alert tone="danger" title="Publishing failed">
            {change.publishError}
          </Alert>
        ) : null}
        <div className="grid gap-4 sm:grid-cols-2">
          {PROFILE_EDITABLE_FIELDS.map((f) => (
            <Field
              key={f}
              label={PROFILE_FIELD_LABELS[f]}
              description={
                values[f].trim() !== current[f].trim() ? `Currently: ${current[f] || '—'}` : undefined
              }
              className={f === 'description' ? 'sm:col-span-2' : undefined}
            >
              {f === 'description' ? (
                <Textarea
                  value={values[f]}
                  onChange={(e) => setValues((v) => ({ ...v, [f]: e.target.value }))}
                  rows={3}
                  maxLength={PROFILE_DESCRIPTION_MAX}
                  disabled={!editable}
                />
              ) : (
                <Input
                  value={values[f]}
                  onChange={(e) => setValues((v) => ({ ...v, [f]: e.target.value }))}
                  disabled={!editable}
                  inputMode={f === 'primaryPhone' ? 'tel' : undefined}
                />
              )}
            </Field>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {editable ? (
            <Button onClick={() => save.mutate()} loading={save.isPending} disabled={changed.length === 0}>
              {change ? 'Update proposal' : 'Save proposal'}
            </Button>
          ) : null}
          {change && change.status !== 'PUBLISHED' && change.status !== 'DISCARDED' ? (
            <>
              {change.approval?.coversCurrentText && change.approval.status === 'PENDING' ? (
                <span className="text-sm text-muted-foreground">Waiting for approval…</span>
              ) : (
                <Button
                  variant="outline"
                  onClick={() => act.mutate('request-approval')}
                  loading={act.isPending && act.variables === 'request-approval'}
                  disabled={changed.length > 0}
                  title={changed.length > 0 ? 'Save your edits first' : undefined}
                >
                  Send for approval
                </Button>
              )}
              {change.canPublish && canPublish ? (
                <Button
                  onClick={() => act.mutate('publish')}
                  loading={act.isPending && act.variables === 'publish'}
                >
                  Publish to Google
                </Button>
              ) : null}
              <Button variant="ghost" onClick={() => discard.mutate()} loading={discard.isPending}>
                Discard
              </Button>
            </>
          ) : null}
        </div>
        {p.hasVoiceOfMerchant === false ? (
          <Alert tone="warning" title="Edits may not go live">
            Google reports the connected account does not control this profile (no Voice of Merchant), so a
            publish may be rejected. Verify the profile or connect the owner’s account.
          </Alert>
        ) : null}
      </CardContent>
    </Card>
  );
}

function Performance({ detail }: { detail: BusinessProfileLocationDto }) {
  const m = detail.metrics;
  if (!m)
    return (
      <Card className="p-5">
        <p className="text-sm font-semibold">Performance</p>
        <p className="mt-1 text-sm text-muted-foreground">
          {detail.location.profileLocationName
            ? 'No metrics yet. Google reports them a few days late; sync to fetch them.'
            : 'Link the profile to see what Google reports.'}
        </p>
      </Card>
    );
  const main = ['CALL_CLICKS', 'BUSINESS_DIRECTION_REQUESTS', 'WEBSITE_CLICKS'];
  const views = m.metrics.filter((x) => x.metric.startsWith('BUSINESS_IMPRESSIONS_'));
  const viewsNow = views.reduce((s, x) => s + x.current, 0);
  const viewsBefore = m.previousRange ? views.reduce((s, x) => s + (x.previous ?? 0), 0) : null;
  const sub = (previous: number | null) =>
    previous === null ? 'No earlier period yet' : `Previous 28 days: ${formatNumber(previous)}`;
  return (
    <Card>
      <CardHeaderRow
        title="Performance reported by Google"
        description={`${formatDate(m.range.from)} to ${formatDate(m.range.to)}${m.previousRange ? ', compared with the 28 days before' : ''}. Source: Business Profile Performance API.`}
      />
      <CardContent className="space-y-5">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <MetricCard
            label="Profile views"
            value={formatNumber(viewsNow)}
            sub={sub(viewsBefore)}
            help="Unique people per day who saw the profile on Google Maps or Search, as Google counts them."
          />
          {main.map((key) => {
            const x = m.metrics.find((y) => y.metric === key);
            return (
              <MetricCard
                key={key}
                label={x?.label ?? key}
                value={formatNumber(x?.current ?? 0)}
                sub={sub(x?.previous ?? null)}
              />
            );
          })}
        </div>
        <ChartFrame
          title="Profile views per day"
          description="Maps and Search views are shown separately, as Google reports them."
          legend={[
            { label: 'Google Maps', color: SERIES[0] },
            { label: 'Google Search', color: SERIES[1] },
          ]}
          table={{
            columns: ['Date', 'Maps views', 'Search views', 'Actions'],
            rows: m.daily.map((d) => [d.date, d.maps, d.search, d.actions]),
          }}
        >
          <LineTrend
            data={m.daily}
            xKey="date"
            series={[
              { key: 'maps', label: 'Google Maps', color: SERIES[0] },
              { key: 'search', label: 'Google Search', color: SERIES[1] },
            ]}
            formatY={(v) => formatNumber(v, { notation: 'compact' })}
            formatX={(v) => formatDate(v, { month: 'short', day: 'numeric' })}
            height={220}
          />
        </ChartFrame>
        {m.metrics.filter((x) => !main.includes(x.metric) && !x.metric.startsWith('BUSINESS_IMPRESSIONS_'))
          .length ? (
          <ul className="grid gap-1 text-sm sm:grid-cols-2">
            {m.metrics
              .filter((x) => !main.includes(x.metric) && !x.metric.startsWith('BUSINESS_IMPRESSIONS_'))
              .map((x) => (
                <li key={x.metric} className="flex justify-between gap-3">
                  <span className="text-muted-foreground">{x.label}</span>
                  <span className="tabular-nums">{formatNumber(x.current)}</span>
                </li>
              ))}
          </ul>
        ) : null}
        <ul className="space-y-1 text-xs text-muted-foreground">
          {m.limitations.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

/** AI sentiment and theme summary over the synced reviews. Regenerated on demand; nothing is published. */
function ReviewSummaryCard({
  projectId,
  locationId,
  detail,
  onChanged,
}: {
  projectId: string;
  locationId: string;
  detail: BusinessProfileLocationDto;
  onChanged: () => void;
}) {
  const canManage = useCan('local.manage');
  const summary = detail.reviewSummary;
  const generate = useMutation({
    mutationFn: () => api.post(`/projects/${projectId}/locations/${locationId}/review-summary`),
    onSuccess: () => {
      toast.success('Review summary updated');
      onChanged();
    },
    onError: (e) => toast.error('Could not summarise the reviews', { description: errorMessage(e) }),
  });
  const total = summary ? summary.sentiment.positive + summary.sentiment.neutral + summary.sentiment.negative : 0; // prettier-ignore
  const pct = (n: number) => (total ? Math.round((n / total) * 100) : 0);
  const bar: { key: 'positive' | 'neutral' | 'negative'; label: string; cls: string }[] = [
    { key: 'positive', label: 'Positive', cls: 'bg-emerald-500' },
    { key: 'neutral', label: 'Neutral', cls: 'bg-muted-foreground/50' },
    { key: 'negative', label: 'Negative', cls: 'bg-red-500' },
  ];
  const generateButton = canManage ? (
    <Button size="sm" variant="outline" onClick={() => generate.mutate()} loading={generate.isPending}>
      {summary ? <RefreshCw /> : <Sparkles />} {summary ? 'Regenerate' : 'Summarise reviews'}
    </Button>
  ) : null;
  return (
    <div className="rounded-lg border border-border bg-muted/30 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 text-sm font-medium">
          <Sparkles className="size-4 text-muted-foreground" /> Sentiment & themes
          {summary?.isDevAdapter ? <Badge tone="demo">Dev template</Badge> : null}
          {summary?.stale ? <Badge tone="warning">New reviews since</Badge> : null}
        </p>
        {generateButton}
      </div>
      {!summary ? (
        <p className="mt-2 text-sm text-muted-foreground">
          {detail.reviews.some((r) => (r.comment ?? '').trim())
            ? 'Summarise the review text into overall sentiment and recurring themes.'
            : 'There are no reviews with text to summarise yet.'}
        </p>
      ) : (
        <div className="mt-3 space-y-3">
          <p className="text-sm">{summary.summary}</p>
          <div>
            <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-border">
              {bar.map((b) =>
                summary.sentiment[b.key] > 0 ? (
                  <div key={b.key} className={b.cls} style={{ width: `${pct(summary.sentiment[b.key])}%` }} />
                ) : null,
              )}
            </div>
            <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted-foreground">
              {bar.map((b) => (
                <span key={b.key}>
                  {b.label}: {summary.sentiment[b.key]} ({pct(summary.sentiment[b.key])}%)
                </span>
              ))}
            </div>
          </div>
          {summary.themes.length ? (
            <ul className="grid gap-1.5 sm:grid-cols-2">
              {summary.themes.map((t) => (
                <li key={t.theme} className="rounded-md border border-border bg-background px-2.5 py-1.5">
                  <span className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium">{t.theme}</span>
                    <Badge
                      tone={
                        t.sentiment === 'positive'
                          ? 'success'
                          : t.sentiment === 'negative'
                            ? 'danger'
                            : 'warning'
                      }
                    >
                      {t.sentiment} · {t.mentions}
                    </Badge>
                  </span>
                  {t.example ? (
                    <span className="mt-0.5 block text-xs text-muted-foreground">“{t.example}”</span>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : summary.isDevAdapter ? (
            <p className="text-xs text-muted-foreground">
              Configure an AI model (LLM_PROVIDER) to extract themes from the review text. Sentiment above is
              from star ratings.
            </p>
          ) : null}
          <p className="text-xs text-muted-foreground">
            From {summary.reviewCount} review{summary.reviewCount === 1 ? '' : 's'} ·{' '}
            {summary.model ? `${summary.model} · ` : ''}
            {formatDateTime(summary.generatedAt)}
          </p>
        </div>
      )}
    </div>
  );
}

function Reviews({
  projectId,
  detail,
  onChanged,
}: {
  projectId: string;
  detail: BusinessProfileLocationDto;
  onChanged: () => void;
}) {
  const [filter, setFilter] = useState<'all' | 'unanswered' | 'negative'>('all');
  const shown = useMemo(
    () =>
      detail.reviews.filter((r: BusinessReviewDto) =>
        filter === 'unanswered'
          ? !r.reply
          : filter === 'negative'
            ? r.starRating !== null && r.starRating <= 3
            : true,
      ),
    [detail.reviews, filter],
  );
  return (
    <Card>
      <CardHeaderRow
        title={
          <span className="flex flex-wrap items-center gap-2">
            Reviews
            {detail.reviewTotals?.averageRating !== null &&
            detail.reviewTotals?.averageRating !== undefined ? (
              <span className="flex items-center gap-1.5 text-sm font-normal text-muted-foreground">
                <Stars rating={Math.round(detail.reviewTotals.averageRating)} />{' '}
                {detail.reviewTotals.averageRating} from{' '}
                {formatNumber(detail.reviewTotals.totalReviewCount ?? 0)} reviews (as Google reports)
              </span>
            ) : null}
          </span>
        }
        description="Replies are drafted here, approved by the business, and only then published on Google."
      />
      <CardContent className="space-y-3">
        <ReviewSummaryCard
          projectId={projectId}
          locationId={detail.location.id}
          detail={detail}
          onChanged={onChanged}
        />
        <Tabs value={filter} onValueChange={(v) => setFilter(v as typeof filter)}>
          <TabsList>
            <TabsTrigger value="all">All ({detail.reviews.length})</TabsTrigger>
            <TabsTrigger value="unanswered">No reply ({detail.unansweredReviews})</TabsTrigger>
            <TabsTrigger value="negative">1–3 stars</TabsTrigger>
          </TabsList>
        </Tabs>
        {shown.length ? (
          shown.map((r) => (
            <ReviewCard
              key={`${r.id}-${r.draft?.id ?? 'none'}-${r.draft?.updatedAt ?? ''}`}
              projectId={projectId}
              review={r}
              onChanged={onChanged}
            />
          ))
        ) : (
          <p className="text-sm text-muted-foreground">
            {detail.reviews.length
              ? 'No reviews match this filter.'
              : 'No reviews were returned for this profile.'}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function LinkPanel({
  location,
  status,
}: {
  location: BusinessProfileStatusDto['locations'][number];
  status: BusinessProfileStatusDto;
}) {
  const project = useProject();
  const queryClient = useQueryClient();
  const [account, setAccount] = useState('');
  const accounts = useQuery({
    queryKey: ['gbp-accounts', project.id],
    queryFn: () => api.get<ProfileAccountDto[]>(`/projects/${project.id}/business-profile/accounts`),
    retry: false,
  });
  useEffect(() => {
    if (!account && accounts.data?.length === 1) setAccount(accounts.data[0]!.name);
  }, [account, accounts.data]);
  const options = useQuery({
    queryKey: ['gbp-locations', project.id, account],
    queryFn: () =>
      api.get<ProfileLocationOptionDto[]>(
        `/projects/${project.id}/business-profile/locations?account=${encodeURIComponent(account)}`,
      ),
    enabled: Boolean(account),
    retry: false,
  });
  const link = useMutation({
    mutationFn: (body: { profileLocationName: string; locationId: string | null }) =>
      api.post<LocationDto>(`/projects/${project.id}/business-profile/links`, {
        accountName: account,
        ...body,
      }),
    onSuccess: (l) => {
      toast.success(`Linked to ${l.name}`, { description: 'The first sync has started.' });
      void queryClient.invalidateQueries({ queryKey: ['gbp', project.id] });
      void queryClient.invalidateQueries({ queryKey: ['locations', project.id] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Card>
      <CardHeaderRow
        title={`Link ${location.name} to its Business Profile`}
        description="Choose the profile on Google that belongs to this location. Profiles are read live from Google and are not stored until linked."
      />
      <CardContent className="space-y-4">
        {accounts.isError ? (
          <Alert tone="danger" title="Google did not return your accounts">
            {errorMessage(accounts.error)}
          </Alert>
        ) : (
          <div className="grid max-w-md gap-1.5">
            <Label htmlFor="gbp-account">Account</Label>
            <NativeSelect
              id="gbp-account"
              value={account}
              onChange={(e) => setAccount(e.target.value)}
              disabled={accounts.isPending}
            >
              <option value="">{accounts.isPending ? 'Loading accounts…' : 'Choose an account'}</option>
              {accounts.data?.map((a) => (
                <option key={a.name} value={a.name}>
                  {a.accountName}
                  {a.type ? ` (${a.type.toLowerCase().replace(/_/g, ' ')})` : ''}
                </option>
              ))}
            </NativeSelect>
          </div>
        )}
        {options.isPending && account ? <LoadingBlock rows={2} /> : null}
        {options.isError ? <Alert tone="danger">{errorMessage(options.error)}</Alert> : null}
        {options.data ? (
          options.data.length ? (
            <ul className="divide-y divide-border rounded-md border border-border">
              {options.data.map((o) => {
                const linkedElsewhere = o.linkedLocationId && o.linkedLocationId !== location.id;
                return (
                  <li key={o.name} className="flex flex-wrap items-center justify-between gap-3 p-3">
                    <div className="min-w-0">
                      <p className="text-sm font-medium">{o.title}</p>
                      <p className="text-xs text-muted-foreground">
                        {[o.primaryCategory, o.address, o.storeCode ? `store code ${o.storeCode}` : null]
                          .filter(Boolean)
                          .join(' · ')}
                      </p>
                      {o.hasVoiceOfMerchant === false ? (
                        <p className="text-xs text-amber-700">
                          Not verified for this account: edits and replies will not go live.
                        </p>
                      ) : null}
                    </div>
                    {linkedElsewhere ? (
                      <Badge>Linked to another location</Badge>
                    ) : (
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          onClick={() =>
                            link.mutate({ profileLocationName: o.name, locationId: location.id })
                          }
                          loading={link.isPending}
                        >
                          <Link2 /> Link to {location.name}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => link.mutate({ profileLocationName: o.name, locationId: null })}
                          disabled={link.isPending}
                        >
                          Add as new location
                        </Button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">This account has no Business Profile locations.</p>
          )
        ) : null}
        <p className="text-xs text-muted-foreground">
          Business Profile data is stored for at most {status.retentionDays} days, as Google requires, and
          refreshed daily.
        </p>
      </CardContent>
    </Card>
  );
}

function LocationDetail({
  projectId,
  locationId,
  linked,
}: {
  projectId: string;
  locationId: string;
  linked: boolean;
}) {
  const queryClient = useQueryClient();
  const detail = useQuery({
    queryKey: ['gbp', projectId, 'location', locationId],
    queryFn: () =>
      api.get<BusinessProfileLocationDto>(`/projects/${projectId}/locations/${locationId}/business-profile`),
  });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['gbp', projectId] });
  if (detail.isPending) return <LoadingBlock rows={6} />;
  if (detail.isError) return <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />;
  const d = detail.data;
  return (
    <div className="space-y-5">
      {linked && !d.profile ? (
        <Alert tone="info" title="Waiting for the first sync">
          The profile is linked. Its data appears here after the sync finishes.
        </Alert>
      ) : null}
      <div className="grid gap-5 xl:grid-cols-2">
        <AuditList detail={d} />
        <div className="space-y-5">
          <ProfileSummary detail={d} />
          <Performance detail={d} />
        </div>
      </div>
      {linked && d.profile ? (
        <ProfileEdits
          key={d.profileChange?.id ?? d.profileChange?.updatedAt ?? d.snapshotAt ?? 'new'}
          projectId={projectId}
          detail={d}
          onChanged={refresh}
        />
      ) : null}
      {linked ? <Reviews projectId={projectId} detail={d} onChanged={refresh} /> : null}
      <ul className="space-y-1 text-xs text-muted-foreground">
        {d.limitations.map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
    </div>
  );
}

export default function BusinessProfilePage() {
  const project = useProject();
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const canConnect = useCan('integration.manage');
  const canManage = useCan('local.manage');
  const [jobId, setJobId] = useState<string | null>(null);
  const status = useQuery({
    queryKey: ['gbp', project.id, 'status'],
    queryFn: () => api.get<BusinessProfileStatusDto>(`/projects/${project.id}/business-profile`),
  });
  useEffect(() => {
    if (params.get('connected') === 'google-business-profile') {
      toast.success('Google Business Profile connected', {
        description: 'Link each location to its profile.',
      });
      const next = new URLSearchParams(params);
      next.delete('connected');
      setParams(next, { replace: true });
    }
  }, [params, setParams]);
  const connect = useMutation({
    mutationFn: () =>
      api.post<{ url: string }>(`/projects/${project.id}/integrations/google-business-profile/connect`),
    onSuccess: (r) => window.location.assign(r.url),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const sync = useMutation({
    mutationFn: () => api.post<{ jobId: string }>(`/projects/${project.id}/business-profile/sync`),
    onSuccess: (r) => setJobId(r.jobId),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['gbp', project.id] });

  const header = (
    <PageHeader
      title="Business Profile"
      description="Audit the Google Business Profile, see the views, calls and direction requests Google reports, and answer reviews. Replies are published only after approval."
      breadcrumbs={[{ label: 'Local', to: `/app/p/${project.id}/local` }, { label: 'Business Profile' }]}
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
  const selectedId = params.get('location') ?? s.locations[0]?.id ?? null;
  const selected = s.locations.find((l) => l.id === selectedId) ?? s.locations[0] ?? null;
  const integration = s.integration;
  const connected = integration?.status === 'CONNECTED' || integration?.status === 'ERROR';
  const anyLinked = s.locations.some((l) => l.profileLocationName);

  return (
    <>
      {header}
      <div className="space-y-5">
        <Card>
          <CardHeaderRow
            title={
              <span className="flex items-center gap-2">
                Google Business Profile{' '}
                {integration ? <StatusBadge status={integration.status} /> : <Badge>Not connected</Badge>}
              </span>
            }
            description={
              integration
                ? `${integration.externalAccount ? `Connected as ${integration.externalAccount}` : 'Connected'}${integration.lastSyncAt ? ` · last sync ${formatDateTime(integration.lastSyncAt)}` : ' · not synced yet'}`
                : 'Connect the Google account that manages the profile. Surfaced asks only for Business Profile access.'
            }
            actions={
              s.configured ? (
                !connected ? (
                  canConnect ? (
                    <Button onClick={() => connect.mutate()} loading={connect.isPending}>
                      <Plug /> {integration?.status === 'NEEDS_REAUTH' ? 'Reconnect' : 'Connect with Google'}
                    </Button>
                  ) : null
                ) : canManage ? (
                  <Button
                    variant="outline"
                    onClick={() => sync.mutate()}
                    loading={sync.isPending}
                    disabled={!anyLinked || Boolean(jobId)}
                  >
                    <RefreshCw /> Sync now
                  </Button>
                ) : null
              ) : null
            }
          />
          <CardContent className="space-y-3">
            {!s.configured ? (
              <Alert tone="warning" title="Not configured on this server">
                {s.setup}
              </Alert>
            ) : null}
            {integration?.status === 'NEEDS_REAUTH' ? (
              <Alert tone="warning">Google access expired or was revoked. Reconnect to keep syncing.</Alert>
            ) : null}
            {integration?.lastError ? (
              <Alert
                tone={integration.lastSyncStatus === 'PARTIAL' ? 'warning' : 'danger'}
                title={
                  integration.lastSyncStatus === 'PARTIAL'
                    ? 'Some locations did not sync'
                    : 'Last sync failed'
                }
              >
                <span className="whitespace-pre-line">{integration.lastError}</span>
              </Alert>
            ) : null}
            {jobId ? (
              <JobProgress
                jobId={jobId}
                label="Business Profile sync"
                onFinished={refresh}
                onDismiss={() => setJobId(null)}
              />
            ) : null}
            {s.configured && !connected ? (
              <p className="text-xs text-muted-foreground">
                Google must approve Business Profile API access for this installation before data can be read;
                until then Google answers with a quota error, shown here. Disconnecting is done on the{' '}
                <Link to={`/app/p/${project.id}/integrations`} className="text-primary hover:underline">
                  Integrations
                </Link>{' '}
                page.
              </p>
            ) : null}
          </CardContent>
        </Card>

        {!s.locations.length ? (
          <EmptyState
            title="Add a location first"
            description="Business Profile is linked per location."
            action={
              <Button asChild>
                <Link to={`/app/p/${project.id}/locations`}>Add a location</Link>
              </Button>
            }
          />
        ) : (
          <>
            {s.locations.length > 1 ? (
              <div className="grid max-w-md gap-1.5">
                <Label htmlFor="gbp-location">Location</Label>
                <NativeSelect
                  id="gbp-location"
                  value={selected?.id ?? ''}
                  onChange={(e) => {
                    const next = new URLSearchParams(params);
                    next.set('location', e.target.value);
                    setParams(next, { replace: true });
                  }}
                >
                  {s.locations.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}, {l.city}
                      {l.profileLocationName ? '' : ' (not linked)'}
                    </option>
                  ))}
                </NativeSelect>
              </div>
            ) : null}
            {selected ? (
              <>
                {selected.profileLocationName ? (
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <Badge tone="primary">
                      <Link2 className="size-3" aria-hidden /> Linked to {selected.profileLocationName}
                    </Badge>
                    {selected.snapshotAt ? (
                      <span className="text-xs text-muted-foreground">
                        data from {formatDateTime(selected.snapshotAt)}
                      </span>
                    ) : null}
                    {canManage ? (
                      <ConfirmDialog
                        title={`Unlink ${selected.name}?`}
                        description="The Business Profile data stored for this location is deleted. Reply drafts and approvals are kept. Nothing changes on Google."
                        confirmLabel="Unlink"
                        destructive
                        onConfirm={async () => {
                          await api.delete(
                            `/projects/${project.id}/locations/${selected.id}/business-profile`,
                          );
                          toast.success('Unlinked');
                          refresh();
                        }}
                        trigger={
                          <Button size="sm" variant="ghost">
                            <Unlink /> Unlink
                          </Button>
                        }
                      />
                    ) : null}
                  </div>
                ) : connected && canManage ? (
                  <LinkPanel location={selected} status={s} />
                ) : connected ? (
                  <Alert tone="info">
                    This location is not linked to a Business Profile yet. Someone who manages local SEO can
                    link it.
                  </Alert>
                ) : (
                  <Alert tone="info" title="Audit of the details entered in Surfaced">
                    <span className="inline-flex items-start gap-1.5">
                      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                      Connect Business Profile to audit the live profile, see Google’s performance numbers and
                      answer reviews.
                    </span>
                  </Alert>
                )}
                <LocationDetail
                  key={selected.id}
                  projectId={project.id}
                  locationId={selected.id}
                  linked={Boolean(selected.profileLocationName)}
                />
              </>
            ) : null}
          </>
        )}
      </div>
    </>
  );
}
