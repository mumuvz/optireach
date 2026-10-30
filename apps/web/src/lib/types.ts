// Response shapes used by the web client that are not part of @surfaced/shared/types.
import type { JobDto, MetricComposition, PlanLimits, TrendPoint, VisibilityMetrics } from '@surfaced/shared';

export interface PlanDto {
  id?: string;
  key: string;
  name: string;
  description: string;
  currency: string;
  priceMonthly: number;
  priceYearly: number;
  limits: PlanLimits;
  features: string[];
  highlighted: boolean;
  sortOrder: number;
  isActive?: boolean;
}

export interface BillingMode {
  provider: string;
  mode: 'development' | 'disabled' | 'live';
}

export interface PlansResponse {
  plans: PlanDto[];
  billing: BillingMode | null;
}

// ---------------- Audits ----------------

export interface IssueCountsDto {
  total: number;
  bySeverity: Record<string, number>;
  byCategory: Record<string, number>;
  limitations?: string[];
}

export interface AuditRunSummary {
  id: string;
  status: string;
  crawlStatus: string;
  trigger: string;
  progress: number;
  score: number | null;
  issueCounts: IssueCountsDto | null;
  pagesCrawled: number;
  pagesAnalyzed: number | null;
  isDemo: boolean;
  createdAt: string;
  finishedAt: string | null;
}

export interface AuditDetailDto {
  id: string;
  projectId: string;
  status: string;
  score: number | null;
  categoryScores: Record<string, number> | null;
  issueCounts: IssueCountsDto | null;
  limitations: string[];
  pagesAnalyzed: number | null;
  scoringVersion: string;
  isDemo: boolean;
  createdAt: string;
  finishedAt: string | null;
  crawl: {
    id: string;
    status: string;
    startUrl: string;
    /** null caps mean the crawl covers every page it can reach. */
    settings: { maxPages?: number | null; maxDepth?: number | null } | null;
    progress: number;
    pagesCrawled: number;
    pagesFailed: number;
    pagesDiscovered: number;
    robots: {
      url: string;
      status: string;
      statusCode: number | null;
      sitemaps: string[];
      crawlDelaySec: number | null;
      disallowAll: boolean;
      error: string | null;
    } | null;
    sitemap: {
      found: boolean;
      truncated: boolean;
      urlCount: number;
      files: {
        url: string;
        statusCode: number | null;
        type: string;
        urlCount: number;
        error: string | null;
      }[];
    } | null;
    summary: {
      rootUrl?: string;
      httpsRedirect?: 'ok' | 'not_redirected' | 'unreachable' | 'not_https';
      /** The first 500 robots-blocked URLs. */
      blockedByRobots?: string[];
      blockedByRobotsTotal?: number;
      loopUrlsSkipped?: number;
      stoppedReason?: string | null;
      limitReached?: boolean;
    } | null;
    errorMessage: string | null;
    startedAt: string | null;
    finishedAt: string | null;
  };
  jobs: { crawl: JobDto | null; audit: JobDto | null };
  previous: {
    id: string;
    score: number | null;
    issueCounts: IssueCountsDto | null;
    finishedAt: string | null;
  } | null;
}

export interface IssueDto {
  id: string;
  ruleId: string;
  category: string;
  severity: string;
  status: string;
  url: string | null;
  title: string;
  description: string;
  impact: string | null;
  evidence: unknown;
  suggestedFix: string;
  firstDetectedAt: string;
  lastDetectedAt: string;
  resolvedAt: string | null;
  ignoredAt: string | null;
}

export interface IssueSummaryDto {
  bySeverity: Record<string, number>;
  byCategory: Record<string, number>;
  byStatus: Record<string, number>;
  rules: { ruleId: string; count: number; title: string; category: string | null; severity: string | null }[];
}

export interface CrawledPageRow {
  id: string;
  url: string;
  statusCode: number | null;
  title: string | null;
  depth: number;
  wordCount: number | null;
  responseTimeMs: number | null;
  isIndexable: boolean;
  indexabilityReason: string | null;
  inlinksCount: number;
  inSitemap: boolean;
  fetchError: string | null;
  issueCount: number;
}

// ---------------- AI visibility ----------------

export interface PromptDto {
  id: string;
  projectId: string;
  text: string;
  intent: string | null;
  country: string;
  city: string | null;
  language: string;
  targetBrand: string;
  competitorIds: string[];
  providers: string[];
  frequency: string;
  status: string;
  lastRunAt: string | null;
  nextRunAt: string | null;
  createdAt: string;
}

