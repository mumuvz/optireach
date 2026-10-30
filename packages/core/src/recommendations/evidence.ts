// Saves an evidence-backed action (from a competitor gap analysis or an SEO comparison) as a recommendation.
import type {
  BenefitLevel,
  IssueSeverity,
  RecommendationCategory,
  RecommendationSource,
} from '@surfaced/shared';
import { sha256Hex } from '../crypto';
import type { Prisma, PrismaClient } from '../db';
import { OWNER_ROLE_FOR_CATEGORY, effortForCategory, expectedBenefitFor, verificationFor } from './benefit';

export interface EvidenceRecommendationInput {
  /** Stable per project and finding, e.g. "gap|third-party-lists" or "seo|rule:title-missing". */
  fingerprintKey: string;
  source: RecommendationSource;
  title: string;
  category: RecommendationCategory;
  /** 1 (fix first) to 4 (housekeeping). */
  priority: 1 | 2 | 3 | 4;
  relatedUrl: string | null;
  evidence: Record<string, unknown>;
  steps: string[];
}

const SEVERITY_BY_PRIORITY: Record<EvidenceRecommendationInput['priority'], IssueSeverity> = {
  1: 'CRITICAL',
  2: 'HIGH',
  3: 'MEDIUM',
  4: 'LOW',
};

/** Idempotent per fingerprint; dismissed recommendations stay dismissed, completed ones are reopened. */
export async function upsertEvidenceRecommendation(
  prisma: PrismaClient,
  projectId: string,
  input: EvidenceRecommendationInput,
): Promise<{ id: string; created: boolean }> {
  const fingerprint = sha256Hex(input.fingerprintKey);
  const benefitLevel: BenefitLevel = input.priority <= 2 ? 'HIGH' : input.priority === 3 ? 'MEDIUM' : 'LOW';
  const data = {
    title: input.title.slice(0, 255),
    category: input.category,
    source: input.source,
    severity: SEVERITY_BY_PRIORITY[input.priority],
    relatedUrl: input.relatedUrl?.slice(0, 2048) ?? null,
    expectedBenefit: expectedBenefitFor(input.category),
    benefitLevel,
    evidence: input.evidence as Prisma.InputJsonValue,
    proposedFix: input.steps.map((s, i) => `${i + 1}. ${s}`).join('\n'),
    lastGeneratedAt: new Date(),
  };
  const existing = await prisma.recommendation.findUnique({
    where: { projectId_fingerprint: { projectId, fingerprint } },
  });
  if (!existing) {
    const created = await prisma.recommendation.create({
      data: {
        projectId,
        fingerprint,
        ...data,
        ownerRole: OWNER_ROLE_FOR_CATEGORY[input.category],
        effort: effortForCategory(input.category),
        verification: verificationFor(input.category),
      },
    });
    return { id: created.id, created: true };
  }
  if (existing.status !== 'DISMISSED')
    await prisma.recommendation.update({
      where: { id: existing.id },
      data: { ...data, status: existing.status === 'COMPLETED' ? 'OPEN' : existing.status },
    });
  return { id: existing.id, created: false };
}
