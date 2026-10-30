// Google Business Profile for a project: connection status, linking profile locations to business locations, sync,
// the profile audit, performance metrics, and reviews with reply drafts. Replies reach Google only through
// publishReply, which requires an approval for the exact text (docs/providers/google-business-profile.md).
import { assertApproved, latestApproval, requestApproval, snapshotHash } from '@surfaced/core/approvals';
import { recordAuditLog } from '@surfaced/core/audit-log';
import { getLlmProvider, ProviderError } from '@surfaced/core/ai';
import type {
  BusinessLocation,
  Integration,
  PrismaClient,
  ProfileChangeRequest,
  ReviewReply,
} from '@surfaced/core/db';
import { Errors, errorMessage } from '@surfaced/core/errors';
import { emitEvent } from '@surfaced/core/events';
import {
  GoogleApiError,
  IntegrationAuthError,
  googleOAuthConfigured,
  integrationCatalog,
  type HttpFetch,
} from '@surfaced/core/integrations';
import { createJobRecord, enqueueJobRecord } from '@surfaced/core/jobs';
import {
  auditProfile,
  deleteProfileData,
  draftReviewReply,
  formatProfileAddress,
  getProfileLocation,
  listProfileAccounts,
  listProfileLocations,
  locationFromProfile,
  locationWriteData,
  profileRetentionCutoff,
  putReviewReply,
  summarizeProfileMetrics,
  summarizeReviews,
  toLocationDto,
  toProfileView,
  updateProfileLocation,
  type GbpLocation,
} from '@surfaced/core/local';
import {
  assertCountLimit,
  assertMonthlyQuota,
  countLocationsForLimit,
  recordUsage,
  withWorkspaceLock,
} from '@surfaced/core/usage';
import {
  PROFILE_DATA_RETENTION_DAYS,
  PROFILE_EDITABLE_FIELDS,
  businessProfileSchema,
  locationInputSchema,
  profileChangeSchema,
  profileLinkSchema,
  reviewReplyDraftSchema,
  reviewReplyUpdateSchema,
  type BusinessProfileLocationDto,
  type BusinessProfileStatusDto,
  type BusinessReviewDto,
  type LocationDto,
  type LocationKind,
  type ProfileAccountDto,
  type ProfileLinkInput,
  type ProfileChangeInput,
  type ProfileChangeRequestDto,
  type ProfileEditableField,
  type ProfileLocationOptionDto,
  type ReviewReplyDraftInput,
  type ReviewReplyDto,
  type ReviewReplyStatus,
  type ReviewSummaryDto,
  type ReviewThemeDto,
} from '@surfaced/shared';
import type { AppDeps, AuthUser } from '../types';
import { requireProjectAccess } from './access';

const REVIEWS_SHOWN = 200;

type ReplyRow = ReviewReply & { createdBy: { id: string; name: string } | null };

/** Google's refusals (no API access yet, quota 0, no permission on the profile) reach the user with Google's reason. */
async function google<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof GoogleApiError)
      throw Errors.upstream(error.message, {
        provider: 'GOOGLE_BUSINESS_PROFILE',
        httpStatus: error.httpStatus,
        googleStatus: error.googleStatus,
      });
    if (error instanceof IntegrationAuthError)
      throw Errors.conflict(error.message, { reason: 'NEEDS_REAUTH' });
    throw error;
  }
}

/** What an approver approves: the reply text and where it will be published. */
function replySnapshot(
  reply: Pick<ReviewReply, 'reviewName' | 'comment'>,
  location: Pick<BusinessLocation, 'name'>,
) {
  return {
    action: 'Publish a reply to a Google review',
    location: location.name,
    reviewName: reply.reviewName,
    reply: reply.comment,
  };
}

/** Only the editable fields with string values, from the stored JSON (defensive against unexpected shapes). */
function changeFields(fields: unknown): Partial<Record<ProfileEditableField, string>> {
  const out: Partial<Record<ProfileEditableField, string>> = {};
  if (fields && typeof fields === 'object')
    for (const key of PROFILE_EDITABLE_FIELDS) {
      const value = (fields as Record<string, unknown>)[key];
      if (typeof value === 'string') out[key] = value;
    }
  return out;
}

/** What an approver approves: the exact field values and where they will be published. */
function profileChangeSnapshot(
  fields: Partial<Record<ProfileEditableField, string>>,
  location: Pick<BusinessLocation, 'name'>,
) {
  return { action: 'Update the Google Business Profile fields', location: location.name, fields };
}

/** A stored review summary row to its DTO; `stale` is true when newer reviews have arrived since generation. */
function reviewSummaryDto(
  row: {
    reviewCount: number;
    positive: number;
    neutral: number;
    negative: number;
    themes: unknown;
    summary: string;
    model: string | null;
    isDevAdapter: boolean;
    newestReviewAt: Date | null;
    generatedAt: Date;
  },
  newestReviewAt: Date | null,
): ReviewSummaryDto {
  return {
    reviewCount: row.reviewCount,
    sentiment: { positive: row.positive, neutral: row.neutral, negative: row.negative },
    themes: (Array.isArray(row.themes) ? row.themes : []) as unknown as ReviewThemeDto[],
    summary: row.summary,
    model: row.model,
    isDevAdapter: row.isDevAdapter,
    generatedAt: row.generatedAt.toISOString(),
    stale: Boolean(newestReviewAt && (!row.newestReviewAt || newestReviewAt > row.newestReviewAt)),
  };
}

