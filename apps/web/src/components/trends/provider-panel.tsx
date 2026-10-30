import type { TrendProviderStatusDto, TrendsStatusDto } from '@surfaced/shared';
import { Badge, type BadgeTone } from '@/components/ui/badge';
import { Card, CardContent, CardHeaderRow } from '@/components/ui/card';
import { formatRelative } from '@/lib/format';

function providerState(p: TrendProviderStatusDto): { tone: BadgeTone; label: string } {
  if (p.health && p.health.coolingDownSeconds > 0)
    return { tone: 'warning', label: `Paused ${Math.ceil(p.health.coolingDownSeconds / 60)} min` };
  if (p.available) return { tone: 'success', label: 'Available' };
  if (!p.configured) return { tone: 'neutral', label: 'Not set up' };
  return { tone: 'danger', label: 'Unavailable' };
}

/** Where trends data can come from on this server, and whether each source works right now. */
export function ProviderPanel({ status }: { status: TrendsStatusDto }) {
  return (
    <Card>
      <CardHeaderRow
        title="Data sources"
        description="Each report uses one source; numbers from different sources are never mixed."
      />
      <CardContent className="grid gap-3">
        <ul className="grid gap-3 md:grid-cols-2">
          {status.providers.map((p) => {
            const state = providerState(p);
            return (
              <li key={p.key} className="rounded-lg border border-border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{p.label}</span>
                  <Badge tone={state.tone}>{state.label}</Badge>
                  {p.experimental ? <Badge tone="warning">Experimental</Badge> : null}
                  {p.paid ? <Badge tone="neutral">Paid</Badge> : null}
                </div>
                <p className="mt-1.5 text-[13px] text-muted-foreground">{p.detail}</p>
                {p.health?.lastError && !p.available ? (
                  <p className="mt-1 text-[13px] text-destructive">{p.health.lastError}</p>
                ) : null}
                {p.lastSuccessAt || p.lastFailure ? (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {p.lastSuccessAt
                      ? `Last success ${formatRelative(p.lastSuccessAt)}`
                      : 'No successful request yet'}
                    {p.lastFailure
                      ? ` · last problem ${formatRelative(p.lastFailure.at)}: ${p.lastFailure.message ?? p.lastFailure.outcome}`
                      : ''}
                  </p>
                ) : null}
              </li>
            );
          })}
          <li className="rounded-lg border border-border p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">Google Search Console (your own data)</span>
              <Badge tone={status.searchConsole.connected ? 'success' : 'neutral'}>
                {status.searchConsole.connected ? 'Connected' : 'Not connected'}
              </Badge>
            </div>
            <p className="mt-1.5 text-[13px] text-muted-foreground">{status.searchConsole.detail}</p>
          </li>
          <li className="rounded-lg border border-border p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">Google Ads Keyword Planner</span>
              <Badge tone="neutral">Not connected</Badge>
            </div>
            <p className="mt-1.5 text-[13px] text-muted-foreground">{status.keywordPlanner.detail}</p>
          </li>
        </ul>
        <p className="text-xs text-muted-foreground">
          Live lookups today: {status.limits.liveReportsToday} of{' '}
          {status.limits.liveReportsPerWorkspacePerDay} for this workspace (reused cached data does not
          count).
        </p>
      </CardContent>
    </Card>
  );
}
