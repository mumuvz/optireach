// Google Business Profile: the profile as Google returns it (normalized for display), the profile audit, performance
// metrics, and reviews with reply drafts. Google allows Business Profile content to be stored for at most 30 days, so
// everything here is either recent data from Google or the business's own records (reply drafts and approvals).
import { z } from 'zod';
import type { LocationKind, OpeningPeriod } from './local';

export const PROFILE_DATA_RETENTION_DAYS = 30;

/** Daily metrics requested from the Business Profile Performance API (deprecated ones left out). */
export const PROFILE_DAILY_METRICS = [
  'BUSINESS_IMPRESSIONS_MOBILE_MAPS',
  'BUSINESS_IMPRESSIONS_DESKTOP_MAPS',
  'BUSINESS_IMPRESSIONS_MOBILE_SEARCH',
  'BUSINESS_IMPRESSIONS_DESKTOP_SEARCH',
  'CALL_CLICKS',
  'BUSINESS_DIRECTION_REQUESTS',
  'WEBSITE_CLICKS',
  'MESSAGING_CLICKS',
  'BUSINESS_BOOKINGS',
  'BUSINESS_FOOD_MENU_CLICKS',
] as const;
export type ProfileDailyMetric = (typeof PROFILE_DAILY_METRICS)[number];
export const PROFILE_METRIC_LABELS: Record<ProfileDailyMetric, string> = {
  BUSINESS_IMPRESSIONS_MOBILE_MAPS: 'Views on Google Maps (mobile)',
  BUSINESS_IMPRESSIONS_DESKTOP_MAPS: 'Views on Google Maps (desktop)',
  BUSINESS_IMPRESSIONS_MOBILE_SEARCH: 'Views on Google Search (mobile)',
  BUSINESS_IMPRESSIONS_DESKTOP_SEARCH: 'Views on Google Search (desktop)',
  CALL_CLICKS: 'Call button clicks',
  BUSINESS_DIRECTION_REQUESTS: 'Direction requests',
  WEBSITE_CLICKS: 'Website clicks',
  MESSAGING_CLICKS: 'Messaging clicks',
  BUSINESS_BOOKINGS: 'Bookings (Reserve with Google)',
  BUSINESS_FOOD_MENU_CLICKS: 'Menu clicks',
};

/** The parts of a Business Profile location that Surfaced reads, as Google returned them. */
export interface ProfileView {
  /** Google's resource name, locations/{id}. */
  name: string;
  title: string;
  storeCode: string | null;
  primaryCategory: string | null;
  additionalCategories: string[];
  primaryPhone: string | null;
  additionalPhones: string[];
  websiteUri: string | null;
  address: {
    lines: string[];
    sublocality: string | null;
    locality: string | null;
    administrativeArea: string | null;
    postalCode: string | null;
    regionCode: string | null;
  } | null;
  serviceArea: {
    businessType: 'CUSTOMER_LOCATION_ONLY' | 'CUSTOMER_AND_BUSINESS_LOCATION' | null;
    places: string[];
  } | null;
  /** Regular hours; periods past midnight are split at midnight. */
  regularHours: OpeningPeriod[];
  specialHoursCount: number;
  description: string | null;
  openStatus: 'OPEN' | 'CLOSED_PERMANENTLY' | 'CLOSED_TEMPORARILY' | null;
  latitude: number | null;
  longitude: number | null;
  placeId: string | null;
  mapsUri: string | null;
  newReviewUri: string | null;
  /** False means the account cannot publish edits to this profile (not verified, or ownership lost). */
  hasVoiceOfMerchant: boolean | null;
  hasPendingEdits: boolean;
  hasGoogleUpdated: boolean;
  labels: string[];
}

export interface ProfileAccountDto {
  /** accounts/{id} */
  name: string;
  accountName: string;
  type: string | null;
  role: string | null;
  verificationState: string | null;
}

export interface ProfileLocationOptionDto {
  name: string;
  title: string;
  address: string | null;
  storeCode: string | null;
  primaryCategory: string | null;
  placeId: string | null;
  hasVoiceOfMerchant: boolean | null;
  /** The Surfaced location already linked to this profile, if any. */
  linkedLocationId: string | null;
}

export const profileAccountNameSchema = z.string().regex(/^accounts\/\d{1,30}$/, 'Invalid account');
export const profileLocationNameSchema = z.string().regex(/^locations\/\d{1,30}$/, 'Invalid location');

