// Merchant Center and product data: the product catalog (from a feed file or the Merchant API), Surfaced's own
// country- and program-aware checks, Google's statuses when connected, and the eligibility checklist. Checks follow
// Google's published product data specification; they say what is likely to block or limit a listing, and Google
// decides the outcome (its own item issues are shown separately, as Google reports them).
import { z } from 'zod';
import { countryCodeSchema, languageCodeSchema } from './schemas/common';

export const PRODUCT_SOURCES = ['FEED_IMPORT', 'MERCHANT_API'] as const;
export type ProductSource = (typeof PRODUCT_SOURCES)[number];
export const PRODUCT_SOURCE_LABELS: Record<ProductSource, string> = {
  FEED_IMPORT: 'Product feed file (imported)',
  MERCHANT_API: 'Google Merchant Center (connected)',
};

export const PRODUCT_AVAILABILITY = [
  'in_stock',
  'out_of_stock',
  'preorder',
  'backorder',
  'limited_availability',
] as const;
export type ProductAvailability = (typeof PRODUCT_AVAILABILITY)[number];

export const PRODUCT_CONDITIONS = ['new', 'refurbished', 'used'] as const;
export type ProductCondition = (typeof PRODUCT_CONDITIONS)[number];

/** Where products can appear. Each is checked separately; they are never merged into one status. */
export const PRODUCT_PROGRAMS = ['FREE_LISTINGS', 'SHOPPING_ADS', 'FREE_LOCAL_LISTINGS'] as const;
export type ProductProgram = (typeof PRODUCT_PROGRAMS)[number];
export const PRODUCT_PROGRAM_LABELS: Record<ProductProgram, string> = {
  FREE_LISTINGS: 'Free listings (Google Search, Shopping tab, Images)',
  SHOPPING_ADS: 'Shopping ads (paid, in Google Ads)',
  FREE_LOCAL_LISTINGS: 'Free local listings (in-store products)',
};

export interface Money {
  amount: number;
  currency: string;
}

/** Product attributes in Google's product data specification (only those Surfaced reads). */
export interface ProductData {
  offerId: string;
  title: string | null;
  description: string | null;
  link: string | null;
  imageLink: string | null;
  additionalImageLinks: string[];
  price: Money | null;
  salePrice: Money | null;
  availability: string | null;
  condition: string | null;
  brand: string | null;
  gtins: string[];
  mpn: string | null;
  /** false: the product has no GTIN and no brand + MPN (for example custom or handmade pieces). */
  identifierExists: boolean | null;
  googleProductCategory: string | null;
  productTypes: string[];
  itemGroupId: string | null;
  color: string | null;
  material: string | null;
  pattern: string | null;
  size: string | null;
  gender: string | null;
  ageGroup: string | null;
  productDetails: { section: string | null; name: string; value: string }[];
}

export type ProductIssueSeverity = 'error' | 'warning' | 'suggestion';

export interface ProductIssue {
  code: string;
  /** error: likely disapproval for the programs listed; warning: limited performance; suggestion: improvement. */
  severity: ProductIssueSeverity;
  attribute: string | null;
  message: string;
  fix: string | null;
  programs: ProductProgram[];
  /** SURFACED: Surfaced's check of the data. GOOGLE: reported by Merchant Center for this product. */
  source: 'SURFACED' | 'GOOGLE';
  countries: string[];
  documentation: string | null;
}

/** What Merchant Center reports for one product and reporting context (only when connected). */
export interface ProductGoogleStatus {
  context: string;
  approvedCountries: string[];
  pendingCountries: string[];
  disapprovedCountries: string[];
}

export interface ProductDto extends ProductData {
  id: string;
  source: ProductSource;
  contentLanguage: string;
  /** Country the product data targets (feed label). */
  feedLabel: string;
  status: 'ok' | 'warnings' | 'errors';
  errorCount: number;
  warningCount: number;
  issues: ProductIssue[];
  googleStatus: ProductGoogleStatus[] | null;
  lastSeenAt: string;
  updatedAt: string;
}

