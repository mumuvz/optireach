import type { WorkspaceRole } from './enums';

/**
 * Workspace permission matrix. The API enforces it on every request (apps/api middleware and
 * services). The web app uses the same table only to hide controls; hiding is never the control.
 */
export const PERMISSIONS = {
  'workspace.read': ['OWNER', 'ADMIN', 'MEMBER', 'CLIENT'],
  'workspace.update': ['OWNER', 'ADMIN'],
  'workspace.delete': ['OWNER'],
  'members.read': ['OWNER', 'ADMIN', 'MEMBER', 'CLIENT'],
  'members.invite': ['OWNER', 'ADMIN'],
  'members.manage': ['OWNER', 'ADMIN'],
  'billing.read': ['OWNER', 'ADMIN'],
  'billing.manage': ['OWNER'],
  'usage.read': ['OWNER', 'ADMIN', 'MEMBER'],
  'auditlog.read': ['OWNER', 'ADMIN'],
  'project.read': ['OWNER', 'ADMIN', 'MEMBER', 'CLIENT'],
  'project.create': ['OWNER', 'ADMIN'],
  'project.update': ['OWNER', 'ADMIN'],
  'project.delete': ['OWNER', 'ADMIN'],
  'audit.run': ['OWNER', 'ADMIN', 'MEMBER'],
  'audit.cancel': ['OWNER', 'ADMIN', 'MEMBER'],
  'issue.update': ['OWNER', 'ADMIN', 'MEMBER'],
  'prompt.manage': ['OWNER', 'ADMIN', 'MEMBER'],
  'visibility.run': ['OWNER', 'ADMIN', 'MEMBER'],
  'content.edit': ['OWNER', 'ADMIN', 'MEMBER'],
  'content.generate': ['OWNER', 'ADMIN', 'MEMBER'],
  'content.approve': ['OWNER', 'ADMIN'],
  'content.delete': ['OWNER', 'ADMIN'],
  'keyword.manage': ['OWNER', 'ADMIN', 'MEMBER'],
  'competitor.manage': ['OWNER', 'ADMIN'],
  'competitor.snapshot': ['OWNER', 'ADMIN', 'MEMBER'],
  'recommendation.update': ['OWNER', 'ADMIN', 'MEMBER'],
  'report.create': ['OWNER', 'ADMIN', 'MEMBER'],
  'report.delete': ['OWNER', 'ADMIN'],
  'report.schedule': ['OWNER', 'ADMIN'],
  'integration.read': ['OWNER', 'ADMIN', 'MEMBER'],
  'integration.manage': ['OWNER', 'ADMIN'],
  // Approvals: members request, customers decide (see canDecideApproval for agency access).
  'approval.read': ['OWNER', 'ADMIN', 'MEMBER', 'CLIENT'],
  'approval.request': ['OWNER', 'ADMIN', 'MEMBER'],
  'approval.decide': ['OWNER', 'ADMIN', 'CLIENT'],
  'task.read': ['OWNER', 'ADMIN', 'MEMBER', 'CLIENT'],
  'task.manage': ['OWNER', 'ADMIN', 'MEMBER'],
  // Drafting is open to the team; executing an approved external change is limited to owners and admins.
  'local.manage': ['OWNER', 'ADMIN', 'MEMBER'],
  'local.publish': ['OWNER', 'ADMIN'],
  'commerce.manage': ['OWNER', 'ADMIN', 'MEMBER'],
  'commerce.publish': ['OWNER', 'ADMIN'],
  'search.manage': ['OWNER', 'ADMIN', 'MEMBER'],
  'site.publish': ['OWNER', 'ADMIN'],
  'authority.manage': ['OWNER', 'ADMIN', 'MEMBER'],
  'attribution.manage': ['OWNER', 'ADMIN', 'MEMBER'],
  'alert.manage': ['OWNER', 'ADMIN'],
  /** API keys and outbound webhooks. */
  'developer.manage': ['OWNER', 'ADMIN'],
  'engagement.read': ['OWNER', 'ADMIN', 'MEMBER', 'CLIENT'],
  'engagement.manage': ['OWNER', 'ADMIN'],
  'brief.edit': ['OWNER', 'ADMIN', 'MEMBER', 'CLIENT'],
  /** Client workspaces and links, from the agency side. */
  'agency.manage': ['OWNER', 'ADMIN'],
} as const satisfies Record<string, readonly WorkspaceRole[]>;

export type Permission = keyof typeof PERMISSIONS;

export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

export function can(role: WorkspaceRole | null | undefined, permission: Permission): boolean {
  if (!role) return false;
  return (PERMISSIONS[permission] as readonly WorkspaceRole[]).includes(role);
}

export function permissionsFor(role: WorkspaceRole): Permission[] {
  return ALL_PERMISSIONS.filter((permission) => can(role, permission));
}

