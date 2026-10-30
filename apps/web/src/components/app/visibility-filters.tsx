import { useQuery } from '@tanstack/react-query';
import {
  MANUAL_PROVIDER_KEYS,
  countryName,
  languageName,
  observationProviderLabel,
  type ProviderStatusDto,
} from '@surfaced/shared';
import type { VisibilityFilterState } from '@/app/hooks';
import { NativeSelect, Switch } from '@/components/ui/form';
import { api } from '@/lib/api';

const RANGES: { label: string; days: number | null }[] = [
  { label: 'Last 7 days', days: 7 },
  { label: 'Last 30 days', days: 30 },
  { label: 'Last 90 days', days: 90 },
  { label: 'All time', days: null },
];

/** Visibility provider configuration (configured, not configured, demo) and the content LLM status. */
export function useProviderStatuses() {
  return useQuery({
    queryKey: ['visibility-providers'],
    queryFn: () =>
      api.get<{
        providers: ProviderStatusDto[];
        llm: { configured: boolean; isDevAdapter: boolean; detail: string };
      }>('/ai-visibility/providers'),
    staleTime: 5 * 60_000,
  });
}

/** One filter row above everything it scopes (date range first). */
export function FilterRow({
  value,
  onChange,
  countries,
  languages,
}: {
  value: VisibilityFilterState;
  onChange: (v: VisibilityFilterState) => void;
  countries: string[];
  languages: string[];
}) {
  const providers = useProviderStatuses();
  return (
    <div className="mb-5 flex flex-wrap items-center gap-2" role="group" aria-label="Filters">
      <NativeSelect
        aria-label="Date range"
        value={String(value.days)}
        onChange={(e) =>
          onChange({ ...value, days: e.target.value === 'null' ? null : Number(e.target.value) })
        }
        className="w-40"
      >
        {RANGES.map((r) => (
          <option key={r.label} value={String(r.days)}>
            {r.label}
          </option>
        ))}
      </NativeSelect>
      <NativeSelect
        aria-label="Provider"
        value={value.provider}
        onChange={(e) => onChange({ ...value, provider: e.target.value })}
        className="w-52"
      >
        <option value="all">All providers</option>
        {(providers.data?.providers ?? []).map((p) => (
          <option key={p.key} value={p.key}>
            {p.label}
          </option>
        ))}
        <optgroup label="Manual observations">
          {MANUAL_PROVIDER_KEYS.map((k) => (
            <option key={k} value={k}>
              {observationProviderLabel(k).replace('Manual observation · ', '')}
            </option>
          ))}
        </optgroup>
      </NativeSelect>
      <NativeSelect
        aria-label="Country"
        value={value.country ?? ''}
        onChange={(e) => onChange({ ...value, country: e.target.value || undefined })}
        className="w-44"
      >
        <option value="">All countries</option>
        {countries.map((c) => (
          <option key={c} value={c}>
            {countryName(c)}
          </option>
        ))}
      </NativeSelect>
      <NativeSelect
        aria-label="Language"
        value={value.language ?? ''}
        onChange={(e) => onChange({ ...value, language: e.target.value || undefined })}
        className="w-40"
      >
        <option value="">All languages</option>
        {languages.map((l) => (
          <option key={l} value={l}>
            {languageName(l)}
          </option>
        ))}
      </NativeSelect>
      <label className="ml-1 flex items-center gap-2 text-sm">
        <Switch
          checked={value.includeDemo}
          onCheckedChange={(v) => onChange({ ...value, includeDemo: v })}
          aria-label="Include demo data"
        />
        Include demo data
      </label>
    </div>
  );
}
