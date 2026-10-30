// Business locations: mapping between the validated input, the database row and the API shape.
import type {
  LocationData,
  LocationDto,
  LocationKind,
  LocationSource,
  OpeningPeriod,
} from '@surfaced/shared';
import type { BusinessLocation, Prisma } from '../db';

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];

export function locationWriteData(
  input: LocationData,
): Omit<Prisma.BusinessLocationUncheckedCreateInput, 'projectId'> {
  return {
    name: input.name,
    kind: input.kind,
    primaryCategory: input.primaryCategory,
    secondaryCategories: input.secondaryCategories,
    addressLine1: input.addressLine1,
    addressLine2: input.addressLine2,
    locality: input.locality,
    city: input.city,
    region: input.region,
    postalCode: input.postalCode,
    country: input.country,
    serviceAreas: input.serviceAreas,
    latitude: input.latitude,
    longitude: input.longitude,
    phone: input.phone,
    email: input.email,
    websiteUrl: input.websiteUrl,
    openingHours: input.openingHours,
    isPrimary: input.isPrimary,
    placeId: input.placeId,
  };
}

export function toLocationDto(row: BusinessLocation): LocationDto {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    kind: row.kind as LocationKind,
    primaryCategory: row.primaryCategory,
    secondaryCategories: strings(row.secondaryCategories),
    addressLine1: row.addressLine1,
    addressLine2: row.addressLine2,
    locality: row.locality,
    city: row.city,
    region: row.region,
    postalCode: row.postalCode,
    country: row.country,
    serviceAreas: strings(row.serviceAreas),
    latitude: row.latitude === null ? null : Number(row.latitude),
    longitude: row.longitude === null ? null : Number(row.longitude),
    phone: row.phone,
    email: row.email,
    websiteUrl: row.websiteUrl,
    openingHours: (Array.isArray(row.openingHours) ? row.openingHours : []) as unknown as OpeningPeriod[],
    isPrimary: row.isPrimary,
    source: row.source as LocationSource,
    profileLocationName: row.profileLocationName,
    placeId: row.placeId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** One-line address for display and matching ("Ghod Dod Rd, Athwa, Surat 395007"). */
export function formatLocationAddress(
  l: Pick<LocationDto, 'addressLine1' | 'locality' | 'city' | 'postalCode' | 'kind'>,
): string {
  if (l.kind === 'SERVICE_AREA') return l.city;
  return [l.addressLine1, l.locality, [l.city, l.postalCode].filter(Boolean).join(' ')]
    .filter(Boolean)
    .join(', ');
}
