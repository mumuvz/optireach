import { listAccessibleWorkspaces } from '@surfaced/core/access';
import { recordAuditLog } from '@surfaced/core/audit-log';
import { hashToken, randomToken } from '@surfaced/core/crypto';
import { ensureDefaultPlans } from '@surfaced/core/billing';
import { queueEmail } from '@surfaced/core/email';
import { getEnv } from '@surfaced/core/env';
import { Errors } from '@surfaced/core/errors';
import { assertCountLimit, assertPlanFeature, countTeamMembers } from '@surfaced/core/usage';
import {
  DEFAULT_PLAN_KEY,
  ROLE_CHANGE_DENIAL_MESSAGES,
  ROLE_LABELS,
  checkMemberRemoval,
  checkRoleChange,
  invitableRoles,
  slugify,
  type InvitationDto,
  type WorkspaceMemberDto,
  type WorkspaceRole,
} from '@surfaced/shared';
import type { AppDeps, AuthUser } from '../types';
import { requireWorkspaceAccess } from './access';
import { toWorkspaceDto } from './dto';

const INVITATION_TTL_MS = 7 * 24 * 3600 * 1000;
const MAX_OWNED_WORKSPACES = 10;

export class WorkspaceService {
  constructor(private readonly deps: AppDeps) {}

  private get prisma() {
    return this.deps.prisma;
  }

  /** Direct memberships plus client workspaces of the user's agencies. */
  async list(user: AuthUser) {
    const accessible = await listAccessibleWorkspaces(this.prisma, user.id);
    return accessible.map((a) => toWorkspaceDto(a.workspace, a.role, a.via));
  }

  async create(user: AuthUser, name: string) {
    const owned = await this.prisma.workspaceMember.count({ where: { userId: user.id, role: 'OWNER' } });
    if (owned >= MAX_OWNED_WORKSPACES)
      throw Errors.conflict(`You can own at most ${MAX_OWNED_WORKSPACES} workspaces.`);
    await ensureDefaultPlans(this.prisma);
    const freePlan = await this.prisma.subscriptionPlan.findUniqueOrThrow({
      where: { key: DEFAULT_PLAN_KEY },
    });
    const workspace = await this.prisma.$transaction(async (tx) => {
      const ws = await tx.workspace.create({
        data: { name, slug: `${slugify(name, 40) || 'workspace'}-${randomToken(4).toLowerCase()}` },
      });
      await tx.workspaceMember.create({ data: { workspaceId: ws.id, userId: user.id, role: 'OWNER' } });
      await tx.subscription.create({ data: { workspaceId: ws.id, planId: freePlan.id, status: 'ACTIVE' } });
      await tx.user.update({ where: { id: user.id }, data: { lastWorkspaceId: ws.id } });
      return ws;
    });
    await recordAuditLog(this.prisma, {
      action: 'workspace.created',
      actorUserId: user.id,
      workspaceId: workspace.id,
      targetType: 'Workspace',
      targetId: workspace.id,
    });
    return toWorkspaceDto(workspace, 'OWNER');
  }

  async members(user: AuthUser, workspaceId: string): Promise<WorkspaceMemberDto[]> {
    await requireWorkspaceAccess(this.prisma, user, workspaceId, 'members.read');
    const members = await this.prisma.workspaceMember.findMany({
      where: { workspaceId },
      include: { user: { select: { name: true, email: true } } },
      orderBy: { createdAt: 'asc' },
    });
    return members.map((m) => ({
      id: m.id,
      userId: m.userId,
      name: m.user.name,
      email: m.user.email,
      role: m.role,
      createdAt: m.createdAt.toISOString(),
    }));
  }

