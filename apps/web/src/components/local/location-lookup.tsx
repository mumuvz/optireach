import { useMutation } from '@tanstack/react-query';
import { Link2, LocateFixed } from 'lucide-react';
import { lazy, Suspense, useState } from 'react';
import { WEEKDAYS, type LocationInput, type OpeningPeriod, type Weekday } from '@surfaced/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/feedback';
import { Input, NativeSelect } from '@/components/ui/form';
import { api, errorMessage } from '@/lib/api';
import type { LocationDraft } from './location-editor';

const LocationPinMap = lazy(() => import('./location-pin-map'));

interface GooglePlaceFill {
  fields: Partial<LocationInput> & { placeId?: string | null };
  filled: string[];
  source: 'places_api' | 'link';
  googleMapsUri: string | null;
  notes: string[];
}

interface GeocodeCandidate {
  latitude: number;
  longitude: number;
  label: string;
  precision: 'address' | 'street' | 'area';
  matchedOn: string;
}

/** Coordinates from a pasted Google Maps URL ("!3d…!4d…" is the place pin, "@lat,lng" the map centre). */
export function coordinatesFromMapsUrl(text: string): string | null {
  const t = decodeURIComponent(text);
  const m =
    t.match(/!3d(-?\d{1,3}\.\d+)!4d(-?\d{1,3}\.\d+)/) ?? t.match(/@(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)/);
  return m ? `${Number(m[1])}, ${Number(m[2])}` : null;
}

/** Google opening periods to the draft's one-period-per-day form (earliest open, latest close). */
function hoursToDraft(periods: OpeningPeriod[], current: LocationDraft['hours']): LocationDraft['hours'] {
  const next = { ...current };
  for (const day of WEEKDAYS) {
    const list = periods.filter((p) => p.day === day);
    if (!list.length) {
      next[day] = { ...current[day], open: false };
      continue;
    }
    const from = list.map((p) => p.open).sort()[0]!;
    const to = list
      .map((p) => (p.close === '24:00' ? '23:59' : p.close))
      .sort()
      .at(-1)!;
    next[day] = { open: true, from, to };
  }
  return next;
}

export function applyPlaceFields(draft: LocationDraft, fields: GooglePlaceFill['fields']): LocationDraft {
  const pick = <K extends keyof LocationDraft>(key: K, value: LocationDraft[K] | undefined | null) =>
    value === undefined || value === null || value === '' ? {} : { [key]: value };
  return {
    ...draft,
    ...pick('name', fields.name),
    ...pick('addressLine1', fields.addressLine1),
    ...pick('locality', fields.locality),
    ...pick('city', fields.city),
    ...pick('region', fields.region),
    ...pick('postalCode', fields.postalCode),
    ...pick('country', fields.country),
    ...pick('phone', fields.phone),
    ...pick('websiteUrl', fields.websiteUrl),
    ...pick('primaryCategory', fields.primaryCategory),
    ...(typeof fields.latitude === 'number' && typeof fields.longitude === 'number'
      ? { coordinates: `${fields.latitude}, ${fields.longitude}` }
      : {}),
    ...(fields.openingHours?.length
      ? { hours: hoursToDraft(fields.openingHours as OpeningPeriod[], draft.hours) }
      : {}),
    ...(fields.placeId ? { placeId: fields.placeId } : {}),
  };
}

