// Google Business Profile client and sync (docs/providers/google-business-profile.md). Reads accounts, locations,
// daily performance metrics and reviews for locations the business linked, and publishes review replies only after
// an approval for the exact text (see the API service). Google allows the content to be stored for at most 30 days,
// so the sync replaces it and purgeExpiredProfileData deletes anything older.
import {
  PROFILE_DAILY_METRICS,
  PROFILE_DATA_RETENTION_DAYS,
  PROFILE_METRIC_LABELS,
  WEEKDAYS,
  type LocationData,
  type OpeningPeriod,
  type ProfileAccountDto,
  type ProfileDailyMetric,
  type ProfileMetricsDto,
  type ProfileView,
  type Weekday,
} from '@surfaced/shared';
import type { Prisma, PrismaClient } from '../db';
import { Errors } from '../errors';
import { googleApiRequest, type HttpFetch } from '../integrations/google';

const ACCOUNTS_API = 'https://mybusinessaccountmanagement.googleapis.com/v1';
const INFO_API = 'https://mybusinessbusinessinformation.googleapis.com/v1';
const PERFORMANCE_API = 'https://businessprofileperformance.googleapis.com/v1';
const REVIEWS_API = 'https://mybusiness.googleapis.com/v4';
const SERVICE = 'Google Business Profile';

export const PROFILE_READ_MASK =
  'name,title,storeCode,phoneNumbers,categories,storefrontAddress,websiteUri,regularHours,specialHours,serviceArea,labels,latlng,openInfo,metadata,profile';
/** Metric days fetched per sync: the last 28 days and the 28 before them, for period comparison. */
export const PROFILE_METRIC_DAYS = 56;
/** Reviews fetched per location per sync (newest first, 50 per page). */
export const PROFILE_REVIEW_PAGES = 4;
const MAX_PAGES = 20;

// ---------------- Google's shapes (only the fields read) ----------------

interface TimeOfDay {
  hours?: number;
  minutes?: number;
}
interface GbpPeriod {
  openDay?: string;
  openTime?: TimeOfDay;
  closeDay?: string;
  closeTime?: TimeOfDay;
}
export interface GbpLocation {
  name: string;
  title?: string;
  storeCode?: string;
  phoneNumbers?: { primaryPhone?: string; additionalPhones?: string[] };
  categories?: {
    primaryCategory?: { name?: string; displayName?: string };
    additionalCategories?: { name?: string; displayName?: string }[];
  };
  storefrontAddress?: {
    regionCode?: string;
    postalCode?: string;
    administrativeArea?: string;
    locality?: string;
    sublocality?: string;
    addressLines?: string[];
  };
  websiteUri?: string;
  regularHours?: { periods?: GbpPeriod[] };
  specialHours?: { specialHourPeriods?: unknown[] };
  serviceArea?: {
    businessType?: string;
    places?: { placeInfos?: { placeName?: string; placeId?: string }[] };
  };
  labels?: string[];
  latlng?: { latitude?: number; longitude?: number };
  openInfo?: { status?: string };
  metadata?: {
    placeId?: string;
    mapsUri?: string;
    newReviewUri?: string;
    hasVoiceOfMerchant?: boolean;
    hasPendingEdits?: boolean;
    hasGoogleUpdated?: boolean;
  };
  profile?: { description?: string };
}

interface GbpReview {
  name: string;
  reviewer?: { displayName?: string; isAnonymous?: boolean };
  starRating?: string;
  comment?: string;
  createTime?: string;
  updateTime?: string;
  reviewReply?: { comment?: string; updateTime?: string };
}

// ---------------- Requests ----------------

function gbpRequest<T>(
  prisma: PrismaClient,
  integrationId: string,
  url: string,
  init: RequestInit,
  httpFetch: HttpFetch,
): Promise<T> {
  return googleApiRequest<T>(prisma, integrationId, url, init, httpFetch, SERVICE);
}

async function paged<T, K extends string>(
  fetchPage: (pageToken: string | null) => Promise<Partial<Record<K, T[]>> & { nextPageToken?: string }>,
  key: K,
  maxPages = MAX_PAGES,
): Promise<{ items: T[]; complete: boolean }> {
  const items: T[] = [];
  let token: string | null = null;
  for (let page = 0; page < maxPages; page++) {
    const data = await fetchPage(token);
    items.push(...((data[key] as T[] | undefined) ?? []));
    if (!data.nextPageToken) return { items, complete: true };
    token = data.nextPageToken;
  }
  return { items, complete: false };
}