export class BusinessProfileService {
  constructor(private readonly deps: AppDeps) {}

  private get prisma(): PrismaClient {
    return this.deps.prisma;
  }

  private get http(): HttpFetch {
    return this.deps.httpFetch ?? fetch;
  }

  private integration(projectId: string): Promise<Integration | null> {
    return this.prisma.integration.findUnique({
      where: { projectId_provider: { projectId, provider: 'GOOGLE_BUSINESS_PROFILE' } },
    });
  }

  private async connected(projectId: string): Promise<Integration> {
    const integration = await this.integration(projectId);
    if (!integration || integration.status === 'DISCONNECTED')
      throw Errors.conflict('Connect Google Business Profile first (Integrations).');
    if (integration.status === 'NEEDS_REAUTH')
      throw Errors.conflict('Google access expired or was revoked. Reconnect Google Business Profile.');
    return integration;
  }

  private async location(projectId: string, locationId: string): Promise<BusinessLocation> {
    const row = await this.prisma.businessLocation.findFirst({
      where: { id: locationId, projectId, archivedAt: null },
    });
    if (!row) throw Errors.notFound('Location');
    return row;
  }

  // ---------------- Status, accounts, linking ----------------

  async status(user: AuthUser, projectId: string): Promise<BusinessProfileStatusDto> {
    await requireProjectAccess(this.prisma, user, projectId, 'project.read');
    const [integration, locations] = await Promise.all([
      this.integration(projectId),
      this.prisma.businessLocation.findMany({
        where: { projectId, archivedAt: null },
        orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
        include: {
          profileSnapshots: { orderBy: { fetchedAt: 'desc' }, take: 1, select: { fetchedAt: true } },
          _count: { select: { reviews: { where: { replyComment: null } } } },
        },
      }),
    ]);
    const entry = integrationCatalog().find((e) => e.provider === 'GOOGLE_BUSINESS_PROFILE')!;
    return {
      configured: googleOAuthConfigured(),
      setup: entry.setup,
      retentionDays: PROFILE_DATA_RETENTION_DAYS,
      integration:
        integration && integration.status !== 'DISCONNECTED'
          ? {
              id: integration.id,
              status: integration.status,
              externalAccount: integration.externalAccount,
              connectedAt: integration.connectedAt?.toISOString() ?? null,
              lastSyncAt: integration.lastSyncAt?.toISOString() ?? null,
              lastSyncStatus: integration.lastSyncStatus,
              lastError: integration.lastError,
            }
          : null,
      locations: locations.map((l) => ({
        id: l.id,
        name: l.name,
        city: l.city,
        kind: l.kind as LocationKind,
        profileLocationName: l.profileLocationName,
        profileAccountName: l.profileAccountName,
        snapshotAt: l.profileSnapshots[0]?.fetchedAt.toISOString() ?? null,
        unansweredReviews: l._count.reviews,
      })),
    };
  }

  async accounts(user: AuthUser, projectId: string): Promise<ProfileAccountDto[]> {
    await requireProjectAccess(this.prisma, user, projectId, 'local.manage');
    const integration = await this.connected(projectId);
    return google(() => listProfileAccounts(this.prisma, integration.id, this.http));
  }

  /** Profile locations of one account, read live from Google (not stored). */
  async accountLocations(
    user: AuthUser,
    projectId: string,
    accountName: string,
  ): Promise<ProfileLocationOptionDto[]> {
    await requireProjectAccess(this.prisma, user, projectId, 'local.manage');
    const integration = await this.connected(projectId);
    const [raw, linked] = await Promise.all([
      google(() => listProfileLocations(this.prisma, integration.id, accountName, this.http)),
      this.prisma.businessLocation.findMany({
        where: { projectId, archivedAt: null, profileLocationName: { not: null } },
        select: { id: true, profileLocationName: true },
      }),
    ]);
    return raw.map((l: GbpLocation) => {
      const view = toProfileView(l);
      return {
        name: view.name,
        title: view.title,
        address:
          formatProfileAddress(view) ??
          (view.serviceArea?.places.length
            ? `Serves ${view.serviceArea.places.slice(0, 3).join(', ')}`
            : null),
        storeCode: view.storeCode,
        primaryCategory: view.primaryCategory,
        placeId: view.placeId,
        hasVoiceOfMerchant: view.hasVoiceOfMerchant,
        linkedLocationId: linked.find((x) => x.profileLocationName === view.name)?.id ?? null,
      };
    });
  }

