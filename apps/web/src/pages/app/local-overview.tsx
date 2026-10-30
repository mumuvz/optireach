import { useQuery } from '@tanstack/react-query';
import { ArrowDownRight, ArrowRight, ArrowUpRight, MapPin, Minus } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import type { LocalOverviewDto, LocationDto, OverviewCard, OverviewCardState } from '@surfaced/shared';
import { useProject } from '@/app/project-scope';
import { PageHeader } from '@/components/app/page';
import { SetupChecklist } from '@/components/local/setup-checklist';
import { Badge, type BadgeTone } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ErrorState, LoadingBlock } from '@/components/ui/feedback';
import { NativeSelect } from '@/components/ui/form';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatRelative } from '@/lib/format';

const STATE: Record<OverviewCardState, { tone: BadgeTone; label: string } | null> = {
  ok: null,
  empty: { tone: 'neutral', label: 'No data yet' },
  connect: { tone: 'info', label: 'Connect account' },
  unavailable: { tone: 'neutral', label: 'Data unavailable' },
  unsupported: { tone: 'warning', label: 'Measurement unsupported' },
};

function Change({ change }: { change: NonNullable<OverviewCard['change']> }) {
  const Icon =
    change.direction === 'up' ? ArrowUpRight : change.direction === 'down' ? ArrowDownRight : Minus;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-0.5 text-xs font-medium',
        change.good === true && 'text-emerald-700 dark:text-emerald-400',
        change.good === false && 'text-red-700 dark:text-red-400',
        change.good === null && 'text-muted-foreground',
      )}
    >
      <Icon className="size-3.5" aria-hidden />
      {change.absolute}
      {change.percent !== null ? ` (${change.percent > 0 ? '+' : ''}${change.percent}%)` : ''}
    </span>
  );
}

function SurfaceCard({ card }: { card: OverviewCard }) {
  const state = STATE[card.state];
  return (
    <Card className="flex flex-col">
      <CardContent className="flex flex-1 flex-col gap-2 pt-5">
        <div className="flex items-start justify-between gap-2">
          <h2 className="text-sm font-semibold">{card.title}</h2>
          {state ? <Badge tone={state.tone}>{state.label}</Badge> : null}
          {card.freshness === 'stale' ? <Badge tone="warning">Older data</Badge> : null}
        </div>
        {card.value ? (
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="text-2xl font-semibold tabular-nums">{card.value}</span>
            {card.change ? <Change change={card.change} /> : null}
          </div>
        ) : null}
        {card.previous ? <p className="text-xs text-muted-foreground">Previous: {card.previous}</p> : null}
        {card.lines.length ? (
          <ul className="space-y-1 text-sm">
            {card.lines.map((l) => (
              <li key={l.label} className="flex justify-between gap-3">
                <span className="min-w-0 break-words">{l.label}</span>
                <span className="shrink-0 text-right tabular-nums">
                  {l.value}
                  {l.note ? <span className="block text-xs text-muted-foreground">{l.note}</span> : null}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
        {card.limitations.length ? (
          <ul className="space-y-1 text-xs text-muted-foreground">
            {card.limitations.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        ) : null}
        <dl className="mt-auto grid gap-0.5 border-t border-border pt-2 text-xs text-muted-foreground">
          {card.dateRange ? (
            <div>
              <dt className="inline">Period: </dt>
              <dd className="inline">{card.dateRange}</dd>
            </div>
          ) : null}
          {card.place ? (
            <div>
              <dt className="inline">Place: </dt>
              <dd className="inline">{card.place}</dd>
            </div>
          ) : null}
          {card.source ? (
            <div>
              <dt className="inline">Source: </dt>
              <dd className="inline">{card.source}</dd>
            </div>
          ) : null}
          {card.lastCollectedAt ? (
            <div>
              <dt className="inline">Last collected: </dt>
              <dd className="inline">{formatRelative(card.lastCollectedAt)}</dd>
            </div>
          ) : null}
        </dl>
        {card.action ? (
          <Button asChild size="sm" variant="outline" className="justify-self-start">
            <Link to={card.action.to}>
              {card.action.label} <ArrowRight />
            </Link>
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}

export default function LocalOverviewPage() {
  const project = useProject();
  const [locationId, setLocationId] = useState('');
  const [days, setDays] = useState(28);
  const locations = useQuery({
    queryKey: ['locations', project.id],
    queryFn: () => api.get<LocationDto[]>(`/projects/${project.id}/locations`),
  });
  const overview = useQuery({
    queryKey: ['local-overview', project.id, locationId, days],
    queryFn: () =>
      api.get<LocalOverviewDto>(`/projects/${project.id}/local/overview`, {
        locationId: locationId || undefined,
        days,
      }),
  });
  return (
    <>
      <PageHeader
        title="Local Search & AI Visibility"
        description="Each search surface is measured separately: Maps, organic search, AI answers and Shopping are never merged into one number."
        actions={
          <div className="flex flex-wrap gap-2">
            <NativeSelect
              aria-label="Location"
              value={locationId}
              onChange={(e) => setLocationId(e.target.value)}
              className="w-56"
            >
              <option value="">{locations.data?.length ? 'Primary location' : 'No locations yet'}</option>
              {(locations.data ?? []).map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name} · {l.locality ? `${l.locality}, ` : ''}
                  {l.city}
                </option>
              ))}
            </NativeSelect>
            <NativeSelect
              aria-label="Period"
              value={String(days)}
              onChange={(e) => setDays(Number(e.target.value))}
              className="w-36"
            >
              <option value="7">Last 7 days</option>
              <option value="28">Last 28 days</option>
              <option value="90">Last 90 days</option>
            </NativeSelect>
          </div>
        }
      />
      {locations.data && !locations.data.length ? (
        <Card className="mb-5">
          <CardContent className="flex flex-wrap items-center justify-between gap-3 pt-5">
            <p className="flex items-center gap-2 text-sm">
              <MapPin className="size-4 text-muted-foreground" aria-hidden /> Add the business’s location to
              track Google Maps rankings and local competitors. {/* prettier-ignore */}
            </p>
            <Button asChild size="sm">
              <Link to={`/app/p/${project.id}/locations`}>Add a location</Link>
            </Button>
          </CardContent>
        </Card>
      ) : null}
      {overview.isLoading ? <LoadingBlock rows={6} /> : null}
      {overview.error ? <ErrorState error={overview.error} onRetry={() => void overview.refetch()} /> : null}
      {overview.data?.setup ? <SetupChecklist projectId={project.id} steps={overview.data.setup} /> : null}
      {overview.data ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {overview.data.cards.map((c) => (
            <SurfaceCard key={c.key} card={c} />
          ))}
        </div>
      ) : null}
    </>
  );
}