export async function listProfileAccounts(
  prisma: PrismaClient,
  integrationId: string,
  httpFetch: HttpFetch = fetch,
): Promise<ProfileAccountDto[]> {
  const { items } = await paged<
    { name: string; accountName?: string; type?: string; role?: string; verificationState?: string },
    'accounts'
  >(
    (token) =>
      gbpRequest(
        prisma,
        integrationId,
        `${ACCOUNTS_API}/accounts?pageSize=20${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`,
        { method: 'GET' },
        httpFetch,
      ),
    'accounts',
  );
  return items.map((a) => ({
    name: a.name,
    accountName: a.accountName ?? a.name,
    type: a.type ?? null,
    role: a.role ?? null,
    verificationState: a.verificationState ?? null,
  }));
}

export async function listProfileLocations(
  prisma: PrismaClient,
  integrationId: string,
  accountName: string,
  httpFetch: HttpFetch = fetch,
): Promise<GbpLocation[]> {
  const { items } = await paged<GbpLocation, 'locations'>(
    (token) =>
      gbpRequest(
        prisma,
        integrationId,
        `${INFO_API}/${accountName}/locations?pageSize=100&readMask=${PROFILE_READ_MASK}${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`,
        { method: 'GET' },
        httpFetch,
      ),
    'locations',
  );
  return items;
}

export function getProfileLocation(
  prisma: PrismaClient,
  integrationId: string,
  locationName: string,
  httpFetch: HttpFetch = fetch,
): Promise<GbpLocation> {
  return gbpRequest<GbpLocation>(
    prisma,
    integrationId,
    `${INFO_API}/${locationName}?readMask=${PROFILE_READ_MASK}`,
    { method: 'GET' },
    httpFetch,
  );
}

const ymd = (d: Date) => ({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() });
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** Daily values per metric between two dates (inclusive). Google omits zero values; they are filled in as 0. */
export async function fetchProfileMetrics(
  prisma: PrismaClient,
  integrationId: string,
  locationName: string,
  from: Date,
  to: Date,
  httpFetch: HttpFetch = fetch,
): Promise<{ metric: ProfileDailyMetric; date: string; value: number }[]> {
  const start = ymd(from);
  const end = ymd(to);
  const params = new URLSearchParams();
  for (const metric of PROFILE_DAILY_METRICS) params.append('dailyMetrics', metric);
  params.set('dailyRange.startDate.year', String(start.year));
  params.set('dailyRange.startDate.month', String(start.month));
  params.set('dailyRange.startDate.day', String(start.day));
  params.set('dailyRange.endDate.year', String(end.year));
  params.set('dailyRange.endDate.month', String(end.month));
  params.set('dailyRange.endDate.day', String(end.day));
  const data = await gbpRequest<{
    multiDailyMetricTimeSeries?: {
      dailyMetricTimeSeries?: {
        dailyMetric?: string;
        timeSeries?: {
          datedValues?: { date?: { year?: number; month?: number; day?: number }; value?: string }[];
        };
      }[];
    }[];
  }>(
    prisma,
    integrationId,
    `${PERFORMANCE_API}/${locationName}:fetchMultiDailyMetricsTimeSeries?${params.toString()}`,
    { method: 'GET' },
    httpFetch,
  );
  const known = new Set<string>(PROFILE_DAILY_METRICS);
  const rows: { metric: ProfileDailyMetric; date: string; value: number }[] = [];
  for (const group of data.multiDailyMetricTimeSeries ?? [])
    for (const series of group.dailyMetricTimeSeries ?? []) {
      if (!series.dailyMetric || !known.has(series.dailyMetric)) continue;
      for (const point of series.timeSeries?.datedValues ?? []) {
        const d = point.date;
        if (!d?.year || !d.month || !d.day) continue;
        const value = Number(point.value ?? 0);
        rows.push({
          metric: series.dailyMetric as ProfileDailyMetric,
          date: `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`,
          value: Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0,
        });
      }
    }
  return rows;
}

/** Path of a location under its account for the v4 reviews API: accounts/{a}/locations/{l}. */
export function reviewsParent(accountName: string, locationName: string): string {
  return `${accountName}/${locationName}`;
}