  /** Links a profile location to an existing business location, or creates one from the profile. Then syncs. */
  async link(user: AuthUser, projectId: string, input: ProfileLinkInput): Promise<LocationDto> {
    const { project } = await requireProjectAccess(this.prisma, user, projectId, 'local.manage');
    const data = profileLinkSchema.parse(input);
    const integration = await this.connected(projectId);
    const taken = await this.prisma.businessLocation.findFirst({
      where: { projectId, archivedAt: null, profileLocationName: data.profileLocationName },
      select: { id: true, name: true },
    });
    if (taken && taken.id !== data.locationId)
      throw Errors.conflict(`This profile is already linked to ${taken.name}.`);
    const raw = await google(() =>
      getProfileLocation(this.prisma, integration.id, data.profileLocationName, this.http),
    );
    const view = toProfileView(raw);
    const link = {
      profileLocationName: data.profileLocationName,
      profileAccountName: data.accountName,
      profileLinkedAt: new Date(),
    };
    let row: BusinessLocation;
    if (data.locationId) {
      const existing = await this.location(projectId, data.locationId);
      if (existing.profileLocationName && existing.profileLocationName !== data.profileLocationName)
        await deleteProfileData(this.prisma, { projectId, locationId: existing.id });
      row = await this.prisma.businessLocation.update({
        where: { id: existing.id },
        data: { ...link, ...(view.placeId && !existing.placeId ? { placeId: view.placeId } : {}) },
      });
    } else {
      const used = await countLocationsForLimit(this.prisma, project.workspaceId);
      await assertCountLimit(this.prisma, project.workspaceId, 'businessLocations', used);
      const first =
        (await this.prisma.businessLocation.count({ where: { projectId, archivedAt: null } })) === 0;
      const parsed = locationInputSchema.safeParse(locationFromProfile(view, first));
      if (!parsed.success)
        throw Errors.badRequest(
          'This profile has no street address or service area that can be used for a location. Add the location by hand, then link it.',
        );
      row = await this.prisma.$transaction(async (tx) => {
        if (parsed.data.isPrimary)
          await tx.businessLocation.updateMany({ where: { projectId }, data: { isPrimary: false } });
        return tx.businessLocation.create({
          data: {
            projectId,
            ...locationWriteData(parsed.data),
            source: 'BUSINESS_PROFILE',
            placeId: view.placeId,
            ...link,
          },
        });
      });
    }
    await recordAuditLog(this.prisma, {
      action: 'business_profile.linked',
      actorUserId: user.id,
      workspaceId: project.workspaceId,
      targetType: 'BusinessLocation',
      targetId: row.id,
      metadata: { profileLocationName: data.profileLocationName, created: !data.locationId },
    });
    await this.queueSync(integration, user.id).catch(() => undefined);
    return toLocationDto(row);
  }

  /** Removes the link and deletes the Business Profile data stored for the location. Reply drafts are kept. */
  async unlink(user: AuthUser, projectId: string, locationId: string): Promise<void> {
    const { project } = await requireProjectAccess(this.prisma, user, projectId, 'local.manage');
    const location = await this.location(projectId, locationId);
    if (!location.profileLocationName)
      throw Errors.conflict('This location is not linked to a Business Profile.');
    await this.prisma.$transaction(async (tx) => {
      await deleteProfileData(tx, { projectId, locationId });
      await tx.businessLocation.update({
        where: { id: locationId },
        data: { profileLocationName: null, profileAccountName: null, profileLinkedAt: null },
      });
    });
    await recordAuditLog(this.prisma, {
      action: 'business_profile.unlinked',
      actorUserId: user.id,
      workspaceId: project.workspaceId,
      targetType: 'BusinessLocation',
      targetId: locationId,
    });
  }

  async sync(user: AuthUser, projectId: string) {
    await requireProjectAccess(this.prisma, user, projectId, 'local.manage');
    const integration = await this.connected(projectId);
    const linked = await this.prisma.businessLocation.count({
      where: { projectId, archivedAt: null, profileLocationName: { not: null } },
    });
    if (!linked) throw Errors.badRequest('Link a Business Profile location before syncing.');
    return this.queueSync(integration, user.id);
  }

  private async queueSync(integration: Integration, userId: string) {
    const pending = await this.prisma.backgroundJob.findFirst({
      where: { type: 'INTEGRATION_SYNC', entityId: integration.id, status: { in: ['QUEUED', 'RUNNING'] } },
      select: { id: true, status: true },
    });
    if (pending) return { jobId: pending.id, status: pending.status };
    const job = await createJobRecord(this.prisma, {
      type: 'INTEGRATION_SYNC',
      queue: 'integration-sync',
      workspaceId: integration.workspaceId,
      projectId: integration.projectId,
      userId,
      entityType: 'Integration',
      entityId: integration.id,
      payload: { integrationId: integration.id },
    });
    await enqueueJobRecord(this.prisma, this.deps.queues, job, 'integration-sync', {
      backgroundJobId: job.id,
      integrationId: integration.id,
    });
    return { jobId: job.id, status: 'QUEUED' as const };
  }

  // ---------------- Location detail ----------------

