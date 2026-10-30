import type { ContentStatus, WorkspaceRole } from './enums';
import { can, type MembershipVia } from './permissions';

/**
 * Content approval workflow. Generated content is never published automatically: a person moves
 * it through review and approval, and "Published" is a manual confirmation that it went live.
 */
export const CONTENT_TRANSITIONS: Record<ContentStatus, readonly ContentStatus[]> = {
  DRAFT: ['IN_REVIEW', 'ARCHIVED'],
  IN_REVIEW: ['DRAFT', 'APPROVED', 'ARCHIVED'],
  APPROVED: ['DRAFT', 'PUBLISHED', 'ARCHIVED'],
  PUBLISHED: ['DRAFT', 'ARCHIVED'],
  ARCHIVED: ['DRAFT'],
};

/** Transitions that require the `content.approve` permission (Owner/Admin). */
const APPROVER_ONLY = new Set<string>(['IN_REVIEW->APPROVED', 'APPROVED->PUBLISHED']);
/** Client-portal users decide on content in review: approve it, or send it back to draft. */
const CLIENT_TRANSITIONS = new Set<string>(['IN_REVIEW->APPROVED', 'IN_REVIEW->DRAFT']);

export type TransitionDenial =
  'INVALID_TRANSITION' | 'NOT_APPROVER' | 'NO_PERMISSION' | 'SAME_STATUS' | 'CUSTOMER_APPROVAL_REQUIRED';

export interface ContentAccess {
  via?: MembershipVia;
  /** From the agency link: the client allowed the agency to approve on their behalf. */
  approvalsDelegated?: boolean;
}

export function checkContentTransition(
  from: ContentStatus,
  to: ContentStatus,
  role: WorkspaceRole,
  access: ContentAccess = {},
): TransitionDenial | null {
  if (from === to) return 'SAME_STATUS';
  const key = `${from}->${to}`;
  if (role === 'CLIENT') {
    if (!CONTENT_TRANSITIONS[from].includes(to)) return 'INVALID_TRANSITION';
    return CLIENT_TRANSITIONS.has(key) ? null : 'NO_PERMISSION';
  }
  if (!can(role, 'content.edit')) return 'NO_PERMISSION';
  if (!CONTENT_TRANSITIONS[from].includes(to)) return 'INVALID_TRANSITION';
  if (APPROVER_ONLY.has(key) && !can(role, 'content.approve')) return 'NOT_APPROVER';
  // In a client workspace managed by an agency, approving is the client's decision unless delegated.
  if (key === 'IN_REVIEW->APPROVED' && access.via === 'AGENCY' && !access.approvalsDelegated)
    return 'CUSTOMER_APPROVAL_REQUIRED';
  return null;
}

/** Statuses the given role may move a document to from `from`. */
export function allowedContentTransitions(
  from: ContentStatus,
  role: WorkspaceRole,
  access: ContentAccess = {},
): ContentStatus[] {
  return CONTENT_TRANSITIONS[from].filter((to) => checkContentTransition(from, to, role, access) === null);
}

/** Editing the body is allowed while drafting or in review; approved/published content must go back to draft first. */
export function isContentEditable(status: ContentStatus): boolean {
  return status === 'DRAFT' || status === 'IN_REVIEW';
}

export const TRANSITION_DENIAL_MESSAGES: Record<TransitionDenial, string> = {
  INVALID_TRANSITION: 'That status change is not allowed from the current status.',
  NOT_APPROVER: 'Only owners and admins can approve or publish content.',
  NO_PERMISSION: 'Your role cannot change content.',
  SAME_STATUS: 'The document already has that status.',
  CUSTOMER_APPROVAL_REQUIRED:
    'This workspace is managed by an agency, so the client approves content unless they delegated approvals.',
};
