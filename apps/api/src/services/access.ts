// Tenant isolation. Every project- or workspace-scoped operation goes through these guards. Access is either a
// direct membership or inherited through an agency that manages the workspace (docs/extension-plan.md D-024).
// Resources in workspaces the caller cannot reach are reported as 404 (never 403) so ids cannot be probed.
import { listAccessibleWorkspaces, resolveMembership } from '@surfaced/core/access';
import type { PrismaClient, Project, Workspace } from '@surfaced/core/db';
import { Errors } from '@surfaced/core/errors';
import { can, type MembershipVia, type Permission, type WorkspaceRole } from '@surfaced/shared';
import type { AuthUser } from '../types';

export interface MembershipContext {
  role: WorkspaceRole;
  via: MembershipVia;
  agencyWorkspaceId: string | null;
  approvalsDelegated: boolean;
}

export interface WorkspaceAccess extends MembershipContext {
  workspace: Workspace;
}

export interface ProjectAccess extends MembershipContext {
  project: Project;
}

export async function requireWorkspaceAccess(
  prisma: PrismaClient,
  user: AuthUser,
  workspaceId: string,
  permission: Permission,
): Promise<WorkspaceAccess> {
  const [membership, workspace] = await Promise.all([
    resolveMembership(prisma, user.id, workspaceId),
    prisma.workspace.findUnique({ where: { id: workspaceId } }),
  ]);
  if (!membership || !workspace) throw Errors.notFound('Workspace');
  if (!can(membership.role, permission)) throw Errors.forbidden();
  return {
    workspace,
    role: membership.role,
    via: membership.via,
    agencyWorkspaceId: membership.agencyWorkspaceId,
    approvalsDelegated: membership.approvalsDelegated,
  };
}

export async function requireProjectAccess(
  prisma: PrismaClient,
  user: AuthUser,
  projectId: string,
  permission: Permission,
): Promise<ProjectAccess> {
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) throw Errors.notFound('Project');
  const membership = await resolveMembership(prisma, user.id, project.workspaceId);
  if (!membership) throw Errors.notFound('Project');
  if (!can(membership.role, permission)) throw Errors.forbidden();
  return {
    project,
    role: membership.role,
    via: membership.via,
    agencyWorkspaceId: membership.agencyWorkspaceId,
    approvalsDelegated: membership.approvalsDelegated,
  };
}

/** Workspace ids the user can reach (direct and through agencies), for list endpoints that span workspaces. */
export async function memberWorkspaceIds(prisma: PrismaClient, userId: string): Promise<string[]> {
  return (await listAccessibleWorkspaces(prisma, userId)).map((w) => w.workspaceId);
}