export const productListQuerySchema = z.object({
  filter: z.enum(['all', 'errors', 'warnings', 'ok']).default('all'),
  q: z.string().trim().max(200).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

// ---------------- Feed import ----------------

export const PRODUCT_FEED_MAX_CHARS = 20_000_000;
export const PRODUCT_FEED_MAX_ROWS = 50_000;

export const productFeedSchema = z.object({
  fileName: z.string().trim().min(1).max(200),
  content: z
    .string()
    .min(1, 'The file is empty')
    .max(PRODUCT_FEED_MAX_CHARS, 'The file is larger than 20 MB'),
  /** Country the products are sold in (feed label), and the language of the product data. */
  country: countryCodeSchema,
  language: languageCodeSchema,
  /** replace: the file is the whole catalog (products not in it are removed). merge: add or update only. */
  mode: z.enum(['replace', 'merge']).default('replace'),
});
export type ProductFeedInput = z.input<typeof productFeedSchema>;

export interface ProductFeedPreviewDto {
  format: 'GOOGLE_CSV' | 'GOOGLE_TSV' | 'SHOPIFY_CSV';
  rows: number;
  products: number;
  columns: { name: string; mappedTo: string | null }[];
  /** Columns that are not read (kept out of the import). */
  ignoredColumns: string[];
  rowErrors: { row: number; message: string }[];
  sample: (ProductData & { issues: ProductIssue[] })[];
  summary: { errors: number; warnings: number; ok: number };
  limitations: string[];
}

export interface ProductFeedImportResultDto {
  importId: string;
  imported: number;
  updated: number;
  removed: number;
  skipped: number;
  rowErrors: { row: number; message: string }[];
  limitedByPlan: boolean;
}

// ---------------- Merchant account and checklist ----------------

export const merchantAccountSelectSchema = z.object({
  accountId: z.string().regex(/^\d{1,20}$/, 'Invalid Merchant Center account'),
});

export interface MerchantAccountDto {
  accountId: string;
  accountName: string;
  homepageUri: string | null;
}

export type ChecklistStatus = 'done' | 'todo' | 'unknown' | 'not_applicable';

export interface MerchantChecklistItem {
  key: string;
  title: string;
  status: ChecklistStatus;
  detail: string;
  action: { label: string; href: string; external: boolean } | null;
}

export interface MerchantStatusDto {
  configured: boolean;
  setup: string;
  plan: { ecommerce: boolean; productsTracked: number; productsUsed: number };
  integration: {
    id: string;
    status: string;
    externalAccount: string | null;
    accountId: string | null;
    accountName: string | null;
    lastSyncAt: string | null;
    lastSyncStatus: string | null;
    lastError: string | null;
  } | null;
  /** As Merchant Center reported it at the last sync (null when not connected). */
  account: {
    homepage: { uri: string | null; claimed: boolean | null } | null;
    freeListings: { state: string; regions: string[]; unmetRequirements: string[] } | null;
    issues: { title: string; severity: string; detail: string | null; documentation: string | null }[];
    syncedAt: string;
  } | null;
  products: {
    total: number;
    errors: number;
    warnings: number;
    ok: number;
    bySource: Partial<Record<ProductSource, number>>;
    /** Products with an error that blocks each program (Surfaced's checks and Google's issues). */
    blockedByProgram: Record<ProductProgram, number>;
    topIssues: { code: string; message: string; severity: ProductIssueSeverity; products: number }[];
  };
  lastImport: { id: string; fileName: string; createdAt: string; products: number } | null;
  hasWebsite: boolean;
  checklist: MerchantChecklistItem[];
  limitations: string[];
}

// ---------------- Countries ----------------

/** Currency Merchant Center expects for prices in each country (without currency conversion). */
export const COUNTRY_CURRENCY: Record<string, string> = {
  IN: 'INR', US: 'USD', GB: 'GBP', AE: 'AED', SA: 'SAR', QA: 'QAR', KW: 'KWD', OM: 'OMR', BH: 'BHD',
  AU: 'AUD', NZ: 'NZD', CA: 'CAD', SG: 'SGD', MY: 'MYR', HK: 'HKD', JP: 'JPY', KR: 'KRW', TH: 'THB',
  ID: 'IDR', PH: 'PHP', VN: 'VND', BR: 'BRL', MX: 'MXN', AR: 'ARS', CL: 'CLP', CO: 'COP', ZA: 'ZAR',
  CH: 'CHF', SE: 'SEK', NO: 'NOK', DK: 'DKK', PL: 'PLN', CZ: 'CZK', HU: 'HUF', RO: 'RON', TR: 'TRY',
  IL: 'ILS', DE: 'EUR', FR: 'EUR', IT: 'EUR', ES: 'EUR', NL: 'EUR', BE: 'EUR', AT: 'EUR', IE: 'EUR',
  PT: 'EUR', FI: 'EUR', GR: 'EUR', SK: 'EUR',
}; // prettier-ignore

/** Countries where colour, gender and age group (and size for clothing and shoes) are required for apparel. */
export const APPAREL_STRICT_COUNTRIES = ['BR', 'FR', 'DE', 'JP', 'GB', 'US'] as const;