export async function listProfileReviews(
  prisma: PrismaClient,
  integrationId: string,
  accountName: string,
  locationName: string,
  httpFetch: HttpFetch = fetch,
  maxPages = PROFILE_REVIEW_PAGES,
): Promise<{
  reviews: GbpReview[];
  complete: boolean;
  averageRating: number | null;
  totalReviewCount: number | null;
}> {
  let totals: { averageRating: number | null; totalReviewCount: number | null } = {
    averageRating: null,
    totalReviewCount: null,
  };
  const parent = reviewsParent(accountName, locationName);
  const { items, complete } = await paged<GbpReview, 'reviews'>(
    async (token) => {
      const data = await gbpRequest<{
        reviews?: GbpReview[];
        averageRating?: number;
        totalReviewCount?: number;
        nextPageToken?: string;
      }>(
        prisma,
        integrationId,
        `${REVIEWS_API}/${parent}/reviews?pageSize=50&orderBy=updateTime%20desc${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`,
        { method: 'GET' },
        httpFetch,
      );
      if (!token)
        totals = {
          averageRating: typeof data.averageRating === 'number' ? data.averageRating : null,
          totalReviewCount: typeof data.totalReviewCount === 'number' ? data.totalReviewCount : null,
        };
      return data;
    },
    'reviews',
    maxPages,
  );
  return { reviews: items, complete, ...totals };
}

/** Publishes (or replaces) the reply to a review. Callers must check the approval first. */
export async function putReviewReply(
  prisma: PrismaClient,
  integrationId: string,
  reviewName: string,
  comment: string,
  httpFetch: HttpFetch = fetch,
): Promise<{ comment: string; updateTime: string | null }> {
  if (!/^accounts\/\d+\/locations\/\d+\/reviews\/[\w-]+$/.test(reviewName))
    throw Errors.badRequest('Invalid review.');
  const data = await gbpRequest<{ comment?: string; updateTime?: string }>(
    prisma,
    integrationId,
    `${REVIEWS_API}/${reviewName}/reply`,
    { method: 'PUT', body: JSON.stringify({ comment }) },
    httpFetch,
  );
  return { comment: data.comment ?? comment, updateTime: data.updateTime ?? null };
}

/**
 * Patches the editable own-fields of a Business Profile location (name, phone, website, description). Only the
 * fields present are sent, with a matching updateMask. Callers must check the approval first. Google rejects edits
 * when the account lacks "voice of merchant" (unverified/ownership lost); that error is surfaced to the caller.
 */
export async function updateProfileLocation(
  prisma: PrismaClient,
  integrationId: string,
  locationName: string,
  fields: { title?: string; primaryPhone?: string; websiteUri?: string; description?: string },
  httpFetch: HttpFetch = fetch,
): Promise<GbpLocation> {
  if (!/^locations\/\d+$/.test(locationName))
    throw Errors.badRequest('The location is not linked to a Business Profile.');
  const mask: string[] = [];
  const body: Record<string, unknown> = {};
  if (fields.title !== undefined) {
    body.title = fields.title;
    mask.push('title');
  }
  if (fields.primaryPhone !== undefined) {
    body.phoneNumbers = { primaryPhone: fields.primaryPhone };
    mask.push('phoneNumbers.primaryPhone');
  }
  if (fields.websiteUri !== undefined) {
    body.websiteUri = fields.websiteUri;
    mask.push('websiteUri');
  }
  if (fields.description !== undefined) {
    body.profile = { description: fields.description };
    mask.push('profile.description');
  }
  if (!mask.length) throw Errors.badRequest('No profile fields to update.');
  return gbpRequest<GbpLocation>(
    prisma,
    integrationId,
    `${INFO_API}/${locationName}?updateMask=${encodeURIComponent(mask.join(','))}`,
    { method: 'PATCH', body: JSON.stringify(body) },
    httpFetch,
  );
}

