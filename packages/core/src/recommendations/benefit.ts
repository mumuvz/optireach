// Qualitative benefit texts and categories for recommendations. They describe a likely effect, never a promised
// outcome.
import type {
  AuditCategory,
  RecommendationCategory,
  RecommendationEffort,
  RecommendationOwnerRole,
} from '@surfaced/shared';

const CATEGORY_MAP: Record<AuditCategory, RecommendationCategory> = {
  CRAWLABILITY: 'TECHNICAL_SEO',
  HTTP_ERRORS: 'TECHNICAL_SEO',
  METADATA: 'TECHNICAL_SEO',
  CONTENT_STRUCTURE: 'CONTENT',
  INTERNAL_LINKS: 'INTERNAL_LINKING',
  STRUCTURED_DATA: 'STRUCTURED_DATA',
  IMAGES: 'TECHNICAL_SEO',
  PERFORMANCE: 'PERFORMANCE',
};

/** Rules that matter most for answer engines / generative search get AEO/GEO categories. */
const RULE_CATEGORY_OVERRIDES: Record<string, RecommendationCategory> = {
  'aeo-no-question-headings': 'AEO',
  'organization-schema-missing': 'GEO',
  'structured-data-none': 'GEO',
  'thin-content': 'AEO',
};

/** Recommendation category of an audit rule. */
export function categoryForAuditRule(ruleId: string, category: AuditCategory): RecommendationCategory {
  return RULE_CATEGORY_OVERRIDES[ruleId] ?? CATEGORY_MAP[category];
}

export const BENEFIT_TEXT: Record<RecommendationCategory, string> = {
  TECHNICAL_SEO: 'Likely helps search engines crawl, understand and index the affected pages more reliably.',
  CONTENT:
    'Likely makes the affected pages clearer and more useful for readers and for systems that summarize them.',
  AEO: 'May make content easier for answer engines to match to customer questions and to quote accurately.',
  GEO: 'May help AI systems connect your brand, website and offerings into a consistent entity.',
  STRUCTURED_DATA:
    'Helps machines interpret page content; it does not guarantee rich results or AI citations.',
  PERFORMANCE: 'Likely improves loading experience for visitors and crawl efficiency.',
  INTERNAL_LINKING:
    'Likely helps visitors and crawlers discover related pages and understand site structure.',
  LOCAL_SEO:
    'Likely makes your business information more complete and consistent for people searching nearby; it does not guarantee a local ranking.',
  ECOMMERCE:
    'Likely improves product data quality and eligibility for product listings; Google decides approval and placement.',
  SEARCH_PERFORMANCE:
    'Based on your Search Console data; may improve how the affected pages perform in search, which later measurements will show.',
  INTERNATIONAL: 'Likely helps search engines show the right language or regional version to each audience.',
  AUTHORITY:
    'May increase genuine references to your brand from relevant sites; it does not guarantee rankings or citations.',
  PAGE_EXPERIENCE: 'Likely improves loading and responsiveness for visitors as measured by Core Web Vitals.',
};

export const DISCLAIMER =
  'This is a qualitative estimate; actual impact depends on the importance of the affected pages and is not guaranteed.';

export function expectedBenefitFor(category: RecommendationCategory): string {
  return `${BENEFIT_TEXT[category]} ${DISCLAIMER}`;
}

/** Default owner role per category (who usually does this kind of work); the user can reassign it. */
export const OWNER_ROLE_FOR_CATEGORY: Record<RecommendationCategory, RecommendationOwnerRole> = {
  TECHNICAL_SEO: 'DEVELOPER',
  CONTENT: 'WRITER',
  AEO: 'WRITER',
  GEO: 'SEO',
  STRUCTURED_DATA: 'DEVELOPER',
  PERFORMANCE: 'DEVELOPER',
  INTERNAL_LINKING: 'SEO',
  LOCAL_SEO: 'SEO',
  ECOMMERCE: 'SEO',
  SEARCH_PERFORMANCE: 'SEO',
  INTERNATIONAL: 'DEVELOPER',
  AUTHORITY: 'MARKETER',
  PAGE_EXPERIENCE: 'DEVELOPER',
};

const EFFORT_FOR_CATEGORY: Record<RecommendationCategory, RecommendationEffort> = {
  TECHNICAL_SEO: 'MEDIUM',
  CONTENT: 'LARGE',
  AEO: 'LARGE',
  GEO: 'MEDIUM',
  STRUCTURED_DATA: 'SMALL',
  PERFORMANCE: 'MEDIUM',
  INTERNAL_LINKING: 'SMALL',
  LOCAL_SEO: 'SMALL',
  ECOMMERCE: 'MEDIUM',
  SEARCH_PERFORMANCE: 'MEDIUM',
  INTERNATIONAL: 'LARGE',
  AUTHORITY: 'LARGE',
  PAGE_EXPERIENCE: 'MEDIUM',
};

export function effortForCategory(category: RecommendationCategory): RecommendationEffort {
  return EFFORT_FOR_CATEGORY[category];
}

const VERIFICATION_FOR_CATEGORY: Record<RecommendationCategory, string> = {
  TECHNICAL_SEO: 'Re-run the website audit; the issue should no longer be listed for the affected pages.',
  CONTENT: 'Re-run the audit and re-read the page: the content gap it flagged should be resolved.',
  AEO: 'Ask the target question of an AI assistant and check the page answers it; re-run the audit.',
  GEO: 'Re-run the audit; confirm the structured data and entity details are present and valid.',
  STRUCTURED_DATA: 'Validate the page with a structured-data testing tool and re-run the audit.',
  PERFORMANCE: 'Re-measure Core Web Vitals / page speed for the affected pages after the change.',
  INTERNAL_LINKING: 'Re-run the audit; the orphan or weak-linking warning should be gone.',
  LOCAL_SEO: 'Re-check the business listing and re-run the relevant checks.',
  ECOMMERCE: 'Re-sync products and confirm the item issue is cleared in Merchant Center.',
  SEARCH_PERFORMANCE: 'Watch Search Console for the affected pages over the following weeks.',
  INTERNATIONAL: 'Re-run the audit; confirm the language/region annotations are correct.',
  AUTHORITY: 'Track new references from relevant sites over time.',
  PAGE_EXPERIENCE: 'Re-measure Core Web Vitals after the change.',
};

export function verificationFor(category: RecommendationCategory): string {
  return VERIFICATION_FOR_CATEGORY[category];
}
