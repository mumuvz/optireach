// Local SEO health: an explainable score from what the business controls (profile completeness, review replies,
// product data). Visibility results (Maps, AI answers) are outcomes and stay on their own cards. Components without
// data are left out, the weights of the others are rescaled, and the coverage is shown.
import { businessProfileSchema, type MerchantStatusDto } from '@surfaced/shared';
import type { BusinessLocation, Project, PrismaClient } from '../db';
import { profileRetentionCutoff, toProfileView, type GbpLocation } from './business-profile';
import { toLocationDto } from './locations';
import { auditProfile } from './profile-audit';

export interface HealthComponent {
  key: 'profile' | 'reviews' | 'products' | 'listings';
  label: string;
  weight: number;
  /** 0–100, or null when not measured (left out of the score). */
  score: number | null;
  evidence: string;
  source: string | null;
}

export interface LocalHealth {
  score: number | null;
  components: HealthComponent[];
  measured: number;
}

export async function computeLocalHealth(
  prisma: PrismaClient,
  project: Project,
  location: BusinessLocation | null,
  products: MerchantStatusDto['products'],
  now = new Date(),
): Promise<LocalHealth> {
  const components: HealthComponent[] = [];
  const businessProfile = businessProfileSchema.safeParse(project.businessProfile ?? {});
  const types = businessProfile.success ? businessProfile.data.types : [];

  // Profile completeness: the live profile when linked and synced, otherwise the details entered in Surfaced.
  if (location) {
    const cutoff = profileRetentionCutoff(now);
    const snapshot = location.profileLocationName
      ? await prisma.businessProfileSnapshot.findFirst({ where: { locationId: location.id, profileLocationName: location.profileLocationName, fetchedAt: { gte: cutoff } }, orderBy: { fetchedAt: 'desc' } }) // prettier-ignore
      : null;
    const reviews = snapshot
      ? await prisma.businessReview.findMany({ where: { locationId: location.id, fetchedAt: { gte: cutoff } }, select: { replyComment: true, createTime: true } }) // prettier-ignore
      : [];
    const unanswered = reviews.filter((r) => !r.replyComment);
    const audit = auditProfile({
      now,
      location: toLocationDto(location),
      profile: snapshot ? toProfileView(snapshot.data as unknown as GbpLocation) : null,
      website:
        project.websiteUrl && project.domain ? { url: project.websiteUrl, domain: project.domain } : null,
      businessProfile: businessProfile.success ? businessProfile.data : null,
      reviews: snapshot && location.profileAccountName ? { total: reviews.length, unanswered: unanswered.length, oldestUnansweredAt: unanswered.reduce<Date | null>((m, r) => (!m || r.createTime < m ? r.createTime : m), null) } : null, // prettier-ignore
    });
    const failing = audit.checks.filter((c) => c.status === 'fail').map((c) => c.title.toLowerCase());
    components.push({
      key: 'profile',
      label: 'Profile completeness',
      weight: 40,
      score: audit.applicable ? Math.round((audit.passed / audit.applicable) * 100) : null,
      evidence: audit.applicable
        ? `${audit.passed} of ${audit.applicable} applicable checks pass${failing.length ? `; to fix: ${failing.slice(0, 3).join(', ')}${failing.length > 3 ? '…' : ''}` : ''}.`
        : 'No checks could be evaluated.',
      source: audit.source === 'BUSINESS_PROFILE' ? 'Business Profile (live)' : 'Details entered in Surfaced',
    });
    components.push({
      key: 'reviews',
      label: 'Review replies',
      weight: 20,
      score:
        snapshot && reviews.length
          ? Math.round(((reviews.length - unanswered.length) / reviews.length) * 100)
          : null,
      evidence: !snapshot
        ? 'Needs a connected Business Profile.'
        : reviews.length
          ? `${reviews.length - unanswered.length} of the ${reviews.length} most recent reviews have a reply.`
          : 'No reviews were returned.',
      source: snapshot ? 'Business Profile (live)' : null,
    });
  }
  components.push({
    key: 'listings',
    label: 'Listing consistency (name, address, phone)',
    weight: 25,
    score: null,
    evidence: 'Not tracked yet.',
    source: null,
  });
  const sellsProducts =
    types.includes('MERCHANT_SELLER') || types.includes('ECOMMERCE') || products.total > 0;
  if (sellsProducts)
    components.push({
      key: 'products',
      label: 'Product data',
      weight: 15,
      score: products.total ? Math.round((products.ok / products.total) * 100) : null,
      evidence: products.total
        ? `${products.ok} of ${products.total} products pass all checks; ${products.errors} have errors.`
        : 'Import a product feed or connect Merchant Center to include it.',
      source: products.total ? 'Product data checks' : null,
    });
  const measured = components.filter((c) => c.score !== null);
  const totalWeight = measured.reduce((s, c) => s + c.weight, 0);
  return {
    score: totalWeight
      ? Math.round(measured.reduce((s, c) => s + c.score! * c.weight, 0) / totalWeight)
      : null,
    components,
    measured: measured.length,
  };
}