/** Publishes a Business Profile post (localPost). Callers must check the approval first. */
export async function createLocalPost(
  prisma: PrismaClient,
  integrationId: string,
  accountName: string,
  locationName: string,
  post: {
    summary: string;
    topicType: string;
    languageCode: string;
    callToAction?: { actionType: string; url: string };
  },
  httpFetch: HttpFetch = fetch,
): Promise<{ name: string | null; searchUrl: string | null }> {
  if (!/^accounts\/\d+$/.test(accountName) || !/^locations\/\d+$/.test(locationName))
    throw Errors.badRequest('The location is not linked to a Business Profile.');
  const data = await gbpRequest<{ name?: string; searchUrl?: string }>(
    prisma,
    integrationId,
    `${REVIEWS_API}/${accountName}/${locationName}/localPosts`,
    {
      method: 'POST',
      body: JSON.stringify({
        languageCode: post.languageCode,
        summary: post.summary,
        topicType: post.topicType,
        ...(post.callToAction ? { callToAction: post.callToAction } : {}),
      }),
    },
    httpFetch,
  );
  return { name: data.name ?? null, searchUrl: data.searchUrl ?? null };
}

// ---------------- Mapping ----------------

const two = (n: number) => String(n).padStart(2, '0');
const clock = (t: TimeOfDay | undefined) => `${two(t?.hours ?? 0)}:${two(t?.minutes ?? 0)}`;
const isWeekday = (d: string | undefined): d is Weekday => (WEEKDAYS as readonly string[]).includes(d ?? '');

/** Google periods to Surfaced periods; a period that ends on a later day is split at midnight. */
export function periodsFromGoogle(periods: GbpPeriod[] = []): OpeningPeriod[] {
  const out: OpeningPeriod[] = [];
  for (const p of periods) {
    if (!isWeekday(p.openDay)) continue;
    const open = clock(p.openTime);
    const close = clock(p.closeTime);
    if (!p.closeDay || p.closeDay === p.openDay) {
      out.push({ day: p.openDay, open, close: close === '00:00' ? '24:00' : close });
      continue;
    }
    out.push({ day: p.openDay, open, close: '24:00' });
    if (isWeekday(p.closeDay) && close !== '00:00') out.push({ day: p.closeDay, open: '00:00', close });
  }
  return out;
}

export function toProfileView(raw: GbpLocation): ProfileView {
  const address = raw.storefrontAddress;
  const hasAddress = Boolean(
    address && (address.addressLines?.length || address.locality || address.postalCode),
  );
  const businessType = raw.serviceArea?.businessType;
  const status = raw.openInfo?.status;
  return {
    name: raw.name,
    title: raw.title ?? '',
    storeCode: raw.storeCode ?? null,
    primaryCategory: raw.categories?.primaryCategory?.displayName ?? null,
    additionalCategories: (raw.categories?.additionalCategories ?? [])
      .map((c) => c.displayName ?? '')
      .filter(Boolean),
    primaryPhone: raw.phoneNumbers?.primaryPhone ?? null,
    additionalPhones: raw.phoneNumbers?.additionalPhones ?? [],
    websiteUri: raw.websiteUri ?? null,
    address: hasAddress
      ? {
          lines: address?.addressLines ?? [],
          sublocality: address?.sublocality ?? null,
          locality: address?.locality ?? null,
          administrativeArea: address?.administrativeArea ?? null,
          postalCode: address?.postalCode ?? null,
          regionCode: address?.regionCode ?? null,
        }
      : null,
    serviceArea: raw.serviceArea
      ? {
          businessType:
            businessType === 'CUSTOMER_LOCATION_ONLY' || businessType === 'CUSTOMER_AND_BUSINESS_LOCATION'
              ? businessType
              : null,
          places: (raw.serviceArea.places?.placeInfos ?? []).map((p) => p.placeName ?? '').filter(Boolean),
        }
      : null,
    regularHours: periodsFromGoogle(raw.regularHours?.periods),
    specialHoursCount: raw.specialHours?.specialHourPeriods?.length ?? 0,
    description: raw.profile?.description?.trim() || null,
    openStatus:
      status === 'OPEN' || status === 'CLOSED_PERMANENTLY' || status === 'CLOSED_TEMPORARILY' ? status : null,
    latitude: typeof raw.latlng?.latitude === 'number' ? raw.latlng.latitude : null,
    longitude: typeof raw.latlng?.longitude === 'number' ? raw.latlng.longitude : null,
    placeId: raw.metadata?.placeId ?? null,
    mapsUri: raw.metadata?.mapsUri ?? null,
    newReviewUri: raw.metadata?.newReviewUri ?? null,
    hasVoiceOfMerchant:
      typeof raw.metadata?.hasVoiceOfMerchant === 'boolean' ? raw.metadata.hasVoiceOfMerchant : null,
    hasPendingEdits: raw.metadata?.hasPendingEdits === true,
    hasGoogleUpdated: raw.metadata?.hasGoogleUpdated === true,
    labels: raw.labels ?? [],
  };
}

