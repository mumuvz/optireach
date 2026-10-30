import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Check,
  Download,
  ExternalLink,
  FileSearch,
  Globe,
  MapPin,
  MapPinned,
  Play,
  Plus,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { Suspense, lazy, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import {
  COLLECTION_DEFAULT_DELAY_MS,
  COLLECTION_MAX_BATCH_SIZE,
  COLLECTION_MAX_DELAY_MS,
  COLLECTION_MIN_DELAY_MS,
  GOOGLE_CAPTURE_DEFAULT_TARGET,
  GOOGLE_CAPTURE_MAX_PAGE_CHARS,
  GOOGLE_CAPTURE_MAX_PAGES,
  GOOGLE_CAPTURE_MAX_TARGET,
  GRID_SIZES,
  compactSavedPage,
  LOCAL_OBSERVATION_TYPE_LABELS,
  LOCAL_RANK_SOURCE_LABELS,
  LOCAL_SURFACE_LABELS,
  RANK_DEPTHS,
  parseGoogleSearchUrl,
  type CollectionStatus,
  type GoogleCaptureResultDto,
  type CollectionAction,
  type GoogleCaptureState,
  type LocalBatchSourceDto,
  type GridPointDto,
  type LocalCompetitorShowing,
  type LocalImportResultDto,
  type LocalRankQueryDto,
  type LocalRankScanDto,
  type LocalRankScanSummaryDto,
  type LocalRankSource,
  type LocalSurface,
  type LocationDto,
  type RankFrequency,
} from '@surfaced/shared';
import { useProject } from '@/app/project-scope';
import { JobProgress, PageHeader } from '@/components/app/page';
import { ChartFrame, LineTrend } from '@/components/charts/charts';
import { SERIES } from '@/components/charts/palette';
import { BusinessRankFinder, ScanListings } from '@/components/local/business-research';
import { CompetitorMap } from '@/components/local/competitor-map';
import { BAND_STYLE, markerText, rankBand } from '@/components/local/rank-bands';
import { Badge, type BadgeTone } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeaderRow } from '@/components/ui/card';
import { ConfirmDialog, Dialog, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/dialog';
import { Alert, EmptyState, ErrorState, LoadingBlock } from '@/components/ui/feedback';
import { Checkbox, Field, Input, NativeSelect, Textarea } from '@/components/ui/form';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { api, errorMessage } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { formatDate, formatDateTime, formatNumber } from '@/lib/format';

const RankMap = lazy(() => import('@/components/local/rank-map'));

interface LocalStatus {
  sources: {
    key: LocalRankSource;
    label: string;
    live: boolean;
    surfaces: LocalSurface[];
    configured: boolean;
    available: boolean;
    detail: string;
  }[];
  defaultLiveSource: LocalRankSource | null;
  batchSources: LocalBatchSourceDto[];
  usage: { localRankPoints: { used: number; limit: number | null; periodKey: string } };
  locations: { used: number; limit: number };
  hasWebsite: boolean;
  compliance: string;
}

const FREQUENCY_LABELS: Record<RankFrequency, string> = {
  MANUAL: 'On request',
  WEEKLY: 'Every week',
  MONTHLY: 'Every month',
};
const pct = (n: number | null | undefined) => (n === null || n === undefined ? '—' : `${n}%`);

function TrackQueryDialog({
  open,
  onOpenChange,
  location,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  location: LocationDto;
}) {
  // prettier-ignore
  const project = useProject();
  const queryClient = useQueryClient();
  const [query, setQuery] = useState('');
  const [surface, setSurface] = useState<LocalSurface>('MAPS');
  const [gridSize, setGridSize] = useState(5);
  const [spacingKm, setSpacingKm] = useState('1');
  const [depth, setDepth] = useState(20);
  const [device, setDevice] = useState<'mobile' | 'desktop'>('mobile');
  const [frequency, setFrequency] = useState<RankFrequency>('MANUAL');
  const create = useMutation({
    mutationFn: () =>
      api.post<LocalRankQueryDto>(`/projects/${project.id}/local/queries`, {
        query,
        locationId: location.id,
        surface,
        gridSize,
        spacingKm: Number(spacingKm),
        depth,
        device,
        frequency,
        language: project.targetLanguages[0] ?? 'en', // prettier-ignore
      }),
    onSuccess: async () => {
      toast.success('Query tracked');
      await queryClient.invalidateQueries({ queryKey: ['local-queries', project.id] });
      onOpenChange(false);
      setQuery('');
    },
    onError: (e) => toast.error('Could not track the query', { description: errorMessage(e) }),
  });
  const points = gridSize * gridSize;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader
          title="Track a search query"
          description={`Checked on a grid around ${location.name}, ${location.city}.`}
        />
        <Field label="Search query" description="What customers type, e.g. best jewellers in surat">
          <Input value={query} onChange={(e) => setQuery(e.target.value)} autoFocus />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Search surface"
            description={
              surface === 'ORGANIC'
                ? 'Organic uses Google’s free Programmable Search API: real Google web results, national (not per grid point) and NOT the Maps pack. A 1×1 grid is used. Maps needs a licensed provider or manual entry.'
                : undefined
            }
          >
            <NativeSelect
              value={surface}
              onChange={(e) => {
                const next = e.target.value as LocalSurface;
                setSurface(next);
                if (next === 'ORGANIC') setGridSize(1);
              }}
            >
              {(['MAPS', 'LOCAL_PACK', 'ORGANIC'] as const).map((s) => (
                <option key={s} value={s}>
                  {LOCAL_SURFACE_LABELS[s]}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label="Device">
            <NativeSelect value={device} onChange={(e) => setDevice(e.target.value as 'mobile' | 'desktop')}>
              <option value="mobile">Mobile</option>
              <option value="desktop">Desktop</option>
            </NativeSelect>
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Grid size" description={`${points} point${points === 1 ? '' : 's'} per scan`}>
            <NativeSelect
              value={String(gridSize)}
              onChange={(e) => setGridSize(Number(e.target.value))}
              disabled={surface === 'ORGANIC'}
            >
              {GRID_SIZES.map((g) => (
                <option key={g} value={g}>
                  {g} × {g}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label="Point spacing (km)">
            <Input value={spacingKm} onChange={(e) => setSpacingKm(e.target.value)} inputMode="decimal" />
          </Field>
          <Field label="Results checked" description="Beyond this, “not found”">
            <NativeSelect value={String(depth)} onChange={(e) => setDepth(Number(e.target.value))}>
              {RANK_DEPTHS.map((d) => (
                <option key={d} value={d}>
                  Top {d}
                </option>
              ))}
            </NativeSelect>
          </Field>
        </div>
        <Field
          label="Scan automatically"
          description="Scheduled scans use a licensed provider and your plan’s grid points."
        >
          <NativeSelect value={frequency} onChange={(e) => setFrequency(e.target.value as RankFrequency)}>
            {(Object.keys(FREQUENCY_LABELS) as RankFrequency[]).map((f) => (
              <option key={f} value={f}>
                {FREQUENCY_LABELS[f]}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => create.mutate()}
            loading={create.isPending}
            disabled={query.trim().length < 2}
          >
            Track query
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ManualEntry({
  scan,
  point,
  onSaved,
}: {
  scan: LocalRankScanDto;
  point: GridPointDto;
  onSaved: () => void;
}) {
  const project = useProject();
  const [text, setText] = useState('');
  const [mine, setMine] = useState<number | null>(null);
  const lines = text
    .split('\n')
    .map((l) => l.replace(/^\s*\d+[.)]\s*/, '').trim())
    .filter(Boolean)
    .slice(0, 100);
  const save = useMutation({
    mutationFn: () =>
      api.post<{ rank: number | null }>(`/projects/${project.id}/local/scans/${scan.id}/points`, {
        row: point.row,
        col: point.col,
        results: lines.map((title, i) => ({ title, isTarget: mine === i })),
      }),
    onSuccess: (r) => {
      toast.success(
        r.rank ? `Saved: your business is #${r.rank} here` : 'Saved: your business is not in this list',
      );
      setText('');
      setMine(null);
      onSaved();
    },
    onError: (e) => toast.error('Could not save the point', { description: errorMessage(e) }),
  });
  return (
    <div className="grid gap-3 rounded-lg border border-dashed border-border p-3">
      <p className="text-sm font-medium">Enter what you saw at this point</p>
      <p className="text-xs text-muted-foreground">
        Search “{scan.query}” on Google Maps at or near {point.latitude.toFixed(4)},{' '}
        {point.longitude.toFixed(4)}, then list the businesses in order, one per line. Sponsored listings are
        not rankings: leave them out. {/* prettier-ignore */}
      </p>
      <Textarea
        rows={6}
        value={text}
        onChange={(e) => setText(e.target.value)}
        aria-label="Businesses in the order shown"
        placeholder={'Kalamandir Jewellers\nShree Yamunaji Jewellers\n…'}
      />
      {lines.length ? (
        <fieldset className="grid gap-1">
          <legend className="text-xs text-muted-foreground">
            Which one is your business? (leave unticked if it is not listed)
          </legend>
          {lines.map((l, i) => (
            <label key={`${l}-${i}`} className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={mine === i}
                onCheckedChange={(v) => setMine(v === true ? i : null)}
                aria-label={`${l} is my business`}
              />
              {i + 1}. {l}
            </label>
          ))}
        </fieldset>
      ) : null}
      <Button
        size="sm"
        className="justify-self-start"
        onClick={() => save.mutate()}
        loading={save.isPending}
        disabled={!lines.length}
      >
        Save this point
      </Button>
    </div>
  );
}

function PointDetail({
  scan,
  point,
  canManage,
  onSaved,
}: {
  scan: LocalRankScanDto;
  point: GridPointDto;
  canManage: boolean;
  onSaved: () => void;
}) {
  // prettier-ignore
  const band = rankBand(point);
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className="inline-flex size-8 items-center justify-center rounded-full text-sm font-semibold"
          style={{ background: BAND_STYLE[band].bg, color: BAND_STYLE[band].fg }}
        >
          {markerText(point)}
        </span>
        <div>
          <p className="text-sm font-medium">
            Point {point.row + 1}-{point.col + 1} · {BAND_STYLE[band].label}
          </p>
          <p className="text-xs text-muted-foreground">
            {point.latitude.toFixed(5)}, {point.longitude.toFixed(5)} ·{' '}
            {LOCAL_RANK_SOURCE_LABELS[scan.source]}
          </p>
          <p className="text-xs text-muted-foreground">
            {LOCAL_OBSERVATION_TYPE_LABELS[scan.observationType ?? 'observed_search_position']}
          </p>
        </div>
      </div>
      {point.error ? <p className="text-[13px] text-muted-foreground">{point.error}</p> : null}
      {point.results.length ? (
        <ol className="grid gap-1 text-sm">
          {point.results.map((r) => {
            // Does this point span more than one continuation batch? Then show which batch each listing came from.
            const multiBatch = point.results.some((x) => (x.batch ?? 1) > 1);
            const unit = scan.source === 'GOOGLE_CAPTURE' ? 'page' : 'batch';
            return (
              <li
                key={`${r.batch ?? 1}-${r.rank}-${r.title}`}
                className={cn(
                  'flex justify-between gap-2 rounded-md px-2 py-1',
                  r.isTarget && 'bg-accent font-medium',
                )}
              >
                <span className="min-w-0">
                  {/* A page-local position (offset unknown) is never shown as a global rank. */}
                  {multiBatch && r.cumulativePosition == null
                    ? `${unit === 'page' ? 'Page' : 'Batch'} ${r.batch ?? 1} #${r.sourcePosition ?? r.rank}`
                    : `${r.rank}.`}{' '}
                  {r.title}
                  {r.sponsored ? (
                    <Badge tone="warning" className="ml-1.5 align-middle">
                      Sponsored
                    </Badge>
                  ) : null}
                  {multiBatch ? (
                    <span className="ml-1.5 align-middle text-xs text-muted-foreground">
                      {r.cumulativePosition == null
                        ? `${unit}-local position (${unit} offset unknown)`
                        : `${unit} ${r.batch ?? 1}${r.sourcePosition != null ? ` · #${r.sourcePosition} on that ${unit}` : ''}`}
                    </span>
                  ) : null}
                  {r.category ? (
                    <span className="block text-xs text-muted-foreground">{r.category}</span>
                  ) : null}
                </span>
                <span className="flex shrink-0 items-center gap-1.5 text-right text-xs text-muted-foreground tabular-nums">
                  {r.rating !== null ? `${r.rating}★` : ''}
                  {r.reviewCount !== null ? ` (${formatNumber(r.reviewCount)})` : ''}
                  {r.website ? (
                    <a
                      href={r.website}
                      target="_blank"
                      rel="noreferrer noopener"
                      aria-label={`${r.title} website`}
                      className="hover:text-foreground"
                    >
                      <Globe className="size-3.5" />
                    </a>
                  ) : null}
                  {r.mapsUrl ? (
                    <a
                      href={r.mapsUrl}
                      target="_blank"
                      rel="noreferrer noopener"
                      aria-label={`${r.title} on Google Maps`}
                      className="hover:text-foreground"
                    >
                      <MapPin className="size-3.5" />
                    </a>
                  ) : null}
                </span>
              </li>
            );
          })}
        </ol>
      ) : point.status === 'PENDING' ? null : (
        <p className="text-sm text-muted-foreground">No businesses recorded at this point.</p>
      )}
      {scan.source === 'MANUAL' && scan.status === 'RUNNING' && canManage ? (
        <ManualEntry scan={scan} point={point} onSaved={onSaved} />
      ) : null}
    </div>
  );
}

function Comparison({ queryId }: { queryId: string }) {
  const project = useProject();
  const queryClient = useQueryClient();
  const canManage = useCan('competitor.manage');
  const data = useQuery({
    queryKey: ['local-comparison', project.id, queryId],
    queryFn: () =>
      api.get<{ scanId: string | null; measured: number; showings: LocalCompetitorShowing[]; reviewGrowth: Record<string, number | null> }>(`/projects/${project.id}/local/queries/${queryId}/comparison`), // prettier-ignore
  });
  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: 'CONFIRMED' | 'DISMISSED' }) =>
      api.patch(`/projects/${project.id}/local/competitors/${id}`, { status }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['local-comparison', project.id] });
    },
    onError: (e) => toast.error('Could not update the competitor', { description: errorMessage(e) }),
  });
  if (!data.data?.scanId) return null;
  const { measured, showings, reviewGrowth } = data.data;
  return (
    <Card>
      <CardHeaderRow
        title="Who appears around you"
        description={`Every business listed in the latest scan, over ${measured} measured points. Ratings and review counts are as publicly displayed; they describe the listings, not why they rank.`}
      />
      <CardContent className="overflow-x-auto">
        <Table>
          <THead>
            <TR>
              <TH>Business</TH>
              <TH className="text-right">Listed at</TH>
              <TH className="text-right">Top 3 at</TH>
              <TH className="text-right">Average rank</TH>
              <TH className="text-right">Rating</TH>
              <TH className="text-right">Reviews</TH>
              <TH className="text-right">Since last scan</TH>
              <TH>Status</TH>
            </TR>
          </THead>
          <TBody>
            {showings.slice(0, 25).map((s) => {
              const growth = reviewGrowth[s.placeId ?? s.name];
              return (
                <TR key={`${s.placeId ?? s.name}`} className={s.isTarget ? 'bg-accent/50' : undefined}>
                  <TD className="align-top">
                    <div className="font-medium">
                      {s.name} {s.isTarget ? <Badge tone="primary">You</Badge> : null}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {[s.category, s.domain ?? 'no website listed'].filter(Boolean).join(' · ')}
                    </div>
                  </TD>
                  <TD className="text-right tabular-nums">
                    {s.appearances}/{measured}
                  </TD>
                  <TD className="text-right tabular-nums">{s.top3}</TD>
                  <TD className="text-right tabular-nums">{s.averageRank ?? '—'}</TD>
                  <TD className="text-right tabular-nums">{s.rating ?? '—'}</TD>
                  <TD className="text-right tabular-nums">
                    {s.reviewCount === null ? '—' : formatNumber(s.reviewCount)}
                  </TD>
                  <TD className="text-right tabular-nums">
                    {growth === null || growth === undefined ? '—' : `${growth > 0 ? '+' : ''}${growth}`}
                  </TD>
                  <TD className="align-top">
                    {s.isTarget ? null : s.status === 'SUGGESTED' && s.competitorId && canManage ? (
                      <div className="flex gap-1">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setStatus.mutate({ id: s.competitorId!, status: 'CONFIRMED' })}
                          aria-label={`Confirm ${s.name} as a competitor`}
                        >
                          <Check /> Confirm
                        </Button>
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          onClick={() => setStatus.mutate({ id: s.competitorId!, status: 'DISMISSED' })}
                          aria-label={`Dismiss ${s.name}`}
                        >
                          <X />
                        </Button>
                      </div>
                    ) : s.status ? (
                      <Badge tone={s.status === 'CONFIRMED' ? 'success' : 'neutral'}>
                        {s.status === 'CONFIRMED'
                          ? 'Competitor'
                          : s.status === 'DISMISSED'
                            ? 'Dismissed'
                            : 'Suggested'}
                      </Badge>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </TD>
                </TR>
              );
            })}
          </TBody>
        </Table>
      </CardContent>
    </Card>
  );
}

const COLLECTION_STATUS: Record<CollectionStatus, { tone: BadgeTone; label: string }> = {
  successful: { tone: 'success', label: 'Collected' },
  partial: { tone: 'warning', label: 'Partly collected' },
  failed: { tone: 'danger', label: 'Collection failed' },
  unavailable: { tone: 'neutral', label: 'No listings available' },
  in_progress: { tone: 'info', label: 'Collecting' },
};

/** The address a browser recorded inside a saved page (MHTML location, or Chrome's "saved from url" comment). */
function savedFromAddress(text: string): string | null {
  const head = text.slice(0, 4000);
  return (
    /^Snapshot-Content-Location:\s*(\S+)/im.exec(head)?.[1] ??
    /<!--\s*saved from url=\(\d+\)(\S+?)\s*-->/i.exec(head)?.[1] ??
    null
  );
}

const CAPTURE_STATE: Record<GoogleCaptureState, { tone: BadgeTone; label: string }> = {
  IN_PROGRESS: { tone: 'info', label: 'Collecting' },
  PAUSED: { tone: 'warning', label: 'Paused' },
  TARGET_REACHED: { tone: 'success', label: 'Target reached' },
  SOURCE_EXHAUSTED: { tone: 'success', label: 'Source has no more results' },
  PARTIAL: { tone: 'warning', label: 'Stopped early' },
  CANCELLED: { tone: 'neutral', label: 'Cancelled' },
  FAILED: { tone: 'danger', label: 'Stopped by an error' },
};
/** Saved-page collections wait for the user, and their source is Google itself. */
const stateLabel = (state: GoogleCaptureState, automatic: boolean) =>
  automatic
    ? CAPTURE_STATE[state].label
    : state === 'IN_PROGRESS'
      ? 'Collecting — waiting for the next page'
      : state === 'SOURCE_EXHAUSTED'
        ? 'Google has no more results'
        : CAPTURE_STATE[state].label;

interface SavedPage {
  key: string;
  fileName: string;
  html: string;
  /** The page's address: recorded by the browser in the file, or typed by the user. */
  url: string;
  recorded: boolean;
}

/** Reads saved pages (several at once). MHTML archives are reduced to their HTML part; nothing else is changed. */
async function readSavedPages(files: FileList): Promise<SavedPage[]> {
  const pages: SavedPage[] = [];
  for (const file of Array.from(files)) {
    const html = compactSavedPage(await file.text());
    if (html.length > GOOGLE_CAPTURE_MAX_PAGE_CHARS) {
      toast.error(`${file.name} is too large to read`, {
        description: 'Save it again as “Webpage, Complete” and choose the .html file it creates.',
      });
      continue;
    }
    const recorded = savedFromAddress(html);
    pages.push({ key: `${file.name}-${file.lastModified}-${file.size}`, fileName: file.name, html, url: recorded ?? '', recorded: Boolean(recorded) }); // prettier-ignore
  }
  return pages;
}

/** Choose one or more saved pages; shows what each page's address says (search, view, results offset). */
function SavedPagesPicker({
  pages,
  onChange,
}: {
  pages: SavedPage[];
  onChange: (pages: SavedPage[]) => void;
}) {
  return (
    <div className="grid gap-2">
      <input
        type="file"
        multiple
        accept=".html,.htm,.mhtml,.mht,text/html"
        className="block w-full text-sm file:mr-3 file:rounded-md file:border file:border-border file:bg-muted file:px-3 file:py-1.5 file:text-sm"
        onChange={(e) => {
          const files = e.target.files;
          if (files?.length) void readSavedPages(files).then((read) => onChange([...pages, ...read].slice(0, GOOGLE_CAPTURE_MAX_PAGES))); // prettier-ignore
          e.target.value = '';
        }}
      />
      {pages.map((p, i) => {
        const check = p.url.trim() ? parseGoogleSearchUrl(p.url) : null;
        return (
          <div key={p.key} className="grid gap-1.5 rounded-md border border-border p-2.5">
            <div className="flex items-center justify-between gap-2">
              <p className="truncate text-sm font-medium">{p.fileName}</p>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={`Remove ${p.fileName}`}
                onClick={() => onChange(pages.filter((_, j) => j !== i))}
              >
                <X />
              </Button>
            </div>
            {p.recorded ? null : (
              <Input
                value={p.url}
                onChange={(e) => onChange(pages.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)))}
                placeholder="Address not recorded in the file — paste it to place this page in the order (optional)"
                aria-invalid={check ? !check.ok : undefined}
              />
            )}
            <p className="text-xs text-muted-foreground">
              {check && !check.ok
                ? check.reason
                : check?.ok
                  ? `“${check.info.query}” · ${check.info.surface === 'maps' ? 'Google Maps list' : check.info.surface === 'places' ? 'Places results' : 'main results'} · results from #${check.info.start + 1}${p.recorded ? ' (address recorded in the file)' : ''}`
                  : 'No address: its listings keep page-local positions.'}
            </p>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Starts an automatic collection: the tracked query's keyword and location, collected from a configured source in
 * batches until the target or the end of the source. Shows what the chosen source's order means before it starts.
 */
function AutoCollectionDialog({
  open,
  onOpenChange,
  projectId,
  query,
  sources,
  onStarted,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  projectId: string;
  query: LocalRankQueryDto;
  sources: LocalBatchSourceDto[];
  onStarted: (scanId: string) => void;
}) {
  const usable = sources.filter((s) => s.configured);
  const [source, setSource] = useState<LocalRankSource | ''>(usable[0]?.key ?? '');
  const chosen = sources.find((s) => s.key === source) ?? null;
  const [target, setTarget] = useState(String(GOOGLE_CAPTURE_DEFAULT_TARGET));
  const [batchSize, setBatchSize] = useState(String(COLLECTION_MAX_BATCH_SIZE));
  const [delay, setDelay] = useState(String(COLLECTION_DEFAULT_DELAY_MS / 1000));
  const t = Number(target);
  const b = Number(batchSize);
  const d = Math.round(Number(delay) * 1000);
  const minDelay = Math.max(COLLECTION_MIN_DELAY_MS, chosen?.minDelayMs ?? 0);
  const validTarget = Number.isInteger(t) && t >= 1 && t <= GOOGLE_CAPTURE_MAX_TARGET;
  const validBatch =
    Number.isInteger(b) && b >= 1 && b <= (chosen?.maxBatchSize ?? COLLECTION_MAX_BATCH_SIZE);
  const validDelay = Number.isFinite(d) && d >= minDelay && d <= COLLECTION_MAX_DELAY_MS;
  const start = useMutation({
    mutationFn: () =>
      api.post<{ scanId: string; jobId: string }>(
        `/projects/${projectId}/local/queries/${query.id}/collections`,
        {
          source,
          target: t,
          batchSize: b,
          delayMs: d,
        },
      ),
    onSuccess: (r) => {
      toast.success('Collection started', { description: 'Batches are collected in the background; progress updates here.' }); // prettier-ignore
      onStarted(r.scanId);
      onOpenChange(false);
    },
    onError: (e) => toast.error('Could not start the collection', { description: errorMessage(e) }),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader
          title="Automatic collection"
          description={`Collects “${query.query}” at this location batch by batch, until the target is reached or the source has no more results. Each batch is saved as it arrives.`}
        />
        {!usable.length ? (
          <Alert tone="warning" title="No automatic source is configured">
            OpenStreetMap: set SERP_PROVIDER=osm (real businesses, but discovery by distance — not a Google
            ranking). Your own authorized collection service: set SERP_PROVIDER=custom and CUSTOM_SERP_URL; it
            must answer
            {' { limit, cursor } '}with{' { results, nextCursor } '}(see .env.example).
          </Alert>
        ) : null}
        <Field label="Source">
          <NativeSelect value={source} onChange={(e) => setSource(e.target.value as LocalRankSource)}>
            {sources.map((s) => (
              <option key={s.key} value={s.key} disabled={!s.configured}>
                {s.label}
                {s.configured ? '' : ' (not configured)'}
              </option>
            ))}
          </NativeSelect>
        </Field>
        {chosen ? (
          <div className="grid gap-2">
            {!chosen.googleRanking ? (
              <Alert tone="warning" title="Not a Google ranking">
                {chosen.observationType === 'discovery_order'
                  ? `${chosen.label} returns real businesses in discovery order, not the order Google shows. They are labelled that way everywhere.`
                  : `${chosen.label} declares what its order means; OptiReach shows that declaration and does not verify that it is a Google ranking.`}
              </Alert>
            ) : null}
            <p className="text-xs text-muted-foreground">{chosen.pagination}</p>
            <p className="text-xs text-muted-foreground">{chosen.detail}</p>
          </div>
        ) : null}
        <div className="grid gap-4 sm:grid-cols-3">
          <Field
            label="Unique businesses"
            description={`Stops at this many (1–${GOOGLE_CAPTURE_MAX_TARGET}).`}
          >
            <Input
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              inputMode="numeric"
              aria-invalid={!validTarget}
            />
          </Field>
          <Field
            label="Records per batch"
            description={`Up to ${chosen?.maxBatchSize ?? COLLECTION_MAX_BATCH_SIZE}.`}
          >
            <Input
              value={batchSize}
              onChange={(e) => setBatchSize(e.target.value)}
              inputMode="numeric"
              aria-invalid={!validBatch}
            />
          </Field>
          <Field
            label="Seconds between requests"
            description={`At least ${minDelay / 1000}s; the source’s limits always apply.`}
          >
            <Input
              value={delay}
              onChange={(e) => setDelay(e.target.value)}
              inputMode="decimal"
              aria-invalid={!validDelay}
            />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => start.mutate()}
            loading={start.isPending}
            disabled={!chosen?.configured || !validTarget || !validBatch || !validDelay}
          >
            <Play /> Start
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const MANUAL_STEP_NOTICE =
  'OptiReach cannot open Google pages for you: Google does not allow automated access to its search results. You open and save each page in your own browser; reading it, checking for duplicates, storing it and tracking progress are automatic.';

/**
 * Starts a multi-page collection from Google results pages the user saved in their own browser. OptiReach reads the
 * saved files; it never requests Google itself. Later pages are added from the collection panel on the scan.
 */
function GoogleCaptureDialog({
  open,
  onOpenChange,
  projectId,
  queryId,
  onCaptured,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  projectId: string;
  queryId: string;
  onCaptured: (scanId: string) => void;
}) {
  const [pages, setPages] = useState<SavedPage[]>([]);
  const [target, setTarget] = useState(String(GOOGLE_CAPTURE_DEFAULT_TARGET));
  const [result, setResult] = useState<GoogleCaptureResultDto | null>(null);
  const targetValue = Number(target);
  const validTarget =
    Number.isInteger(targetValue) && targetValue >= 1 && targetValue <= GOOGLE_CAPTURE_MAX_TARGET;
  const capture = useMutation({
    mutationFn: () =>
      api.post<GoogleCaptureResultDto>(`/projects/${projectId}/local/queries/${queryId}/google-capture`, {
        pages: pages.map((p) => ({ html: p.html, ...(p.url.trim() ? { url: p.url.trim() } : {}) })),
        target: targetValue,
      }),
    onSuccess: (r) => {
      if (r.scanId) {
        toast.success(`Collection started: ${r.progress?.uniqueBusinesses ?? 0} unique businesses so far`);
        onCaptured(r.scanId);
        onOpenChange(false);
      } else setResult(r);
    },
    onError: (e) => toast.error('Could not start the collection', { description: errorMessage(e) }),
  });
  const ready = pages.length > 0 && validTarget && pages.every((p) => !p.url.trim() || parseGoogleSearchUrl(p.url).ok); // prettier-ignore
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader
          title="Collect from Google results pages"
          description="Collects page after page until the target is reached or Google has no more results. The order is exactly what Google showed you."
        />
        <Alert tone="info" title="Each page is saved by you">
          {MANUAL_STEP_NOTICE}
        </Alert>
        <p className="text-[13px] font-medium">One file for the whole list (Google Maps)</p>
        <ol className="list-decimal space-y-0.5 pl-5 text-[13px] text-muted-foreground">
          <li>Search on google.com/maps in your browser (for example “jewellery shop in Surat”).</li>
          <li>
            Scroll the results list on the left until it says “You’ve reached the end of the list” (often
            about 120 businesses).
          </li>
          <li>Press Ctrl+S (⌘S on Mac), save as “Webpage, Complete”, and choose the file here.</li>
        </ol>
        <p className="text-[13px] text-muted-foreground">
          Google Search results also work (search, click “More places”, save): they hold 20 businesses per
          page, and next pages are added from the collection, which shows the link to open.
        </p>
        {result ? (
          <Alert tone="warning" title={COLLECTION_STATUS[result.collectionStatus].label}>
            {result.batches
              .map((b) => b.error)
              .filter(Boolean)
              .join(' ') || 'No local listings were found in these pages.'}
          </Alert>
        ) : null}
        <Field
          label="Unique businesses to collect"
          description={`Stops when this many are collected (1–${GOOGLE_CAPTURE_MAX_TARGET}).`}
        >
          <Input
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            inputMode="numeric"
            aria-invalid={!validTarget}
            className="w-32"
          />
        </Field>
        <Field label="Saved page(s)">
          <SavedPagesPicker pages={pages} onChange={setPages} />
        </Field>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => capture.mutate()} loading={capture.isPending} disabled={!ready}>
            Start collection
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Progress of a multi-page collection, with the next manual step and resumption. */
function GoogleCaptureCollectionPanel({
  projectId,
  scan,
  onChanged,
}: {
  projectId: string;
  scan: LocalRankScanDto;
  onChanged: () => void;
}) {
  const canManage = useCan('local.manage');
  const p = scan.captureProgress!;
  const batches = scan.captureBatches ?? [];
  const [pages, setPages] = useState<SavedPage[]>([]);
  const open = p.state === 'IN_PROGRESS';
  const automatic = p.automatic;
  const unit = automatic ? 'Batch' : 'Page';
  const control = useMutation({
    mutationFn: (action: CollectionAction) =>
      api.post(`/projects/${projectId}/local/scans/${scan.id}/collection/${action}`),
    onSuccess: (_d, action) => {
      toast.success(
        { pause: 'Paused — the batch in progress is kept', resume: 'Resumed from the next batch', retry: 'Retrying from where it stopped', cancel: 'Cancelled — everything collected is kept' }[action], // prettier-ignore
      );
      onChanged();
    },
    onError: (e) => toast.error('Could not change the collection', { description: errorMessage(e) }),
  });
  const pct = Math.min(100, Math.round((p.uniqueBusinesses / Math.max(1, p.target)) * 100));
  const add = useMutation({
    mutationFn: () =>
      api.post<GoogleCaptureResultDto>(`/projects/${projectId}/local/scans/${scan.id}/google-capture/pages`, {
        pages: pages.map((x) => ({ html: x.html, ...(x.url.trim() ? { url: x.url.trim() } : {}) })),
      }),
    onSuccess: (r) => {
      setPages([]);
      const added = r.batches.reduce((s, b) => s + b.newListings, 0);
      const dupes = r.batches.reduce((s, b) => s + b.duplicates, 0);
      toast.success(
        `${added} new listing${added === 1 ? '' : 's'} added${dupes ? `, ${dupes} already collected` : ''}`,
        {
          description: r.progress ? `${r.progress.uniqueBusinesses} of ${r.progress.target} unique businesses · ${CAPTURE_STATE[r.progress.state].label}` : undefined, // prettier-ignore
        },
      );
      onChanged();
    },
    onError: (e) => toast.error('Could not add the page', { description: errorMessage(e) }),
  });
  const finish = useMutation({
    mutationFn: () => api.post(`/projects/${projectId}/local/scans/${scan.id}/google-capture/finish`),
    onSuccess: onChanged,
    onError: (e) => toast.error('Could not finish the collection', { description: errorMessage(e) }),
  });
  const stat = (label: string, value: number) => (
    <div className="rounded-md border border-border px-3 py-2">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-lg font-semibold tabular-nums">{formatNumber(value)}</p>
    </div>
  );
  return (
    <div className="grid gap-3 rounded-lg border border-border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={CAPTURE_STATE[p.state].tone}>{stateLabel(p.state, automatic)}</Badge>
          <span className="text-sm">
            <span className="font-semibold tabular-nums">{formatNumber(p.uniqueBusinesses)}</span> of{' '}
            {formatNumber(p.target)} unique businesses
          </span>
        </div>
        {automatic && canManage ? (
          <div className="flex flex-wrap gap-2">
            {p.state === 'IN_PROGRESS' ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => control.mutate('pause')}
                loading={control.isPending && control.variables === 'pause'}
              >
                Pause
              </Button>
            ) : null}
            {p.state === 'PAUSED' ? (
              <Button
                size="sm"
                onClick={() => control.mutate('resume')}
                loading={control.isPending && control.variables === 'resume'}
              >
                Resume
              </Button>
            ) : null}
            {p.state === 'FAILED' ? (
              <Button
                size="sm"
                onClick={() => control.mutate('retry')}
                loading={control.isPending && control.variables === 'retry'}
              >
                Retry
              </Button>
            ) : null}
            {p.state === 'IN_PROGRESS' || p.state === 'PAUSED' || p.state === 'FAILED' ? (
              <ConfirmDialog
                title="Cancel this collection?"
                description="Everything collected so far is kept; the collection cannot be resumed afterwards."
                confirmLabel="Cancel collection"
                destructive
                onConfirm={() => control.mutateAsync('cancel')}
                trigger={
                  <Button size="sm" variant="ghost">
                    Cancel
                  </Button>
                }
              />
            ) : null}
          </div>
        ) : null}
        {!automatic && open && canManage ? (
          <ConfirmDialog
            title="Finish this collection?"
            description="Everything collected so far is kept; no more pages can be added."
            confirmLabel="Finish"
            onConfirm={() => finish.mutateAsync()}
            trigger={
              <Button size="sm" variant="outline">
                Finish collection
              </Button>
            }
          />
        ) : null}
      </div>
      <div
        className="h-2 w-full overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Unique businesses collected of the target"
      >
        <div className="h-full bg-primary" style={{ width: `${pct}%` }} />
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>
          Source: <span className="font-medium text-foreground">{p.sourceLabel}</span>
        </span>
        <span>· {LOCAL_OBSERVATION_TYPE_LABELS[p.observationType]}</span>
        {p.observationType !== 'observed_search_position' ? (
          <Badge tone="warning">Not a Google ranking</Badge>
        ) : null}
        {automatic && p.batchSize ? (
          <span>
            · batches of up to {p.batchSize}, at least {Math.round((p.delayMs ?? 0) / 100) / 10}s apart
          </span>
        ) : null}
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        {stat(`${unit === 'Page' ? 'Pages' : 'Batches'} processed`, p.pagesProcessed)}
        {stat('Listings read', p.listingsExtracted)}
        {stat('Unique businesses', p.uniqueBusinesses)}
        {stat('Duplicates skipped', p.duplicatesSkipped)}
        {stat(`Failed ${unit === 'Page' ? 'pages' : 'batches'}`, p.pagesFailed)}
        {stat(`Repeated ${unit === 'Page' ? 'pages' : 'batches'}`, p.pagesRepeated)}
      </div>
      {p.reason ? <p className="text-[13px] text-muted-foreground">{p.reason}</p> : null}
      {!automatic && open && canManage ? (
        <div className="grid gap-2 rounded-md bg-muted/40 p-3">
          <p className="text-sm font-medium">Next step — needs you</p>
          <p className="text-[13px] text-muted-foreground">{MANUAL_STEP_NOTICE}</p>
          {p.nextUrl ? (
            <div>
              <Button asChild size="sm">
                <a href={p.nextUrl} target="_blank" rel="noreferrer noopener">
                  Open the next page on Google <ExternalLink />
                </a>
              </Button>
              <p className="mt-1 text-xs text-muted-foreground">
                Then press Ctrl+S, save it, and add the file below.
              </p>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              The last saved page carried no next-page link for this search. Open “More places” on Google, or
              click “Next” there, save that page and add it. For a Google Maps list, scroll it to its end and
              save it again.
            </p>
          )}
          <SavedPagesPicker pages={pages} onChange={setPages} />
          <div>
            <Button
              size="sm"
              onClick={() => add.mutate()}
              loading={add.isPending}
              disabled={!pages.length || pages.some((x) => x.url.trim() && !parseGoogleSearchUrl(x.url).ok)}
            >
              <Upload /> Add {pages.length > 1 ? `${pages.length} pages` : 'page'}
            </Button>
          </div>
        </div>
      ) : null}
      {batches.length ? (
        <Table>
          <THead>
            <TR>
              <TH>{unit}</TH>
              <TH>Positions</TH>
              <TH className="text-right">Read</TH>
              <TH className="text-right">New</TH>
              <TH className="text-right">Duplicates</TH>
              <TH>Outcome</TH>
            </TR>
          </THead>
          <TBody>
            {batches.map((b) => (
              <TR key={b.batch}>
                <TD>
                  {b.url ? (
                    <a href={b.url} target="_blank" rel="noreferrer noopener" className="hover:underline">
                      {b.batch}
                    </a>
                  ) : (
                    b.batch
                  )}
                </TD>
                <TD className="text-xs">
                  {b.status !== 'parsed'
                    ? '—'
                    : !b.listings
                      ? '—'
                      : b.offsetKnown
                        ? `#${b.start + 1}–#${b.start + b.listings}`
                        : `${unit.toLowerCase()}-local (offset unknown)`}
                </TD>
                <TD className="text-right tabular-nums">{b.listings}</TD>
                <TD className="text-right tabular-nums">{b.newListings}</TD>
                <TD className="text-right tabular-nums">{b.duplicates}</TD>
                <TD className="text-xs">
                  {b.status === 'parsed'
                    ? 'Read'
                    : b.status === 'repeated'
                      ? `Repeated ${unit.toLowerCase()}`
                      : b.status === 'failed'
                        ? 'Failed'
                        : 'No listings'}
                  {b.error ? <span className="block text-muted-foreground">{b.error}</span> : null}
                  {b.notes.length ? (
                    <span className="block text-muted-foreground">{b.notes.join(' ')}</span>
                  ) : null}
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      ) : null}
      {p.notes.length ? (
        <ul className="space-y-0.5 text-xs text-muted-foreground">
          {p.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** Paste or upload a CSV of observations (one row per business at a grid point); the file's order is kept. */
function ImportCsvDialog({
  open,
  onOpenChange,
  gridSize,
  pending,
  onImport,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  gridSize: number;
  pending: boolean;
  onImport: (csv: string) => void;
}) {
  const [csv, setCsv] = useState('');
  const example = `row,col,business,rank,is_tracked_business,rating,review_count,domain\n0,0,Example Jewellers,1,no,4.8,1200,example.com\n0,0,Your Business,2,yes,4.6,210,`;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader
          title="Import observations from a CSV"
          description={`One row per business listed at a grid point. The order is kept as given (by the rank column when present). Grid points run 0–${gridSize - 1} for this ${gridSize}×${gridSize} grid.`}
        />
        <Field
          label="CSV file"
          description="Columns: row, col, business (required); rank, is_tracked_business, rating, review_count, domain, observed_at (optional)."
        >
          <input
            type="file"
            accept=".csv,text/csv"
            className="block w-full text-sm file:mr-3 file:rounded-md file:border file:border-border file:bg-muted file:px-3 file:py-1.5 file:text-sm"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void file.text().then(setCsv);
            }}
          />
        </Field>
        <Field label="Or paste CSV">
          <Textarea
            value={csv}
            onChange={(e) => setCsv(e.target.value)}
            rows={8}
            placeholder={example}
            className="font-mono text-xs"
          />
        </Field>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => onImport(csv)} loading={pending} disabled={csv.trim().length < 5}>
            Import
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function QueryPanel({ query, status }: { query: LocalRankQueryDto; status: LocalStatus | undefined }) {
  const project = useProject();
  const queryClient = useQueryClient();
  const canManage = useCan('local.manage');
  const [scanId, setScanId] = useState<string | null>(query.latestScan?.id ?? null);
  const [selected, setSelected] = useState<{ row: number; col: number } | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [captureOpen, setCaptureOpen] = useState(false);
  const [autoOpen, setAutoOpen] = useState(false);
  useEffect(() => setScanId(query.latestScan?.id ?? null), [query.id, query.latestScan?.id]);
  const history = useQuery({
    queryKey: ['local-scans', project.id, query.id],
    queryFn: () =>
      api.get<LocalRankScanSummaryDto[]>(`/projects/${project.id}/local/queries/${query.id}/scans`),
  });
  const scan = useQuery({
    queryKey: ['local-scan', project.id, scanId],
    queryFn: () => api.get<LocalRankScanDto>(`/projects/${project.id}/local/scans/${scanId}`),
    enabled: Boolean(scanId),
    // Poll while results are still arriving: a queued scan, a running live scan, or an automatic collection that is
    // collecting (not one that is paused, stopped, or waiting for a saved page).
    refetchInterval: (q) => {
      const d = q.state.data;
      if (!d) return false;
      if (d.captureProgress)
        return d.captureProgress.automatic && d.captureProgress.state === 'IN_PROGRESS' ? 3000 : false;
      return d.status === 'QUEUED' || (d.status === 'RUNNING' && d.source !== 'MANUAL') ? 3000 : false;
    },
  });
  const refresh = () => {
    for (const key of [
      ['local-scan', project.id],
      ['local-scans', project.id],
      ['local-queries', project.id],
      ['local-comparison', project.id],
    ])
      // prettier-ignore
      void queryClient.invalidateQueries({ queryKey: key });
  };
  const start = useMutation({
    mutationFn: (source: LocalRankSource) => api.post<{ scanId: string }>(`/projects/${project.id}/local/queries/${query.id}/scans`, { source }), // prettier-ignore
    onSuccess: (r) => {
      setScanId(r.scanId);
      refresh();
    },
    onError: (e) => toast.error('Could not start the scan', { description: errorMessage(e) }),
  });
  const finish = useMutation({
    mutationFn: () => api.post(`/projects/${project.id}/local/scans/${scanId}/finish`),
    onSuccess: () => {
      toast.success('Manual scan finished');
      refresh();
    },
    onError: (e) => toast.error('Could not finish the scan', { description: errorMessage(e) }),
  });
  const importCsv = useMutation({
    mutationFn: (csv: string) =>
      api.post<LocalImportResultDto>(`/projects/${project.id}/local/queries/${query.id}/import`, { csv }),
    onSuccess: (r) => {
      setScanId(r.scanId);
      setImportOpen(false);
      toast.success(`Imported ${r.pointsImported} grid point${r.pointsImported === 1 ? '' : 's'}`, {
        description: r.errors.length
          ? `${r.rowsParsed} rows read · ${r.errors.length} skipped`
          : `${r.rowsParsed} rows read`,
      });
      refresh();
    },
    onError: (e) => toast.error('Could not import the file', { description: errorMessage(e) }),
  });
  const remove = async () => {
    await api.delete(`/projects/${project.id}/local/queries/${query.id}`);
    await queryClient.invalidateQueries({ queryKey: ['local-queries', project.id] });
  };
  const s = scan.data;
  const point =
    s && selected ? s.points.find((p) => p.row === selected.row && p.col === selected.col) : undefined;
  const liveSources = (status?.sources ?? []).filter(
    (x) => x.live && x.available && (x.surfaces ?? []).includes(query.surface),
  );
  const trend = useMemo(
    () =>
      [...(history.data ?? [])]
        .filter((h) => h.status === 'SUCCEEDED')
        .reverse()
        .map((h) => ({
          date: h.createdAt.slice(0, 10),
          top3: h.summary.top3Share,
          top10: h.summary.top10Share,
        })),
    [history.data],
  );
  return (
    <div className="grid gap-5">
      <Card>
        <CardHeaderRow
          title={`“${query.query}”`}
          description={`${LOCAL_SURFACE_LABELS[query.surface]} · ${query.gridSize}×${query.gridSize} grid, ${query.spacingKm} km apart · top ${query.depth} checked · ${query.device} · ${FREQUENCY_LABELS[query.frequency]}`}
          actions={
            canManage ? (
              <div className="flex flex-wrap gap-2">
                {liveSources.map((src) => (
                  <Button
                    key={src.key}
                    size="sm"
                    onClick={() => start.mutate(src.key)}
                    loading={start.isPending && start.variables === src.key}
                  >
                    <Play /> Scan now
                    {liveSources.length > 1
                      ? ` (${src.key === 'FIXTURE' ? 'fixture' : src.key === 'GOOGLE_CSE' ? 'Google organic' : 'provider'})`
                      : ''}
                  </Button>
                ))}
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => start.mutate('MANUAL')}
                  loading={start.isPending && start.variables === 'MANUAL'}
                >
                  <Plus /> Record manually
                </Button>
                <Button size="sm" onClick={() => setAutoOpen(true)}>
                  <Play /> Automatic collection
                </Button>
                <Button size="sm" variant="outline" onClick={() => setCaptureOpen(true)}>
                  <FileSearch /> Collect from Google pages
                </Button>
                <Button size="sm" variant="outline" onClick={() => setImportOpen(true)}>
                  <Upload /> Import CSV
                </Button>
                <ConfirmDialog
                  title={`Stop tracking “${query.query}”?`}
                  description="Its scans and history are deleted."
                  confirmLabel="Delete"
                  destructive
                  onConfirm={() => remove().catch((e: unknown) => toast.error(errorMessage(e)))}
                  trigger={
                    <Button size="icon-sm" variant="ghost" aria-label={`Delete ${query.query}`}>
                      <Trash2 />
                    </Button>
                  }
                />
                <ImportCsvDialog
                  open={importOpen}
                  onOpenChange={setImportOpen}
                  gridSize={query.gridSize}
                  pending={importCsv.isPending}
                  onImport={(csv) => importCsv.mutate(csv)}
                />
                {autoOpen ? (
                  <AutoCollectionDialog
                    open
                    onOpenChange={setAutoOpen}
                    projectId={project.id}
                    query={query}
                    sources={status?.batchSources ?? []}
                    onStarted={(id) => {
                      setScanId(id);
                      refresh();
                    }}
                  />
                ) : null}
                {captureOpen ? (
                  <GoogleCaptureDialog
                    open
                    onOpenChange={setCaptureOpen}
                    projectId={project.id}
                    queryId={query.id}
                    onCaptured={(id) => {
                      setScanId(id);
                      refresh();
                    }}
                  />
                ) : null}
              </div>
            ) : undefined
          }
        />
        <CardContent className="grid gap-4">
          {!liveSources.length ? (
            <Alert tone="info" title="No live rank source is connected">
              Google offers no API for Maps rankings. You can record what you see manually (labeled as
              manual), or an administrator can enable a licensed provider. {/* prettier-ignore */}
            </Alert>
          ) : null}
          {scan.isLoading ? <LoadingBlock rows={4} /> : null}
          {scan.error ? <ErrorState error={scan.error} onRetry={() => void scan.refetch()} /> : null}
          {s ? (
            <>
              {!s.captureProgress &&
              (s.status === 'QUEUED' || (s.status === 'RUNNING' && s.source !== 'MANUAL')) &&
              s.jobId ? (
                <JobProgress jobId={s.jobId} label="Checking grid points" onFinished={refresh} />
              ) : null}
              {s.status === 'FAILED' ? (
                <Alert tone="danger" title="This scan failed">
                  {s.errorMessage ?? 'No point could be measured.'}
                </Alert>
              ) : null}
              <div className="flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground">
                <Badge tone={s.source === 'FIXTURE' ? 'demo' : s.source === 'MANUAL' ? 'info' : 'neutral'}>
                  {LOCAL_RANK_SOURCE_LABELS[s.source]}
                </Badge>
                <Badge tone={COLLECTION_STATUS[s.collectionStatus].tone}>
                  {COLLECTION_STATUS[s.collectionStatus].label}
                </Badge>
                <span>{formatDateTime(s.finishedAt ?? s.createdAt)}</span>
                {(s.captureProgress ? [] : (s.captureBatches ?? [])).map((b) => (
                  <a
                    key={b.batch}
                    href={b.url ?? undefined}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="inline-flex items-center gap-1 hover:text-foreground"
                    title={b.error ?? `${b.listings} listings from #${b.start + 1}`}
                  >
                    Page {b.batch}
                    {b.status === 'parsed'
                      ? ''
                      : ` (${b.status === 'failed' ? 'failed' : 'no listings'})`}{' '}
                    <ExternalLink className="size-3" />
                  </a>
                ))}
                {s.status === 'SUCCEEDED' ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      void api
                        .download(`/projects/${project.id}/local/scans/${s.id}/export`, undefined, 'grid.csv')
                        .catch((e: unknown) => toast.error(errorMessage(e)))
                    }
                  >
                    {' '}
                    {/* prettier-ignore */}
                    <Download /> Export CSV
                  </Button>
                ) : null}
                {s.source === 'MANUAL' && s.status === 'RUNNING' && canManage ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => finish.mutate()}
                    loading={finish.isPending}
                  >
                    Finish manual scan
                  </Button>
                ) : null}
              </div>
              {s.captureProgress ? (
                <GoogleCaptureCollectionPanel projectId={project.id} scan={s} onChanged={refresh} />
              ) : null}
              {s.gridSize === 1 ? <ScanListings projectId={project.id} scan={s} /> : null}
              <dl className="grid gap-3 sm:grid-cols-4">
                {[
                  [
                    'Top-3 visibility',
                    pct(s.summary.top3Share),
                    'Measured points where you rank 1–3 ÷ measured points. Failed points are left out.',
                  ],
                  [
                    'Top-10 visibility',
                    pct(s.summary.top10Share),
                    'Measured points where you rank 1–10 ÷ measured points.',
                  ],
                  [
                    'Average rank where found',
                    s.summary.averageRankFound ?? '—',
                    'Over the points where your business was listed.',
                  ],
                  [
                    'Coverage',
                    `${s.summary.pointsMeasured}/${s.summary.pointsPlanned} points`,
                    `${s.summary.pointsFailed} failed; unmeasured points are excluded from every figure.`,
                  ],
                ].map(([label, value, help]) => (
                  <div key={String(label)} className="rounded-lg border border-border p-3">
                    <dt className="text-xs text-muted-foreground">{label}</dt>
                    <dd className="text-xl font-semibold tabular-nums">{value}</dd>
                    <dd className="mt-1 text-xs text-muted-foreground">{help}</dd>
                  </div>
                ))}
              </dl>
              <div className="grid gap-4 lg:grid-cols-[3fr_2fr]">
                <div className="grid gap-2">
                  <Suspense fallback={<LoadingBlock rows={6} />}>
                    <RankMap
                      points={s.points}
                      selected={selected}
                      onSelect={(p) => setSelected({ row: p.row, col: p.col })}
                    />
                  </Suspense>
                  <ul className="flex flex-wrap gap-3 text-xs" aria-label="Legend">
                    {Object.values(BAND_STYLE).map((b) => (
                      <li key={b.label} className="flex items-center gap-1.5">
                        <span className="size-3 rounded-full" style={{ background: b.bg }} aria-hidden />{' '}
                        {b.label}
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="grid content-start gap-3">
                  <div className="overflow-x-auto">
                    <table className="text-xs" aria-label="Grid points (table view)">
                      <tbody>
                        {Array.from({ length: s.gridSize }, (_, row) => (
                          <tr key={row}>
                            {Array.from({ length: s.gridSize }, (_, col) => {
                              const p = s.points.find((x) => x.row === row && x.col === col)!;
                              const b = BAND_STYLE[rankBand(p)];
                              const sel = selected?.row === row && selected?.col === col;
                              return (
                                <td key={col} className="p-0.5">
                                  <button
                                    type="button"
                                    onClick={() => setSelected({ row, col })}
                                    className={cn(
                                      'size-8 rounded-md font-semibold',
                                      sel && 'ring-2 ring-foreground',
                                    )}
                                    style={{ background: b.bg, color: b.fg }}
                                    aria-label={`Point ${row + 1}-${col + 1}: ${p.status === 'FOUND' ? `rank ${p.rank}` : b.label}`}
                                  >
                                    {markerText(p)}
                                  </button>
                                </td>
                              );
                            })}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {point ? (
                    <PointDetail scan={s} point={point} canManage={canManage} onSaved={refresh} />
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      Select a point to see who is listed there.
                    </p>
                  )}
                </div>
              </div>
              {s.limitations.length ? (
                <ul className="list-disc space-y-1 pl-5 text-[13px] text-muted-foreground">
                  {s.limitations.map((l) => (
                    <li key={l}>{l}</li>
                  ))}
                </ul>
              ) : null}
            </>
          ) : !scan.isLoading ? (
            <p className="text-sm text-muted-foreground">
              No scan yet. Scan now, or record what you see manually.
            </p>
          ) : null}
        </CardContent>
      </Card>
      {trend.length > 1 ? (
        <Card>
          <CardContent className="pt-5">
            <ChartFrame
              title="Grid visibility over time"
              description="Share of measured points in the top 3 and top 10, per finished scan."
              legend={[{ label: 'Top 3', color: SERIES[0], kind: 'line' }, { label: 'Top 10', color: SERIES[1], kind: 'line' }]} // prettier-ignore
              table={{
                columns: ['Scan', 'Top 3 %', 'Top 10 %'],
                rows: trend.map((t) => [t.date, t.top3 ?? '—', t.top10 ?? '—']),
              }}
            >
              <LineTrend
                data={trend}
                xKey="date"
                series={[
                  { key: 'top3', label: 'Top 3', color: SERIES[0] },
                  { key: 'top10', label: 'Top 10', color: SERIES[1] },
                ]}
                formatY={(v) => `${Math.round(v)}%`}
                domain={[0, 100]}
                formatX={(v) => formatDate(v, { month: 'short', day: 'numeric' })}
              />{' '}
              {/* prettier-ignore */}
            </ChartFrame>
          </CardContent>
        </Card>
      ) : null}
      {history.data && history.data.length > 1 ? (
        <Card>
          <CardHeaderRow title="Scan history" />
          <CardContent>
            <ul className="grid gap-1">
              {history.data.map((h) => (
                <li key={h.id}>
                  <button
                    type="button"
                    onClick={() => setScanId(h.id)}
                    className={cn(
                      'flex w-full flex-wrap justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted',
                      scanId === h.id && 'bg-muted',
                    )}
                  >
                    <span>
                      {formatDateTime(h.createdAt)} · {LOCAL_RANK_SOURCE_LABELS[h.source]}
                    </span>
                    <span className="tabular-nums text-muted-foreground">
                      {h.status === 'SUCCEEDED'
                        ? `top 3 at ${pct(h.summary.top3Share)} · ${h.summary.pointsMeasured}/${h.summary.pointsPlanned} points`
                        : h.status.toLowerCase()}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}
      <Comparison queryId={query.id} />
    </div>
  );
}

export default function RankTrackerPage() {
  const project = useProject();
  const canManage = useCan('local.manage');
  const [locationId, setLocationId] = useState('');
  const [selectedQuery, setSelectedQuery] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const status = useQuery({ queryKey: ['local-status', project.id], queryFn: () => api.get<LocalStatus>(`/projects/${project.id}/local/status`) }); // prettier-ignore
  const locations = useQuery({ queryKey: ['locations', project.id], queryFn: () => api.get<LocationDto[]>(`/projects/${project.id}/locations`) }); // prettier-ignore
  const location = locations.data?.find((l) => l.id === locationId) ?? locations.data?.[0] ?? null;
  const queries = useQuery({
    queryKey: ['local-queries', project.id, location?.id],
    queryFn: () =>
      api.get<LocalRankQueryDto[]>(`/projects/${project.id}/local/queries`, { locationId: location!.id }),
    enabled: Boolean(location),
  });
  const current = queries.data?.find((q) => q.id === selectedQuery) ?? queries.data?.[0] ?? null;
  const usage = status.data?.usage.localRankPoints;
  return (
    <>
      <PageHeader
        title="Local Rank Tracker"
        description="Where your business appears on Google Maps for a search, point by point around each location."
        actions={
          locations.data && locations.data.length > 1 ? (
            <NativeSelect
              aria-label="Location"
              value={location?.id ?? ''}
              onChange={(e) => setLocationId(e.target.value)}
              className="w-60"
            >
              {locations.data.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name} · {l.city}
                </option>
              ))}
            </NativeSelect>
          ) : undefined
        }
      />
      {locations.isLoading ? <LoadingBlock rows={4} /> : null}
      {locations.data && !locations.data.length ? (
        <EmptyState
          icon={MapPinned}
          title="Add a location first"
          description="Rank grids are centred on a business location."
          action={
            <Button asChild>
              <Link to={`/app/p/${project.id}/locations`}>Add a location</Link>
            </Button>
          }
        />
      ) : null}
      {location ? (
        <div className="grid gap-5 lg:grid-cols-[18rem_1fr]">
          <div className="grid content-start gap-3">
            <Card>
              <CardHeaderRow
                title="Tracked queries"
                actions={
                  canManage ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setAdding(true)}
                      disabled={location.latitude === null}
                      title={location.latitude === null ? 'Add the location’s coordinates first' : undefined}
                    >
                      {' '}
                      {/* prettier-ignore */}
                      <Plus /> Track
                    </Button>
                  ) : undefined
                }
              />
              <CardContent className="grid gap-1">
                {location.latitude === null ? (
                  <p className="text-[13px] text-muted-foreground">
                    Add this location’s coordinates (Locations page) to centre a grid on it.
                  </p>
                ) : null}
                {(queries.data ?? []).map((q) => (
                  <button
                    key={q.id}
                    type="button"
                    onClick={() => setSelectedQuery(q.id)}
                    className={cn(
                      'grid gap-0.5 rounded-md px-2 py-1.5 text-left hover:bg-muted',
                      current?.id === q.id && 'bg-muted',
                    )}
                  >
                    <span className="text-sm font-medium">{q.query}</span>
                    <span className="text-xs text-muted-foreground">
                      {q.surface === 'MAPS' ? 'Maps' : 'Local pack'} · {q.gridSize}×{q.gridSize} ·{' '}
                      {q.latestScan?.status === 'SUCCEEDED'
                        ? `top 3 at ${pct(q.latestScan.summary.top3Share)}`
                        : 'no finished scan'}
                    </span>
                  </button>
                ))}
                {queries.data && !queries.data.length ? (
                  <p className="text-sm text-muted-foreground">No queries tracked yet.</p>
                ) : null}
              </CardContent>
            </Card>
            {usage ? (
              <p className="text-xs text-muted-foreground">
                Licensed grid points this month: {formatNumber(usage.used)}
                {usage.limit !== null ? ` of ${formatNumber(usage.limit)}` : ''}. Manual observations use
                none.
              </p>
            ) : null}
            {status.data ? <p className="text-xs text-muted-foreground">{status.data.compliance}</p> : null}
          </div>
          {current ? <QueryPanel key={current.id} query={current} status={status.data} /> : null}
        </div>
      ) : null}
      {location ? (
        <div className="mt-5">
          <BusinessRankFinder projectId={project.id} />
        </div>
      ) : null}
      {location ? (
        <div className="mt-5">
          <CompetitorMap projectId={project.id} location={location} />
        </div>
      ) : null}
      {adding && location ? <TrackQueryDialog open onOpenChange={setAdding} location={location} /> : null}
    </>
  );
}