  async locationDetail(
    user: AuthUser,
    projectId: string,
    locationId: string,
  ): Promise<BusinessProfileLocationDto> {
    const { project } = await requireProjectAccess(this.prisma, user, projectId, 'project.read');
    const location = await this.location(projectId, locationId);
    const now = new Date();
    const cutoff = profileRetentionCutoff(now);
    const linked = Boolean(location.profileLocationName);
    const [snapshot, metricRows, reviews, replies, summaryRow, changeRow] = await Promise.all([
      linked
        ? this.prisma.businessProfileSnapshot.findFirst({
            where: {
              locationId,
              profileLocationName: location.profileLocationName!,
              fetchedAt: { gte: cutoff },
            },
            orderBy: { fetchedAt: 'desc' },
          })
        : null,
      linked
        ? this.prisma.businessProfileMetric.findMany({
            where: { locationId, fetchedAt: { gte: cutoff } },
            orderBy: { date: 'asc' },
          })
        : [],
      linked
        ? this.prisma.businessReview.findMany({
            where: { locationId, fetchedAt: { gte: cutoff } },
            orderBy: { createTime: 'desc' },
            take: REVIEWS_SHOWN,
          })
        : [],
      this.prisma.reviewReply.findMany({
        where: { locationId, status: { not: 'DISCARDED' } },
        orderBy: { createdAt: 'desc' },
        include: { createdBy: { select: { id: true, name: true } } },
        take: 500,
      }),
      this.prisma.businessReviewSummary.findUnique({ where: { locationId } }),
      this.prisma.profileChangeRequest.findFirst({
        where: { locationId, status: { not: 'DISCARDED' } },
        orderBy: { createdAt: 'desc' },
      }),
    ]);
    const profile = snapshot ? toProfileView(snapshot.data as unknown as GbpLocation) : null;
    const replyDtos = await this.replyDtos(project.workspaceId, location, replies);
    const reviewDtos: BusinessReviewDto[] = reviews.map((r) => ({
      id: r.id,
      reviewName: r.reviewName,
      reviewerName: r.reviewerName,
      isAnonymous: r.isAnonymous,
      starRating: r.starRating,
      comment: r.comment,
      createTime: r.createTime.toISOString(),
      updateTime: r.updateTime?.toISOString() ?? null,
      reply: r.replyComment
        ? { comment: r.replyComment, updateTime: r.replyUpdateTime?.toISOString() ?? null }
        : null,
      fetchedAt: r.fetchedAt.toISOString(),
      draft: replyDtos.find((d) => d.reviewName === r.reviewName) ?? null,
    }));
    const unanswered = reviews.filter((r) => !r.replyComment);
    const oldest = unanswered.reduce<Date | null>(
      (min, r) => (!min || r.createTime < min ? r.createTime : min),
      null,
    );
    const newestReviewAt = reviews.reduce<Date | null>((max, r) => {
      const t = r.updateTime ?? r.createTime;
      return !max || t > max ? t : max;
    }, null);
    const website =
      project.websiteUrl && project.domain ? { url: project.websiteUrl, domain: project.domain } : null;
    const businessProfile = businessProfileSchema.safeParse(project.businessProfile ?? {});
    return {
      location: {
        id: location.id,
        name: location.name,
        city: location.city,
        kind: location.kind as LocationKind,
        profileLocationName: location.profileLocationName,
        profileAccountName: location.profileAccountName,
      },
      profile,
      snapshotAt: snapshot?.fetchedAt.toISOString() ?? null,
      reviewTotals: snapshot
        ? {
            averageRating: snapshot.averageRating === null ? null : Number(snapshot.averageRating),
            totalReviewCount: snapshot.totalReviewCount,
          }
        : null,
      audit: auditProfile({
        now,
        location: toLocationDto(location),
        profile,
        website,
        businessProfile: businessProfile.success ? businessProfile.data : null,
        reviews: snapshot && location.profileAccountName ? { total: reviews.length, unanswered: unanswered.length, oldestUnansweredAt: oldest } : null, // prettier-ignore
      }),
      metrics: metricRows.length
        ? summarizeProfileMetrics(metricRows, snapshot?.fetchedAt ?? metricRows[0]!.fetchedAt)
        : null,
      reviews: reviewDtos,
      unansweredReviews: unanswered.length,
      reviewSummary: summaryRow ? reviewSummaryDto(summaryRow, newestReviewAt) : null,
      profileChange: changeRow ? await this.profileChangeDto(project.workspaceId, location, changeRow) : null,
      limitations: [
        `Google allows Business Profile data to be stored for at most ${PROFILE_DATA_RETENTION_DAYS} days, so Surfaced keeps only the latest sync and deletes older data.`,
        'Performance metrics are as reported by Google and arrive a few days late; Google can revise them.',
        ...(location.profileAccountName
          ? []
          : [
              'Reviews are read through the account the profile was linked with; link the profile again to read reviews.',
            ]),
      ],
    };
  }

  // ---------------- Review replies ----------------

  private async replyDtos(
    workspaceId: string,
    location: BusinessLocation,
    rows: ReplyRow[],
  ): Promise<ReviewReplyDto[]> {
    return Promise.all(
      rows.map(async (row) => {
        const approval = await latestApproval(this.prisma, {
          workspaceId,
          entityType: 'REVIEW_REPLY',
          entityId: row.id,
        });
        const covers = approval
          ? approval.snapshotHash === snapshotHash(replySnapshot(row, location))
          : false;
        return {
          id: row.id,
          reviewName: row.reviewName,
          comment: row.comment,
          origin: row.origin === 'AI' ? 'AI' : 'HUMAN',
          model: row.model,
          status: row.status as ReviewReplyStatus,
          approval: approval ? { id: approval.id, status: approval.status, coversCurrentText: covers } : null,
          canPublish:
            approval?.status === 'APPROVED' &&
            covers &&
            (row.status === 'AWAITING_APPROVAL' || row.status === 'FAILED'),
          publishedAt: row.publishedAt?.toISOString() ?? null,
          publishError: row.publishError,
          createdBy: row.createdBy,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
        } satisfies ReviewReplyDto;
      }),
    );
  }

  private async replyDto(workspaceId: string, replyId: string): Promise<ReviewReplyDto> {
    const row = await this.prisma.reviewReply.findUniqueOrThrow({
      where: { id: replyId },
      include: { createdBy: { select: { id: true, name: true } }, location: true },
    });
    return (await this.replyDtos(workspaceId, row.location, [row]))[0]!;
  }

  private async loadReply(projectId: string, replyId: string) {
    const reply = await this.prisma.reviewReply.findFirst({
      where: { id: replyId, projectId },
      include: { location: true },
    });
    if (!reply) throw Errors.notFound('Reply');
    return reply;
  }

