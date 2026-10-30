// Enum values shared by the browser and the server. They mirror the Prisma enums in
// prisma/schema.prisma; packages/core/test/enum-parity.test.ts fails if the two drift apart.

export const WORKSPACE_ROLES = ['OWNER', 'ADMIN', 'MEMBER', 'CLIENT'] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];
/** Roles that work on projects (everyone except client-portal users). */
export const TEAM_ROLES: readonly WorkspaceRole[] = ['OWNER', 'ADMIN', 'MEMBER'];

export const PLATFORM_ROLES = ['USER', 'ADMIN'] as const;
export type PlatformRole = (typeof PLATFORM_ROLES)[number];

export const JOB_STATUSES = ['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];
export const ACTIVE_JOB_STATUSES: readonly JobStatus[] = ['QUEUED', 'RUNNING'];

export const JOB_TRIGGERS = ['MANUAL', 'SCHEDULED', 'PUBLIC', 'SYSTEM'] as const;
export type JobTrigger = (typeof JOB_TRIGGERS)[number];

export const BACKGROUND_JOB_TYPES = [
  'CRAWL',
  'AUDIT',
  'CONTENT_GENERATION',
  'KEYWORD_SUGGESTIONS',
  'VISIBILITY_RUN',
  'COMPETITOR_SNAPSHOT',
  'REPORT',
  'INTEGRATION_SYNC',
  'EMAIL',
  'MAINTENANCE',
  'PUBLISH',
  'VERIFICATION',
  'DISCOVERY',
  'RANK_CHECK',
  'WEB_VITALS',
  'WEBHOOK_DELIVERY',
  'AI_DRAFT',
  'IMPORT',
  'GAP_ANALYSIS',
  'SEO_COMPARISON',
  'TREND_REPORT',
] as const;
export type BackgroundJobType = (typeof BACKGROUND_JOB_TYPES)[number];

export const AUDIT_SCHEDULES = ['MANUAL', 'WEEKLY', 'MONTHLY'] as const;
export type AuditSchedule = (typeof AUDIT_SCHEDULES)[number];

export const PAGE_SOURCES = ['SEED', 'SITEMAP', 'LINK', 'REDIRECT'] as const;
export type PageSource = (typeof PAGE_SOURCES)[number];

export const AUDIT_CATEGORIES = [
  'CRAWLABILITY',
  'HTTP_ERRORS',
  'METADATA',
  'CONTENT_STRUCTURE',
  'INTERNAL_LINKS',
  'STRUCTURED_DATA',
  'IMAGES',
  'PERFORMANCE',
] as const;
export type AuditCategory = (typeof AUDIT_CATEGORIES)[number];

export const AUDIT_CATEGORY_LABELS: Record<AuditCategory, string> = {
  CRAWLABILITY: 'Crawlability & indexability',
  HTTP_ERRORS: 'HTTP errors',
  METADATA: 'Metadata',
  CONTENT_STRUCTURE: 'Content structure',
  INTERNAL_LINKS: 'Internal links',
  STRUCTURED_DATA: 'Structured data',
  IMAGES: 'Images',
  PERFORMANCE: 'Performance observations',
};

export const ISSUE_SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const;
export type IssueSeverity = (typeof ISSUE_SEVERITIES)[number];
export const SEVERITY_LABELS: Record<IssueSeverity, string> = {
  CRITICAL: 'Critical',
  HIGH: 'High',
  MEDIUM: 'Medium',
  LOW: 'Low',
};
export const SEVERITY_RANK: Record<IssueSeverity, number> = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1 };

export const ISSUE_STATUSES = ['OPEN', 'IGNORED', 'RESOLVED'] as const;
export type IssueStatus = (typeof ISSUE_STATUSES)[number];

export const PROMPT_FREQUENCIES = ['MANUAL', 'DAILY', 'WEEKLY', 'MONTHLY'] as const;
export type PromptFrequency = (typeof PROMPT_FREQUENCIES)[number];

