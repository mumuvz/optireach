import {
  idSchema,
  profileAccountNameSchema,
  profileChangeSchema,
  profileLinkSchema,
  reviewReplyDraftSchema,
  reviewReplyUpdateSchema,
} from '@surfaced/shared';
import { z } from 'zod';
import { accepted, created, noContent, ok } from '../lib/http';
import { route, type AnyRoute } from '../lib/router';
import { BusinessProfileService } from '../services/business-profile.service';
import type { AppDeps } from '../types';

const projectParams = z.object({ projectId: idSchema });
const locationParams = projectParams.extend({ locationId: idSchema });
const reviewParams = projectParams.extend({ reviewId: idSchema });
const replyParams = projectParams.extend({ replyId: idSchema });
const changeParams = projectParams.extend({ changeId: idSchema });

/**
 * Google Business Profile under /projects. Served to the business's own signed-in users only: Business Profile data
 * and actions are not exposed through any public API (Google's "no indirect access" policy).
 */
export function projectBusinessProfileRoutes(deps: AppDeps): AnyRoute[] {
  const service = new BusinessProfileService(deps);
  const tags = ['Business Profile'];
  return [
    route({
      method: 'get',
      path: '/:projectId/business-profile',
      summary: 'Connection status and the locations linked to Business Profile',
      tags,
      auth: 'user',
      params: projectParams,
      handler: async ({ user, params }) => ok(await service.status(user, params.projectId)),
    }),
    route({
      method: 'get',
      path: '/:projectId/business-profile/accounts',
      summary: 'Business Profile accounts the connected Google account can manage (read live)',
      tags,
      auth: 'user',
      params: projectParams,
      handler: async ({ user, params }) => ok(await service.accounts(user, params.projectId)),
    }),
    route({
      method: 'get',
      path: '/:projectId/business-profile/locations',
      summary: 'Profile locations in one account (read live, not stored)',
      tags,
      auth: 'user',
      params: projectParams,
      query: z.object({ account: profileAccountNameSchema }),
      handler: async ({ user, params, query }) =>
        ok(await service.accountLocations(user, params.projectId, query.account)),
    }),
    route({
      method: 'post',
      path: '/:projectId/business-profile/links',
      summary: 'Link a profile location to a business location (or create one from it), then sync',
      tags,
      auth: 'user',
      params: projectParams,
      body: profileLinkSchema,
      successStatus: 201,
      handler: async ({ user, params, body }) => created(await service.link(user, params.projectId, body)),
    }),
    route({
      method: 'delete',
      path: '/:projectId/locations/:locationId/business-profile',
      summary: 'Unlink the profile and delete the Business Profile data stored for the location',
      tags,
      auth: 'user',
      params: locationParams,
      handler: async ({ user, params }) => {
        await service.unlink(user, params.projectId, params.locationId);
        return noContent();
      },
    }),
    route({
      method: 'post',
      path: '/:projectId/business-profile/sync',
      summary: 'Sync linked profiles now: profile, metrics and reviews (background job)',
      tags,
      auth: 'user',
      params: projectParams,
      successStatus: 202,
      handler: async ({ user, params }) => accepted(await service.sync(user, params.projectId)),
    }),
    route({
      method: 'get',
      path: '/:projectId/locations/:locationId/business-profile',
      summary: 'Profile, audit, performance metrics and reviews of one location',
      tags,
      auth: 'user',
      params: locationParams,
      handler: async ({ user, params }) =>
        ok(await service.locationDetail(user, params.projectId, params.locationId)),
    }),
    route({
      method: 'post',
      path: '/:projectId/locations/:locationId/review-summary',
      summary: 'Generate an AI sentiment and theme summary over the synced reviews (nothing is published)',
      tags,
      auth: 'user',
      params: locationParams,
      handler: async ({ user, params }) =>
        ok(await service.generateReviewSummary(user, params.projectId, params.locationId)),
    }),
    route({
      method: 'post',
      path: '/:projectId/locations/:locationId/profile-changes',
      summary:
        'Propose edits to the profile’s own fields (name, phone, website, description) — a draft, not published',
      tags,
      auth: 'user',
      params: locationParams,
      body: profileChangeSchema,
      successStatus: 201,
      handler: async ({ user, params, body }) =>
        created(await service.createProfileChange(user, params.projectId, params.locationId, body)),
    }),
    route({
      method: 'patch',
      path: '/:projectId/profile-changes/:changeId',
      summary: 'Edit a proposed profile change (withdraws a pending approval)',
      tags,
      auth: 'user',
      params: changeParams,
      body: profileChangeSchema,
      handler: async ({ user, params, body }) =>
        ok(await service.updateProfileChange(user, params.projectId, params.changeId, body)),
    }),
    route({
      method: 'post',
      path: '/:projectId/profile-changes/:changeId/request-approval',
      summary: 'Ask an approver to approve the exact profile field changes',
      tags,
      auth: 'user',
      params: changeParams,
      handler: async ({ user, params }) =>
        ok(await service.requestProfileChangeApproval(user, params.projectId, params.changeId)),
    }),
    route({
      method: 'post',
      path: '/:projectId/profile-changes/:changeId/publish',
      summary:
        'Publish approved field changes to Google (needs local.publish and an approval for these values)',
      tags,
      auth: 'user',
      params: changeParams,
      handler: async ({ user, params }) =>
        ok(await service.publishProfileChange(user, params.projectId, params.changeId)),
    }),
    route({
      method: 'delete',
      path: '/:projectId/profile-changes/:changeId',
      summary: 'Discard a proposed profile change',
      tags,
      auth: 'user',
      params: changeParams,
      handler: async ({ user, params }) => {
        await service.discardProfileChange(user, params.projectId, params.changeId);
        return noContent();
      },
    }),
    route({
      method: 'post',
      path: '/:projectId/reviews/:reviewId/replies',
      summary: 'Create a reply draft, written or drafted by the AI model (never published without approval)',
      tags,
      auth: 'user',
      params: reviewParams,
      body: reviewReplyDraftSchema,
      successStatus: 201,
      handler: async ({ user, params, body }) =>
        created(await service.createDraft(user, params.projectId, params.reviewId, body)),
    }),
    route({
      method: 'patch',
      path: '/:projectId/review-replies/:replyId',
      summary: 'Edit a reply draft (withdraws a pending approval)',
      tags,
      auth: 'user',
      params: replyParams,
      body: reviewReplyUpdateSchema,
      handler: async ({ user, params, body }) =>
        ok(await service.updateReply(user, params.projectId, params.replyId, body)),
    }),
    route({
      method: 'post',
      path: '/:projectId/review-replies/:replyId/request-approval',
      summary: 'Ask an approver to approve the exact reply text',
      tags,
      auth: 'user',
      params: replyParams,
      handler: async ({ user, params }) =>
        ok(await service.requestApproval(user, params.projectId, params.replyId)),
    }),
    route({
      method: 'post',
      path: '/:projectId/review-replies/:replyId/publish',
      summary: 'Publish an approved reply to Google (needs local.publish and an approval for this text)',
      tags,
      auth: 'user',
      params: replyParams,
      handler: async ({ user, params }) =>
        ok(await service.publishReply(user, params.projectId, params.replyId)),
    }),
    route({
      method: 'delete',
      path: '/:projectId/review-replies/:replyId',
      summary: 'Discard a reply draft',
      tags,
      auth: 'user',
      params: replyParams,
      handler: async ({ user, params }) => {
        await service.discardReply(user, params.projectId, params.replyId);
        return noContent();
      },
    }),
  ];
}
