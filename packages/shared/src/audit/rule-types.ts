import type { AuditCategory, IssueSeverity } from '../enums';

export type RuleScope = 'page' | 'site';

export interface AuditRuleDefinition {
  id: string;
  category: AuditCategory;
  /** Default severity; some rules escalate based on evidence (e.g. very slow responses). */
  severity: IssueSeverity;
  scope: RuleScope;
  title: string;
  /** Why it matters, written for non-specialists. Never promises ranking outcomes. */
  impact: string;
  /** Recommended fix. */
  fix: string;
}
