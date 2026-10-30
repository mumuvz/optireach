// Guards against drift between the Prisma schema enums and the shared (browser-safe) enum arrays.
import * as shared from '@surfaced/shared';
import { describe, expect, it } from 'vitest';
import * as prismaEnums from '../src/generated/prisma/enums';

const PAIRS: [keyof typeof prismaEnums, readonly string[]][] = [
  ['WorkspaceRole', shared.WORKSPACE_ROLES],
  ['PlatformRole', shared.PLATFORM_ROLES],
  ['UserTokenType', shared.USER_TOKEN_TYPES],
  ['JobStatus', shared.JOB_STATUSES],
  ['JobTrigger', shared.JOB_TRIGGERS],
  ['BackgroundJobType', shared.BACKGROUND_JOB_TYPES],
  ['AuditSchedule', shared.AUDIT_SCHEDULES],
  ['PageSource', shared.PAGE_SOURCES],
  ['AuditCategory', shared.AUDIT_CATEGORIES],
  ['IssueSeverity', shared.ISSUE_SEVERITIES],
  ['IssueStatus', shared.ISSUE_STATUSES],
  ['PromptFrequency', shared.PROMPT_FREQUENCIES],
  ['PromptStatus', shared.PROMPT_STATUSES],
  ['ObservationStatus', shared.OBSERVATION_STATUSES],
  ['MentionEntityType', shared.MENTION_ENTITY_TYPES],
  ['MentionMatchType', shared.MENTION_MATCH_TYPES],
  ['CitationSourceType', shared.CITATION_SOURCE_TYPES],
  ['Sentiment', shared.SENTIMENTS],
  ['SearchIntent', shared.SEARCH_INTENTS],
  ['ContentStatus', shared.CONTENT_STATUSES],
  ['ContentVersionSource', shared.CONTENT_VERSION_SOURCES],
  ['KeywordPriority', shared.KEYWORD_PRIORITIES],
  ['KeywordStatus', shared.KEYWORD_STATUSES],
  ['KeywordSource', shared.KEYWORD_SOURCES],
  ['RecommendationStatus', shared.RECOMMENDATION_STATUSES],
  ['RecommendationCategory', shared.RECOMMENDATION_CATEGORIES],
  ['RecommendationSource', shared.RECOMMENDATION_SOURCES],
  ['BenefitLevel', shared.BENEFIT_LEVELS],
  ['IntegrationProvider', shared.INTEGRATION_PROVIDERS],
  ['IntegrationStatus', shared.INTEGRATION_STATUSES],
  ['GscDimension', shared.GSC_DIMENSIONS],
  ['SubscriptionStatus', shared.SUBSCRIPTION_STATUSES],
  ['BillingProvider', shared.BILLING_PROVIDERS],
  ['BillingInterval', shared.BILLING_INTERVALS],
  ['InvoiceStatus', shared.INVOICE_STATUSES],
  ['WebhookEventStatus', shared.WEBHOOK_EVENT_STATUSES],
  ['UsageMetric', shared.USAGE_METRICS],
  ['ReportStatus', shared.REPORT_STATUSES],
  ['EmailStatus', shared.EMAIL_STATUSES],
];

describe('Prisma ↔ shared enum parity', () => {
  it.each(PAIRS)('%s matches the shared values', (name, values) => {
    const prismaValues = Object.values(prismaEnums[name] as Record<string, string>);
    expect([...prismaValues].sort()).toEqual([...values].sort());
  });
});
