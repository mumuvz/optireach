// Business research from an observed local ranking: where a business ranks for a search, how it compares with the
// listings ranked above it (only what the collected results show), and an action plan grounded in that comparison
// and in Google's published guidance. Nothing here claims to know Google's algorithm or promises a position.
import { z } from 'zod';
import { LLM_PROVIDER_KEYS } from './enums';
import type { LocalObservationType, LocalRankSource, LocalResult } from './local';

export interface ObservedPosition {
  /** Global position when the page offset was known, else the position on its own page. */
  position: number;
  pageLocal: boolean;
  page: number | null;
  /** Position among organic listings in the same order (ads excluded); null for ads and page-local positions. */
  organicPosition: number | null;
}

/** Where each stored listing sits in the observed order. Ads keep their place on the page but have no organic rank. */
export function observedPositions(results: LocalResult[]): ObservedPosition[] {
  const multiPage = results.some((r) => (r.batch ?? 1) > 1);
  const base = results.map((r) => {
    const pageLocal = multiPage && r.cumulativePosition == null;
    return { position: pageLocal ? (r.sourcePosition ?? r.rank) : r.rank, pageLocal, page: r.batch ?? null };
  });
  const organicGlobal = base.filter((b, i) => !b.pageLocal && !results[i]!.sponsored).map((b) => b.position);
  return base.map((b, i) => ({
    ...b,
    organicPosition:
      b.pageLocal || results[i]!.sponsored ? null : organicGlobal.filter((p) => p <= b.position).length,
  }));
}

export const RESEARCH_AREAS = ['reviews', 'profile', 'category', 'photos', 'products', 'posts', 'website', 'citations', 'policy'] as const; // prettier-ignore
export type ResearchArea = (typeof RESEARCH_AREAS)[number];
export const RESEARCH_AREA_LABELS: Record<ResearchArea, string> = {
  reviews: 'Reviews',
  profile: 'Profile details',
  category: 'Category',
  photos: 'Photos & videos',
  products: 'Products',
  posts: 'Posts & offers',
  website: 'Website',
  citations: 'Listings across the web',
  policy: 'Google’s rules',
};
export const RESEARCH_PRIORITIES = ['high', 'medium', 'low'] as const;
export type ResearchPriority = (typeof RESEARCH_PRIORITIES)[number];
export const RESEARCH_EFFORTS = ['low', 'medium', 'high'] as const;
export type ResearchEffort = (typeof RESEARCH_EFFORTS)[number];

/** One listing as the research sees it: only what the collected results showed. */
export interface ResearchListing {
  /** Index of the listing in the scan point's results (stable: results are only appended). */
  index: number;
  title: string;
  /** Position as observed: global when the page offset was known, else the position on its own page. */
  position: number;
  /** Position counting only organic (non-sponsored) listings; null when positions are page-local. */
  organicPosition: number | null;
  /** True when `position` is the position on its own page (that page's offset was unknown). */
  pageLocal: boolean;
  /** The saved page or batch the listing came from. */
  page: number | null;
  sponsored: boolean;
  rating: number | null;
  reviewCount: number | null;
  category: string | null;
  address: string | null;
  /** Card details. phoneShown and serviceOptions are null when they were not captured for this listing (an older
   * capture or another source); hours is null when none was shown or not captured. */
  hours: string | null;
  serviceOptions: string[] | null;
  phoneShown: boolean | null;
  reviewSnippet: string | null;
  website: string | null;
  /** Whether the profile lists a website (from the saved page's own data); null when not known (older collections
   * have no value, so read it as possibly undefined). */
  websiteListed: boolean | null;
  /** The tracked business (matched by place ID, website or exact name). */
  isTarget: boolean;
}

export const RESEARCH_FINDING_TONES = ['gap', 'strength', 'info'] as const;
export type ResearchFindingTone = (typeof RESEARCH_FINDING_TONES)[number];

/** A comparison computed from the collected listings (no AI involved), cited by the action plan as F1, F2, … */
export interface ResearchFinding {
  id: string;
  area: ResearchArea | 'ranking' | 'distance';
  tone: ResearchFindingTone;
  title: string;
  detail: string;
}