export const PROMPT_STATUSES = ['ACTIVE', 'PAUSED'] as const;
export type PromptStatus = (typeof PROMPT_STATUSES)[number];

export const OBSERVATION_STATUSES = ['SUCCEEDED', 'FAILED'] as const;
export type ObservationStatus = (typeof OBSERVATION_STATUSES)[number];

export const MENTION_ENTITY_TYPES = ['BRAND', 'COMPETITOR'] as const;
export type MentionEntityType = (typeof MENTION_ENTITY_TYPES)[number];

export const MENTION_MATCH_TYPES = ['NAME', 'ALIAS', 'DOMAIN', 'AI_ENTITY'] as const;
export type MentionMatchType = (typeof MENTION_MATCH_TYPES)[number];

export const CITATION_SOURCE_TYPES = ['INLINE_CITATION', 'SEARCH_RESULT', 'MENTIONED_URL'] as const;
export type CitationSourceType = (typeof CITATION_SOURCE_TYPES)[number];

export const SENTIMENTS = ['POSITIVE', 'NEUTRAL', 'NEGATIVE', 'MIXED'] as const;
export type Sentiment = (typeof SENTIMENTS)[number];

export const SEARCH_INTENTS = ['INFORMATIONAL', 'COMMERCIAL', 'TRANSACTIONAL', 'NAVIGATIONAL'] as const;
export type SearchIntent = (typeof SEARCH_INTENTS)[number];
export const SEARCH_INTENT_LABELS: Record<SearchIntent, string> = {
  INFORMATIONAL: 'Informational',
  COMMERCIAL: 'Commercial investigation',
  TRANSACTIONAL: 'Transactional',
  NAVIGATIONAL: 'Navigational',
};

export const CONTENT_STATUSES = ['DRAFT', 'IN_REVIEW', 'APPROVED', 'PUBLISHED', 'ARCHIVED'] as const;
export type ContentStatus = (typeof CONTENT_STATUSES)[number];
export const CONTENT_STATUS_LABELS: Record<ContentStatus, string> = {
  DRAFT: 'Draft',
  IN_REVIEW: 'In review',
  APPROVED: 'Approved',
  PUBLISHED: 'Published',
  ARCHIVED: 'Archived',
};

export const CONTENT_VERSION_SOURCES = ['MANUAL', 'AI_GENERATION', 'AI_SECTION', 'RESTORE'] as const;
export type ContentVersionSource = (typeof CONTENT_VERSION_SOURCES)[number];

export const KEYWORD_PRIORITIES = ['HIGH', 'MEDIUM', 'LOW'] as const;
export type KeywordPriority = (typeof KEYWORD_PRIORITIES)[number];

export const KEYWORD_STATUSES = [
  'IDEA',
  'PLANNED',
  'IN_PROGRESS',
  'PUBLISHED',
  'OPTIMIZING',
  'DISCARDED',
] as const;
export type KeywordStatus = (typeof KEYWORD_STATUSES)[number];
export const KEYWORD_STATUS_LABELS: Record<KeywordStatus, string> = {
  IDEA: 'Idea',
  PLANNED: 'Planned',
  IN_PROGRESS: 'In progress',
  PUBLISHED: 'Published',
  OPTIMIZING: 'Optimizing',
  DISCARDED: 'Discarded',
};

export const KEYWORD_SOURCES = ['MANUAL', 'CSV_IMPORT', 'AI_SUGGESTION', 'PROVIDER'] as const;
export type KeywordSource = (typeof KEYWORD_SOURCES)[number];

