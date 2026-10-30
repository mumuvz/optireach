import { useMemo } from 'react';
import {
  LOCATION_KINDS,
  LOCATION_KIND_LABELS,
  WEEKDAYS,
  countryOptions,
  locationInputSchema,
  type LocationData,
  type LocationDto,
  type LocationInput,
  type LocationKind,
  type Weekday,
} from '@surfaced/shared';
import { Checkbox, Field, Input, NativeSelect } from '@/components/ui/form';
import { TagInput } from '@/components/ui/multi-select';
import { CoordinatesTools, GoogleLinkFill, coordinatesFromMapsUrl } from './location-lookup';

export interface LocationDraft {
  name: string;
  kind: LocationKind;
  primaryCategory: string;
  addressLine1: string;
  addressLine2: string;
  locality: string;
  city: string;
  region: string;
  postalCode: string;
  country: string;
  serviceAreas: string[];
  /** "21.1702, 72.8311" as copied from Google Maps. */
  coordinates: string;
  phone: string;
  email: string;
  websiteUrl: string;
  hours: Record<Weekday, { open: boolean; from: string; to: string }>;
  isPrimary: boolean;
  /** Google place ID, kept when filled from a Google link or a linked profile. */
  placeId: string | null;
}

const DAY_LABELS: Record<Weekday, string> = {
  MONDAY: 'Monday',
  TUESDAY: 'Tuesday',
  WEDNESDAY: 'Wednesday',
  THURSDAY: 'Thursday',
  FRIDAY: 'Friday',
  SATURDAY: 'Saturday',
  SUNDAY: 'Sunday',
};

const closedWeek = () =>
  Object.fromEntries(
    WEEKDAYS.map((d) => [d, { open: false, from: '10:00', to: '19:00' }]),
  ) as LocationDraft['hours'];

export function emptyLocationDraft(defaults: Partial<LocationDraft> = {}): LocationDraft {
  return {
    name: '',
    kind: 'STOREFRONT',
    primaryCategory: '',
    addressLine1: '',
    addressLine2: '',
    locality: '',
    city: '',
    region: '',
    postalCode: '',
    country: 'IN',
    serviceAreas: [],
    coordinates: '',
    phone: '',
    email: '',
    websiteUrl: '',
    hours: closedWeek(),
    isPrimary: false,
    placeId: null,
    ...defaults,
  };
}

export function locationToDraft(l: LocationDto): LocationDraft {
  const hours = closedWeek();
  for (const p of l.openingHours) hours[p.day] = { open: true, from: p.open, to: p.close };
  return {
    name: l.name,
    kind: l.kind,
    primaryCategory: l.primaryCategory ?? '',
    addressLine1: l.addressLine1 ?? '',
    addressLine2: l.addressLine2 ?? '',
    locality: l.locality ?? '',
    city: l.city,
    region: l.region ?? '',
    postalCode: l.postalCode ?? '',
    country: l.country,
    serviceAreas: l.serviceAreas,
    coordinates: l.latitude !== null && l.longitude !== null ? `${l.latitude}, ${l.longitude}` : '',
    phone: l.phone ?? '',
    email: l.email ?? '',
    websiteUrl: l.websiteUrl ?? '',
    hours,
    isPrimary: l.isPrimary,
    placeId: l.placeId,
  };
}

const orNull = (v: string) => (v.trim() ? v.trim() : null);

/** Reads "lat, lng" (or "lat lng"); null when empty; NaN pair when it cannot be read. */
export function parseCoordinates(text: string): { latitude: number; longitude: number } | null | 'invalid' {
  if (!text.trim()) return null;
  const m = text.trim().match(/^(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)$/);
  if (!m) return 'invalid';
  const latitude = Number(m[1]);
  const longitude = Number(m[2]);
  return Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180 ? { latitude, longitude } : 'invalid';
}

