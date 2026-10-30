import type { AuditCategory } from '../enums';
import type { AuditRuleDefinition } from './rule-types';
import { CONTENT_RULES } from './rules-content';
import { TECHNICAL_RULES } from './rules-technical';

export const AUDIT_RULES: readonly AuditRuleDefinition[] = Object.freeze([
  ...TECHNICAL_RULES,
  ...CONTENT_RULES,
]);

const RULES_BY_ID = new Map(AUDIT_RULES.map((rule) => [rule.id, rule]));

export function getAuditRule(id: string): AuditRuleDefinition | undefined {
  return RULES_BY_ID.get(id);
}

/** Like getAuditRule but throws for unknown ids — used by the rule engine where ids are constants. */
export function requireAuditRule(id: string): AuditRuleDefinition {
  const rule = RULES_BY_ID.get(id);
  if (!rule) throw new Error(`Unknown audit rule: ${id}`);
  return rule;
}

export function rulesForCategory(category: AuditCategory): AuditRuleDefinition[] {
  return AUDIT_RULES.filter((rule) => rule.category === category);
}