export const RECOMMENDATION_STATUSES = [
  'OPEN',
  'PLANNED',
  'IN_PROGRESS',
  'AWAITING_APPROVAL',
  'COMPLETED',
  'VERIFIED',
  'DISMISSED',
  'BLOCKED',
] as const;
export type RecommendationStatus = (typeof RECOMMENDATION_STATUSES)[number];
export const RECOMMENDATION_STATUS_LABELS: Record<RecommendationStatus, string> = {
  OPEN: 'Open',
  PLANNED: 'Planned',
  IN_PROGRESS: 'In progress',
  AWAITING_APPROVAL: 'Awaiting approval',
  COMPLETED: 'Completed',
  VERIFIED: 'Verified',
  DISMISSED: 'Dismissed',
  BLOCKED: 'Blocked',
};
/** Statuses that count as still needing work (for counts and the default filter). */
export const RECOMMENDATION_OPEN_STATUSES = ['OPEN', 'PLANNED', 'IN_PROGRESS', 'AWAITING_APPROVAL', 'BLOCKED'] as const; // prettier-ignore

/** Who should carry out a recommendation. Defaulted from the category; editable. */
export const RECOMMENDATION_OWNER_ROLES = ['WRITER', 'DEVELOPER', 'SEO', 'MARKETER'] as const;
export type RecommendationOwnerRole = (typeof RECOMMENDATION_OWNER_ROLES)[number];
export const RECOMMENDATION_OWNER_ROLE_LABELS: Record<RecommendationOwnerRole, string> = {
  WRITER: 'Content writer',
  DEVELOPER: 'Developer',
  SEO: 'SEO specialist',
  MARKETER: 'Marketing',
};

export const RECOMMENDATION_EFFORTS = ['SMALL', 'MEDIUM', 'LARGE'] as const;
export type RecommendationEffort = (typeof RECOMMENDATION_EFFORTS)[number];
export const RECOMMENDATION_EFFORT_LABELS: Record<RecommendationEffort, string> = {
  SMALL: 'Small (under an hour)',
  MEDIUM: 'Medium (a few hours)',
  LARGE: 'Large (a day or more)',
};

// Selectable LLM providers for AI research. Not a Prisma enum: it is which model API a research run uses, so the
// same request can be run on each configured provider and the results compared. 'dev' is the template adapter and
// is only offered outside production. The server still decides which are actually configured (keys present).
export const LLM_PROVIDER_KEYS = ['openai', 'gemini', 'dev'] as const;
export type LlmProviderKey = (typeof LLM_PROVIDER_KEYS)[number];
export const LLM_PROVIDER_LABELS: Record<LlmProviderKey, string> = {
  openai: 'OpenAI',
  gemini: 'Gemini',
  dev: 'Development adapter',
};

export const RECOMMENDATION_CATEGORIES = [
  'TECHNICAL_SEO',
  'CONTENT',
  'AEO',
  'GEO',
  'STRUCTURED_DATA',
  'PERFORMANCE',
  'INTERNAL_LINKING',
  'LOCAL_SEO',
  'ECOMMERCE',
  'SEARCH_PERFORMANCE',
  'INTERNATIONAL',
  'AUTHORITY',
  'PAGE_EXPERIENCE',
] as const;
export type RecommendationCategory = (typeof RECOMMENDATION_CATEGORIES)[number];
export const RECOMMENDATION_CATEGORY_LABELS: Record<RecommendationCategory, string> = {
  TECHNICAL_SEO: 'Technical SEO',
  CONTENT: 'Content',
  AEO: 'Answer engines (AEO)',
  GEO: 'Generative visibility (GEO)',
  STRUCTURED_DATA: 'Structured data',
  PERFORMANCE: 'Performance',
  INTERNAL_LINKING: 'Internal linking',
  LOCAL_SEO: 'Local SEO',
  ECOMMERCE: 'Ecommerce',
  SEARCH_PERFORMANCE: 'Search performance',
  INTERNATIONAL: 'International SEO',
  AUTHORITY: 'Authority',
  PAGE_EXPERIENCE: 'Page experience',
};

export const RECOMMENDATION_SOURCES = [
  'AUDIT',
  'AI_VISIBILITY',
  'COMPETITOR',
  'SEARCH_CONSOLE',
  'LOCAL',
  'COMMERCE',
  'WEB_VITALS',
  'RANK_TRACKING',
  'SEARCH_TRENDS',
] as const;
export type RecommendationSource = (typeof RECOMMENDATION_SOURCES)[number];