export function draftToInput(d: LocationDraft): LocationInput {
  const coords = parseCoordinates(d.coordinates);
  return {
    name: d.name.trim(),
    kind: d.kind,
    primaryCategory: orNull(d.primaryCategory),
    addressLine1: d.kind === 'SERVICE_AREA' ? null : orNull(d.addressLine1),
    addressLine2: d.kind === 'SERVICE_AREA' ? null : orNull(d.addressLine2),
    locality: orNull(d.locality),
    city: d.city.trim(),
    region: orNull(d.region),
    postalCode: orNull(d.postalCode),
    country: d.country,
    serviceAreas: d.serviceAreas,
    latitude: coords && coords !== 'invalid' ? coords.latitude : null,
    longitude: coords && coords !== 'invalid' ? coords.longitude : null,
    phone: orNull(d.phone),
    email: orNull(d.email),
    websiteUrl: orNull(d.websiteUrl),
    openingHours: WEEKDAYS.filter((day) => d.hours[day].open).map((day) => ({ day, open: d.hours[day].from, close: d.hours[day].to })), // prettier-ignore
    isPrimary: d.isPrimary,
    placeId: d.placeId,
  };
}

/** Validates a draft with the same schema the API uses; errors are keyed by field. */
export function validateLocationDraft(d: LocationDraft): {
  data: LocationData | null;
  errors: Record<string, string>;
} {
  const errors: Record<string, string> = {};
  if (parseCoordinates(d.coordinates) === 'invalid')
    errors.coordinates = 'Use “latitude, longitude”, e.g. 21.1702, 72.8311';
  const parsed = locationInputSchema.safeParse(draftToInput(d));
  if (!parsed.success)
    for (const issue of parsed.error.issues) {
      const key =
        issue.path[0] === 'latitude' || issue.path[0] === 'longitude' ? 'coordinates' : String(issue.path[0]);
      if (key === 'openingHours') errors.hours = issue.message;
      else errors[key] ??= issue.message;
    }
  return { data: parsed.success && !errors.coordinates ? parsed.data : null, errors };
}

