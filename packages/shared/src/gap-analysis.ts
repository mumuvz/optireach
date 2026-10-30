// Competitor gap analysis: why AI answers recommend other brands, and what the project can do about it.
// Everything in a report is derived from stored AI visibility observations, the project's own crawl, and
// live checks of public pages (robots.txt respected). Nothing is estimated or invented.
import type { RecommendationCategory } from './enums';

/** Crawlers whose robots.txt access is checked for the project's homepage. */
export const AI_CRAWLERS = [
  {
    agent: 'OAI-SearchBot',
    label: 'OpenAI search (OAI-SearchBot)',
    purpose: 'Used to show websites in ChatGPT search results.',
    search: true,
  },
  {
    agent: 'ChatGPT-User',
    label: 'ChatGPT user requests (ChatGPT-User)',
    purpose: 'Fetches a page when a ChatGPT user or action asks for it.',
    search: false,
  },
  {
    agent: 'GPTBot',
    label: 'OpenAI training (GPTBot)',
    purpose: 'Collects content that may be used to train OpenAI models. Blocking it is a business choice.',
    search: false,
  },
  {
    agent: 'PerplexityBot',
    label: 'Perplexity search (PerplexityBot)',
    purpose: 'Used to show websites in Perplexity answers.',
    search: true,
  },
  {
    agent: 'Googlebot',
    label: 'Google Search (Googlebot)',
    purpose: 'Crawls pages for Google Search, including AI features in Search.',
    search: true,
  },
  {
    agent: 'Google-Extended',
    label: 'Google AI training (Google-Extended)',
    purpose: 'Controls use in Gemini apps and model training; it does not affect Google Search.',
    search: false,
  },
  {
    agent: 'Bingbot',
    label: 'Bing (Bingbot)',
    purpose: 'Crawls pages for Bing, which several AI assistants use for web results.',
    search: true,
  },
  {
    agent: 'ClaudeBot',
    label: 'Anthropic (ClaudeBot)',
    purpose: 'Collects public web content for Anthropic.',
    search: false,
  },
] as const;

export const GAP_SOURCE_TYPES = [
  'OWN_SITE',
  'TRACKED_COMPETITOR',
  'RECOMMENDED_BRAND',
  'COMPARISON_ARTICLE',
  'COMMUNITY',
  'APP_STORE',
  'VIDEO',
  'SOCIAL',
  'PRESS_RELEASE',
  'REVIEW_DIRECTORY',
  'FILE_HOST',
  'OTHER',
] as const;
export type GapSourceType = (typeof GAP_SOURCE_TYPES)[number];
export const GAP_SOURCE_TYPE_LABELS: Record<GapSourceType, string> = {
  OWN_SITE: 'Your website',
  TRACKED_COMPETITOR: 'Competitor website',
  RECOMMENDED_BRAND: 'Recommended brand’s website',
  COMPARISON_ARTICLE: 'Article or guide',
  COMMUNITY: 'Community discussion',
  APP_STORE: 'App store',
  VIDEO: 'Video',
  SOCIAL: 'Social media',
  PRESS_RELEASE: 'Press release',
  REVIEW_DIRECTORY: 'Review site or directory',
  FILE_HOST: 'File or image host',
  OTHER: 'Other website',
};

/** A sentence copied verbatim from a stored AI answer. */
export interface GapQuote {
  observationId: string;
  promptId: string;
  prompt: string;
  provider: string;
  observedAt: string;
  text: string;
}

export interface GapBrandReason {
  /** Short label for what the answer credits the brand with (assigned by AI extraction). */
  attribute: string;
  answers: number;
  /** Exact words from the answers; every quote was verified to appear in the stored answer text. */
  quotes: GapQuote[];
}

export interface GapBrand {
  /** As written in the answers (or the configured name for your brand and tracked competitors). */
  name: string;
  /** Lower-case letters and digits only; used to match spellings like "Crafty Art" and "craftyart". */
  key: string;
  isYou: boolean;
  competitorId: string | null;
  tracked: boolean;
  domain: string | null;
  /** Answers naming the brand. */
  answers: number;
  /** answers ÷ answers analyzed. */
  mentionRate: number;
  /** Answers citing the brand's own website. */
  citedAnswers: number;
  promptIds: string[];
  reasons: GapBrandReason[];
  /** Sentences that name the brand. */
  quotes: GapQuote[];
  /** How the brand was found: stored mention matching, a cited domain named in the answer, or AI extraction. */
  detection: 'tracked' | 'domain' | 'ai_extraction';
  /** A spelling seen in the answers that the tracked name and aliases do not cover. */
  aliasSuggestion: string | null;
}

export interface GapAttribute {
  attribute: string;
  /** Answers crediting a brand other than yours with this attribute. */
  answers: number;
  brands: string[];
  /** One verified quote from an answer, so a short label can be read in context. */
  example: string | null;
  /** Keyword check on your homepage and crawled page titles/headings; null when nothing could be checked. */
  onYourSite: boolean | null;
  matchedOn: string | null;
}

