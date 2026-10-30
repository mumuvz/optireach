// Turns evidence (audit issues, AI visibility gaps) into actionable recommendations.
// Expected benefits are qualitative estimates — never promises of ranking or citation outcomes.
import { SEVERITY_RANK, getAuditRule, type BenefitLevel, type IssueSeverity } from '@surfaced/shared';
import { topicGaps } from '../competitors';
import { sha256Hex } from '../crypto';
import type { Prisma, PrismaClient } from '../db';
import {
  BENEFIT_TEXT,
  DISCLAIMER,
  OWNER_ROLE_FOR_CATEGORY,
  categoryForAuditRule,
  effortForCategory,
  verificationFor,
} from './benefit';

export { categoryForAuditRule, expectedBenefitFor } from './benefit';
export { syncLocalRecommendations } from './local';

/** Owner role, effort and verification set once when a recommendation is created (later edits are preserved). */
export function recommendationDefaults(category: Parameters<typeof effortForCategory>[0]) {
  return {
    ownerRole: OWNER_ROLE_FOR_CATEGORY[category],
    effort: effortForCategory(category),
    verification: verificationFor(category),
  };
}

const BENEFIT_BY_SEVERITY: Record<IssueSeverity, BenefitLevel> = {
  CRITICAL: 'HIGH',
  HIGH: 'HIGH',
  MEDIUM: 'MEDIUM',
  LOW: 'LOW',
};

export interface RecommendationSyncResult {
  created: number;
  updated: number;
  autoCompleted: number;
}

/** Rebuilds audit-derived recommendations for a project from its current open issues. */
export async function syncAuditRecommendations(
  prisma: PrismaClient,
  projectId: string,
  auditRunId: string | null,
): Promise<RecommendationSyncResult> {
  const issues = await prisma.auditIssue.findMany({
    where: { projectId, status: 'OPEN' },
    select: { ruleId: true, category: true, severity: true, url: true },
    orderBy: { lastDetectedAt: 'desc' },
  });
  const byRule = new Map<string, typeof issues>();
  for (const issue of issues) byRule.set(issue.ruleId, [...(byRule.get(issue.ruleId) ?? []), issue]);

  const now = new Date();
  const result: RecommendationSyncResult = { created: 0, updated: 0, autoCompleted: 0 };
  const activeFingerprints = new Set<string>();

  for (const [ruleId, list] of byRule) {
    const rule = getAuditRule(ruleId);
    if (!rule) continue;
    const fingerprint = sha256Hex(`audit|${ruleId}`);
    activeFingerprints.add(fingerprint);
    const severity = list.reduce<IssueSeverity>(
      (max, i) => (SEVERITY_RANK[i.severity] > SEVERITY_RANK[max] ? i.severity : max),
      'LOW',
    );
    const category = categoryForAuditRule(ruleId, rule.category);
    const pages = list.filter((i) => i.url);
    const title =
      rule.scope === 'site'
        ? rule.title
        : `${rule.title} — ${pages.length} page${pages.length === 1 ? '' : 's'}`;
    const data = {
      title: title.slice(0, 255),
      category,
      source: 'AUDIT' as const,
      severity,
      relatedUrl: pages.length === 1 ? pages[0]!.url : null,
      expectedBenefit: `${BENEFIT_TEXT[category]} ${DISCLAIMER}`,
      benefitLevel: BENEFIT_BY_SEVERITY[severity],
      evidence: {
        ruleId,
        auditRunId,
        affectedCount: list.length,
        sampleUrls: pages.slice(0, 10).map((i) => i.url),
        why: rule.impact,
      } as Prisma.InputJsonValue,
      proposedFix: rule.fix,
      lastGeneratedAt: now,
    };
    const existing = await prisma.recommendation.findUnique({
      where: { projectId_fingerprint: { projectId, fingerprint } },
    });
    if (!existing) {
      await prisma.recommendation.create({ data: { projectId, fingerprint, ...data, ...recommendationDefaults(category) } }); // prettier-ignore
      result.created += 1;
    } else {
      // Dismissed stays dismissed; completed work that regressed is reopened.
      const reopen = existing.status === 'COMPLETED';
      await prisma.recommendation.update({
        where: { id: existing.id },
        data: { ...data, ...(reopen ? { status: 'OPEN', completedAt: null } : {}) },
      });
      result.updated += 1;
    }
  }

  // Audit recommendations whose issues no longer exist were verified as fixed by the latest audit.
  const stale = await prisma.recommendation.findMany({
    where: { projectId, source: 'AUDIT', status: { in: ['OPEN', 'PLANNED', 'IN_PROGRESS', 'AWAITING_APPROVAL', 'BLOCKED'] } }, // prettier-ignore
    select: { id: true, fingerprint: true, evidence: true },
  });
  for (const rec of stale) {
    if (activeFingerprints.has(rec.fingerprint)) continue;
    await prisma.recommendation.update({
      where: { id: rec.id },
      data: {
        status: 'COMPLETED',
        completedAt: now,
        evidence: {
          ...((rec.evidence as Record<string, unknown>) ?? {}),
          verifiedByAuditRunId: auditRunId,
        } as Prisma.InputJsonValue,
      },
    });
    result.autoCompleted += 1;
  }
  return result;
}

