// Google Business Profile posts for a project: draft (written or AI-generated), edit, request approval, and publish
// to Google. A post reaches Google only through publish, which requires local.publish and an approval for the exact
// content (entity type LOCAL_POST). Scheduling is stored on the post; a background tick publishes due, approved posts.
import { getLlmProvider, listLlmProviders, llmStatus, ProviderError } from '@surfaced/core/ai';
import { assertApproved, requestApproval } from '@surfaced/core/approvals';
import type { BusinessLocation, Integration, LocalPost, PrismaClient } from '@surfaced/core/db';
import { Errors } from '@surfaced/core/errors';
import { GoogleApiError, IntegrationAuthError, type HttpFetch } from '@surfaced/core/integrations';
import { draftLocalPost, localPostSnapshot, publishApprovedLocalPost } from '@surfaced/core/local';
import { assertMonthlyQuota, recordUsage, withWorkspaceLock } from '@surfaced/core/usage';
import {
  localPostCreateSchema,
  localPostUpdateSchema,
  type LocalPostCreateInput,
  type LocalPostDto,
  type LocalPostUpdateInput,
} from '@surfaced/shared';
import { iso } from '../lib/http';
import type { AppDeps, AuthUser } from '../types';
import { requireProjectAccess } from './access';

const EDITABLE = ['DRAFT', 'AWAITING_APPROVAL', 'SCHEDULED', 'FAILED'];

async function google<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof GoogleApiError)
      throw Errors.upstream(error.message, { provider: 'GOOGLE_BUSINESS_PROFILE', httpStatus: error.httpStatus }); // prettier-ignore
    if (error instanceof IntegrationAuthError) throw Errors.conflict(error.message, { reason: 'NEEDS_REAUTH' });
    throw error;
  }
}

function toDto(post: LocalPost): LocalPostDto {
  return {
    id: post.id,
    projectId: post.projectId,
    locationId: post.locationId,
    topicType: post.topicType,
    summary: post.summary,
    title: post.title,
    ctaType: post.ctaType ?? 'NONE',
    ctaUrl: post.ctaUrl,
    origin: post.origin,
    model: post.model,
    status: post.status,
    scheduledAt: iso(post.scheduledAt),
    googleName: post.googleName,
    searchUrl: post.searchUrl,
    publishedAt: iso(post.publishedAt),
    publishError: post.publishError,
    createdAt: post.createdAt.toISOString(),
    updatedAt: post.updatedAt.toISOString(),
  };
}

export class LocalPostService {
  constructor(private readonly deps: AppDeps) {}

  private get prisma(): PrismaClient {
    return this.deps.prisma;
  }
  private get http(): HttpFetch {
    return this.deps.httpFetch ?? fetch;
  }

  private async connected(projectId: string): Promise<Integration> {
    const integration = await this.prisma.integration.findUnique({
      where: { projectId_provider: { projectId, provider: 'GOOGLE_BUSINESS_PROFILE' } },
    });
    if (!integration || integration.status === 'DISCONNECTED')
      throw Errors.conflict('Connect Google Business Profile first (Integrations).');
    if (integration.status === 'NEEDS_REAUTH')
      throw Errors.conflict('Google access expired or was revoked. Reconnect Google Business Profile.');
    return integration;
  }

  private async load(projectId: string, postId: string): Promise<LocalPost & { location: BusinessLocation }> {
    const post = await this.prisma.localPost.findFirst({
      where: { id: postId, projectId },
      include: { location: true },
    });
    if (!post) throw Errors.notFound('Post');
    return post;
  }

  /** LLM providers available for AI post generation (for the client's provider selector). */
  async providers(user: AuthUser, projectId: string) {
    await requireProjectAccess(this.prisma, user, projectId, 'project.read');
    return listLlmProviders();
  }