/** "Fill from a Google link": the Share link of the Google listing, or a Google Maps link. */
export function GoogleLinkFill({
  workspaceId,
  draft,
  onFill,
}: {
  workspaceId: string;
  draft: LocationDraft;
  onFill: (next: LocationDraft) => void;
}) {
  const [url, setUrl] = useState('');
  const [result, setResult] = useState<GooglePlaceFill | null>(null);
  const fill = useMutation({
    mutationFn: () =>
      api.post<GooglePlaceFill>(`/workspaces/${workspaceId}/places/from-google-link`, {
        url: url.trim(),
        city: draft.city.trim() || null,
        country: draft.country || null,
      }),
    onSuccess: (r) => {
      setResult(r);
      onFill(applyPlaceFields(draft, r.fields));
    },
  });
  return (
    <div className="grid gap-2 rounded-md border border-dashed border-border p-3">
      <label htmlFor="google-link" className="text-sm font-medium">
        Fill from a Google link <span className="font-normal text-muted-foreground">(optional)</span>
      </label>
      <p className="text-xs text-muted-foreground">
        On Google, open your shop’s listing, click <strong>Share</strong> and copy the link (share.google or
        maps.app.goo.gl), or copy a Google Maps address bar. The details are filled in for you to check.
      </p>
      <div className="flex flex-wrap gap-2">
        <Input
          id="google-link"
          className="min-w-0 flex-1"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://share.google/…"
          inputMode="url"
        />
        <Button
          type="button"
          variant="outline"
          onClick={() => fill.mutate()}
          loading={fill.isPending}
          disabled={!/^https:\/\//i.test(url.trim())}
        >
          <Link2 /> Fill from link
        </Button>
      </div>
      {fill.isError ? <Alert tone="danger">{errorMessage(fill.error)}</Alert> : null}
      {result ? (
        <Alert
          tone={result.source === 'places_api' ? 'success' : 'info'}
          title={result.filled.length ? `Filled: ${result.filled.join(', ')}` : 'Nothing could be filled'}
        >
          <ul className="space-y-1">
            {result.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
          {result.googleMapsUri ? (
            <a
              href={result.googleMapsUri}
              target="_blank"
              rel="noreferrer"
              className="mt-1 inline-block underline"
            >
              Check it on Google Maps
            </a>
          ) : null}
        </Alert>
      ) : null}
    </div>
  );
}

const PRECISION: Record<
  GeocodeCandidate['precision'],
  { label: string; tone: 'success' | 'warning' | 'info' }
> = {
  address: { label: 'Building found', tone: 'success' },
  street: { label: 'Street found', tone: 'info' },
  area: { label: 'Approximate (area only)', tone: 'warning' },
};

/** Coordinates: find them from the address, paste them (or a Google Maps link), and drag the pin to adjust. */
export function CoordinatesTools({
  workspaceId,
  draft,
  parsed,
  onChange,
}: {
  workspaceId: string | null;
  draft: LocationDraft;
  parsed: { latitude: number; longitude: number } | null;
  onChange: (coordinates: string) => void;
}) {
  const [candidates, setCandidates] = useState<GeocodeCandidate[] | null>(null);
  const [chosen, setChosen] = useState(0);
  const find = useMutation({
    mutationFn: () =>
      api.post<{ candidates: GeocodeCandidate[] }>(`/workspaces/${workspaceId}/places/geocode`, {
        addressLine1: draft.addressLine1.trim() || null,
        locality: draft.locality.trim() || null,
        city: draft.city.trim(),
        region: draft.region.trim() || null,
        postalCode: draft.postalCode.trim() || null,
        country: draft.country,
      }),
    onSuccess: (r) => {
      setCandidates(r.candidates);
      setChosen(0);
      if (r.candidates[0]) onChange(`${r.candidates[0].latitude}, ${r.candidates[0].longitude}`);
    },
  });
  const candidate = candidates?.[chosen];
  return (
    <div className="grid gap-2">
      {workspaceId ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => find.mutate()}
            loading={find.isPending}
            disabled={draft.city.trim().length < 2}
          >
            <LocateFixed /> Find from address
          </Button>
          {candidate ? (
            <Badge tone={PRECISION[candidate.precision].tone}>{PRECISION[candidate.precision].label}</Badge>
          ) : null}
        </div>
      ) : null}
      {find.isError ? <p className="text-[13px] text-destructive">{errorMessage(find.error)}</p> : null}
      {candidates && !candidates.length ? (
        <p className="text-[13px] text-muted-foreground">
          The address was not found on the map. Paste the coordinates or a Google Maps link instead.
        </p>
      ) : null}
      {candidates && candidates.length > 1 ? (
        <NativeSelect
          aria-label="Matching places"
          value={String(chosen)}
          onChange={(e) => {
            const i = Number(e.target.value);
            setChosen(i);
            onChange(`${candidates[i]!.latitude}, ${candidates[i]!.longitude}`);
          }}
        >
          {candidates.map((c, i) => (
            <option key={`${c.latitude},${c.longitude}`} value={i}>
              {c.label}
            </option>
          ))}
        </NativeSelect>
      ) : candidate ? (
        <p className="text-xs text-muted-foreground">{candidate.label}</p>
      ) : null}
      {parsed ? (
        <>
          <Suspense fallback={<div className="h-56 rounded-md border border-border bg-muted/40" />}>
            <LocationPinMap
              latitude={parsed.latitude}
              longitude={parsed.longitude}
              zoom={candidate?.precision === 'area' ? 14 : 17}
              onMove={(lat, lng) => onChange(`${lat}, ${lng}`)}
            />
          </Suspense>
          <p className="text-xs text-muted-foreground">
            {candidate?.precision === 'area'
              ? 'Only the area was found: drag the pin onto your shop before saving.'
              : 'Drag the pin onto the shop entrance if it is not exactly right.'}{' '}
            Map data © OpenStreetMap contributors.
          </p>
        </>
      ) : null}
    </div>
  );
}

export type { Weekday };