/**
 * Recommendations from AI visibility evidence:
 *  - prompts where competitors are mentioned but the brand is not (content/answer gaps);
 *  - third-party domains frequently cited alongside competitors but never alongside the brand.
 * Each recommendation links back to the observations behind it.
 */
export async function syncVisibilityRecommendations(
  prisma: PrismaClient,
  projectId: string,
): Promise<RecommendationSyncResult> {
  const result: RecommendationSyncResult = { created: 0, updated: 0, autoCompleted: 0 };
  const now = new Date();
  const since = new Date(now.getTime() - 90 * 24 * 3600 * 1000);
  const gaps = (await topicGaps(prisma, projectId, { from: since, includeDemo: 'true' }))
    .filter((g) => g.brandAbsentWhileCompetitorsPresent >= 1)
    .slice(0, 25);

  const upsert = async (
    fingerprint: string,
    data: Omit<Prisma.RecommendationUncheckedCreateInput, 'projectId' | 'fingerprint'>,
  ) => {
    const existing = await prisma.recommendation.findUnique({
      where: { projectId_fingerprint: { projectId, fingerprint } },
    });
    if (!existing) {
      await prisma.recommendation.create({ data: { projectId, fingerprint, ...data, ...recommendationDefaults(data.category) } }); // prettier-ignore
      result.created += 1;
    } else if (existing.status !== 'DISMISSED') {
      await prisma.recommendation.update({
        where: { id: existing.id },
        data: { ...data, status: existing.status === 'COMPLETED' ? 'OPEN' : existing.status },
      });
      result.updated += 1;
    }
  };

  for (const gap of gaps) {
    const competitors = gap.competitorsMentioned.map((c) => c.name).slice(0, 5);
    await upsert(sha256Hex(`visibility|prompt|${gap.promptId}`), {
      title: `Answer the question "${gap.prompt.slice(0, 150)}"`.slice(0, 255),
      category: 'AEO',
      source: 'AI_VISIBILITY',
      severity: gap.gapRate >= 0.75 ? 'HIGH' : gap.gapRate >= 0.4 ? 'MEDIUM' : 'LOW',
      relatedUrl: null,
      expectedBenefit: `${BENEFIT_TEXT.AEO} In ${gap.brandAbsentWhileCompetitorsPresent} of ${gap.observations} observed answers, ${competitors.join(', ')} appeared and your brand did not. ${DISCLAIMER}`,
      benefitLevel: gap.gapRate >= 0.75 ? 'HIGH' : 'MEDIUM',
      evidence: {
        promptId: gap.promptId,
        prompt: gap.prompt,
        gapRate: gap.gapRate,
        competitorsMentioned: gap.competitorsMentioned,
        observationIds: gap.sampleObservationIds,
      } as Prisma.InputJsonValue,
      proposedFix:
        'Publish or improve a page that answers this question directly: state the answer in the first sentences, cover the comparison criteria people use, describe accurately where your offering fits, and support claims with verifiable sources.',
      lastGeneratedAt: now,
    });
  }

  // Domains cited when competitors were mentioned, but never cited in answers that mention the brand.
  const observations = await prisma.aiVisibilityObservation.findMany({
    where: { projectId, status: 'SUCCEEDED', observedAt: { gte: since } },
    select: {
      id: true,
      brandMentioned: true,
      mentions: { where: { entityType: 'COMPETITOR' }, select: { competitorId: true } },
      citations: { where: { isOwnedDomain: false, competitorId: null }, select: { domain: true } },
    },
    take: 5000,
  });
  const withBrand = new Set(
    observations.filter((o) => o.brandMentioned).flatMap((o) => o.citations.map((c) => c.domain)),
  );
  const counts = new Map<string, { count: number; observationIds: string[] }>();
  for (const o of observations) {
    if (!o.mentions.length) continue;
    for (const domain of new Set(o.citations.map((c) => c.domain))) {
      if (withBrand.has(domain)) continue;
      const entry = counts.get(domain) ?? { count: 0, observationIds: [] };
      entry.count += 1;
      entry.observationIds.push(o.id);
      counts.set(domain, entry);
    }
  }
  const topDomains = [...counts.entries()]
    .filter(([, v]) => v.count >= 2)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 10);
  for (const [domain, { count, observationIds }] of topDomains) {
    await upsert(sha256Hex(`visibility|source|${domain}`), {
      title: `Review your presence on ${domain}`,
      category: 'GEO',
      source: 'AI_VISIBILITY',
      severity: count >= 5 ? 'MEDIUM' : 'LOW',
      relatedUrl: `https://${domain}/`,
      expectedBenefit: `${BENEFIT_TEXT.GEO} ${domain} was cited in ${count} answers that mentioned competitors but not your brand. ${DISCLAIMER}`,
      benefitLevel: count >= 5 ? 'MEDIUM' : 'LOW',
      evidence: {
        domain,
        citedInObservations: count,
        observationIds: observationIds.slice(0, 10),
      } as Prisma.InputJsonValue,
      proposedFix:
        'Check whether this source covers your category and whether an accurate listing, review or mention of your brand is appropriate. Do not pay for undisclosed placements or post misleading content.',
      lastGeneratedAt: now,
    });
  }
  return result;
}
