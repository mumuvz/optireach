// AI-drafted Google Business Profile posts. A draft is only a suggestion: a person edits it, an approver approves
// the exact content, and only then is it published to Google (approvals.ts, entity type LOCAL_POST). The model is
// told never to invent offers, prices, dates or claims it cannot verify.
import { LOCAL_POST_CTA_TYPES, type LocalPostCtaType } from '@surfaced/shared';
import { z } from 'zod';
import type { LlmProvider } from '../ai/llm';
import { assertApproved } from '../approvals';
import { recordAuditLog } from '../audit-log';
import type { BusinessLocation, LocalPost, PrismaClient } from '../db';
import { Errors, errorMessage } from '../errors';
import { emitEvent } from '../events';
import type { HttpFetch } from '../integrations/google';
import { createLocalPost } from './business-profile';

export const localPostOutputSchema = z.object({
  summary: z.string().min(1).max(1500),
  suggestedCta: z.enum(LOCAL_POST_CTA_TYPES),
});

export interface LocalPostDraftRequest {
  businessName: string;
  category: string | null;
  city: string | null;
  /** What the post is about (e.g. "new weekend hours", "diwali collection"). */
  topic?: string | null;
  instructions?: string | null;
}

export interface LocalPostDraft {
  summary: string;
  suggestedCta: LocalPostCtaType;
  model: string;
  isDevAdapter: boolean;
}

const SYSTEM = [
  'You write short Google Business Profile posts for a local business, in the business owner’s voice.',
  'Write 1 to 3 sentences, under 1500 characters, in the language of the topic given.',
  'Be concrete and friendly and end with a clear next step.',
  'NEVER invent offers, discounts, prices, dates, events, awards or claims the business did not provide; if the topic lacks a detail, keep the post general rather than making one up.',
  'Do not include links or phone numbers in the text (a call-to-action button is added separately), and do not mention that the post was drafted with AI.',
  'suggestedCta is the single most fitting button for this post, or NONE.',
].join(' ');

/** Drafts one Business Profile post. The caller stores it as a draft; nothing is sent to Google here. */
export async function draftLocalPost(llm: LlmProvider, req: LocalPostDraftRequest): Promise<LocalPostDraft> {
  const topic = req.topic?.trim() || 'a general update about the business';
  const { data, model, isDevAdapter } = await llm.generateJson({
    schema: localPostOutputSchema,
    schemaName: 'local_post',
    system: SYSTEM,
    user: [
      `Business: ${req.businessName}${req.category ? ` (${req.category})` : ''}${req.city ? `, ${req.city}` : ''}.`,
      `Post topic: ${topic}.`,
      req.instructions ? `Guidance from the business: ${req.instructions}` : '',
      'Write the post and choose the most fitting call-to-action button.',
    ]
      .filter(Boolean)
      .join('\n'),
    maxOutputTokens: 700,
    devFallback: () => ({
      summary: `${req.businessName} — ${topic}. Development adapter template (not AI-generated); configure an LLM provider for real drafts. Visit us or get in touch to learn more.`.slice(
        0,
        1500,
      ),
      suggestedCta: 'LEARN_MORE' as const,
    }),
  });
  return { summary: data.summary.trim(), suggestedCta: data.suggestedCta, model, isDevAdapter };
}

/** What an approver approves: the exact post content and where it will be published. */
export function localPostSnapshot(
  post: { summary: string; topicType: string; ctaType: string | null; ctaUrl: string | null },
  location: { name: string },
) {
  return {
    action: 'Publish a post to the Google Business Profile',
    location: location.name,
    topicType: post.topicType,
    summary: post.summary,
    cta: post.ctaType ? { type: post.ctaType, url: post.ctaUrl } : null,
  };
}

/**
 * Publishes an approved post to Google now. Verifies the approval matches the exact content, claims the row so two
 * publishers cannot race, then calls Google and records the outcome. On failure the row is marked FAILED and the
 * error rethrown. Shared by the API publish action and the scheduled-publish tick.
 */