export const BENEFIT_LEVELS = ['HIGH', 'MEDIUM', 'LOW'] as const;
export type BenefitLevel = (typeof BENEFIT_LEVELS)[number];

export const INTEGRATION_PROVIDERS = [
  'GOOGLE_SEARCH_CONSOLE',
  'GOOGLE_ANALYTICS_4',
  'WORDPRESS',
  'SHOPIFY',
  'GOOGLE_BUSINESS_PROFILE',
  'GOOGLE_MERCHANT_CENTER',
  'CMS_WEBHOOK',
] as const;
export type IntegrationProvider = (typeof INTEGRATION_PROVIDERS)[number];

export const INTEGRATION_STATUSES = ['CONNECTED', 'DISCONNECTED', 'ERROR', 'NEEDS_REAUTH'] as const;
export type IntegrationStatus = (typeof INTEGRATION_STATUSES)[number];

export const GSC_DIMENSIONS = ['DATE', 'QUERY', 'PAGE'] as const;
export type GscDimension = (typeof GSC_DIMENSIONS)[number];

export const SUBSCRIPTION_STATUSES = [
  'ACTIVE',
  'TRIALING',
  'PAST_DUE',
  'CANCELED',
  'INCOMPLETE',
  'UNPAID',
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export const BILLING_PROVIDERS = ['NONE', 'DEV', 'STRIPE', 'RAZORPAY'] as const;
export type BillingProviderKey = (typeof BILLING_PROVIDERS)[number];

export const BILLING_INTERVALS = ['MONTH', 'YEAR'] as const;
export type BillingInterval = (typeof BILLING_INTERVALS)[number];

export const INVOICE_STATUSES = ['PAID', 'OPEN', 'FAILED', 'VOID', 'REFUNDED'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export const WEBHOOK_EVENT_STATUSES = ['RECEIVED', 'PROCESSED', 'IGNORED', 'FAILED'] as const;
export type WebhookEventStatus = (typeof WEBHOOK_EVENT_STATUSES)[number];

export const USAGE_METRICS = [
  'AUDIT_RUN',
  'CRAWL_PAGES',
  'VISIBILITY_CHECK',
  'CONTENT_GENERATION',
  'KEYWORD_SUGGESTION',
  'COMPETITOR_SNAPSHOT',
  'REPORT',
  'RANK_CHECK',
  'LOCAL_RANK_POINT',
  'WEB_VITALS_CHECK',
  'API_REQUEST',
] as const;
export type UsageMetric = (typeof USAGE_METRICS)[number];

export const REPORT_STATUSES = ['QUEUED', 'GENERATING', 'READY', 'FAILED'] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

export const EMAIL_STATUSES = ['QUEUED', 'SENT', 'LOGGED_LOCALLY', 'FAILED'] as const;
export type EmailStatus = (typeof EMAIL_STATUSES)[number];

export const USER_TOKEN_TYPES = ['EMAIL_VERIFICATION', 'PASSWORD_RESET'] as const;
export type UserTokenType = (typeof USER_TOKEN_TYPES)[number];

// ---------- Agency access, approvals and tasks ----------

export const AGENCY_LINK_STATUSES = ['PENDING', 'ACTIVE', 'REVOKED'] as const;
export type AgencyLinkStatus = (typeof AGENCY_LINK_STATUSES)[number];

export const AGENCY_BILLING_MODES = ['AGENCY', 'CLIENT'] as const;
export type AgencyBillingMode = (typeof AGENCY_BILLING_MODES)[number];

export const APPROVAL_STATUSES = [
  'PENDING',
  'APPROVED',
  'REJECTED',
  'CHANGES_REQUESTED',
  'WITHDRAWN',
  'SUPERSEDED',
] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];
export const APPROVAL_STATUS_LABELS: Record<ApprovalStatus, string> = {
  PENDING: 'Awaiting decision',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  CHANGES_REQUESTED: 'Changes requested',
  WITHDRAWN: 'Withdrawn',
  SUPERSEDED: 'Replaced by a newer request',
};
/** Decisions an approver can make on a pending request. */
export const APPROVAL_DECISIONS = ['APPROVED', 'REJECTED', 'CHANGES_REQUESTED'] as const;
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];