  /** Withdraws pending approvals for a reply whose text is changing or that is discarded. */
  private withdrawPending(workspaceId: string, replyId: string) {
    return this.prisma.approvalRequest.updateMany({
      where: { workspaceId, entityType: 'REVIEW_REPLY', entityId: replyId, status: 'PENDING' },
      data: { status: 'WITHDRAWN' },
    });
  }

  /** Creates a reply draft (written by the user, or drafted by the AI model). Earlier open drafts are discarded. */
  async createDraft(
    user: AuthUser,
    projectId: string,
    reviewId: string,
    input: ReviewReplyDraftInput,
  ): Promise<ReviewReplyDto> {
    const { project } = await requireProjectAccess(this.prisma, user, projectId, 'local.manage');
    const data = reviewReplyDraftSchema.parse(input);
    const review = await this.prisma.businessReview.findFirst({
      where: { id: reviewId, projectId },
      include: { location: true },
    });
    if (!review) throw Errors.notFound('Review');
    let comment = data.comment ?? '';
    let origin: 'AI' | 'HUMAN' = 'HUMAN';
    let model: string | null = null;
    if (data.generate) {
      const llm = getLlmProvider();
      if (!llm)
        throw Errors.providerNotConfigured('AI drafting', {
          detail: 'No AI model is configured (LLM_PROVIDER=none). Write the reply instead.',
        });
      await assertMonthlyQuota(this.prisma, project.workspaceId, 'CONTENT_GENERATION', 1);
      try {
        const draft = await draftReviewReply(llm, {
          businessName: review.location.name,
          category: review.location.primaryCategory,
          city: review.location.city,
          review: {
            starRating: review.starRating,
            comment: review.comment,
            reviewerName: review.reviewerName,
          },
          instructions: data.instructions,
        });
        comment = draft.comment.slice(0, 3000);
        model = draft.isDevAdapter ? 'dev-template' : draft.model.slice(0, 80);
        origin = 'AI';
      } catch (error) {
        if (error instanceof ProviderError) throw Errors.upstream(`The AI draft failed: ${error.message}`);
        throw error;
      }
    }
    const open = await this.prisma.reviewReply.findMany({
      where: {
        projectId,
        reviewName: review.reviewName,
        status: { in: ['DRAFT', 'AWAITING_APPROVAL', 'FAILED'] },
      },
      select: { id: true },
    });
    const row = await this.prisma.$transaction(async (tx) => {
      if (open.length) {
        await tx.reviewReply.updateMany({
          where: { id: { in: open.map((o) => o.id) } },
          data: { status: 'DISCARDED' },
        });
        await tx.approvalRequest.updateMany({
          where: {
            workspaceId: project.workspaceId,
            entityType: 'REVIEW_REPLY',
            entityId: { in: open.map((o) => o.id) },
            status: 'PENDING',
          },
          data: { status: 'WITHDRAWN' },
        });
      }
      return tx.reviewReply.create({
        data: {
          projectId,
          locationId: review.locationId,
          reviewName: review.reviewName,
          comment,
          origin,
          model,
          createdById: user.id,
        },
      });
    });
    if (origin === 'AI')
      await withWorkspaceLock(this.prisma, project.workspaceId, (tx) =>
        recordUsage(tx, { workspaceId: project.workspaceId, projectId, metric: 'CONTENT_GENERATION', quantity: 1, idempotencyKey: `review-reply:${row.id}` }),
      ); // prettier-ignore
    return this.replyDto(project.workspaceId, row.id);
  }

  async updateReply(
    user: AuthUser,
    projectId: string,
    replyId: string,
    input: { comment: string },
  ): Promise<ReviewReplyDto> {
    const { project } = await requireProjectAccess(this.prisma, user, projectId, 'local.manage');
    const { comment } = reviewReplyUpdateSchema.parse(input);
    const reply = await this.loadReply(projectId, replyId);
    if (!['DRAFT', 'AWAITING_APPROVAL', 'FAILED'].includes(reply.status))
      throw Errors.conflict('Only unpublished drafts can be edited.');
    if (comment !== reply.comment) {
      await this.withdrawPending(project.workspaceId, replyId);
      await this.prisma.reviewReply.update({
        where: { id: replyId },
        data: { comment, status: 'DRAFT', publishError: null },
      });
    }
    return this.replyDto(project.workspaceId, replyId);
  }

  async requestApproval(user: AuthUser, projectId: string, replyId: string): Promise<ReviewReplyDto> {
    const { project } = await requireProjectAccess(this.prisma, user, projectId, 'local.manage');
    const reply = await this.loadReply(projectId, replyId);
    if (!['DRAFT', 'AWAITING_APPROVAL', 'FAILED'].includes(reply.status))
      throw Errors.conflict('Only unpublished drafts can be sent for approval.');
    await requestApproval(this.prisma, {
      workspaceId: project.workspaceId,
      projectId,
      entityType: 'REVIEW_REPLY',
      entityId: reply.id,
      title: `Review reply for ${reply.location.name}`,
      summary:
        'Approving publishes this reply under the review on Google. The review itself is shown on the Business Profile page.',
      snapshot: replySnapshot(reply, reply.location),
      requestedById: user.id,
    });
    if (reply.status === 'DRAFT')
      await this.prisma.reviewReply.update({ where: { id: replyId }, data: { status: 'AWAITING_APPROVAL' } });
    return this.replyDto(project.workspaceId, replyId);
  }