export const profileLinkSchema = z.object({
  accountName: profileAccountNameSchema,
  profileLocationName: profileLocationNameSchema,
  /** Link this existing location; null creates a location from the profile. */
  locationId: z.string().min(1).max(32).nullable().default(null),
});
export type ProfileLinkInput = z.input<typeof profileLinkSchema>;

// ---------------- Profile audit ----------------

export type ProfileCheckStatus = 'pass' | 'fail' | 'not_applicable' | 'unknown';
export type ProfileCheckSeverity = 'critical' | 'warning' | 'suggestion';

/**
 * One check. Only applicable checks count (a business without a website is not marked down for having no website
 * on its profile); "unknown" means the data needed is not available (for example, not connected).
 */
export interface ProfileAuditCheck {
  key: string;
  title: string;
  status: ProfileCheckStatus;
  severity: ProfileCheckSeverity;
  /** What was checked and the values found. */
  evidence: string;
  recommendation: string | null;
  /** How to confirm the fix. */
  verification: string | null;
  /** Google's guideline or help page. */
  reference: string | null;
}

export interface ProfileAuditDto {
  /** BUSINESS_PROFILE: the live profile from Google. MANUAL: the details entered in Surfaced. */
  source: 'BUSINESS_PROFILE' | 'MANUAL';
  checkedAt: string;
  /** Checks that apply and could be evaluated. */
  applicable: number;
  passed: number;
  checks: ProfileAuditCheck[];
  limitations: string[];
}

// ---------------- Performance ----------------

export interface ProfileMetricSummary {
  metric: ProfileDailyMetric;
  label: string;
  current: number;
  previous: number | null;
  /** Percent change against the previous period; null when the previous period was zero or not available. */
  changePercent: number | null;
}

export interface ProfileMetricsDto {
  range: { from: string; to: string };
  previousRange: { from: string; to: string } | null;
  metrics: ProfileMetricSummary[];
  /** Views on Maps and Search, by day, for the chart. */
  daily: { date: string; maps: number; search: number; actions: number }[];
  fetchedAt: string;
  limitations: string[];
}

// ---------------- Reviews and replies ----------------

export const REVIEW_REPLY_STATUSES = [
  'DRAFT',
  'AWAITING_APPROVAL',
  'PUBLISHING',
  'PUBLISHED',
  'FAILED',
  'DISCARDED',
] as const;
export type ReviewReplyStatus = (typeof REVIEW_REPLY_STATUSES)[number];

export interface ReviewReplyDto {
  id: string;
  reviewName: string;
  comment: string;
  /** AI: drafted by the configured model (and possibly edited since). HUMAN: written by a person. */
  origin: 'AI' | 'HUMAN';
  model: string | null;
  status: ReviewReplyStatus;
  approval: { id: string; status: string; coversCurrentText: boolean } | null;
  /** Approved for exactly this text and not yet published. */
  canPublish: boolean;
  publishedAt: string | null;
  publishError: string | null;
  createdBy: { id: string; name: string } | null;
  createdAt: string;
  updatedAt: string;
}

export interface BusinessReviewDto {
  id: string;
  reviewName: string;
  reviewerName: string | null;
  isAnonymous: boolean;
  starRating: number | null;
  comment: string | null;
  createTime: string;
  updateTime: string | null;
  reply: { comment: string; updateTime: string | null } | null;
  fetchedAt: string;
  /** The latest reply draft that is not discarded. */
  draft: ReviewReplyDto | null;
}

/** Google allows replies of up to 4096 bytes. */
export const REVIEW_REPLY_MAX_BYTES = 4096;
const replyText = z
  .string()
  .trim()
  .min(1, 'Write the reply')
  .max(4096)
  .refine(
    (s) => new TextEncoder().encode(s).length <= REVIEW_REPLY_MAX_BYTES,
    'Google allows up to 4096 bytes',
  );

export const reviewReplyDraftSchema = z
  .object({
    comment: replyText.optional(),
    /** Ask the configured AI model for a draft (it is never published without approval). */
    generate: z.boolean().default(false),
    /** Guidance for the draft, e.g. "apologise for the wait and invite them back". */
    instructions: z.string().trim().max(500).optional(),
  })
  .refine((v) => v.generate || v.comment, { message: 'Write a reply or ask for a draft', path: ['comment'] });
export type ReviewReplyDraftInput = z.input<typeof reviewReplyDraftSchema>;

export const reviewReplyUpdateSchema = z.object({ comment: replyText });

export const reviewListQuerySchema = z.object({
  filter: z.enum(['all', 'unanswered', 'negative']).default('all'),
});

// ---------------- Review sentiment & themes ----------------

export const REVIEW_SENTIMENTS = ['positive', 'neutral', 'negative'] as const;
export type ReviewSentiment = (typeof REVIEW_SENTIMENTS)[number];