/** Records that can need approval before they are published outside Surfaced. */
export const APPROVAL_ENTITY_TYPES = [
  'LOCATION_CHANGE',
  'LOCAL_POST',
  'REVIEW_REPLY',
  'PRODUCT_CHANGE_SET',
  'SITE_CHANGE',
  'CONTENT_PUBLICATION',
  'OUTREACH_DRAFT',
  'COMMUNITY_CONTRIBUTION',
  'STRATEGY_REVIEW',
] as const;
export type ApprovalEntityType = (typeof APPROVAL_ENTITY_TYPES)[number];
export const APPROVAL_ENTITY_LABELS: Record<ApprovalEntityType, string> = {
  LOCATION_CHANGE: 'Business Profile update',
  LOCAL_POST: 'Business Profile post',
  REVIEW_REPLY: 'Review reply',
  PRODUCT_CHANGE_SET: 'Product data changes',
  SITE_CHANGE: 'Website change',
  CONTENT_PUBLICATION: 'Content publication',
  OUTREACH_DRAFT: 'Outreach or PR draft',
  COMMUNITY_CONTRIBUTION: 'Community contribution',
  STRATEGY_REVIEW: 'Strategy review',
};

export const TASK_STATUSES = ['TODO', 'IN_PROGRESS', 'BLOCKED', 'IN_REVIEW', 'DONE', 'CANCELLED'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  TODO: 'To do',
  IN_PROGRESS: 'In progress',
  BLOCKED: 'Blocked',
  IN_REVIEW: 'In review',
  DONE: 'Done',
  CANCELLED: 'Cancelled',
};
export const OPEN_TASK_STATUSES: readonly TaskStatus[] = ['TODO', 'IN_PROGRESS', 'BLOCKED', 'IN_REVIEW'];

export const TASK_PRIORITIES = ['HIGH', 'MEDIUM', 'LOW'] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export const TASK_TYPES = [
  'CONTENT',
  'TECHNICAL',
  'SEARCH',
  'LOCAL_SEO',
  'BUSINESS_PROFILE',
  'MERCHANT',
  'AI_VISIBILITY',
  'BACKLINKS',
  'PR',
  'COMMUNITY',
  'STRATEGY',
  'REPORTING',
  'OTHER',
] as const;
export type TaskType = (typeof TASK_TYPES)[number];
export const TASK_TYPE_LABELS: Record<TaskType, string> = {
  CONTENT: 'Content',
  TECHNICAL: 'Technical SEO',
  SEARCH: 'Search performance',
  LOCAL_SEO: 'Local SEO',
  BUSINESS_PROFILE: 'Business Profile',
  MERCHANT: 'Merchant Center',
  AI_VISIBILITY: 'AI visibility',
  BACKLINKS: 'Backlinks',
  PR: 'Digital PR',
  COMMUNITY: 'Community',
  STRATEGY: 'Strategy',
  REPORTING: 'Reporting',
  OTHER: 'Other',
};

/** How an observation or measurement was obtained (D-027). Shown next to every number. */
export const CAPTURE_METHODS = ['API', 'LICENSED_PROVIDER', 'MANUAL', 'IMPORT', 'DEMO'] as const;
export type CaptureMethod = (typeof CAPTURE_METHODS)[number];
export const CAPTURE_METHOD_LABELS: Record<CaptureMethod, string> = {
  API: 'Official API',
  LICENSED_PROVIDER: 'Licensed data provider',
  MANUAL: 'Manual observation',
  IMPORT: 'Imported',
  DEMO: 'Demo data',
};

// ---------- AI visibility providers ----------