  /** Publishes an approved reply to Google. Needs local.publish and an approval for exactly this text. */
  async publishReply(user: AuthUser, projectId: string, replyId: string): Promise<ReviewReplyDto> {
    const { project } = await requireProjectAccess(this.prisma, user, projectId, 'local.publish');
    const reply = await this.loadReply(projectId, replyId);
    if (reply.status === 'PUBLISHED') throw Errors.conflict('This reply is already published.');
    if (reply.status !== 'AWAITING_APPROVAL' && reply.status !== 'FAILED')
      throw Errors.conflict('Send the reply for approval first.');
    const location = reply.location;
    if (!location.profileLocationName || !location.profileAccountName)
      throw Errors.conflict('The location is no longer linked to a Business Profile.');
    if (
      !reply.reviewName.startsWith(`${location.profileAccountName}/${location.profileLocationName}/reviews/`)
    )
      throw Errors.conflict('This review belongs to a different Business Profile than the one linked now.');
    const integration = await this.connected(projectId);
    const approval = await assertApproved(
      this.prisma,
      { workspaceId: project.workspaceId, entityType: 'REVIEW_REPLY', entityId: reply.id },
      replySnapshot(reply, location),
    );
    const claimed = await this.prisma.reviewReply.updateMany({
      where: { id: reply.id, status: { in: ['AWAITING_APPROVAL', 'FAILED'] } },
      data: { status: 'PUBLISHING', publishError: null },
    });
    if (claimed.count !== 1) throw Errors.conflict('This reply is already being published.');
    try {
      const published = await google(() =>
        putReviewReply(this.prisma, integration.id, reply.reviewName, reply.comment, this.http),
      );
      const now = new Date();
      await this.prisma.$transaction([
        this.prisma.reviewReply.update({
          where: { id: reply.id },
          data: { status: 'PUBLISHED', publishedAt: now, publishedById: user.id },
        }),
        this.prisma.businessReview.updateMany({
          where: { reviewName: reply.reviewName, projectId },
          data: {
            replyComment: published.comment,
            replyUpdateTime: published.updateTime ? new Date(published.updateTime) : now,
          },
        }),
      ]);
    } catch (error) {
      await this.prisma.reviewReply.update({
        where: { id: reply.id },
        data: { status: 'FAILED', publishError: errorMessage(error).slice(0, 2000) },
      });
      throw error;
    }
    await recordAuditLog(this.prisma, {
      action: 'review_reply.published',
      actorUserId: user.id,
      workspaceId: project.workspaceId,
      targetType: 'ReviewReply',
      targetId: reply.id,
      metadata: { approvalId: approval.id, reviewName: reply.reviewName },
    });
    await emitEvent(this.prisma, {
      workspaceId: project.workspaceId,
      projectId,
      type: 'review_reply.published',
      entityType: 'ReviewReply',
      entityId: reply.id,
      actorUserId: user.id,
      data: { approvalId: approval.id, locationId: location.id },
    });
    // Google requires the business to be told about changes made on its behalf.
    const notify = [
      ...new Set(
        [approval.decidedById, reply.createdById].filter((id): id is string => Boolean(id) && id !== user.id),
      ),
    ];
    if (notify.length)
      await this.prisma.notification
        .createMany({
          data: notify.map((userId) => ({
            userId,
            workspaceId: project.workspaceId,
            type: 'review_reply_published',
            title: `Reply published on Google for ${location.name}`.slice(0, 255),
            body: reply.comment.slice(0, 500),
            link: `/app/p/${projectId}/local/profile?location=${location.id}`,
          })),
        })
        .catch(() => undefined);
    return this.replyDto(project.workspaceId, reply.id);
  }

  /**
   * (Re)generates the AI sentiment-and-theme summary over the location's stored reviews. Reads only reviews already
   * synced (within the 30-day window); nothing is published. Uses one CONTENT_GENERATION unit like other AI drafts.
   */
  async generateReviewSummary(
    user: AuthUser,
    projectId: string,
    locationId: string,
  ): Promise<ReviewSummaryDto> {
    const { project } = await requireProjectAccess(this.prisma, user, projectId, 'local.manage');
    const location = await this.location(projectId, locationId);
    const cutoff = profileRetentionCutoff(new Date());
    const reviews = await this.prisma.businessReview.findMany({
      where: { locationId, fetchedAt: { gte: cutoff } },
      orderBy: { createTime: 'desc' },
      take: 500,
    });
    if (!reviews.length)
      throw Errors.badRequest('There are no synced reviews to summarise. Sync the Business Profile first.');
    const withText = reviews.filter((r) => (r.comment ?? '').trim().length > 0);
    if (!withText.length)
      throw Errors.badRequest('The synced reviews have star ratings only (no text) to summarise.');
    const llm = getLlmProvider();
    if (!llm)
      throw Errors.providerNotConfigured('AI summary', {
        detail: 'No AI model is configured (LLM_PROVIDER=none).',
      });
    await assertMonthlyQuota(this.prisma, project.workspaceId, 'CONTENT_GENERATION', 1);
    let result;
    try {
      result = await summarizeReviews(llm, {
        businessName: location.name,
        category: location.primaryCategory,
        city: location.city,
        reviews: reviews.map((r) => ({ starRating: r.starRating, comment: r.comment })),
      });
    } catch (error) {
      if (error instanceof ProviderError) throw Errors.upstream(`The AI summary failed: ${error.message}`);
      throw error;
    }
    const newestReviewAt = reviews.reduce<Date | null>((max, r) => {
      const t = r.updateTime ?? r.createTime;
      return !max || t > max ? t : max;
    }, null);
    const data = {
      projectId,
      reviewCount: result.reviewCount,
      positive: result.sentiment.positive,
      neutral: result.sentiment.neutral,
      negative: result.sentiment.negative,
      themes: result.themes as unknown as object,
      summary: result.summary,
      model: result.model,
      isDevAdapter: result.isDevAdapter,
      newestReviewAt,
      generatedById: user.id,
      generatedAt: new Date(),
    };
    const row = await this.prisma.businessReviewSummary.upsert({
      where: { locationId },
      create: { locationId, ...data },
      update: data,
    });
    await withWorkspaceLock(this.prisma, project.workspaceId, (tx) =>
      recordUsage(tx, { workspaceId: project.workspaceId, projectId, metric: 'CONTENT_GENERATION', quantity: 1, idempotencyKey: `review-summary:${row.id}:${row.generatedAt.getTime()}` }),
    ); // prettier-ignore
    await recordAuditLog(this.prisma, {
      action: 'review_summary.generated',
      actorUserId: user.id,
      workspaceId: project.workspaceId,
      targetType: 'BusinessLocation',
      targetId: locationId,
      metadata: { reviewCount: result.reviewCount, themes: result.themes.length, model: result.model },
    });
    return reviewSummaryDto(row, newestReviewAt);
  }