export interface ReviewThemeDto {
  /** A short recurring topic, e.g. "wait times" or "staff friendliness". */
  theme: string;
  sentiment: 'positive' | 'negative' | 'mixed';
  /** How many reviews mention it (as judged by the model). */
  mentions: number;
  /** A short real phrase from a review, or null. */
  example: string | null;
}

export interface ReviewSummaryDto {
  /** Reviews with text the summary was built from. */
  reviewCount: number;
  /** Count of reviews by overall sentiment (from the model, reconciled to the review count; dev adapter uses stars). */
  sentiment: { positive: number; neutral: number; negative: number };
  themes: ReviewThemeDto[];
  summary: string;
  model: string | null;
  /** True when produced by the development adapter (not a real model); themes are empty in that case. */
  isDevAdapter: boolean;
  generatedAt: string;
  /** True when reviews newer than this summary have been fetched since it was generated. */
  stale: boolean;
}

// ---------------- Profile field write-back ----------------

/** The own-profile fields Surfaced can propose edits to (published to Google only after a LOCATION_CHANGE approval). */
export const PROFILE_EDITABLE_FIELDS = ['title', 'primaryPhone', 'websiteUri', 'description'] as const;
export type ProfileEditableField = (typeof PROFILE_EDITABLE_FIELDS)[number];
export const PROFILE_FIELD_LABELS: Record<ProfileEditableField, string> = {
  title: 'Business name',
  primaryPhone: 'Primary phone',
  websiteUri: 'Website',
  description: 'Description',
};
/** Google caps the profile description at 750 characters. */
export const PROFILE_DESCRIPTION_MAX = 750;

export const profileChangeSchema = z
  .object({
    title: z.string().trim().min(1).max(300).optional(),
    primaryPhone: z.string().trim().min(3).max(40).optional(),
    websiteUri: z.string().trim().url('Enter a full URL (https://…)').max(2048).optional(),
    description: z.string().trim().min(1).max(PROFILE_DESCRIPTION_MAX).optional(),
  })
  .refine(
    (v) => PROFILE_EDITABLE_FIELDS.some((f) => v[f] !== undefined),
    'Change at least one field to propose an edit.',
  );
export type ProfileChangeInput = z.input<typeof profileChangeSchema>;

export interface ProfileChangeRequestDto {
  id: string;
  status: 'DRAFT' | 'AWAITING_APPROVAL' | 'PUBLISHING' | 'PUBLISHED' | 'FAILED' | 'DISCARDED';
  /** Only the fields being changed and their proposed values. */
  fields: Partial<Record<ProfileEditableField, string>>;
  approval: { id: string; status: string; coversCurrentText: boolean } | null;
  /** Approved for exactly these values and not yet published. */
  canPublish: boolean;
  publishedAt: string | null;
  publishError: string | null;
  createdBy: { id: string; name: string } | null;
  createdAt: string;
  updatedAt: string;
}

// ---------------- Page data ----------------

export interface BusinessProfileIntegrationDto {
  id: string;
  status: string;
  externalAccount: string | null;
  connectedAt: string | null;
  lastSyncAt: string | null;
  lastSyncStatus: string | null;
  lastError: string | null;
}

export interface BusinessProfileStatusDto {
  /** The Google OAuth client is configured in this installation. */
  configured: boolean;
  setup: string;
  integration: BusinessProfileIntegrationDto | null;
  retentionDays: number;
  locations: {
    id: string;
    name: string;
    city: string;
    kind: LocationKind;
    profileLocationName: string | null;
    profileAccountName: string | null;
    snapshotAt: string | null;
    unansweredReviews: number;
  }[];
}

export interface BusinessProfileLocationDto {
  location: {
    id: string;
    name: string;
    city: string;
    kind: LocationKind;
    profileLocationName: string | null;
    profileAccountName: string | null;
  };
  profile: ProfileView | null;
  snapshotAt: string | null;
  /** As Google reports them for the profile (not computed by Surfaced). */
  reviewTotals: { averageRating: number | null; totalReviewCount: number | null } | null;
  audit: ProfileAuditDto;
  metrics: ProfileMetricsDto | null;
  reviews: BusinessReviewDto[];
  unansweredReviews: number;
  /** The latest AI sentiment/theme summary over the reviews, or null if none has been generated. */
  reviewSummary: ReviewSummaryDto | null;
  /** The latest open (not discarded) proposed profile edit for this location, or null. */
  profileChange: ProfileChangeRequestDto | null;
  limitations: string[];
}