  async invitations(user: AuthUser, workspaceId: string): Promise<InvitationDto[]> {
    await requireWorkspaceAccess(this.prisma, user, workspaceId, 'members.invite');
    const invitations = await this.prisma.workspaceInvitation.findMany({
      where: { workspaceId, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
      include: { invitedBy: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return invitations.map((i) => ({
      id: i.id,
      email: i.email,
      role: i.role,
      expiresAt: i.expiresAt.toISOString(),
      createdAt: i.createdAt.toISOString(),
      invitedBy: i.invitedBy?.name ?? null,
    }));
  }

  /**
   * Invites someone by email. `agencyHandover` is set only by the agency flow that creates a client workspace,
   * which may invite the client's contact as owner even though the agency's inherited role is admin.
   */
  async invite(
    user: AuthUser,
    workspaceId: string,
    email: string,
    role: WorkspaceRole,
    ip: string,
    options: { agencyHandover?: boolean } = {},
  ) {
    const { workspace, role: actorRole } = await requireWorkspaceAccess(
      this.prisma,
      user,
      workspaceId,
      'members.invite',
    );
    if (!options.agencyHandover && !invitableRoles(actorRole).includes(role))
      throw Errors.forbidden('Your role cannot invite people with that role.');
    const actor = await this.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    if (!actor.emailVerifiedAt) throw Errors.emailNotVerified();

    const alreadyMember = await this.prisma.workspaceMember.findFirst({
      where: { workspaceId, user: { email } },
    });
    if (alreadyMember) throw Errors.conflict('That person is already a member of this workspace.');
    if (role === 'CLIENT') {
      // Client-portal users do not take team seats, but the plan must include the client portal.
      await assertPlanFeature(this.prisma, workspaceId, 'clientPortal', 'The client portal');
    } else {
      const [memberCount, pendingCount] = await Promise.all([
        countTeamMembers(this.prisma, workspaceId),
        this.prisma.workspaceInvitation.count({
          where: {
            workspaceId,
            role: { not: 'CLIENT' },
            acceptedAt: null,
            revokedAt: null,
            expiresAt: { gt: new Date() },
          },
        }),
      ]);
      await assertCountLimit(this.prisma, workspaceId, 'teamMembers', memberCount + pendingCount);
    }

    // Re-inviting the same address replaces any pending invitation.
    await this.prisma.workspaceInvitation.updateMany({
      where: { workspaceId, email, acceptedAt: null, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    const token = randomToken(32);
    const invitation = await this.prisma.workspaceInvitation.create({
      data: {
        workspaceId,
        email,
        role,
        tokenHash: hashToken(token),
        invitedById: user.id,
        expiresAt: new Date(Date.now() + INVITATION_TTL_MS),
      },
    });
    await queueEmail(this.prisma, this.deps.queues, {
      to: email,
      template: 'workspace_invitation',
      data: {
        inviterName: actor.name,
        workspaceName: workspace.name,
        role: ROLE_LABELS[role],
        url: `${getEnv().APP_URL}/invite/accept?token=${encodeURIComponent(token)}`,
      },
      workspaceId,
    });
    await recordAuditLog(this.prisma, {
      action: 'workspace.member_invited',
      actorUserId: user.id,
      workspaceId,
      targetType: 'WorkspaceInvitation',
      targetId: invitation.id,
      ipAddress: ip,
      metadata: { role },
    });
    return invitation;
  }

  async revokeInvitation(user: AuthUser, workspaceId: string, invitationId: string) {
    await requireWorkspaceAccess(this.prisma, user, workspaceId, 'members.invite');
    const result = await this.prisma.workspaceInvitation.updateMany({
      where: { id: invitationId, workspaceId, acceptedAt: null, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (result.count === 0) throw Errors.notFound('Invitation');
    await recordAuditLog(this.prisma, {
      action: 'workspace.invitation_revoked',
      actorUserId: user.id,
      workspaceId,
      targetType: 'WorkspaceInvitation',
      targetId: invitationId,
    });
  }

  async acceptInvitation(user: AuthUser, token: string) {
    const invitation = await this.prisma.workspaceInvitation.findUnique({
      where: { tokenHash: hashToken(token) },
      include: { workspace: true },
    });
    if (!invitation || invitation.acceptedAt || invitation.revokedAt || invitation.expiresAt <= new Date()) {
      throw Errors.badRequest('This invitation is invalid or has expired. Ask for a new one.');
    }
    if (invitation.email.toLowerCase() !== user.email.toLowerCase()) {
      throw Errors.forbidden(
        `This invitation was sent to ${invitation.email}. Sign in with that address to accept it.`,
      );
    }
    const existing = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: invitation.workspaceId, userId: user.id } },
    });
    if (!existing) {
      if (invitation.role !== 'CLIENT') {
        const members = await countTeamMembers(this.prisma, invitation.workspaceId);
        await assertCountLimit(this.prisma, invitation.workspaceId, 'teamMembers', members);
      }
      await this.prisma.$transaction([
        this.prisma.workspaceMember.create({
          data: { workspaceId: invitation.workspaceId, userId: user.id, role: invitation.role },
        }),
        this.prisma.workspaceInvitation.update({
          where: { id: invitation.id },
          data: { acceptedAt: new Date() },
        }),
        this.prisma.user.update({
          where: { id: user.id },
          data: { lastWorkspaceId: invitation.workspaceId },
        }),
      ]);
    }
    await recordAuditLog(this.prisma, {
      action: 'workspace.member_joined',
      actorUserId: user.id,
      workspaceId: invitation.workspaceId,
      targetType: 'User',
      targetId: user.id,
      metadata: { role: invitation.role },
    });
    return toWorkspaceDto(invitation.workspace, existing?.role ?? invitation.role);
  }

  async changeRole(user: AuthUser, workspaceId: string, memberId: string, newRole: WorkspaceRole) {
    const { role: actorRole } = await requireWorkspaceAccess(this.prisma, user, workspaceId, 'members.read');
    const target = await this.prisma.workspaceMember.findFirst({ where: { id: memberId, workspaceId } });
    if (!target) throw Errors.notFound('Member');
    const ownerCount = await this.prisma.workspaceMember.count({ where: { workspaceId, role: 'OWNER' } });
    const denial = checkRoleChange({
      actorRole,
      actorIsTarget: target.userId === user.id,
      targetCurrentRole: target.role,
      newRole,
      ownerCount,
    });
    if (denial)
      throw denial === 'LAST_OWNER'
        ? Errors.conflict(ROLE_CHANGE_DENIAL_MESSAGES[denial])
        : Errors.forbidden(ROLE_CHANGE_DENIAL_MESSAGES[denial]);
    const updated = await this.prisma.workspaceMember.update({
      where: { id: memberId },
      data: { role: newRole },
    });
    await recordAuditLog(this.prisma, {
      action: 'workspace.member_role_changed',
      actorUserId: user.id,
      workspaceId,
      targetType: 'User',
      targetId: target.userId,
      metadata: { from: target.role, to: newRole },
    });
    return updated;
  }

  async removeMember(user: AuthUser, workspaceId: string, memberId: string) {
    const { role: actorRole } = await requireWorkspaceAccess(this.prisma, user, workspaceId, 'members.read');
    const target = await this.prisma.workspaceMember.findFirst({ where: { id: memberId, workspaceId } });
    if (!target) throw Errors.notFound('Member');
    const ownerCount = await this.prisma.workspaceMember.count({ where: { workspaceId, role: 'OWNER' } });
    const denial = checkMemberRemoval({
      actorRole,
      actorIsTarget: target.userId === user.id,
      targetRole: target.role,
      ownerCount,
    });
    if (denial)
      throw denial === 'LAST_OWNER'
        ? Errors.conflict(ROLE_CHANGE_DENIAL_MESSAGES[denial])
        : Errors.forbidden(ROLE_CHANGE_DENIAL_MESSAGES[denial]);
    await this.prisma.$transaction([
      this.prisma.workspaceMember.delete({ where: { id: memberId } }),
      // Unassign the removed member from work items in this workspace.
      this.prisma.recommendation.updateMany({
        where: { assigneeId: target.userId, project: { workspaceId } },
        data: { assigneeId: null },
      }),
      this.prisma.contentDocument.updateMany({
        where: { assigneeId: target.userId, project: { workspaceId } },
        data: { assigneeId: null },
      }),
    ]);
    await recordAuditLog(this.prisma, {
      action: target.userId === user.id ? 'workspace.member_left' : 'workspace.member_removed',
      actorUserId: user.id,
      workspaceId,
      targetType: 'User',
      targetId: target.userId,
    });
  }
}