export interface VisibilityRunDto {
  id: string;
  status: string;
  trigger: string;
  promptCount: number;
  observationCount: number;
  successCount: number;
  failureCount: number;
  isDemo: boolean;
  errorMessage: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface ObservationRow {
  id: string;
  promptId: string;
  promptText: string;
  provider: string;
  model: string | null;
  country: string;
  city: string | null;
  language: string;
  captureMethod: string;
  status: string;
  isDemo: boolean;
  brandMentioned: boolean;
  brandCited: boolean;
  brandRank: number | null;
  sentiment: string | null;
  sentimentSource: string | null;
  errorCode: string | null;
  observedAt: string;
  citationCount: number;
  mentionCount: number;
}

export interface CitationDomainDto {
  domain: string;
  citations: number;
  share: number;
  isOwnedDomain: boolean;
  competitorId: string | null;
  sampleUrls: { url: string; title: string | null }[];
}

export interface VisibilitySummaryDto {
  metrics: VisibilityMetrics;
  composition: MetricComposition;
  truncated: boolean;
  notes: string[];
}

export interface VisibilityTrendDto {
  points: TrendPoint[];
  composition: MetricComposition;
  notes: string[];
}

// ---------------- Content ----------------

export interface ContentDocumentDto {
  id: string;
  projectId: string;
  briefId: string | null;
  title: string;
  status: string;
  wordCount: number | null;
  latestVersion: number;
  targetUrl: string | null;
  assignee: { id: string; name: string } | null;
  approvedBy: { id: string; name: string } | null;
  reviewRequestedAt: string | null;
  approvedAt: string | null;
  publishedAt: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  editable: boolean;
  allowedTransitions: string[];
}

export interface ContentBriefDto {
  id: string;
  projectId: string;
  title: string;
  primaryKeyword: string;
  secondaryKeywords: string[];
  searchIntent: string;
  targetAudience: string | null;
  country: string;
  language: string;
  brandVoice: string | null;
  targetUrl: string | null;
  wordCountTarget: number | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  documentCount?: number;
}

// ---------------- LLM providers ----------------

/** One LLM provider the server can run AI research on. Mirrors core's listLlmProviders(). */
export interface LlmProviderStatusDto {
  key: 'openai' | 'gemini' | 'dev';
  label: string;
  configured: boolean;
  isDevAdapter: boolean;
  model: string | null;
  /** The provider used when a request does not pick one. */
  isDefault: boolean;
  detail: string;
}

// ---------------- Answerability (AEO) ----------------

export interface AnswerabilityFinding {
  area: string;
  status: 'good' | 'fair' | 'poor';
  detail: string;
  recommendation: string;
}
export interface AnswerabilityQuestionCoverage {
  question: string;
  covered: boolean;
  note: string;
}
export interface AnswerabilityAssessmentDto {
  score: number;
  summary: string;
  strengths: string[];
  gaps: string[];
  findings: AnswerabilityFinding[];
  questionCoverage: AnswerabilityQuestionCoverage[];
}
export interface AnswerabilityRunDto {
  id: string;
  projectId: string;
  status: string;
  provider: string | null;
  model: string | null;
  isDevAdapter: boolean;
  score: number | null;
  grade: string | null;
  assessment: AnswerabilityAssessmentDto | null;
  pagesConsidered: number;
  questionsConsidered: number;
  limitations: string[];
  errorMessage: string | null;
  createdAt: string;
  finishedAt: string | null;
  job?: JobDto | null;
}

// ---------------- Recommendations ----------------

export interface RecommendationDto {
  id: string;
  projectId: string;
  title: string;
  category: string;
  source: string;
  severity: string;
  relatedUrl: string | null;
  expectedBenefit: string;
  benefitLevel: string;
  evidence: unknown;
  proposedFix: string;
  status: string;
  assignee: { id: string; name: string } | null;
  ownerRole: string | null;
  effort: string | null;
  verification: string | null;
  dueAt: string | null;
  dismissedReason: string | null;
  blockedReason: string | null;
  verifiedBy: { id: string; name: string } | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  plannedAt: string | null;
  completedAt: string | null;
  verifiedAt: string | null;
  blockedAt: string | null;
  dismissedAt: string | null;
}
