import { useMutation, useQueryClient } from '@tanstack/react-query';
import { BookmarkPlus, ExternalLink, RefreshCw, TrendingUp, Upload } from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  TREND_DATA_TYPE_LABELS,
  TREND_MAX_KEYWORDS,
  TREND_SCHEDULES,
  TREND_TIME_RANGES,
  countryOptions,
  googleTrendsExploreUrl,
  termWithCity,
  trendCityOptions,
  trendCityRegion,
  trendRegionName,
  trendRegionOptions,
  type TrendDataType,
  type TrendLiveSource,
  type TrendSchedule,
  type TrendsStatusDto,
  type TrendTimeRange,
} from '@surfaced/shared';
import { useProject } from '@/app/project-scope';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeaderRow } from '@/components/ui/card';
import { Dialog, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/dialog';
import { Alert } from '@/components/ui/feedback';
import { Checkbox, Field, Input, Label, NativeSelect, Switch, Textarea } from '@/components/ui/form';
import { api, errorMessage } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { CsvImportDialog } from './csv-import-dialog';
import { trendKeys, useTrendCategories } from './hooks';
import { SearchSelect } from './search-select';

export interface CompareSettings {
  terms: string;
  country: string;
  region: string;
  city: string;
  timeRange: TrendTimeRange;
  category: number;
  provider: TrendLiveSource | '';
}

const OPTIONAL_TYPES: TrendDataType[] = ['regions', 'related_queries', 'related_topics'];
const SCHEDULE_LABELS: Record<TrendSchedule, string> = { NONE: 'Not refreshed', WEEKLY: 'Every week', MONTHLY: 'Every month' }; // prettier-ignore

export const termsFrom = (text: string) =>
  [
    ...new Set(
      text
        .split(/[\n,]/)
        .map((t) => t.trim())
        .filter(Boolean),
    ),
  ].slice(0, 10);

/** Searchable list of Google Trends' 1,132 categories: top-level ones on focus, matches while typing. */
function CategoryField({ value, onChange }: { value: number; onChange: (id: number) => void }) {
  const project = useProject();
  const categories = useTrendCategories(project.id);
  const options = useMemo(
    () =>
      (categories.data?.categories ?? []).map(([id, name, path]) => ({
        value: String(id),
        label: name,
        hint: `${path || 'Top level'} · id ${id}`,
      })),
    [categories.data],
  );
  const all = { value: '0', label: 'All categories', hint: 'No category filter' };
  const selected = options.find((o) => o.value === String(value));
  const path = categories.data?.categories.find((c) => c[0] === value)?.[2];
  return (
    <SearchSelect
      label="Category"
      optional
      listLabel="Google Trends categories"
      options={[all, ...options]}
      defaultOptions={[all, ...options.filter((o) => o.hint?.startsWith('Top level'))]}
      display={
        value === 0 ? 'All categories' : selected ? `${selected.label} (${value})` : `Category ${value}`
      }
      placeholder={categories.isLoading ? 'Loading categories…' : 'Type to search, e.g. Weddings'}
      emptyText={categories.isError ? 'Categories could not be loaded.' : undefined}
      description={value && path ? `In ${path}.` : 'Narrows Google Trends to one topic area.'}
      onSelect={(v) => onChange(Number(v))}
    />
  );
}

/**
 * City filter. Google Trends cannot filter to one city (and returns no city breakdown for India), so this compares
 * searches that mention the city, measured in the city's state.
 */
function CityField({
  country,
  region,
  city,
  onChange,
}: {
  country: string;
  region: string;
  city: string;
  onChange: (city: string, region: string | null) => void;
}) {
  const cities = trendCityOptions(country);
  const none = { value: '', label: 'No city', hint: 'Whole country or region' };
  const options = cities.map((c) => ({
    value: c.name,
    label: c.name,
    hint: trendRegionName(c.region) ?? c.region,
  }));
  const inRegion = region ? options.filter((o) => trendCityRegion(country, o.value) === region) : options;
  return (
    <SearchSelect
      label="City"
      optional
      allowFree
      listLabel="Cities"
      options={[none, ...options]}
      defaultOptions={[none, ...inRegion]}
      display={city}
      placeholder="Type a city, e.g. Surat"
      description={
        city
          ? `Compares searches that mention ${city} (e.g. “${termWithCity('wedding card', city)}”)${region ? ` across ${trendRegionName(region)}` : ''}. Google Trends cannot filter to one city.`
          : 'Optional. Google Trends has no city filter, so this compares searches that mention the city.'
      }
      onSelect={(v) => onChange(v, v ? trendCityRegion(country, v) : null)}
    />
  );
}

export function CompareForm({
  status,
  running,
  initial,
  onStarted,
}: {
  status: TrendsStatusDto | undefined;
  running: boolean;
  initial: CompareSettings;
  onStarted: (reportId: string) => void;
}) {
  const project = useProject();
  const queryClient = useQueryClient();
  const canRun = useCan('keyword.manage');
  const countries = useMemo(() => countryOptions(), []);
  const [form, setForm] = useState<CompareSettings>(initial);
  const [include, setInclude] = useState<Set<TrendDataType>>(new Set(OPTIONAL_TYPES));
  const [suggest, setSuggest] = useState(true);
  const [importOpen, setImportOpen] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const set = <K extends keyof CompareSettings>(key: K, value: CompareSettings[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const list = termsFrom(form.terms);
  const regions = trendRegionOptions(form.country);
  const live = (status?.providers ?? []).filter((p) => p.kind !== 'import');
  const chosen = form.provider ? live.find((p) => p.key === form.provider) : live.find((p) => p.key === status?.defaultProvider); // prettier-ignore
  const canFetch = Boolean(chosen?.available);
  // Configured but failing its health check (service stopped, wrong token, paused after a rate limit).
  const unreachable = live.filter((p) => p.configured && !p.available && p.health);
  const checkAgain = () => void queryClient.invalidateQueries({ queryKey: ['trends-status', project.id] });
  const aiReady = status?.ai.configured ?? false;
  const settings = {
    keywords: list.slice(0, TREND_MAX_KEYWORDS),
    country: form.country || null,
    region: form.country && form.region ? form.region : null,
    city: form.country && form.city ? form.city : null,
    timeRange: form.timeRange,
    category: form.category,
  };
  // What Google Trends will compare: with a city, each term mentions it ("wedding card surat").
  const compared = [...new Set(settings.keywords.map((k) => termWithCity(k, settings.city)))];
  const exploreUrl = googleTrendsExploreUrl({ ...settings, keywords: compared });
  const refresh = () =>
    trendKeys(project.id).forEach((queryKey) => void queryClient.invalidateQueries({ queryKey }));

  const fetchLive = useMutation({
    mutationFn: () =>
      api.post<{ reportId: string; cached: boolean }>(`/projects/${project.id}/trends`, {
        ...settings,
        provider: form.provider || undefined,
        include: ['interest', ...include],
        suggestPlacements: suggest && aiReady,
      }),
    onSuccess: (r) => {
      if (r.cached) toast.success('Reusing data fetched recently for the same comparison');
      onStarted(r.reportId);
      refresh();
    },
    onError: (e) => toast.error('Could not fetch trends', { description: errorMessage(e) }),
  });

  return (
    <Card>
      <CardHeaderRow
        title="Compare searches"
        description="Google Trends shows relative interest (100 = the peak in the period and place), not the number of searches."
      />
      <CardContent className="grid gap-4">
        <div className="grid gap-4 lg:grid-cols-[2fr_1fr_1fr]">
          <Field
            label="Search terms"
            description={`One per line or comma-separated. Up to ${TREND_MAX_KEYWORDS} at a time.`}
          >
            <Textarea rows={5} value={form.terms} onChange={(e) => set('terms', e.target.value)} />
          </Field>
          <div className="grid content-start gap-4">
            <Field label="Country">
              <NativeSelect
                value={form.country}
                onChange={(e) => setForm((f) => ({ ...f, country: e.target.value, region: '', city: '' }))}
              >
                <option value="">Worldwide</option>
                {countries.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.name}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            {form.country ? (
              regions.length ? (
                <Field label="Region" optional>
                  <NativeSelect
                    value={form.region}
                    onChange={(e) =>
                      setForm((f) => {
                        const cityRegion = trendCityRegion(f.country, f.city);
                        // A city in another state no longer fits the chosen region.
                        const keepCity = !cityRegion || !e.target.value || cityRegion === e.target.value;
                        return { ...f, region: e.target.value, city: keepCity ? f.city : '' };
                      })
                    }
                  >
                    <option value="">Whole country</option>
                    {regions.map((r) => (
                      <option key={r.code} value={r.code}>
                        {r.name}
                      </option>
                    ))}
                  </NativeSelect>
                </Field>
              ) : (
                <Field
                  label="Region code"
                  optional
                  description={`ISO 3166-2, e.g. ${form.country}-01. Leave empty for the whole country.`}
                >
                  <Input
                    value={form.region}
                    onChange={(e) => set('region', e.target.value.toUpperCase().trim())}
                    placeholder={`${form.country}-…`}
                  />
                </Field>
              )
            ) : null}
            {form.country ? (
              <CityField
                country={form.country}
                region={form.region}
                city={form.city}
                onChange={(city, cityRegion) =>
                  setForm((f) => ({ ...f, city, region: cityRegion ?? f.region }))
                }
              />
            ) : null}
          </div>
          <div className="grid content-start gap-4">
            <Field label="Period">
              <NativeSelect
                value={form.timeRange}
                onChange={(e) => set('timeRange', e.target.value as TrendTimeRange)}
              >
                {TREND_TIME_RANGES.map((t) => (
                  <option key={t.key} value={t.key}>
                    {t.label}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <CategoryField value={form.category} onChange={(id) => set('category', id)} />
          </div>
        </div>
        {settings.city && compared.length ? (
          <p className="text-[13px] text-muted-foreground">
            Will compare: {compared.map((k) => `“${k}”`).join(', ')}.
          </p>
        ) : null}
        {list.length > TREND_MAX_KEYWORDS ? (
          <p className="text-[13px] text-muted-foreground">
            Only the first {TREND_MAX_KEYWORDS} terms are compared at a time.
          </p>
        ) : null}

        <div className="grid gap-4 rounded-lg border border-border p-4 md:grid-cols-[1fr_1.4fr]">
          <Field
            label="Data source"
            description={chosen ? chosen.detail : undefined}
            className="content-start"
          >
            <NativeSelect
              value={form.provider}
              onChange={(e) => set('provider', e.target.value as TrendLiveSource | '')}
            >
              <option value="">
                Automatic
                {status?.defaultProvider
                  ? ` (${live.find((p) => p.key === status.defaultProvider)?.label ?? status.defaultProvider})`
                  : ''}
              </option>
              {live.map((p) => (
                <option key={p.key} value={p.key} disabled={!p.available}>
                  {p.label}
                  {p.available ? '' : ' (not available)'}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <fieldset className="grid content-start gap-2">
            <legend className="mb-1 text-sm font-medium">Include</legend>
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              <Checkbox checked disabled aria-label={TREND_DATA_TYPE_LABELS.interest} />{' '}
              {TREND_DATA_TYPE_LABELS.interest}
            </label>
            {OPTIONAL_TYPES.map((type) => (
              <label key={type} className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={include.has(type)}
                  onCheckedChange={(v) =>
                    setInclude((prev) => {
                      const next = new Set(prev);
                      if (v) next.add(type);
                      else next.delete(type);
                      return next;
                    })
                  }
                  aria-label={TREND_DATA_TYPE_LABELS[type]}
                />
                {TREND_DATA_TYPE_LABELS[type]}
              </label>
            ))}
            <p className="text-xs text-muted-foreground">
              Each part is a separate request to Google Trends; with pytrends, related searches take a few
              seconds per term.
            </p>
            <div className="mt-1 flex items-center gap-2">
              <Switch
                id="trend-suggest"
                checked={suggest && aiReady}
                disabled={!aiReady}
                onCheckedChange={setSuggest}
              />
              <Label htmlFor="trend-suggest" className="text-sm font-normal">
                Suggest where to add missing terms{' '}
                {aiReady ? '(uses 1 AI keyword run)' : '(no AI provider configured)'}
              </Label>
            </div>
          </fieldset>
        </div>

        <div className="flex flex-wrap gap-2">
          {canRun ? (
            <Button
              onClick={() => fetchLive.mutate()}
              loading={fetchLive.isPending}
              disabled={!canFetch || running || !settings.keywords.length}
              title={canFetch ? undefined : 'No live data source is available (see Data sources below).'}
            >
              <TrendingUp /> Fetch live data
            </Button>
          ) : null}
          <Button asChild variant="outline">
            <a href={exploreUrl} target="_blank" rel="noreferrer">
              <ExternalLink /> Open in Google Trends
            </a>
          </Button>
          {canRun ? (
            <>
              <Button variant="outline" onClick={() => setImportOpen(true)} disabled={running}>
                <Upload /> Import CSV
              </Button>
              <Button
                variant="outline"
                onClick={() => setSaveOpen(true)}
                disabled={!settings.keywords.length}
              >
                <BookmarkPlus /> Save comparison
              </Button>
            </>
          ) : null}
        </div>
        {status && !canFetch && unreachable.length ? (
          <Alert tone="warning" title="A live data source is set up but not reachable">
            <ul className="list-disc space-y-1 pl-5">
              {unreachable.map((p) => (
                <li key={p.key}>
                  <span className="font-medium">{p.label}:</span>{' '}
                  {p.health?.coolingDownSeconds
                    ? `paused for about ${Math.ceil(p.health.coolingDownSeconds / 60)} minutes after Google rate-limited it.`
                    : (p.health?.lastError ?? p.lastFailure?.message ?? p.detail)}
                </li>
              ))}
            </ul>
            <p className="mt-2">
              Start or fix the service, then check again. CSV import keeps working in the meantime.
            </p>
            <Button size="sm" variant="outline" className="mt-2" onClick={checkAgain}>
              <RefreshCw /> Check again
            </Button>
          </Alert>
        ) : status && !canFetch ? (
          <Alert tone="info" title="No live data source is available">
            You can always open these terms in Google Trends, download the charts (the download icon on each
            chart) and import the CSV files here. For live data, an administrator can start the free pytrends
            service (experimental and unofficial) or add a DataForSEO account (paid). See Data sources below.
          </Alert>
        ) : chosen?.experimental ? (
          <p className="text-[13px] text-muted-foreground">
            {chosen.label}: requests are spaced out and stop for a while if Google rate-limits them. Nothing
            is retried around Google’s limits, and failures are reported, never filled in.
          </p>
        ) : null}
      </CardContent>
      <CsvImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        settings={settings}
        knownTerms={settings.keywords}
        suggestPlacements={suggest && aiReady}
        onImported={(reportId) => {
          onStarted(reportId);
          refresh();
        }}
      />
      <SaveComparisonDialog
        open={saveOpen}
        onOpenChange={setSaveOpen}
        body={{ ...settings, provider: form.provider || undefined }}
        onSaved={refresh}
      />
    </Card>
  );
}

function SaveComparisonDialog({
  open,
  onOpenChange,
  body,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  body: Record<string, unknown> & { keywords: string[] };
  onSaved: () => void;
}) {
  const project = useProject();
  const [name, setName] = useState('');
  const [schedule, setSchedule] = useState<TrendSchedule>('NONE');
  const save = useMutation({
    mutationFn: () => api.post(`/projects/${project.id}/trends/saved`, { ...body, name: name.trim() || body.keywords.slice(0, 2).join(', '), schedule }), // prettier-ignore
    onSuccess: () => {
      toast.success('Comparison saved');
      onSaved();
      onOpenChange(false);
    },
    onError: (e) => toast.error('Could not save', { description: errorMessage(e) }),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader
          title="Save comparison"
          description="Keep these terms, place and period to run again, or refresh them automatically."
        />
        <Field label="Name">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={body.keywords.slice(0, 2).join(', ')}
          />
        </Field>
        <Field
          label="Refresh"
          description="Scheduled refreshes update the data and the site comparison, without AI suggestions."
        >
          <NativeSelect value={schedule} onChange={(e) => setSchedule(e.target.value as TrendSchedule)}>
            {TREND_SCHEDULES.map((s) => (
              <option key={s} value={s}>
                {SCHEDULE_LABELS[s]}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} loading={save.isPending}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export { SCHEDULE_LABELS };