export function formatProfileAddress(view: Pick<ProfileView, 'address'>): string | null {
  const a = view.address;
  if (!a) return null;
  return [...a.lines, a.sublocality, [a.locality, a.postalCode].filter(Boolean).join(' ')]
    .filter(Boolean)
    .join(', ');
}

/**
 * A new Surfaced location from a profile, created only when a user asks for it. The values become the business's
 * own record; Surfaced does not refresh them from Google afterwards (the 30-day snapshot shows the live profile).
 */
export function locationFromProfile(view: ProfileView, isPrimary: boolean): LocationData {
  const serviceOnly = view.serviceArea?.businessType === 'CUSTOMER_LOCATION_ONLY' || !view.address;
  const hybrid = view.serviceArea?.businessType === 'CUSTOMER_AND_BUSINESS_LOCATION' && Boolean(view.address);
  const lines = view.address?.lines ?? [];
  const city =
    view.address?.locality ?? view.serviceArea?.places[0] ?? view.address?.administrativeArea ?? '';
  return {
    name: view.title.slice(0, 200),
    kind: serviceOnly ? 'SERVICE_AREA' : hybrid ? 'HYBRID' : 'STOREFRONT',
    primaryCategory: view.primaryCategory?.slice(0, 120) ?? null,
    secondaryCategories: view.additionalCategories.slice(0, 10).map((c) => c.slice(0, 120)),
    addressLine1: serviceOnly ? null : (lines[0]?.slice(0, 200) ?? null),
    addressLine2: serviceOnly ? null : lines.slice(1).join(', ').slice(0, 200) || null,
    locality: view.address?.sublocality?.slice(0, 120) ?? null,
    city: (city || 'Unknown').slice(0, 120),
    region: view.address?.administrativeArea?.slice(0, 120) ?? null,
    postalCode: view.address?.postalCode?.slice(0, 20) ?? null,
    country: (view.address?.regionCode ?? 'US').toUpperCase().slice(0, 2),
    serviceAreas: (view.serviceArea?.places ?? []).slice(0, 30).map((p) => p.slice(0, 120)),
    latitude: view.latitude,
    longitude: view.longitude,
    phone: view.primaryPhone?.slice(0, 40) ?? null,
    email: null,
    websiteUrl: view.websiteUri && view.websiteUri.length <= 2048 ? view.websiteUri : null,
    openingHours: view.regularHours.slice(0, 28),
    isPrimary,
    placeId: view.placeId,
  };
}

const STAR: Record<string, number> = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };

function reviewRow(
  projectId: string,
  locationId: string,
  review: GbpReview,
  fetchedAt: Date,
): Prisma.BusinessReviewUncheckedCreateInput {
  const date = (s: string | undefined) => (s && !Number.isNaN(Date.parse(s)) ? new Date(s) : null);
  return {
    projectId,
    locationId,
    reviewName: review.name.slice(0, 255),
    reviewerName: review.reviewer?.isAnonymous ? null : (review.reviewer?.displayName?.slice(0, 255) ?? null),
    isAnonymous: review.reviewer?.isAnonymous === true,
    starRating: STAR[review.starRating ?? ''] ?? null,
    comment: review.comment ?? null,
    createTime: date(review.createTime) ?? fetchedAt,
    updateTime: date(review.updateTime),
    replyComment: review.reviewReply?.comment ?? null,
    replyUpdateTime: date(review.reviewReply?.updateTime),
    fetchedAt,
  };
}

// ---------------- Sync and retention ----------------

export interface ProfileSyncResult {
  locations: number;
  failed: number;
  reviews: number;
  metricDays: number;
  errors: string[];
}