export interface ResearchFieldStats {
  listings: number;
  organic: number;
  sponsored: number;
  medianRating: number | null;
  medianReviews: number | null;
  /** Over the top three organic listings. */
  leadersMedianRating: number | null;
  leadersMedianReviews: number | null;
  /** Categories as shown, most common first, with how many of the top three use each. */
  categories: { category: string; count: number; inLeaders: number }[];
  /** Listings whose hours, phone and service options were captured (older captures did not record them). */
  detailsCaptured: number;
  withPhone: number;
  withHours: number;
  withServiceOptions: number;
  /** Listings whose profile website is known (from the page's data); of those, how many list a website, and how many
   * link a site of their own (not a social media page). Absent on research made before websites were captured. */
  websiteKnown?: number;
  withWebsite?: number;
  withOwnSite?: number;
}

/** The same business in the project's other collected searches (latest collection of each search). */
export interface ResearchOtherSearch {
  scanId: string;
  query: string;
  position: number;
  pageLocal: boolean;
  listings: number;
  capturedAt: string;
}

export interface LocalResearchEvidence {
  query: string;
  location: string | null;
  source: LocalRankSource;
  observationType: LocalObservationType;
  capturedAt: string | null;
  target: ResearchListing;
  /** Up to five organic listings directly above the business, nearest first. */
  above: ResearchListing[];
  /** The top three organic listings other than the business itself. */
  leaders: ResearchListing[];
  field: ResearchFieldStats;
  findings: ResearchFinding[];
  otherSearches: ResearchOtherSearch[];
  limitations: string[];
}

export interface ResearchAction {
  title: string;
  area: ResearchArea;
  priority: ResearchPriority;
  effort: ResearchEffort;
  /** Why, in terms of the comparison. */
  why: string;
  steps: string[];
  /** Finding IDs (F1, F2, …) this action is based on; empty for general good practice. */
  evidence: string[];
}

export interface LocalResearchReport {
  summary: string;
  strengths: string[];
  actions: ResearchAction[];
  /** What to check on the profile itself: things the results page cannot show. */
  verify: string[];
  /** Suggestions dropped because they conflicted with Google's rules (paid or gated reviews, keyword names, …). */
  removedForPolicy: number;
}

export interface LocalResearchSummaryDto {
  id: string;
  scanId: string;
  resultIndex: number;
  businessKey: string;
  businessName: string;
  position: number | null;
  pageLocal: boolean;
  query: string;
  provider: string;
  model: string | null;
  isDevAdapter: boolean;
  actions: number;
  createdAt: string;
}

export interface LocalResearchDto extends LocalResearchSummaryDto {
  evidence: LocalResearchEvidence;
  report: LocalResearchReport;
  createdBy: string | null;
}

export const localResearchRunSchema = z.object({
  /** The listing's index in the point's results. */
  resultIndex: z.number().int().min(0).max(10_000),
  row: z.number().int().min(0).max(20).default(0),
  col: z.number().int().min(0).max(20).default(0),
  provider: z.enum(LLM_PROVIDER_KEYS).optional(),
});
export type LocalResearchRunInput = z.input<typeof localResearchRunSchema>;

export const listingSearchSchema = z.object({ q: z.string().trim().min(2).max(100) });

/** A business found by name in the project's collected searches, with its position there. */
export interface ListingMatchDto {
  scanId: string;
  queryId: string;
  query: string;
  source: LocalRankSource;
  observationType: LocalObservationType;
  capturedAt: string;
  resultIndex: number;
  title: string;
  position: number;
  pageLocal: boolean;
  page: number | null;
  sponsored: boolean;
  rating: number | null;
  reviewCount: number | null;
  category: string | null;
  address: string | null;
  isTarget: boolean;
}

