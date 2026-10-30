import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CreditCard, ExternalLink, FlaskConical } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { useUsage, useWorkspace, useWorkspaceId } from '@/app/queries';
import { Meter } from '@/components/charts/charts';
import { PageHeader } from '@/components/app/page';
import { IntervalToggle, PlanCard, usePlans, type Interval } from '@/components/marketing/pricing';
import { Badge, StatusBadge, humanize } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeaderRow } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/dialog';
import { Alert, ErrorState, LoadingBlock } from '@/components/ui/feedback';
import { Pagination, TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { api, errorMessage } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { formatCurrency, formatDate, formatNumber } from '@/lib/format';
import type { BillingMode, PlanDto } from '@/lib/types';

interface SubscriptionView {
  plan: PlanDto;
  billing: BillingMode;
  subscription: {
    status: string;
    provider: string;
    interval: string;
    currentPeriodStart: string | null;
    currentPeriodEnd: string | null;
    cancelAtPeriodEnd: boolean;
    canceledAt: string | null;
    lastPaymentFailedAt: string | null;
    hasPortal: boolean;
  } | null;
}

const PROVIDER_LABELS: Record<string, string> = {
  NONE: 'Free',
  DEV: 'Development billing',
  STRIPE: 'Stripe',
  RAZORPAY: 'Razorpay',
};

interface InvoiceDto {
  id: string;
  provider: string;
  amount: string;
  currency: string;
  status: string;
  description: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  hostedUrl: string | null;
  paidAt: string | null;
  createdAt: string;
}

function UsageCard() {
  const usage = useUsage();
  return (
    <Card>
      <CardHeaderRow
        title="Usage this month"
        description={
          usage.data ? `Period ${usage.data.periodKey} (UTC). Monthly limits reset on the 1st.` : undefined
        }
      />
      <CardContent>
        {usage.isPending ? (
          <LoadingBlock />
        ) : usage.isError ? (
          <ErrorState error={usage.error} onRetry={() => void usage.refetch()} />
        ) : (
          <ul className="grid gap-4 sm:grid-cols-2">
            {[
              ...usage.data.metrics,
              ...usage.data.counts.map((c) => ({
                metric: c.kind,
                label: c.label,
                used: c.used,
                limit: c.limit as number | null,
              })),
            ].map((m) => (
              <li key={m.metric}>
                <div className="mb-1 flex justify-between text-[13px]">
                  <span>{m.label}</span>
                  <span className="text-muted-foreground tabular-nums">
                    {formatNumber(m.used)}
                    {m.limit !== null ? ` / ${formatNumber(m.limit)}` : ''}
                  </span>
                </div>
                {m.limit !== null ? (
                  <Meter value={m.limit ? (m.used / m.limit) * 100 : 0} label={`${m.label} used`} />
                ) : (
                  <p className="text-xs text-muted-foreground">No monthly limit (bounded per audit)</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

export default function BillingPage() {
  const workspaceId = useWorkspaceId();
  const workspace = useWorkspace();
  const canRead = useCan('billing.read');
  const canManage = useCan('billing.manage');
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [interval, setBillingInterval] = useState<Interval>(
    params.get('interval') === 'YEAR' ? 'YEAR' : 'MONTH',
  );
  const [invoicePage, setInvoicePage] = useState(1);
  const plans = usePlans();
  const sub = useQuery({
    queryKey: ['billing', workspaceId, 'subscription'],
    queryFn: () => api.get<SubscriptionView>('/billing/subscription', { workspaceId }),
    enabled: Boolean(workspaceId && canRead),
  });
  const invoices = useQuery({
    queryKey: ['billing', workspaceId, 'invoices', invoicePage],
    queryFn: () =>
      api.page<InvoiceDto>('/billing/invoices', { workspaceId, page: invoicePage, pageSize: 10 }),
    enabled: Boolean(workspaceId && canRead),
  });
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['billing', workspaceId] });
    void queryClient.invalidateQueries({ queryKey: ['usage', workspaceId] });
    void queryClient.invalidateQueries({ queryKey: ['workspace', workspaceId] });
  };

  useEffect(() => {
    const checkout = params.get('checkout');
    if (checkout === 'success')
      toast.success('Checkout complete', {
        description:
          'Your plan changes once the payment provider confirms the payment, usually within a minute.',
      });
    if (checkout === 'cancelled') toast.info('Checkout cancelled', { description: 'No changes were made.' });
    if (checkout) setParams({}, { replace: true });
  }, [params, setParams]);

  const checkout = useMutation({
    mutationFn: (planKey: string) =>
      api.post<{ mode: string; url: string | null; development?: boolean }>('/billing/checkout', {
        workspaceId,
        planKey,
        interval,
      }),
    onSuccess: (r) => {
      if (r.url) {
        window.location.assign(r.url);
        return;
      }
      if (r.mode === 'activated')
        toast.success('Plan changed', {
          description: r.development ? 'Development billing mode: no payment was taken.' : undefined,
        });
      else if (r.mode === 'scheduled_cancel')
        toast.success('Your paid plan will end at the end of the billing period');
      refresh();
    },
    onError: (e) => toast.error('Could not change the plan', { description: errorMessage(e) }),
  });
  const action = useMutation({
    mutationFn: async (kind: 'cancel' | 'resume' | 'portal') => {
      if (kind === 'portal') {
        const r = await api.post<{ url: string }>('/billing/portal', { workspaceId });
        window.location.assign(r.url);
        return;
      }
      await api.post(`/billing/${kind}`, { workspaceId });
    },
    onSuccess: (_d, kind) => {
      if (kind !== 'portal') {
        toast.success(
          kind === 'cancel' ? 'Cancellation scheduled for the end of the period' : 'Cancellation undone',
        );
        refresh();
      }
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const simulate = useMutation({
    mutationFn: (event: 'payment_failed' | 'payment_recovered' | 'cancel_now') =>
      api.post('/billing/dev/simulate', { workspaceId, event }),
    onSuccess: () => {
      toast.success('Simulated event applied');
      refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const chosenPlan = params.get('plan');
  const view = sub.data;
  const current = view?.plan.key ?? workspace.data?.plan.key;
  const s = view?.subscription;
  const mode = view?.billing.mode ?? plans.data?.billing?.mode;
  const sorted = [...(plans.data?.plans ?? [])].sort((a, b) => a.sortOrder - b.sortOrder);

  return (
    <>
      <PageHeader
        title="Billing and usage"
        description={workspace.data ? `Workspace: ${workspace.data.name}` : undefined}
      />
      {mode === 'development' ? (
        <Alert tone="warning" className="mb-5" title="Development billing mode">
          Plan changes take effect immediately and no payment is processed. Configure Stripe or Razorpay for
          real payments; development billing is refused in production.
        </Alert>
      ) : mode === 'disabled' ? (
        <Alert tone="info" className="mb-5" title="Billing is disabled on this server">
          Plan changes are not available.
        </Alert>
      ) : null}

      {canRead ? (
        <Card className="mb-5">
          <CardHeaderRow
            title={
              <span className="flex items-center gap-2">
                <CreditCard className="size-4 text-muted-foreground" aria-hidden /> Current plan:{' '}
                {view?.plan.name ?? '…'}
              </span>
            }
            description={
              s
                ? `${PROVIDER_LABELS[s.provider] ?? humanize(s.provider)} · ${s.interval === 'YEAR' ? 'yearly' : 'monthly'}${s.currentPeriodEnd ? ` · current period ends ${formatDate(s.currentPeriodEnd)}` : ''}`
                : undefined
            }
            actions={
              <div className="flex flex-wrap items-center gap-2">
                {s ? <StatusBadge status={s.status} /> : null}
                {s?.cancelAtPeriodEnd ? (
                  <Badge tone="warning">Ends {formatDate(s.currentPeriodEnd)}</Badge>
                ) : null}
                {canManage && s?.hasPortal ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => action.mutate('portal')}
                    loading={action.isPending && action.variables === 'portal'}
                  >
                    <ExternalLink /> Manage billing
                  </Button>
                ) : null}
                {canManage && s && current !== 'FREE' && s.status !== 'CANCELED' ? (
                  s.cancelAtPeriodEnd ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => action.mutate('resume')}
                      loading={action.isPending && action.variables === 'resume'}
                    >
                      Keep my plan
                    </Button>
                  ) : (
                    <ConfirmDialog
                      title="Cancel at the end of the billing period?"
                      description="You keep the current plan until the period ends, then the workspace moves to the Free plan. You can undo this before then."
                      confirmLabel="Schedule cancellation"
                      destructive
                      onConfirm={() => action.mutateAsync('cancel')}
                      trigger={
                        <Button size="sm" variant="outline">
                          Cancel plan
                        </Button>
                      }
                    />
                  )
                ) : null}
              </div>
            }
          />
          {s?.status === 'PAST_DUE' ? (
            <CardContent>
              <Alert tone="danger" title="The last payment failed">
                Update your payment method to keep the plan.{' '}
                {s.lastPaymentFailedAt ? `Failed on ${formatDate(s.lastPaymentFailedAt)}.` : ''}
              </Alert>
            </CardContent>
          ) : null}
        </Card>
      ) : (
        <Alert tone="info" className="mb-5">
          Only workspace owners and admins can view billing. Usage is shown below.
        </Alert>
      )}

      {canManage && mode !== 'disabled' ? (
        <section className="mb-8" aria-labelledby="plans-heading">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <h2 id="plans-heading" className="text-lg font-semibold">
              Plans
            </h2>
            <IntervalToggle value={interval} onChange={setBillingInterval} />
          </div>
          {chosenPlan && chosenPlan !== current ? (
            <Alert tone="info" className="mb-4">
              You chose the {sorted.find((p) => p.key === chosenPlan)?.name ?? chosenPlan} plan. Confirm it
              below.
            </Alert>
          ) : null}
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {sorted.map((plan) => (
              <PlanCard
                key={plan.key}
                plan={plan}
                interval={interval}
                cta={
                  plan.key === current ? (
                    <Button className="w-full" variant="outline" disabled>
                      Current plan
                    </Button>
                  ) : (
                    <Button
                      className="w-full"
                      variant={plan.key === chosenPlan || plan.highlighted ? 'primary' : 'outline'}
                      loading={checkout.isPending && checkout.variables === plan.key}
                      disabled={checkout.isPending}
                      onClick={() => checkout.mutate(plan.key)}
                    >
                      {plan.key === 'FREE' ? 'Downgrade to Free' : `Switch to ${plan.name}`}
                    </Button>
                  )
                }
              />
            ))}
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            Paid plans require a verified email address. Payment is confirmed by the payment provider before a
            plan changes.
          </p>
        </section>
      ) : null}

      <div className="grid gap-5 xl:grid-cols-[1.2fr_1fr]">
        <UsageCard />
        {canRead ? (
          <Card>
            <CardHeaderRow title="Invoices" />
            {invoices.isPending ? (
              <CardContent>
                <LoadingBlock />
              </CardContent>
            ) : invoices.isError ? (
              <CardContent>
                <ErrorState error={invoices.error} />
              </CardContent>
            ) : invoices.data.items.length === 0 ? (
              <CardContent>
                <p className="text-sm text-muted-foreground">
                  No invoices yet.
                  {mode === 'development' ? ' Development billing does not create invoices.' : ''}
                </p>
              </CardContent>
            ) : (
              <>
                <Table>
                  <THead>
                    <TR>
                      <TH>Date</TH>
                      <TH>Amount</TH>
                      <TH>Status</TH>
                      <TH className="sr-only">Link</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {invoices.data.items.map((i) => (
                      <TR key={i.id}>
                        <TD className="text-xs">
                          {formatDate(i.createdAt)}
                          {i.description ? (
                            <span className="block text-muted-foreground">{i.description}</span>
                          ) : null}
                        </TD>
                        <TD className="tabular-nums">{formatCurrency(Number(i.amount), i.currency)}</TD>
                        <TD>
                          <StatusBadge status={i.status} />
                        </TD>
                        <TD className="text-right">
                          {i.hostedUrl ? (
                            <a
                              href={i.hostedUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-[13px] font-medium text-primary hover:underline"
                            >
                              View
                            </a>
                          ) : null}
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
                <Pagination meta={invoices.data.meta} onPage={setInvoicePage} />
              </>
            )}
          </Card>
        ) : null}
      </div>

      {canManage && mode === 'development' ? (
        <Card className="mt-5">
          <CardHeaderRow
            title={
              <span className="flex items-center gap-2">
                <FlaskConical className="size-4 text-muted-foreground" aria-hidden /> Development tools
              </span>
            }
            description="Simulate provider events to check how the product handles them. Only available in development billing mode."
          />
          <CardContent className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => simulate.mutate('payment_failed')}
              loading={simulate.isPending && simulate.variables === 'payment_failed'}
            >
              Simulate failed payment
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => simulate.mutate('payment_recovered')}
              loading={simulate.isPending && simulate.variables === 'payment_recovered'}
            >
              Simulate recovered payment
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => simulate.mutate('cancel_now')}
              loading={simulate.isPending && simulate.variables === 'cancel_now'}
            >
              Simulate immediate cancellation
            </Button>
          </CardContent>
        </Card>
      ) : null}
    </>
  );
}