/** Syncs every linked location of the integration's project. One failing location does not stop the others. */
export async function syncBusinessProfile(
  prisma: PrismaClient,
  integrationId: string,
  httpFetch: HttpFetch = fetch,
  now = new Date(),
): Promise<ProfileSyncResult> {
  const integration = await prisma.integration.findUniqueOrThrow({ where: { id: integrationId } });
  if (integration.provider !== 'GOOGLE_BUSINESS_PROFILE')
    throw Errors.badRequest('Not a Business Profile integration.');
  const locations = await prisma.businessLocation.findMany({
    where: { projectId: integration.projectId, archivedAt: null, profileLocationName: { not: null } },
  });
  if (!locations.length) throw Errors.badRequest('Link a Business Profile location before syncing.');
  const result: ProfileSyncResult = { locations: 0, failed: 0, reviews: 0, metricDays: 0, errors: [] };
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));
  const from = new Date(to.getTime() - (PROFILE_METRIC_DAYS - 1) * 86_400_000);
  let firstError: unknown = null;
  for (const location of locations) {
    const locationName = location.profileLocationName!;
    try {
      const raw = await getProfileLocation(prisma, integrationId, locationName, httpFetch);
      const view = toProfileView(raw);
      const metrics = await fetchProfileMetrics(prisma, integrationId, locationName, from, to, httpFetch);
      const reviews = location.profileAccountName
        ? await listProfileReviews(
            prisma,
            integrationId,
            location.profileAccountName,
            locationName,
            httpFetch,
          )
        : null;
      const fetchedAt = new Date();
      await prisma.$transaction(
        async (tx) => {
          await tx.businessProfileSnapshot.create({
            data: {
              projectId: location.projectId,
              locationId: location.id,
              profileLocationName: locationName,
              data: raw as unknown as Prisma.InputJsonValue,
              averageRating: reviews?.averageRating ?? null,
              totalReviewCount: reviews?.totalReviewCount ?? null,
              fetchedAt,
            },
          });
          await tx.businessProfileMetric.deleteMany({ where: { locationId: location.id } });
          if (metrics.length)
            await tx.businessProfileMetric.createMany({
              data: metrics.map((m) => ({
                projectId: location.projectId,
                locationId: location.id,
                metric: m.metric,
                date: new Date(`${m.date}T00:00:00Z`),
                value: m.value,
                fetchedAt,
              })),
              skipDuplicates: true,
            });
          if (reviews) {
            for (const review of reviews.reviews) {
              const row = reviewRow(location.projectId, location.id, review, fetchedAt);
              await tx.businessReview.upsert({
                where: { reviewName: row.reviewName },
                create: row,
                update: row,
              });
            }
            // Reviews removed on Google are removed here too (only known when every page was read).
            if (reviews.complete)
              await tx.businessReview.deleteMany({
                where: { locationId: location.id, fetchedAt: { lt: fetchedAt } },
              });
          }
          if (view.placeId && !location.placeId)
            await tx.businessLocation.update({ where: { id: location.id }, data: { placeId: view.placeId } });
        },
        { timeout: 30_000 },
      );
      result.locations += 1;
      result.reviews += reviews?.reviews.length ?? 0;
      result.metricDays = Math.max(result.metricDays, new Set(metrics.map((m) => m.date)).size);
    } catch (error) {
      firstError ??= error;
      result.failed += 1;
      result.errors.push(
        `${location.name}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500),
      );
    }
  }
  if (result.locations === 0 && firstError) {
    await prisma.integration.update({
      where: { id: integrationId },
      data: { lastSyncStatus: 'FAILED', lastError: result.errors.join('\n').slice(0, 2000) },
    });
    throw firstError;
  }
  await prisma.integration.update({
    where: { id: integrationId },
    data: {
      lastSyncAt: new Date(),
      lastSyncStatus: result.failed ? 'PARTIAL' : 'SUCCEEDED',
      lastError: result.failed ? result.errors.join('\n').slice(0, 2000) : null,
    },
  });
  return result;
}

const retentionCutoff = (now: Date) => new Date(now.getTime() - PROFILE_DATA_RETENTION_DAYS * 86_400_000);

/** Deletes Business Profile content stored more than 30 days ago (Google's storage limit). */
export async function purgeExpiredProfileData(prisma: PrismaClient, now = new Date()) {
  const before = retentionCutoff(now);
  const [snapshots, metrics, reviews, summaries] = await Promise.all([
    prisma.businessProfileSnapshot.deleteMany({ where: { fetchedAt: { lt: before } } }),
    prisma.businessProfileMetric.deleteMany({ where: { fetchedAt: { lt: before } } }),
    prisma.businessReview.deleteMany({ where: { fetchedAt: { lt: before } } }),
    // The summary is derived from review content, so it expires on the same schedule.
    prisma.businessReviewSummary.deleteMany({ where: { generatedAt: { lt: before } } }),
  ]);
  return { snapshots: snapshots.count, metrics: metrics.count, reviews: reviews.count, summaries: summaries.count }; // prettier-ignore
}

/** Deletes all stored Business Profile content of a project, or of one location (on disconnect or unlink). */
export async function deleteProfileData(
  prisma: PrismaClient | Prisma.TransactionClient,
  where: { projectId: string; locationId?: string },
) {
  const filter = {
    projectId: where.projectId,
    ...(where.locationId ? { locationId: where.locationId } : {}),
  };
  await prisma.businessProfileSnapshot.deleteMany({ where: filter });
  await prisma.businessProfileMetric.deleteMany({ where: filter });
  await prisma.businessReview.deleteMany({ where: filter });
  await prisma.businessReviewSummary.deleteMany({ where: filter });
}

export { retentionCutoff as profileRetentionCutoff };

// ---------------- Metric summaries ----------------

const METRIC_WINDOW_DAYS = 28;
const MAPS_METRICS: ProfileDailyMetric[] = [
  'BUSINESS_IMPRESSIONS_MOBILE_MAPS',
  'BUSINESS_IMPRESSIONS_DESKTOP_MAPS',
];
const SEARCH_METRICS: ProfileDailyMetric[] = [
  'BUSINESS_IMPRESSIONS_MOBILE_SEARCH',
  'BUSINESS_IMPRESSIONS_DESKTOP_SEARCH',
];
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);

/** Totals for the last 28 days of data and the 28 days before, plus a daily series for the chart. */
export function summarizeProfileMetrics(
  rows: { metric: string; date: Date; value: number }[],
  fetchedAt: Date,
): ProfileMetricsDto {
  const last = rows.reduce((max, r) => (r.date > max ? r.date : max), rows[0]!.date);
  const first = rows.reduce((min, r) => (r.date < min ? r.date : min), rows[0]!.date);
  const from = addDays(last, -(METRIC_WINDOW_DAYS - 1));
  const prevTo = addDays(from, -1);
  const prevFrom = addDays(prevTo, -(METRIC_WINDOW_DAYS - 1));
  const hasPrevious = first <= prevFrom;
  const sum = (metric: string, a: Date, b: Date) =>
    rows.filter((r) => r.metric === metric && r.date >= a && r.date <= b).reduce((s, r) => s + r.value, 0);
  const metrics = PROFILE_DAILY_METRICS.map((metric) => {
    const current = sum(metric, from, last);
    const previous = hasPrevious ? sum(metric, prevFrom, prevTo) : null;
    return {
      metric,
      label: PROFILE_METRIC_LABELS[metric],
      current,
      previous,
      changePercent: previous ? Math.round(((current - previous) / previous) * 1000) / 10 : null,
    };
  }).filter((m) => m.current > 0 || (m.previous ?? 0) > 0);
  const byDay = new Map<string, { maps: number; search: number; actions: number }>();
  for (let d = from; d <= last; d = addDays(d, 1)) byDay.set(isoDay(d), { maps: 0, search: 0, actions: 0 });
  for (const r of rows) {
    const day = byDay.get(isoDay(r.date));
    if (!day) continue;
    if (MAPS_METRICS.includes(r.metric as ProfileDailyMetric)) day.maps += r.value;
    else if (SEARCH_METRICS.includes(r.metric as ProfileDailyMetric)) day.search += r.value;
    else day.actions += r.value;
  }
  return {
    range: { from: isoDay(from), to: isoDay(last) },
    previousRange: hasPrevious ? { from: isoDay(prevFrom), to: isoDay(prevTo) } : null,
    metrics,
    daily: [...byDay.entries()].map(([date, v]) => ({ date, ...v })),
    fetchedAt: fetchedAt.toISOString(),
    limitations: [
      'Views count unique people per day on each surface, as Google defines them; they are not searches or rankings.',
      ...(hasPrevious ? [] : ['Fewer than 56 days of data: no comparison with the previous period yet.']),
    ],
  };
}