export const VISIBILITY_PROVIDER_KEYS = [
  'openai_web_search',
  'openai_model_knowledge',
  'perplexity_sonar',
  'gemini_model_knowledge',
  'dataforseo_ai_mode',
  'mock_demo',
] as const;
export type VisibilityProviderKey = (typeof VISIBILITY_PROVIDER_KEYS)[number];

export type VisibilityProviderKind = 'live_search' | 'model_knowledge' | 'demo';

export interface VisibilityProviderMeta {
  key: VisibilityProviderKey;
  label: string;
  vendor: string;
  kind: VisibilityProviderKind;
  description: string;
}

export const VISIBILITY_PROVIDERS: Record<VisibilityProviderKey, VisibilityProviderMeta> = {
  openai_web_search: {
    key: 'openai_web_search',
    label: 'OpenAI · web search',
    vendor: 'OpenAI',
    kind: 'live_search',
    description:
      'OpenAI Responses API with the web_search tool. Answers are grounded in live web results with inline citations. This approximates, but is not identical to, what ChatGPT users see.',
  },
  openai_model_knowledge: {
    key: 'openai_model_knowledge',
    label: 'OpenAI · model knowledge',
    vendor: 'OpenAI',
    kind: 'model_knowledge',
    description:
      'A plain model answer without browsing. Useful for understanding what the model has learned about your brand. Not a live search result.',
  },
  perplexity_sonar: {
    key: 'perplexity_sonar',
    label: 'Perplexity · web search',
    vendor: 'Perplexity',
    kind: 'live_search',
    description:
      'Perplexity Agent API (preset "fast") with web search. Answers are grounded in live search results with returned citations. The provider key keeps its original name for stored observations.',
  },
  gemini_model_knowledge: {
    key: 'gemini_model_knowledge',
    label: 'Gemini · model knowledge',
    vendor: 'Google',
    kind: 'model_knowledge',
    description:
      'A plain Gemini API answer without Google Search grounding. Shows what the model has learned about your brand; it is not the Gemini app and not a live search result. Grounded answers are not tracked: Google’s terms do not allow storing them.',
  },
  dataforseo_ai_mode: {
    key: 'dataforseo_ai_mode',
    label: 'Google AI Mode · licensed provider',
    vendor: 'DataForSEO',
    kind: 'live_search',
    description:
      'Google AI Mode answers with their references, collected by the licensed provider DataForSEO for the prompt’s country (or the business location’s coordinates when a city is set). Google offers no API for AI Mode.',
  },
  mock_demo: {
    key: 'mock_demo',
    label: 'Demo fixtures',
    vendor: 'Surfaced (development)',
    kind: 'demo',
    description:
      'Deterministic fixture answers for development and testing. Demo data — not a real AI response.',
  },
};

export const REPORT_SECTIONS = [
  'audit_summary',
  'technical_issues',
  'url_findings',
  'ai_visibility',
  'prompt_observations',
  'citation_sources',
  'competitor_comparison',
  'keyword_opportunities',
  'completed_work',
  'next_steps',
] as const;
export type ReportSection = (typeof REPORT_SECTIONS)[number];
export const REPORT_SECTION_LABELS: Record<ReportSection, string> = {
  audit_summary: 'Audit summary',
  technical_issues: 'Technical issue breakdown',
  url_findings: 'URL-level findings',
  ai_visibility: 'AI visibility results',
  prompt_observations: 'Prompt-level observations',
  citation_sources: 'Citation sources',
  competitor_comparison: 'Competitor comparison',
  keyword_opportunities: 'Keyword opportunities',
  completed_work: 'Completed work',
  next_steps: 'Recommended next steps',
};

export const CONTENT_GENERATION_MODES = ['outline', 'article', 'meta', 'faq', 'schema', 'section'] as const;
export type ContentGenerationMode = (typeof CONTENT_GENERATION_MODES)[number];

export const CONTACT_TOPICS = ['sales', 'support', 'partnership', 'press', 'privacy', 'other'] as const;
export type ContactTopic = (typeof CONTACT_TOPICS)[number];
