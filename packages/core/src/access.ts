// Effective workspace access (docs/extension-plan.md D-024): a direct membership, or access inherited from an
// agency that manages the workspace through an ACTIVE agency link. The API guards and workspace listings both use
// this module so the two can never disagree.
import type { MembershipVia, WorkspaceRole } from '@surfaced/shared';
import type { Prisma, PrismaClient, Workspace } from './db';

type Db = PrismaClient | Prisma.TransactionClient;

export interface EffectiveMembership {
  workspaceId: string;
  role: WorkspaceRole;
  via: MembershipVia;
  /** Set when access is inherited through an agency. */
  agencyWorkspaceId: string | null;
  /** From the agency link: the client allowed the agency to decide approvals. */
  approvalsDelegated: boolean;
}

/**
 * Role a member of the agency workspace receives in a client workspace. Agency owners and admins get the
 * link's access level (ADMIN or MEMBER); agency members get MEMBER. Client-role users never inherit access.
 */
export function inheritedRole(
  agencyRole: WorkspaceRole,
  linkAccessRole: WorkspaceRole,
): WorkspaceRole | null {
  if (agencyRole === 'OWNER' || agencyRole === 'ADMIN')
    return linkAccessRole === 'MEMBER' ? 'MEMBER' : 'ADMIN';
  if (agencyRole === 'MEMBER') return 'MEMBER';
  return null;
}

export async function resolveMembership(
  db: Db,
  userId: string,
  workspaceId: string,
): Promise<EffectiveMembership | null> {
  const direct = await db.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
    select: { role: true },
  });
  if (direct)
    return {
      workspaceId,
      role: direct.role,
      via: 'DIRECT',
      agencyWorkspaceId: null,
      approvalsDelegated: false,
    };
  const link = await db.agencyClientLink.findFirst({
    where: {
      clientWorkspaceId: workspaceId,
      status: 'ACTIVE',
      agencyWorkspace: { members: { some: { userId } } },
    },
    select: {
      agencyWorkspaceId: true,
      accessRole: true,
      approvalsDelegated: true,
      agencyWorkspace: { select: { members: { where: { userId }, select: { role: true } } } },
    },
  });
  const agencyRole = link?.agencyWorkspace.members[0]?.role;
  if (!link || !agencyRole) return null;
  const role = inheritedRole(agencyRole, link.accessRole);
  if (!role) return null;
  return {
    workspaceId,
    role,
    via: 'AGENCY',
    agencyWorkspaceId: link.agencyWorkspaceId,
    approvalsDelegated: link.approvalsDelegated,
  };
}

export type AccessibleWorkspace = EffectiveMembership & { workspace: Workspace };

/** Every workspace the user can reach: direct memberships first, then client workspaces of their agencies. */
export async function listAccessibleWorkspaces(db: Db, userId: string): Promise<AccessibleWorkspace[]> {
  const direct = await db.workspaceMember.findMany({
    where: { userId },
    include: { workspace: true },
    orderBy: { createdAt: 'asc' },
  });
  const result: AccessibleWorkspace[] = direct.map((m) => ({
    workspaceId: m.workspaceId,
    role: m.role,
    via: 'DIRECT',
    agencyWorkspaceId: null,
    approvalsDelegated: false,
    workspace: m.workspace,
  }));
  const agencyRoles = new Map(direct.filter((m) => m.role !== 'CLIENT').map((m) => [m.workspaceId, m.role]));
  if (agencyRoles.size === 0) return result;
  const links = await db.agencyClientLink.findMany({
    where: { agencyWorkspaceId: { in: [...agencyRoles.keys()] }, status: 'ACTIVE' },
    include: { clientWorkspace: true },
    orderBy: { createdAt: 'asc' },
  });
  const seen = new Set(result.map((r) => r.workspaceId));
  for (const link of links) {
    if (seen.has(link.clientWorkspaceId)) continue;
    const role = inheritedRole(agencyRoles.get(link.agencyWorkspaceId)!, link.accessRole);
    if (!role) continue;
    seen.add(link.clientWorkspaceId);
    result.push({
      workspaceId: link.clientWorkspaceId,
      role,
      via: 'AGENCY',
      agencyWorkspaceId: link.agencyWorkspaceId,
      approvalsDelegated: link.approvalsDelegated,
      workspace: link.clientWorkspace,
    });
  }
  return result;
}

export interface WorkspaceParticipant {
  userId: string;
  role: WorkspaceRole;
  via: MembershipVia;
}

/**
 * Active users who can reach a workspace, optionally limited to effective roles. Used for notifications and to
 * validate assignees, so agency staff working on a client workspace can be assigned work there.
 */
export async function workspaceParticipants(
  db: Db,
  workspaceId: string,
  roles?: readonly WorkspaceRole[],
): Promise<WorkspaceParticipant[]> {
  const direct = await db.workspaceMember.findMany({
    where: { workspaceId, user: { disabledAt: null } },
    select: { userId: true, role: true },
  });
  const participants = new Map<string, WorkspaceParticipant>(
    direct.map((m) => [m.userId, { userId: m.userId, role: m.role, via: 'DIRECT' as const }]),
  );
  const link = await db.agencyClientLink.findFirst({
    where: { clientWorkspaceId: workspaceId, status: 'ACTIVE' },
    select: {
      accessRole: true,
      agencyWorkspace: {
        select: { members: { where: { user: { disabledAt: null } }, select: { userId: true, role: true } } },
      },
    },
  });
  for (const member of link?.agencyWorkspace.members ?? []) {
    if (participants.has(member.userId)) continue;
    const role = inheritedRole(member.role, link!.accessRole);
    if (role) participants.set(member.userId, { userId: member.userId, role, via: 'AGENCY' });
  }
  const all = [...participants.values()];
  return roles ? all.filter((p) => roles.includes(p.role)) : all;
}

/** True when the user can reach the workspace (used to validate assignees and approvers). */
export async function isWorkspaceParticipant(db: Db, workspaceId: string, userId: string): Promise<boolean> {
  return (await resolveMembership(db, userId, workspaceId)) !== null;
}

/** The agency link currently managing a workspace, if any. */
export function activeAgencyLink(db: Db, clientWorkspaceId: string) {
  return db.agencyClientLink.findFirst({
    where: { clientWorkspaceId, status: 'ACTIVE' },
    include: { agencyWorkspace: true },
  });
}