export async function publishApprovedLocalPost(
  prisma: PrismaClient,
  args: {
    post: LocalPost;
    location: BusinessLocation;
    integrationId: string;
    workspaceId: string;
    projectId: string;
    actorUserId: string | null;
  },
  httpFetch: HttpFetch = fetch,
): Promise<void> {
  const { post, location, integrationId, workspaceId, projectId, actorUserId } = args;
  if (!location.profileLocationName || !location.profileAccountName)
    throw Errors.conflict('The location is no longer linked to a Business Profile.');
  const approval = await assertApproved(
    prisma,
    { workspaceId, entityType: 'LOCAL_POST', entityId: post.id },
    localPostSnapshot(post, location),
  );
  const claimed = await prisma.localPost.updateMany({
    where: { id: post.id, status: { in: ['AWAITING_APPROVAL', 'SCHEDULED', 'FAILED'] } },
    data: { status: 'PUBLISHING', publishError: null },
  });
  if (claimed.count !== 1) throw Errors.conflict('This post is already being published.');
  try {
    const published = await createLocalPost(
      prisma,
      integrationId,
      location.profileAccountName,
      location.profileLocationName,
      {
        summary: post.summary,
        topicType: post.topicType,
        languageCode: 'en',
        callToAction: post.ctaType && post.ctaUrl ? { actionType: post.ctaType, url: post.ctaUrl } : undefined,
      },
      httpFetch,
    );
    await prisma.localPost.update({
      where: { id: post.id },
      data: {
        status: 'PUBLISHED',
        googleName: published.name,
        searchUrl: published.searchUrl,
        publishedAt: new Date(),
        publishedById: actorUserId,
      },
    });
  } catch (error) {
    await prisma.localPost.update({
      where: { id: post.id },
      data: { status: 'FAILED', publishError: errorMessage(error).slice(0, 2000) },
    });
    throw error;
  }
  await recordAuditLog(prisma, {
    action: 'local_post.published',
    actorUserId,
    workspaceId,
    targetType: 'LocalPost',
    targetId: post.id,
    metadata: { approvalId: approval.id, locationId: location.id, scheduled: actorUserId === null },
  });
  await emitEvent(prisma, {
    workspaceId,
    projectId,
    type: 'local_post.published',
    entityType: 'LocalPost',
    entityId: post.id,
    actorUserId: actorUserId ?? undefined,
    data: { approvalId: approval.id, locationId: location.id },
  });
}

/** Publishes scheduled, approved posts whose time has come. Best-effort; failures are recorded on each post. */
export async function publishDueLocalPosts(
  prisma: PrismaClient,
  options: { now?: Date; httpFetch?: HttpFetch } = {},
): Promise<{ published: number; failed: number }> {
  const now = options.now ?? new Date();
  const due = await prisma.localPost.findMany({
    where: { status: 'SCHEDULED', scheduledAt: { lte: now } },
    include: { location: true, project: { select: { workspaceId: true } } },
    take: 100,
  });
  let published = 0;
  let failed = 0;
  for (const post of due) {
    const integration = await prisma.integration.findUnique({
      where: { projectId_provider: { projectId: post.projectId, provider: 'GOOGLE_BUSINESS_PROFILE' } },
    });
    if (!integration || integration.status === 'DISCONNECTED' || integration.status === 'NEEDS_REAUTH') {
      await prisma.localPost.update({
        where: { id: post.id },
        data: { status: 'FAILED', publishError: 'Business Profile is not connected; reconnect to publish.' },
      });
      failed += 1;
      continue;
    }
    try {
      await publishApprovedLocalPost(
        prisma,
        {
          post,
          location: post.location,
          integrationId: integration.id,
          workspaceId: post.project.workspaceId,
          projectId: post.projectId,
          actorUserId: null,
        },
        options.httpFetch,
      );
      published += 1;
    } catch {
      failed += 1; // publishApprovedLocalPost already recorded the error on the post
    }
  }
  return { published, failed };
}