  async list(
    user: AuthUser,
    projectId: string,
    query: { locationId?: string; status?: string },
  ): Promise<LocalPostDto[]> {
    await requireProjectAccess(this.prisma, user, projectId, 'project.read');
    const rows = await this.prisma.localPost.findMany({
      where: {
        projectId,
        ...(query.locationId ? { locationId: query.locationId } : {}),
        ...(query.status ? { status: query.status } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return rows.map(toDto);
  }

  async create(user: AuthUser, projectId: string, input: LocalPostCreateInput): Promise<LocalPostDto> {
    const { project } = await requireProjectAccess(this.prisma, user, projectId, 'local.manage');
    const data = localPostCreateSchema.parse(input);
    const location = await this.prisma.businessLocation.findFirst({
      where: { id: data.locationId, projectId, archivedAt: null },
    });
    if (!location) throw Errors.notFound('Location');

    let summary = data.summary ?? '';
    let origin: 'AI' | 'HUMAN' = 'HUMAN';
    let model: string | null = null;
    let ctaType = data.ctaType;
    if (data.generate) {
      const providers = listLlmProviders();
      const chosen = data.provider
        ? providers.find((p) => p.key === data.provider)
        : providers.find((p) => p.isDefault);
      if (!chosen?.configured)
        throw Errors.providerNotConfigured(
          data.provider ? `Post generation on ${chosen?.label ?? data.provider}` : 'Post generation',
          chosen ?? llmStatus(),
        );
      const llm = getLlmProvider(data.provider ?? undefined);
      if (!llm) throw Errors.providerNotConfigured('Post generation', llmStatus());
      await assertMonthlyQuota(this.prisma, project.workspaceId, 'CONTENT_GENERATION', 1);
      try {
        const draft = await draftLocalPost(llm, {
          businessName: location.name,
          category: location.primaryCategory,
          city: location.city,
          topic: data.topic ?? data.summary ?? null,
          instructions: data.instructions,
        });
        summary = draft.summary;
        model = draft.isDevAdapter ? 'dev-template' : draft.model.slice(0, 80);
        origin = 'AI';
        if (ctaType === 'NONE' && draft.suggestedCta !== 'NONE' && data.ctaUrl) ctaType = draft.suggestedCta;
      } catch (error) {
        if (error instanceof ProviderError) throw Errors.upstream(`The AI draft failed: ${error.message}`);
        throw error;
      }
    }
    if (!summary.trim()) throw Errors.badRequest('The post is empty.');

    const row = await this.prisma.localPost.create({
      data: {
        projectId,
        locationId: location.id,
        topicType: data.topicType,
        summary: summary.slice(0, 1500),
        title: data.title,
        ctaType: ctaType === 'NONE' ? null : ctaType,
        ctaUrl: ctaType === 'NONE' ? null : data.ctaUrl,
        scheduledAt: data.scheduledAt,
        origin,
        model,
        createdById: user.id,
      },
    });
    if (origin === 'AI')
      await withWorkspaceLock(this.prisma, project.workspaceId, (tx) =>
        recordUsage(tx, { workspaceId: project.workspaceId, projectId, metric: 'CONTENT_GENERATION', quantity: 1, idempotencyKey: `local-post:${row.id}` }),
      ); // prettier-ignore
    return toDto(row);
  }

  async update(
    user: AuthUser,
    projectId: string,
    postId: string,
    input: LocalPostUpdateInput,
  ): Promise<LocalPostDto> {
    const { project } = await requireProjectAccess(this.prisma, user, projectId, 'local.manage');
    const data = localPostUpdateSchema.parse(input);
    const post = await this.load(projectId, postId);
    if (!EDITABLE.includes(post.status))
      throw Errors.conflict('Only unpublished posts can be edited.');
    // A content change withdraws any pending approval and returns the post to DRAFT.
    const changesContent =
      (data.summary !== undefined && data.summary !== post.summary) ||
      (data.ctaType !== undefined && data.ctaType !== (post.ctaType ?? 'NONE')) ||
      (data.ctaUrl !== undefined && data.ctaUrl !== post.ctaUrl) ||
      (data.topicType !== undefined && data.topicType !== post.topicType);
    if (changesContent)
      await this.prisma.approvalRequest.updateMany({
        where: { workspaceId: project.workspaceId, entityType: 'LOCAL_POST', entityId: postId, status: 'PENDING' }, // prettier-ignore
        data: { status: 'WITHDRAWN' },
      });
    const nextCta = data.ctaType ?? post.ctaType ?? 'NONE';
    const nextUrl = data.ctaUrl !== undefined ? data.ctaUrl : post.ctaUrl;
    const updated = await this.prisma.localPost.update({
      where: { id: postId },
      data: {
        ...(data.summary !== undefined ? { summary: data.summary.slice(0, 1500) } : {}),
        ...(data.title !== undefined ? { title: data.title } : {}),
        ...(data.topicType !== undefined ? { topicType: data.topicType } : {}),
        ctaType: nextCta === 'NONE' ? null : nextCta,
        ctaUrl: nextCta === 'NONE' ? null : nextUrl,
        ...(data.scheduledAt !== undefined ? { scheduledAt: data.scheduledAt } : {}),
        ...(changesContent ? { status: 'DRAFT', publishError: null } : {}),
      },
    });
    return toDto(updated);
  }

  async requestApproval(user: AuthUser, projectId: string, postId: string): Promise<LocalPostDto> {
    const { project } = await requireProjectAccess(this.prisma, user, projectId, 'local.manage');
    const post = await this.load(projectId, postId);
    if (!['DRAFT', 'SCHEDULED', 'AWAITING_APPROVAL', 'FAILED'].includes(post.status))
      throw Errors.conflict('Only unpublished posts can be sent for approval.');
    await requestApproval(this.prisma, {
      workspaceId: project.workspaceId,
      projectId,
      entityType: 'LOCAL_POST',
      entityId: post.id,
      title: `Business Profile post for ${post.location.name}`,
      summary: 'Approving allows this post to be published to the Google Business Profile.',
      snapshot: localPostSnapshot(post, post.location),
      requestedById: user.id,
    });
    if (post.status === 'DRAFT' || post.status === 'FAILED')
      await this.prisma.localPost.update({ where: { id: postId }, data: { status: 'AWAITING_APPROVAL' } });
    return toDto(await this.load(projectId, postId));
  }

  /**
   * Publishes an approved post. Needs local.publish and an approval for exactly this content. A post set for a
   * future time is verified-approved and moved to SCHEDULED (the background tick publishes it when due); otherwise
   * it is published to Google immediately.
   */
  async publish(user: AuthUser, projectId: string, postId: string): Promise<LocalPostDto> {
    const { project } = await requireProjectAccess(this.prisma, user, projectId, 'local.publish');
    const post = await this.load(projectId, postId);
    if (post.status === 'PUBLISHED') throw Errors.conflict('This post is already published.');
    if (!['AWAITING_APPROVAL', 'SCHEDULED', 'FAILED'].includes(post.status))
      throw Errors.conflict('Send the post for approval first.');
    const location = post.location;
    if (!location.profileLocationName || !location.profileAccountName)
      throw Errors.conflict('The location is no longer linked to a Business Profile.');
    const integration = await this.connected(projectId);

    // Future-dated: confirm it is approved, then defer to the scheduled tick.
    if (post.scheduledAt && post.scheduledAt.getTime() > Date.now()) {
      await assertApproved(
        this.prisma,
        { workspaceId: project.workspaceId, entityType: 'LOCAL_POST', entityId: post.id },
        localPostSnapshot(post, location),
      );
      if (post.status !== 'SCHEDULED')
        await this.prisma.localPost.update({
          where: { id: post.id },
          data: { status: 'SCHEDULED', publishError: null },
        });
      return toDto(await this.load(projectId, postId));
    }

    await google(() =>
      publishApprovedLocalPost(
        this.prisma,
        {
          post,
          location,
          integrationId: integration.id,
          workspaceId: project.workspaceId,
          projectId,
          actorUserId: user.id,
        },
        this.http,
      ),
    );
    return toDto(await this.load(projectId, postId));
  }

  async discard(user: AuthUser, projectId: string, postId: string): Promise<void> {
    const { project } = await requireProjectAccess(this.prisma, user, projectId, 'local.manage');
    const post = await this.load(projectId, postId);
    if (post.status === 'PUBLISHED') throw Errors.conflict('A published post cannot be discarded.');
    await this.prisma.approvalRequest.updateMany({
      where: { workspaceId: project.workspaceId, entityType: 'LOCAL_POST', entityId: postId, status: 'PENDING' }, // prettier-ignore
      data: { status: 'WITHDRAWN' },
    });
    await this.prisma.localPost.update({ where: { id: postId }, data: { status: 'DISCARDED' } });
  }
}