export const ROLE_LABELS: Record<WorkspaceRole, string> = {
  OWNER: 'Owner',
  ADMIN: 'Admin',
  MEMBER: 'Member',
  CLIENT: 'Client',
};

export const ROLE_DESCRIPTIONS: Record<WorkspaceRole, string> = {
  OWNER: 'Full access, including billing, plan changes, ownership and deleting the workspace.',
  ADMIN: 'Manages projects, members, competitors and integrations. Cannot change billing or owners.',
  MEMBER: 'Works on projects: audits, prompts, content drafts, keywords, recommendations and reports.',
  CLIENT:
    'Client portal: views results and reports, approves or rejects changes, and edits the onboarding brief.',
};

/** How a user reaches a workspace: as a member, or through an agency that manages it (D-024). */
export type MembershipVia = 'DIRECT' | 'AGENCY';

export interface ApprovalActor {
  role: WorkspaceRole;
  via: MembershipVia;
  /** From the agency link: the client allowed the agency to decide approvals. */
  approvalsDelegated?: boolean;
}

/**
 * Approvals are customer decisions. Direct members with `approval.decide` (owners, admins, clients) may decide;
 * people who reach the workspace through an agency may decide only when the client delegated approvals.
 */
export function canDecideApproval(actor: ApprovalActor): boolean {
  if (!can(actor.role, 'approval.decide')) return false;
  return actor.via === 'DIRECT' || actor.approvalsDelegated === true;
}

export type RoleChangeDenial =
  'INSUFFICIENT_ROLE' | 'CANNOT_MANAGE_OWNER' | 'CANNOT_GRANT_OWNER' | 'LAST_OWNER' | 'SELF_CHANGE';

export interface RoleChangeContext {
  actorRole: WorkspaceRole;
  actorIsTarget: boolean;
  targetCurrentRole: WorkspaceRole;
  newRole: WorkspaceRole;
  /** Number of owners in the workspace before the change. */
  ownerCount: number;
}

/**
 * Rules for changing a member's role:
 * - Members cannot change roles.
 * - Admins can switch people between MEMBER and ADMIN, but cannot touch owners or grant OWNER.
 * - Owners can assign any role, including transferring or sharing ownership.
 * - Nobody changes their own role (prevents accidental lock-out); the last owner can never be demoted.
 */
export function checkRoleChange(ctx: RoleChangeContext): RoleChangeDenial | null {
  if (!can(ctx.actorRole, 'members.manage')) return 'INSUFFICIENT_ROLE';
  if (ctx.actorIsTarget) return 'SELF_CHANGE';
  if (ctx.actorRole !== 'OWNER') {
    if (ctx.targetCurrentRole === 'OWNER') return 'CANNOT_MANAGE_OWNER';
    if (ctx.newRole === 'OWNER') return 'CANNOT_GRANT_OWNER';
  }
  if (ctx.targetCurrentRole === 'OWNER' && ctx.newRole !== 'OWNER' && ctx.ownerCount <= 1)
    return 'LAST_OWNER';
  return null;
}

export interface MemberRemovalContext {
  actorRole: WorkspaceRole;
  actorIsTarget: boolean;
  targetRole: WorkspaceRole;
  ownerCount: number;
}

/**
 * Rules for removing a member: anyone may leave (remove themselves) unless they are the last owner;
 * admins may remove members and admins; only owners may remove other owners.
 */
export function checkMemberRemoval(ctx: MemberRemovalContext): RoleChangeDenial | null {
  if (ctx.targetRole === 'OWNER' && ctx.ownerCount <= 1) return 'LAST_OWNER';
  if (ctx.actorIsTarget) return null;
  if (!can(ctx.actorRole, 'members.manage')) return 'INSUFFICIENT_ROLE';
  if (ctx.targetRole === 'OWNER' && ctx.actorRole !== 'OWNER') return 'CANNOT_MANAGE_OWNER';
  return null;
}

/** Roles an actor may assign when inviting someone. Client invitations also need the plan's client portal. */
export function invitableRoles(actorRole: WorkspaceRole): WorkspaceRole[] {
  if (actorRole === 'OWNER') return ['OWNER', 'ADMIN', 'MEMBER', 'CLIENT'];
  if (actorRole === 'ADMIN') return ['ADMIN', 'MEMBER', 'CLIENT'];
  return [];
}

export const ROLE_CHANGE_DENIAL_MESSAGES: Record<RoleChangeDenial, string> = {
  INSUFFICIENT_ROLE: 'Your role does not allow managing members.',
  CANNOT_MANAGE_OWNER: 'Only an owner can change or remove another owner.',
  CANNOT_GRANT_OWNER: 'Only an owner can grant the owner role.',
  LAST_OWNER: 'A workspace must keep at least one owner. Transfer ownership first.',
  SELF_CHANGE: 'You cannot change your own role.',
};
