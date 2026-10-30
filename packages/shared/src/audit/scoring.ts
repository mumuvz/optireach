import { AUDIT_CATEGORIES, type AuditCategory, type IssueSeverity } from '../enums';
import type { RuleScope } from './rule-types';

/**
 * Surfaced Site Health score — a deterministic diagnostic index created by this application.
 * It is NOT a Google ranking score and does not predict rankings or AI citations.
 *
 * Model (see docs/scoring.md):
 *   categoryScore = 100 − min(100, pagePenalty + sitePenalty)
 *   pagePenalty   = Σ over pages of min(1, Σ severityPagePoints of that page's issues) × 100 / N
 *   sitePenalty   = Σ severitySitePoints of site-level issues
 *   overall       = Σ (weight × categoryScore) / Σ weight        (rounded)
 * where N is the number of HTML pages analyzed (minimum 1).
 */
export const SCORING_VERSION = '2026.10';

export const DEFAULT_CATEGORY_WEIGHTS: Record<AuditCategory, number> = {
  CRAWLABILITY: 20,
  HTTP_ERRORS: 15,
  METADATA: 15,
  CONTENT_STRUCTURE: 12,
  INTERNAL_LINKS: 12,
  STRUCTURED_DATA: 10,
  PERFORMANCE: 10,
  IMAGES: 6,
};

/** Share of one page's category budget consumed by one issue of each severity. */
export const DEFAULT_SEVERITY_PAGE_POINTS: Record<IssueSeverity, number> = {
  CRITICAL: 1,
  HIGH: 0.6,
  MEDIUM: 0.3,
  LOW: 0.1,
};

/** Fixed category penalty for site-level issues (e.g. no sitemap). */
export const DEFAULT_SEVERITY_SITE_POINTS: Record<IssueSeverity, number> = {
  CRITICAL: 60,
  HIGH: 35,
  MEDIUM: 15,
  LOW: 5,
};

export interface ScoringConfig {
  version: string;
  categoryWeights: Record<AuditCategory, number>;
  severityPagePoints: Record<IssueSeverity, number>;
  severitySitePoints: Record<IssueSeverity, number>;
}

export const DEFAULT_SCORING_CONFIG: ScoringConfig = {
  version: SCORING_VERSION,
  categoryWeights: DEFAULT_CATEGORY_WEIGHTS,
  severityPagePoints: DEFAULT_SEVERITY_PAGE_POINTS,
  severitySitePoints: DEFAULT_SEVERITY_SITE_POINTS,
};

export interface ScorableIssue {
  category: AuditCategory;
  severity: IssueSeverity;
  scope: RuleScope;
  /** Page identity for page-scoped issues (normalized URL). Ignored for site issues. */
  url?: string | null;
}

export interface AuditScoreResult {
  score: number;
  categoryScores: Record<AuditCategory, number>;
  pagesAnalyzed: number;
}

export function computeAuditScore(
  issues: readonly ScorableIssue[],
  pagesAnalyzed: number,
  config: ScoringConfig = DEFAULT_SCORING_CONFIG,
): AuditScoreResult {
  const n = Math.max(1, pagesAnalyzed);
  const categoryScores = {} as Record<AuditCategory, number>;

  for (const category of AUDIT_CATEGORIES) {
    const perPage = new Map<string, number>();
    let sitePenalty = 0;
    for (const issue of issues) {
      if (issue.category !== category) continue;
      if (issue.scope === 'site' || !issue.url) {
        sitePenalty += config.severitySitePoints[issue.severity];
      } else {
        perPage.set(issue.url, (perPage.get(issue.url) ?? 0) + config.severityPagePoints[issue.severity]);
      }
    }
    let pagePenalty = 0;
    for (const points of perPage.values()) pagePenalty += Math.min(1, points);
    pagePenalty = (pagePenalty * 100) / n;
    categoryScores[category] = Math.max(0, Math.round(100 - Math.min(100, pagePenalty + sitePenalty)));
  }

  let weighted = 0;
  let totalWeight = 0;
  for (const category of AUDIT_CATEGORIES) {
    const weight = config.categoryWeights[category];
    weighted += weight * categoryScores[category];
    totalWeight += weight;
  }
  const score = totalWeight > 0 ? Math.round(weighted / totalWeight) : 0;
  return { score, categoryScores, pagesAnalyzed: n };
}

export type ScoreBand = 'good' | 'fair' | 'poor';

export function scoreBand(score: number): ScoreBand {
  if (score >= 80) return 'good';
  if (score >= 50) return 'fair';
  return 'poor';
}