export interface GapPageCheck {
  url: string;
  status: 'OK' | 'HTTP_ERROR' | 'BLOCKED_BY_ROBOTS' | 'UNSAFE_URL' | 'FETCH_FAILED' | 'NOT_HTML';
  title: string | null;
  /** Brands named in the answers that also appear on the page. */
  brandsOnPage: string[];
  youOnPage: boolean | null;
  linksToYou: boolean | null;
  checkedAt: string;
  note: string | null;
}

export interface GapSource {
  domain: string;
  type: GapSourceType;
  /** Brand the source belongs to (your brand, a tracked competitor or a recommended brand). */
  brand: string | null;
  answers: number;
  citations: number;
  urls: { url: string; title: string | null; citations: number }[];
  /** Brands named in the answers that cited this source. */
  brandsInAnswers: string[];
  /** Answers citing this source that also named your brand. */
  youNamedInAnswers: number;
  /** A brand's own page that compares options ("best", "vs", "alternatives", "guide" in the address). */
  comparisonPages: string[];
  checks: GapPageCheck[];
}

export interface GapPrompt {
  promptId: string;
  prompt: string;
  answers: number;
  youNamed: number;
  youCited: number;
  brandsNamed: { name: string; answers: number }[];
  topSources: { domain: string; type: GapSourceType; answers: number }[];
  /** Attributes credited to other brands in this prompt's answers. */
  attributes: { attribute: string; answers: number }[];
  /** Answers to this prompt that named at least one brand (yours included). */
  answersNamingBrands: number;
  /** False when no answer to this prompt named any brand (the AI did the task itself, for example). */
  recommendsBrands: boolean;
  /** Best-matching page of your latest crawl, by the prompt's words in its address, title and headings. */
  yourPage: { url: string; title: string | null; matched: string[]; missing: string[]; score: number } | null;
  /** False when there is no crawl to search. */
  pageMatchAvailable: boolean;
}

export interface GapCrawlerAccess {
  agent: string;
  label: string;
  purpose: string;
  search: boolean;
  allowed: boolean | null;
}

export interface GapReadiness {
  robots: {
    url: string;
    status: 'ok' | 'missing' | 'unreachable' | 'not_checked';
    httpStatus: number | null;
    error: string | null;
    agents: GapCrawlerAccess[];
  };
  homepage: {
    url: string;
    status: GapPageCheck['status'] | 'NOT_CHECKED';
    httpStatus: number | null;
    title: string | null;
    metaDescription: string | null;
    h1: string | null;
    wordCount: number | null;
    schemaTypes: string[];
    error: string | null;
  };
  audit: {
    auditRunId: string;
    score: number | null;
    finishedAt: string | null;
    pagesAnalyzed: number | null;
    issues: { ruleId: string; title: string; count: number }[];
  } | null;
}

export type GapActionPriority = 1 | 2 | 3 | 4;
export const GAP_ACTION_PRIORITY_LABELS: Record<GapActionPriority, string> = {
  1: 'Fix first',
  2: 'High impact',
  3: 'Worth doing',
  4: 'Housekeeping',
};

export interface GapAction {
  /** Stable per project and finding, e.g. "prompt-page:<promptId>". */
  key: string;
  priority: GapActionPriority;
  category: RecommendationCategory;
  title: string;
  /** The evidence behind the action, with numbers from this analysis. */
  why: string;
  steps: string[];
  evidence: { promptIds: string[]; urls: string[]; observationIds: string[]; brands: string[] };
  /** In-app destination relative to the project, e.g. "audits" or "content". */
  link: { label: string; path: string } | null;
  /** Brands the "track" action would add as competitors. */
  trackBrands?: { name: string; domain: string | null }[];
}

export interface GapAnalysisResult {
  version: 1;
  window: { from: string; to: string; days: number };
  answers: number;
  /** Successful answers left out because they came from the demo provider. */
  demoAnswersExcluded: number;
  prompts: GapPrompt[];
  providers: string[];
  you: GapBrand;
  /** Every brand named in the answers, yours included, most-named first. */
  brands: GapBrand[];
  attributes: GapAttribute[];
  sources: GapSource[];
  readiness: GapReadiness;
  actions: GapAction[];
  method: {
    brandDetection: 'ai_extraction' | 'domain_only';
    extractionModel: string | null;
    answersExtracted: number;
    liveChecks: boolean;
  };
  notes: string[];
}

export interface GapAnalysisDto {
  id: string;
  projectId: string;
  status: 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  errorMessage: string | null;
  jobId: string | null;
  /** Successful answers stored after this analysis started (re-run to include them). */
  newAnswersSince: number;
  result: GapAnalysisResult | null;
}

/** Lower-case letters and digits only ("Crafty Art" → "craftyart"). */
export function brandKey(name: string): string {
  return name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}