  // ---------------- Profile field write-back ----------------

  private async profileChangeDto(
    workspaceId: string,
    location: Pick<BusinessLocation, 'name'>,
    row: ProfileChangeRequest,
  ): Promise<ProfileChangeRequestDto> {
    const fields = changeFields(row.fields);
    const [approval, createdBy] = await Promise.all([
      latestApproval(this.prisma, { workspaceId, entityType: 'LOCATION_CHANGE', entityId: row.id }),
      row.createdById
        ? this.prisma.user.findUnique({ where: { id: row.createdById }, select: { id: true, name: true } })
        : Promise.resolve(null),
    ]);
    const covers = approval
      ? approval.snapshotHash === snapshotHash(profileChangeSnapshot(fields, location))
      : false;
    return {
      id: row.id,
      status: row.status as ProfileChangeRequestDto['status'],
      fields,
      approval: approval ? { id: approval.id, status: approval.status, coversCurrentText: covers } : null,
      canPublish:
        approval?.status === 'APPROVED' &&
        covers &&
        (row.status === 'AWAITING_APPROVAL' || row.status === 'FAILED'),
      publishedAt: row.publishedAt?.toISOString() ?? null,
      publishError: row.publishError,
      createdBy,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private async loadChange(projectId: string, changeId: string) {
    const change = await this.prisma.profileChangeRequest.findFirst({
      where: { id: changeId, projectId },
      include: { location: true },
    });
    if (!change) throw Errors.notFound('Profile change');
    return change;
  }

  private async changeDtoById(workspaceId: string, changeId: string): Promise<ProfileChangeRequestDto> {
    const row = await this.prisma.profileChangeRequest.findUniqueOrThrow({
      where: { id: changeId },
      include: { location: true },
    });
    return this.profileChangeDto(workspaceId, row.location, row);
  }

  /** Proposes a set of edits to the linked profile's own fields. Earlier open proposals for the location are discarded. */
  async createProfileChange(
    user: AuthUser,
    projectId: string,
    locationId: string,
    input: ProfileChangeInput,
  ): Promise<ProfileChangeRequestDto> {
    const { project } = await requireProjectAccess(this.prisma, user, projectId, 'local.manage');
    const fields = profileChangeSchema.parse(input) as Partial<Record<ProfileEditableField, string>>;
    const location = await this.location(projectId, locationId);
    if (!location.profileLocationName)
      throw Errors.conflict('Link this location to a Business Profile before proposing edits.');
    const open = await this.prisma.profileChangeRequest.findMany({
      where: { locationId, status: { in: ['DRAFT', 'AWAITING_APPROVAL', 'FAILED'] } },
      select: { id: true },
    });
    const row = await this.prisma.$transaction(async (tx) => {
      if (open.length) {
        await tx.profileChangeRequest.updateMany({
          where: { id: { in: open.map((o) => o.id) } },
          data: { status: 'DISCARDED' },
        });
        await tx.approvalRequest.updateMany({
          where: {
            workspaceId: project.workspaceId,
            entityType: 'LOCATION_CHANGE',
            entityId: { in: open.map((o) => o.id) },
            status: 'PENDING',
          },
          data: { status: 'WITHDRAWN' },
        });
      }
      return tx.profileChangeRequest.create({
        data: { projectId, locationId, fields, createdById: user.id },
      });
    });
    return this.profileChangeDto(project.workspaceId, location, row);
  }

  async updateProfileChange(
    user: AuthUser,
    projectId: string,
    changeId: string,
    input: ProfileChangeInput,
  ): Promise<ProfileChangeRequestDto> {
    const { project } = await requireProjectAccess(this.prisma, user, projectId, 'local.manage');
    const fields = profileChangeSchema.parse(input) as Partial<Record<ProfileEditableField, string>>;
    const change = await this.loadChange(projectId, changeId);
    if (!['DRAFT', 'AWAITING_APPROVAL', 'FAILED'].includes(change.status))
      throw Errors.conflict('Only unpublished proposals can be edited.');
    await this.prisma.approvalRequest.updateMany({
      where: { workspaceId: project.workspaceId, entityType: 'LOCATION_CHANGE', entityId: changeId, status: 'PENDING' }, // prettier-ignore
      data: { status: 'WITHDRAWN' },
    });
    await this.prisma.profileChangeRequest.update({
      where: { id: changeId },
      data: { fields, status: 'DRAFT', publishError: null },
    });
    return this.changeDtoById(project.workspaceId, changeId);
  }

  async requestProfileChangeApproval(
    user: AuthUser,
    projectId: string,
    changeId: string,
  ): Promise<ProfileChangeRequestDto> {
    const { project } = await requireProjectAccess(this.prisma, user, projectId, 'local.manage');
    const change = await this.loadChange(projectId, changeId);
    if (!['DRAFT', 'AWAITING_APPROVAL', 'FAILED'].includes(change.status))
      throw Errors.conflict('Only unpublished proposals can be sent for approval.');
    const fields = changeFields(change.fields);
    await requestApproval(this.prisma, {
      workspaceId: project.workspaceId,
      projectId,
      entityType: 'LOCATION_CHANGE',
      entityId: change.id,
      title: `Business Profile edit for ${change.location.name}`,
      summary: 'Approving publishes these field changes to the Google Business Profile.',
      snapshot: profileChangeSnapshot(fields, change.location),
      requestedById: user.id,
    });
    if (change.status === 'DRAFT')
      await this.prisma.profileChangeRequest.update({
        where: { id: changeId },
        data: { status: 'AWAITING_APPROVAL' },
      });
    return this.changeDtoById(project.workspaceId, changeId);
  }

  /** Publishes approved field changes to Google. Needs local.publish and an approval for exactly these values. */
  async publishProfileChange(
    user: AuthUser,
    projectId: string,
    changeId: string,
  ): Promise<ProfileChangeRequestDto> {
    const { project } = await requireProjectAccess(this.prisma, user, projectId, 'local.publish');
    const change = await this.loadChange(projectId, changeId);
    if (change.status === 'PUBLISHED') throw Errors.conflict('These changes are already published.');
    if (change.status !== 'AWAITING_APPROVAL' && change.status !== 'FAILED')
      throw Errors.conflict('Send the changes for approval first.');
    const location = change.location;
    if (!location.profileLocationName)
      throw Errors.conflict('The location is no longer linked to a Business Profile.');
    const fields = changeFields(change.fields);
    const integration = await this.connected(projectId);
    const approval = await assertApproved(
      this.prisma,
      { workspaceId: project.workspaceId, entityType: 'LOCATION_CHANGE', entityId: change.id },
      profileChangeSnapshot(fields, location),
    );
    const claimed = await this.prisma.profileChangeRequest.updateMany({
      where: { id: change.id, status: { in: ['AWAITING_APPROVAL', 'FAILED'] } },
      data: { status: 'PUBLISHING', publishError: null },
    });
    if (claimed.count !== 1) throw Errors.conflict('These changes are already being published.');
    try {
      await google(() =>
        updateProfileLocation(this.prisma, integration.id, location.profileLocationName!, fields, this.http),
      );
      await this.prisma.profileChangeRequest.update({
        where: { id: change.id },
        data: { status: 'PUBLISHED', publishedAt: new Date(), publishedById: user.id },
      });
    } catch (error) {
      await this.prisma.profileChangeRequest.update({
        where: { id: change.id },
        data: { status: 'FAILED', publishError: errorMessage(error).slice(0, 2000) },
      });
      throw error;
    }
    await recordAuditLog(this.prisma, {
      action: 'profile_change.published',
      actorUserId: user.id,
      workspaceId: project.workspaceId,
      targetType: 'BusinessLocation',
      targetId: location.id,
      metadata: { approvalId: approval.id, changeId: change.id, fields: Object.keys(fields) },
    });
    await emitEvent(this.prisma, {
      workspaceId: project.workspaceId,
      projectId,
      type: 'profile_change.published',
      entityType: 'ProfileChangeRequest',
      entityId: change.id,
      actorUserId: user.id,
      data: { approvalId: approval.id, locationId: location.id, fields: Object.keys(fields) },
    });
    // Refresh the stored profile so the page reflects the new values (best-effort).
    await this.queueSync(integration, user.id).catch(() => undefined);
    return this.changeDtoById(project.workspaceId, changeId);
  }

  async discardProfileChange(user: AuthUser, projectId: string, changeId: string): Promise<void> {
    const { project } = await requireProjectAccess(this.prisma, user, projectId, 'local.manage');
    const change = await this.loadChange(projectId, changeId);
    if (change.status === 'PUBLISHED' || change.status === 'PUBLISHING')
      throw Errors.conflict('Published changes cannot be discarded.');
    await this.prisma.approvalRequest.updateMany({
      where: { workspaceId: project.workspaceId, entityType: 'LOCATION_CHANGE', entityId: changeId, status: 'PENDING' }, // prettier-ignore
      data: { status: 'WITHDRAWN' },
    });
    await this.prisma.profileChangeRequest.update({ where: { id: changeId }, data: { status: 'DISCARDED' } });
  }

  async discardReply(user: AuthUser, projectId: string, replyId: string): Promise<void> {
    const { project } = await requireProjectAccess(this.prisma, user, projectId, 'local.manage');
    const reply = await this.loadReply(projectId, replyId);
    if (reply.status === 'PUBLISHED' || reply.status === 'PUBLISHING')
      throw Errors.conflict(
        'A published reply cannot be discarded here; edit or delete it in Business Profile.',
      );
    await this.withdrawPending(project.workspaceId, replyId);
    await this.prisma.reviewReply.update({ where: { id: replyId }, data: { status: 'DISCARDED' } });
  }
}