export function LocationEditor({
  value,
  onChange,
  errors = {},
  workspaceId = null,
}: {
  value: LocationDraft;
  onChange: (next: LocationDraft) => void;
  errors?: Record<string, string>;
  /** Enables "Fill from a Google link" and "Find from address". */
  workspaceId?: string | null;
}) {
  const countries = useMemo(() => countryOptions(), []);
  const set = <K extends keyof LocationDraft>(key: K, v: LocationDraft[K]) =>
    onChange({ ...value, [key]: v });
  const serviceArea = value.kind === 'SERVICE_AREA';
  const coords = parseCoordinates(value.coordinates);
  return (
    <div className="grid gap-4">
      {workspaceId ? <GoogleLinkFill workspaceId={workspaceId} draft={value} onFill={onChange} /> : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name customers see" error={errors.name}>
          <Input value={value.name} onChange={(e) => set('name', e.target.value)} />
        </Field>
        <Field
          label="Primary category"
          optional
          error={errors.primaryCategory}
          description="As on Google, e.g. Jewellery store"
        >
          <Input value={value.primaryCategory} onChange={(e) => set('primaryCategory', e.target.value)} />
        </Field>
      </div>
      <Field label="How customers are served">
        <NativeSelect value={value.kind} onChange={(e) => set('kind', e.target.value as LocationKind)}>
          {LOCATION_KINDS.map((k) => (
            <option key={k} value={k}>
              {LOCATION_KIND_LABELS[k]}
            </option>
          ))}
        </NativeSelect>
      </Field>
      {!serviceArea ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Street address" error={errors.addressLine1}>
            <Input
              value={value.addressLine1}
              onChange={(e) => set('addressLine1', e.target.value)}
              autoComplete="address-line1"
            />
          </Field>
          <Field label="Address line 2" optional>
            <Input
              value={value.addressLine2}
              onChange={(e) => set('addressLine2', e.target.value)}
              autoComplete="address-line2"
            />
          </Field>
        </div>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-4">
        <Field label="Neighbourhood" optional description="e.g. Mota Varachha">
          <Input value={value.locality} onChange={(e) => set('locality', e.target.value)} />
        </Field>
        <Field label="City" error={errors.city}>
          <Input
            value={value.city}
            onChange={(e) => set('city', e.target.value)}
            autoComplete="address-level2"
          />
        </Field>
        <Field label="State or region" optional>
          <Input
            value={value.region}
            onChange={(e) => set('region', e.target.value)}
            autoComplete="address-level1"
          />
        </Field>
        <Field label="Postal code" optional error={errors.postalCode}>
          <Input
            value={value.postalCode}
            onChange={(e) => set('postalCode', e.target.value)}
            autoComplete="postal-code"
          />
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Country" error={errors.country}>
          <NativeSelect value={value.country} onChange={(e) => set('country', e.target.value)}>
            {countries.map((c) => (
              <option key={c.code} value={c.code}>
                {c.name}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field
          label="Coordinates (map position)"
          optional
          error={errors.coordinates}
          description="Needed for rank grids. Click “Find from address”, paste a Google Maps link, or type latitude, longitude."
        >
          <Input
            value={value.coordinates}
            onChange={(e) => set('coordinates', coordinatesFromMapsUrl(e.target.value) ?? e.target.value)}
            placeholder="21.1702, 72.8311"
          />
        </Field>
      </div>
      <CoordinatesTools
        workspaceId={workspaceId}
        draft={value}
        parsed={coords && coords !== 'invalid' ? coords : null}
        onChange={(c) => set('coordinates', c)}
      />
      {serviceArea || value.kind === 'HYBRID' ? (
        <Field
          label="Areas served"
          error={errors.serviceAreas}
          description="Cities, neighbourhoods or postal codes. Press Enter after each."
        >
          <TagInput
            value={value.serviceAreas}
            onChange={(v) => set('serviceAreas', v)}
            placeholder="e.g. Adajan"
            max={30}
          />
        </Field>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Phone" optional error={errors.phone}>
          <Input
            value={value.phone}
            onChange={(e) => set('phone', e.target.value)}
            autoComplete="tel"
            inputMode="tel"
          />
        </Field>
        <Field label="Email" optional error={errors.email}>
          <Input
            value={value.email}
            onChange={(e) => set('email', e.target.value)}
            autoComplete="email"
            inputMode="email"
          />
        </Field>
        <Field
          label="Location page"
          optional
          error={errors.websiteUrl}
          description="The page for this branch, if any"
        >
          <Input
            value={value.websiteUrl}
            onChange={(e) => set('websiteUrl', e.target.value)}
            inputMode="url"
            placeholder="https://"
          />
        </Field>
      </div>
      <fieldset className="grid gap-2">
        <legend className="mb-1 text-sm font-medium">
          Opening hours{' '}
          <span className="font-normal text-muted-foreground">(optional; leave days closed if unsure)</span>
        </legend>
        {WEEKDAYS.map((day) => {
          const h = value.hours[day];
          return (
            <div key={day} className="grid grid-cols-[7rem_auto_1fr_1fr] items-center gap-2 text-sm">
              <span>{DAY_LABELS[day]}</span>
              <Checkbox
                aria-label={`Open on ${DAY_LABELS[day]}`}
                checked={h.open}
                onCheckedChange={(v) => set('hours', { ...value.hours, [day]: { ...h, open: v === true } })}
              />
              <Input
                type="time"
                aria-label={`${DAY_LABELS[day]} opening time`}
                value={h.from}
                disabled={!h.open}
                onChange={(e) => set('hours', { ...value.hours, [day]: { ...h, from: e.target.value } })}
              />
              <Input
                type="time"
                aria-label={`${DAY_LABELS[day]} closing time`}
                value={h.to}
                disabled={!h.open}
                onChange={(e) => set('hours', { ...value.hours, [day]: { ...h, to: e.target.value } })}
              />
            </div>
          );
        })}
        {errors.hours ? <p className="text-[13px] text-destructive">{errors.hours}</p> : null}
      </fieldset>
    </div>
  );
}
