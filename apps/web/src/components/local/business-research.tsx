// Business research on collected rankings: find a business in a search's listings (or across every collected search),
// see its position, and research it — how it compares with the listings above it (computed from what the results
// showed) and an action plan citing that comparison. Plans come from the chosen AI model; template plans from the
// development adapter are labelled as such.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Search, Sparkles } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  LOCAL_RANKING_PRACTICES,
  LOCAL_RANKING_SOURCES,
  RESEARCH_AREA_LABELS,
  observedPositions,
  type ListingMatchDto,
  type LocalRankScanDto,
  type LocalResearchDto,
  type LocalResearchSummaryDto,
  type ResearchAction,
  type ResearchFindingTone,
  type ResearchListing,
} from '@surfaced/shared';
import { Badge, type BadgeTone } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeaderRow } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader } from '@/components/ui/dialog';
import { Alert, LoadingBlock } from '@/components/ui/feedback';
import { Field, Input, NativeSelect } from '@/components/ui/form';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { api, errorMessage } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { formatDateTime, formatNumber } from '@/lib/format';
import type { LlmProviderStatusDto } from '@/lib/types';

const normalize = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
const matches = (title: string, q: string) => {
  const words = normalize(q).split(' ').filter(Boolean);
  const name = normalize(title);
  return words.every((w) => name.includes(w));
};

const TONE: Record<ResearchFindingTone, { tone: BadgeTone; label: string }> = {
  gap: { tone: 'warning', label: 'Gap' },
  strength: { tone: 'success', label: 'Strength' },
  info: { tone: 'neutral', label: 'Note' },
};
const PRIORITY: Record<ResearchAction['priority'], { tone: BadgeTone; label: string }> = {
  high: { tone: 'orange', label: 'High impact' },
  medium: { tone: 'info', label: 'Medium impact' },
  low: { tone: 'neutral', label: 'Lower impact' },
};
const EFFORT: Record<ResearchAction['effort'], string> = {
  low: 'Quick to do',
  medium: 'Some effort',
  high: 'Ongoing effort',
};

const researchListKey = (projectId: string, scanId: string) => ['local-research', projectId, scanId];

function placeText(
  l: Pick<ResearchListing, 'pageLocal' | 'position' | 'page' | 'organicPosition' | 'sponsored'>,
) {
  if (l.sponsored) return 'Ad';
  if (l.pageLocal) return `#${l.position} on page ${l.page}`;
  return `#${l.organicPosition ?? l.position}`;
}

// ---------------- Listings of one search ----------------