/** Google's own documentation the guidance below is taken from. */
export const LOCAL_RANKING_SOURCES = {
  ranking: { label: 'Google: tips to improve your local ranking', url: 'https://support.google.com/business/answer/7091' }, // prettier-ignore
  guidelines: { label: 'Google: guidelines for representing your business', url: 'https://support.google.com/business/answer/3038177' }, // prettier-ignore
  reviews: { label: 'Google Maps: prohibited & restricted content (fake engagement)', url: 'https://support.google.com/contributionpolicy/answer/7400114' }, // prettier-ignore
  schema: { label: 'Google Search Central: local business structured data', url: 'https://developers.google.com/search/docs/appearance/structured-data/local-business' }, // prettier-ignore
} as const;
export type LocalRankingSourceKey = keyof typeof LOCAL_RANKING_SOURCES;

/**
 * Good practice for local ranking, limited to what Google documents. Google: local results are mainly based on
 * relevance, distance and prominence; more reviews and positive ratings can help; there is no way to pay for a
 * better local ranking.
 */
export const LOCAL_RANKING_PRACTICES: {
  area: ResearchArea;
  title: string;
  detail: string;
  source: LocalRankingSourceKey;
}[] = [
  // prettier-ignore
  { area: 'category', title: 'Choose the most specific primary category', detail: 'Pick the fewest categories that describe the core business (“This business IS a …”). Relevance is how well a profile matches the search; categories are not keywords.', source: 'guidelines' }, // prettier-ignore
  { area: 'profile', title: 'Complete every field and keep it accurate', detail: 'Address, phone, website, regular hours, special hours for festivals and holidays, attributes and service options. Google says complete, accurate profiles are more likely to show in local results.', source: 'ranking' }, // prettier-ignore
  { area: 'profile', title: 'Verify the profile', detail: 'Verification tells Google you represent the business, which makes it more likely to show in results.', source: 'ranking' }, // prettier-ignore
  { area: 'reviews', title: 'Ask every customer for a genuine review', detail: 'Ask all customers, not only happy ones — for example a QR code at billing or a link after a purchase. No discounts, gifts or payment for reviews, no review quotas for staff, no reviews from employees or relatives.', source: 'reviews' }, // prettier-ignore
  { area: 'reviews', title: 'Reply to every review', detail: 'Thank people, answer concerns specifically and offer a way to resolve them. Google: positive reviews and helpful replies help a business stand out.', source: 'ranking' }, // prettier-ignore
  { area: 'photos', title: 'Add real photos and videos regularly', detail: 'Storefront (so customers recognise it), interior, products and team. Show what you offer.', source: 'ranking' }, // prettier-ignore
  { area: 'products', title: 'List products and collections', detail: 'For a jeweller: gold, diamond, silver and bridal collections with real photos. In eligible regions, in-store products can appear in local results.', source: 'ranking' }, // prettier-ignore
  { area: 'posts', title: 'Post updates and offers', detail: 'New collections, festive offers and events keep the profile current for customers. Offers must link to their terms; the description itself must not be a promotion.', source: 'guidelines' }, // prettier-ignore
  { area: 'website', title: 'Make the website match the profile', detail: 'The same name, address and phone, a page per location, and local business structured data. Google counts how many websites link to a business towards its prominence.', source: 'schema' }, // prettier-ignore
  { area: 'citations', title: 'Keep the business consistent across the web', detail: 'Directories, social profiles and local sites should show the same name, address and phone; local press and associations linking to you add to prominence.', source: 'ranking' }, // prettier-ignore
  { area: 'policy', title: 'Use the real-world name only', detail: 'No keywords, locations, taglines or ® in the name — it can lead to suspension. If a competitor’s name breaks this rule, use “Suggest an edit” on Google Maps.', source: 'guidelines' }, // prettier-ignore
  { area: 'policy', title: 'One profile per real location', detail: 'No virtual offices, P.O. boxes or duplicate profiles. Distance to the searcher is a ranking factor that cannot be changed by moving the pin.', source: 'guidelines' }, // prettier-ignore
  { area: 'policy', title: 'Ads are separate from ranking', detail: 'Sponsored listings are paid ads. Google says there is no way to request or pay for a better local ranking.', source: 'ranking' }, // prettier-ignore
];