/** Every business in a one-point scan, searchable by name, each with its position and a research action. */
export function ScanListings({ projectId, scan }: { projectId: string; scan: LocalRankScanDto }) {
  const results = useMemo(() => scan.points.find((p) => p.row === 0 && p.col === 0)?.results ?? [], [scan.points]); // prettier-ignore
  const positions = useMemo(() => observedPositions(results), [results]);
  const [q, setQ] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [open, setOpen] = useState<{ index: number; title: string } | null>(null);
  const research = useQuery({
    queryKey: researchListKey(projectId, scan.id),
    queryFn: () =>
      api.get<LocalResearchSummaryDto[]>(`/projects/${projectId}/local/scans/${scan.id}/research`),
    enabled: results.length > 0,
  });
  const observed = (scan.observationType ?? 'observed_search_position') === 'observed_search_position';
  const researched = new Set((research.data ?? []).map((r) => r.resultIndex));
  if (!results.length) return null;
  const rows = results
    .map((r, i) => ({ r, i, at: positions[i]! }))
    .filter(({ r }) => !q.trim() || matches(r.title, q));
  const visible = showAll || q.trim() ? rows : rows.slice(0, 25);
  return (
    <div className="grid gap-3 rounded-lg border border-border p-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-sm font-medium">Businesses in this search</p>
          <p className="text-xs text-muted-foreground">
            {formatNumber(results.length)} listings in the order they were shown. Research compares a business
            with the listings ranked above it.
          </p>
        </div>
        <div className="relative w-full sm:w-64">
          <Search
            className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />{' '}
          {/* prettier-ignore */}
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Find a business by name"
            aria-label="Find a business by name"
            className="pl-8"
          />
        </div>
      </div>
      {!observed ? (
        <Alert tone="warning" title="Not a search ranking">
          This order is discovery order or an estimate, so there is no ranking to research.
        </Alert>
      ) : null}
      {rows.length ? (
        <div className="overflow-x-auto">
          <Table>
            <THead>
              <TR>
                <TH>Position</TH>
                <TH>Business</TH>
                <TH className="text-right">Rating</TH>
                <TH className="text-right">Reviews</TH>
                <TH>On the listing</TH>
                <TH />
              </TR>
            </THead>
            <TBody>
              {visible.map(({ r, i, at }) => (
                <TR key={i} className={cn(r.isTarget && 'bg-accent')}>
                  <TD className="whitespace-nowrap tabular-nums">
                    {placeText({ ...at, sponsored: Boolean(r.sponsored) })}
                  </TD>
                  <TD>
                    <span className="font-medium">{r.title}</span>
                    {r.sponsored ? (
                      <Badge tone="warning" className="ml-1.5 align-middle">
                        Sponsored
                      </Badge>
                    ) : null}
                    {r.isTarget ? (
                      <Badge tone="primary" className="ml-1.5 align-middle">
                        Your business
                      </Badge>
                    ) : null}
                    {r.category ? (
                      <span className="block text-xs text-muted-foreground">{r.category}</span>
                    ) : null}
                  </TD>
                  <TD className="text-right tabular-nums">{r.rating ?? '—'}</TD>
                  <TD className="text-right tabular-nums">
                    {r.reviewCount === null ? '—' : formatNumber(r.reviewCount)}
                  </TD>{' '}
                  {/* prettier-ignore */}
                  <TD className="text-xs text-muted-foreground">
                    {typeof r.phoneShown !== 'boolean'
                      ? '—'
                      : [
                          r.phoneShown ? 'Phone' : 'No phone',
                          r.hours ? 'Hours' : 'No hours',
                          r.serviceOptions?.length ? `${r.serviceOptions.length} service option${r.serviceOptions.length === 1 ? '' : 's'}` : null, // prettier-ignore
                          typeof r.websiteListed === 'boolean' ? (r.websiteListed ? 'Website' : 'No website') : null, // prettier-ignore
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                  </TD>
                  <TD className="text-right">
                    <Button
                      size="sm"
                      variant={researched.has(i) ? 'outline' : 'ghost'}
                      onClick={() => setOpen({ index: i, title: r.title })}
                      disabled={!observed}
                    >
                      <Sparkles /> {researched.has(i) ? 'View research' : 'Research'}
                    </Button>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">No business in this search matches “{q}”.</p>
      )}
      {!showAll && !q.trim() && rows.length > visible.length ? (
        <div>
          <Button size="sm" variant="outline" onClick={() => setShowAll(true)}>
            Show all {formatNumber(rows.length)}
          </Button>
        </div>
      ) : null}
      {open ? (
        <ResearchDialog
          projectId={projectId}
          scanId={scan.id}
          resultIndex={open.index}
          title={open.title}
          onOpenChange={(v) => !v && setOpen(null)}
        />
      ) : null}
    </div>
  );
}

// ---------------- Across collected searches ----------------

/** Find a business by name across the project's collected searches, with its position in each. */
export function BusinessRankFinder({ projectId }: { projectId: string }) {
  const [q, setQ] = useState('');
  const [term, setTerm] = useState('');
  const [open, setOpen] = useState<ListingMatchDto | null>(null);
  useEffect(() => {
    const t = setTimeout(() => setTerm(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);
  const found = useQuery({
    queryKey: ['local-listings', projectId, term],
    queryFn: () => api.get<ListingMatchDto[]>(`/projects/${projectId}/local/listings`, { q: term }),
    enabled: term.length >= 2,
  });
  return (
    <Card>
      <CardHeaderRow
        title="Find a business’s rank"
        description="Searches the latest collection of each search in this project. Positions are what the collected results showed, on the device and place they were viewed."
      />
      <CardContent className="grid gap-3">
        <div className="relative sm:max-w-sm">
          <Search
            className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />{' '}
          {/* prettier-ignore */}
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Business name, e.g. Zaver Jewellers"
            aria-label="Business name"
            className="pl-8"
          />
        </div>
        {found.isFetching && !found.data ? <LoadingBlock rows={2} /> : null}
        {found.error ? <p className="text-sm text-destructive">{errorMessage(found.error)}</p> : null}
        {term.length >= 2 && found.data ? (
          found.data.length ? (
            <div className="overflow-x-auto">
              <Table>
                <THead>
                  <TR>
                    <TH>Business</TH>
                    <TH>Search</TH>
                    <TH>Position</TH>
                    <TH className="text-right">Rating</TH>
                    <TH className="text-right">Reviews</TH>
                    <TH>Collected</TH>
                    <TH />
                  </TR>
                </THead>
                <TBody>
                  {found.data.map((m) => {
                    const observed = m.observationType === 'observed_search_position';
                    return (
                      <TR key={`${m.scanId}-${m.resultIndex}`}>
                        <TD>
                          <span className="font-medium">{m.title}</span>
                          {m.category ? (
                            <span className="block text-xs text-muted-foreground">{m.category}</span>
                          ) : null}{' '}
                          {/* prettier-ignore */}
                        </TD>
                        <TD className="text-[13px]">“{m.query}”</TD>
                        <TD className="whitespace-nowrap tabular-nums">
                          {m.sponsored
                            ? 'Ad'
                            : m.pageLocal
                              ? `#${m.position} on page ${m.page}`
                              : `#${m.position}`}
                          {!observed ? (
                            <span className="block text-xs text-muted-foreground">Not a Google ranking</span>
                          ) : null}
                        </TD>
                        <TD className="text-right tabular-nums">{m.rating ?? '—'}</TD>
                        <TD className="text-right tabular-nums">
                          {m.reviewCount === null ? '—' : formatNumber(m.reviewCount)}
                        </TD>{' '}
                        {/* prettier-ignore */}
                        <TD className="text-xs text-muted-foreground">{formatDateTime(m.capturedAt)}</TD>
                        <TD className="text-right">
                          <Button size="sm" variant="ghost" onClick={() => setOpen(m)} disabled={!observed}>
                            <Sparkles /> Research
                          </Button>
                        </TD>
                      </TR>
                    );
                  })}
                </TBody>
              </Table>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              No business named like “{term}” in the collected searches.
            </p>
          )
        ) : null}
      </CardContent>
      {open ? (
        <ResearchDialog
          projectId={projectId}
          scanId={open.scanId}
          resultIndex={open.resultIndex}
          title={open.title}
          onOpenChange={(v) => !v && setOpen(null)}
        />
      ) : null}
    </Card>
  );
}

// ---------------- Research ----------------

function ResearchDialog({
  projectId,
  scanId,
  resultIndex,
  title,
  onOpenChange,
}: {
  projectId: string;
  scanId: string;
  resultIndex: number;
  title: string;
  onOpenChange: (v: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const canManage = useCan('local.manage');
  const [ran, setRan] = useState<string | null>(null);
  const [provider, setProvider] = useState('');
  const list = useQuery({
    queryKey: researchListKey(projectId, scanId),
    queryFn: () =>
      api.get<LocalResearchSummaryDto[]>(`/projects/${projectId}/local/scans/${scanId}/research`),
  });
  const researchId = ran ?? list.data?.find((r) => r.resultIndex === resultIndex)?.id ?? null;
  const detail = useQuery({
    queryKey: ['local-research-item', projectId, researchId],
    queryFn: () => api.get<LocalResearchDto>(`/projects/${projectId}/local/research/${researchId}`),
    enabled: Boolean(researchId),
  });
  const providers = useQuery({
    queryKey: ['local-research-providers', projectId],
    queryFn: () => api.get<LlmProviderStatusDto[]>(`/projects/${projectId}/local/research-providers`),
  });
  const configured = (providers.data ?? []).filter((p) => p.configured);
  // Prefer a real AI model: the configured default if it is one, else the first configured model.
  const effective =
    provider ||
    configured.find((p) => p.isDefault && !p.isDevAdapter)?.key ||
    configured.find((p) => !p.isDevAdapter)?.key ||
    configured[0]?.key ||
    '';
  const run = useMutation({
    mutationFn: () =>
      api.post<LocalResearchDto>(`/projects/${projectId}/local/scans/${scanId}/research`, {
        resultIndex,
        ...(effective ? { provider: effective } : {}),
      }),
    onSuccess: (r) => {
      queryClient.setQueryData(['local-research-item', projectId, r.id], r);
      setRan(r.id);
      void queryClient.invalidateQueries({ queryKey: ['local-research', projectId] });
      toast.success('Research ready', {
        description: `${r.report.actions.length} actions for ${r.businessName}`,
      });
    },
    onError: (e) => toast.error('The research failed', { description: errorMessage(e) }),
  });
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent size="xl">
        <DialogHeader
          title={`Research: ${title}`}
          description="How this listing compares with the ones ranked above it for this search, and what to do about it — based only on what the collected results showed and on Google’s published guidance."
        />
        {canManage ? (
          <div className="flex flex-wrap items-end gap-2">
            <Field label="AI model" className="w-64">
              <NativeSelect value={effective} onChange={(e) => setProvider(e.target.value)}>
                {configured.map((p) => (
                  <option key={p.key} value={p.key}>
                    {p.isDevAdapter ? 'Template (development, not AI)' : (p.detail ?? p.label)}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Button onClick={() => run.mutate()} loading={run.isPending} disabled={!effective}>
              <Sparkles /> {detail.data ? 'Run again' : 'Run research'}
            </Button>
            <p className="w-full text-xs text-muted-foreground">
              Uses one AI generation from the workspace’s monthly allowance. Business names, ratings, reviews
              and addresses from the listings are sent to the chosen model.
            </p>
          </div>
        ) : null}
        {run.isPending ? (
          <div className="grid gap-2">
            <p className="text-sm text-muted-foreground">
              Comparing the listings and writing the plan… This can take up to two minutes, depending on the
              model.
            </p>
            <LoadingBlock rows={5} />
          </div>
        ) : detail.data ? (
          <ResearchReport research={detail.data} />
        ) : detail.isLoading || list.isLoading ? (
          <LoadingBlock rows={4} />
        ) : (
          <p className="text-sm text-muted-foreground">
            No research for this business yet.{canManage ? ' Choose a model and run it.' : ''}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}

const yesNo = (v: boolean | null) => (v === null ? '—' : v ? 'Yes' : 'No');
/** The profile's website as a host; research made before websites were captured has no value. */
const websiteText = (l: ResearchListing) => {
  if (typeof l.websiteListed !== 'boolean') return '—';
  if (!l.websiteListed || !l.website) return l.websiteListed ? 'Yes' : 'None';
  try {
    return new URL(l.website).hostname.replace(/^www\./, '');
  } catch {
    return 'Yes';
  }
};

/** A research report: the comparison, the plan, and what it is based on. */
export function ResearchReport({ research }: { research: LocalResearchDto }) {
  const { evidence: e, report } = research;
  const findings = new Map(e.findings.map((f) => [f.id, f]));
  const nearby = e.above.slice(0, 3);
  const rows = [
    e.target,
    ...nearby,
    ...e.leaders.filter((l) => !nearby.some((a) => a.index === l.index)),
  ].sort((a, b) => a.position - b.position);
  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground">
        <span className="text-base font-semibold text-foreground">
          {placeText(e.target)}
          {e.target.pageLocal ? '' : ` of ${e.field.organic}`}
        </span>
        <span>
          for “{e.query}”{e.location ? ` · ${e.location}` : ''}
        </span>
        <Badge tone={research.isDevAdapter ? 'demo' : 'info'}>
          {research.isDevAdapter ? 'Template — not AI' : `AI · ${research.model ?? research.provider}`}
        </Badge>
        <span>{formatDateTime(research.createdAt)}</span>
      </div>
      {research.isDevAdapter ? (
        <Alert tone="warning" title="Template plan">
          Built from fixed templates for the gaps found, not written by an AI model. Choose OpenAI or Gemini
          for an analysis of this business.
        </Alert>
      ) : null}
      <p className="text-sm leading-relaxed">{report.summary}</p>

      <section className="grid gap-2">
        <h3 className="text-sm font-semibold">How it compares</h3>
        <div className="overflow-x-auto">
          <Table>
            <THead>
              <TR>
                <TH>Position</TH>
                <TH>Business</TH>
                <TH className="text-right">Rating</TH>
                <TH className="text-right">Reviews</TH>
                <TH>Category</TH>
                <TH>Phone</TH>
                <TH>Website</TH>
                <TH>Service options</TH>
              </TR>
            </THead>
            <TBody>
              {rows.map((l) => (
                <TR key={l.index} className={cn(l.index === e.target.index && 'bg-accent font-medium')}>
                  <TD className="tabular-nums">{placeText(l)}</TD>
                  <TD>{l.title}</TD>
                  <TD className="text-right tabular-nums">{l.rating ?? '—'}</TD>
                  <TD className="text-right tabular-nums">
                    {l.reviewCount === null ? '—' : formatNumber(l.reviewCount)}
                  </TD>{' '}
                  {/* prettier-ignore */}
                  <TD className="text-xs">{l.category ?? '—'}</TD>
                  <TD className="text-xs">{yesNo(l.phoneShown)}</TD>
                  <TD className="text-xs">{websiteText(l)}</TD>
                  <TD className="text-xs">
                    {l.serviceOptions === null ? '—' : l.serviceOptions.join(', ') || 'None shown'}
                  </TD>{' '}
                  {/* prettier-ignore */}
                </TR>
              ))}
              <TR>
                <TD />
                <TD className="text-xs text-muted-foreground">Median of the top three</TD>
                <TD className="text-right text-xs tabular-nums text-muted-foreground">
                  {e.field.leadersMedianRating ?? '—'}
                </TD>{' '}
                {/* prettier-ignore */}
                <TD className="text-right text-xs tabular-nums text-muted-foreground">{e.field.leadersMedianReviews === null ? '—' : formatNumber(e.field.leadersMedianReviews)}</TD>{' '}
                {/* prettier-ignore */}
                <TD colSpan={4} />
              </TR>
            </TBody>
          </Table>
        </div>
      </section>

      <section className="grid gap-2">
        <h3 className="text-sm font-semibold">What to do</h3>
        <ol className="grid gap-2">
          {report.actions.map((a, i) => (
            <li key={`${i}-${a.title}`} className="rounded-lg border border-border p-3">
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge tone={PRIORITY[a.priority].tone}>{PRIORITY[a.priority].label}</Badge>
                <Badge>{RESEARCH_AREA_LABELS[a.area]}</Badge>
                <span className="text-xs text-muted-foreground">{EFFORT[a.effort]}</span>
              </div>
              <p className="mt-1.5 text-sm font-medium">
                {i + 1}. {a.title}
              </p>
              <p className="text-[13px] text-muted-foreground">{a.why}</p>
              <ol className="mt-2 list-decimal space-y-0.5 pl-5 text-[13px]">
                {a.steps.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ol>
              <p className="mt-2 text-xs text-muted-foreground">
                {a.evidence.length
                  ? `Based on: ${a.evidence.map((id) => `${id} ${findings.get(id)?.title ?? ''}`.trim()).join(' · ')}`
                  : 'General good practice from Google’s guidance'}
              </p>
            </li>
          ))}
        </ol>
        {report.removedForPolicy ? (
          <p className="text-xs text-muted-foreground">
            {report.removedForPolicy} suggestion{report.removedForPolicy === 1 ? ' was' : 's were'} removed
            because {report.removedForPolicy === 1 ? 'it' : 'they'} conflicted with Google’s rules.
          </p>
        ) : null}
      </section>

      <div className="grid gap-4 sm:grid-cols-2">
        {report.strengths.length ? (
          <section className="grid content-start gap-1.5">
            <h3 className="text-sm font-semibold">Strengths</h3>
            <ul className="list-disc space-y-0.5 pl-5 text-[13px]">
              {report.strengths.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
          </section>
        ) : null}
        {report.verify.length ? (
          <section className="grid content-start gap-1.5">
            <h3 className="text-sm font-semibold">Check on the profile</h3>
            <p className="text-xs text-muted-foreground">The results page cannot show these.</p>
            <ul className="list-disc space-y-0.5 pl-5 text-[13px]">
              {report.verify.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>

      <section className="grid gap-1.5">
        <h3 className="text-sm font-semibold">Findings from the collected results</h3>
        <ul className="grid gap-1.5">
          {e.findings.map((f) => (
            <li key={f.id} className="text-[13px]">
              <span className="mr-1.5 font-mono text-xs text-muted-foreground">{f.id}</span>
              <Badge tone={TONE[f.tone].tone} className="mr-1.5 align-middle">
                {TONE[f.tone].label}
              </Badge>
              <span className="font-medium">{f.title}.</span>{' '}
              <span className="text-muted-foreground">{f.detail}</span>
            </li>
          ))}
        </ul>
      </section>

      <details className="rounded-lg border border-border p-3">
        <summary className="cursor-pointer text-sm font-semibold">
          Google’s guidance for local ranking
        </summary>
        <p className="mt-2 text-[13px] text-muted-foreground">
          Google: local results are mainly based on relevance, distance and prominence; more reviews and
          positive ratings can help; there is no way to request or pay for a better local ranking.
        </p>
        <ul className="mt-2 grid gap-2">
          {LOCAL_RANKING_PRACTICES.map((p) => (
            <li key={p.title} className="text-[13px]">
              <span className="font-medium">{p.title}.</span>{' '}
              <span className="text-muted-foreground">{p.detail}</span>{' '}
              <a
                href={LOCAL_RANKING_SOURCES[p.source].url}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex items-center gap-0.5 text-xs text-primary hover:underline"
              >
                Source <ExternalLink className="size-3" />
              </a>
            </li>
          ))}
        </ul>
      </details>

      <ul className="list-disc space-y-0.5 pl-5 text-xs text-muted-foreground">
        {e.limitations.map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
    </div>
  );
}
