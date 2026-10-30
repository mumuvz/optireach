// Agency client workspaces (docs/extension-plan.md D-024). Agency-side actions need direct owner/admin
// membership of the agency workspace; client-side consent (requesting, changing and revoking access) stays with
// the client's own owners and admins.
import { workspaceParticipants } from '@surfaced/core/access';
import { recordAuditLog } from '@surfaced/core/audit-log';
import { ensureDefaultPlans, getWorkspacePlan } from '@surfaced/core/billing';
import { randomToken } from '@surfaced/core/crypto';
import type { AgencyClientLink, Workspace } from '@surfaced/core/db';
import { Errors } from '@surfaced/core/errors';
import { emitEvent } from '@surfaced/core/events';
import { removeReportFiles } from '@surfaced/core/reports';
import {
  DEFAULT_PLAN_KEY,
  slugify,
  type AgencyLinkDto,
  type AgencyLinkRequestInput,
  type AgencyLinkUpdateInput,
  type ClientWorkspaceCreateInput,
} from '@surfaced/shared';
import type { AppDeps, AuthUser } from '../types';
import { requireWorkspaceAccess } from './access';
import { WorkspaceService } from './workspace.service';

type LinkRow = AgencyClientLink & { agencyWorkspace: Workspace; clientWorkspace: Workspace };

export function toAgencyLinkDto(link: LinkRow): AgencyLinkDto {
  return {
    id: link.id,
    agencyWorkspaceId: link.agencyWorkspaceId,
    agencyName: link.agencyWorkspace.name,
    clientWorkspaceId: link.clientWorkspaceId,
    clientName: link.clientWorkspace.name,
    status: link.status,
    accessRole: link.accessRole,
    approvalsDelegated: link.approvalsDelegated,
    billingMode: link.billingMode,
    acceptedAt: link.acceptedAt?.toISOString() ?? null,
    revokedAt: link.revokedAt?.toISOString() ?? null,
    createdAt: link.createdAt.toISOString(),
  };
}

const linkInclude = { agencyWorkspace: true, clientWorkspace: true } as const;

export class AgencyService {
  constructor(private readonly deps: AppDeps) {}

  private get prisma() {
    return this.deps.prisma;
  }

  /** Agency-side access: a direct owner or admin of the agency workspace. */
  private async requireAgencyManager(user: AuthUser, agencyWorkspaceId: string) {
    const access = await requireWorkspaceAccess(this.prisma, user, agencyWorkspaceId, 'agency.manage');
    if (access.via !== 'DIRECT')
      throw Errors.forbidden('Manage client workspaces from your own agency workspace.');
    return access;
  }

  /** Whether a workspace may act as an agency, and how many client workspaces it may manage. */
  async eligibility(agencyWorkspaceId: string) {
    const [workspace, { limits, plan }, used, managedBy] = await Promise.all([
      this.prisma.workspace.findUniqueOrThrow({ where: { id: agencyWorkspaceId } }),
      getWorkspacePlan(this.prisma, agencyWorkspaceId),
      this.prisma.agencyClientLink.count({
        where: { agencyWorkspaceId, status: { in: ['PENDING', 'ACTIVE'] } },
      }),
      this.prisma.agencyClientLink.findFirst({
        where: { clientWorkspaceId: agencyWorkspaceId, status: 'ACTIVE', billingMode: 'AGENCY' },
        select: { id: true },
      }),
    ]);
    const limit = workspace.isServiceProvider ? null : limits.clientWorkspaces;
    const eligible = !managedBy && (workspace.isServiceProvider || limits.clientWorkspaces > 0);
    return {
      eligible,
      isServiceProvider: workspace.isServiceProvider,
      planName: plan.name,
      limit,
      used,
      reason: managedBy
        ? 'This workspace is billed through another agency, so it cannot manage client workspaces.'
        : eligible
          ? null
          : `Client workspaces are not included in the ${plan.name} plan.`,
    };
  }

  private async assertCanAddClient(agencyWorkspaceId: string) {
    const status = await this.eligibility(agencyWorkspaceId);
    if (!status.eligible) throw Errors.planLimit(status.reason ?? 'This workspace cannot manage clients.');
    if (status.limit !== null && status.used >= status.limit)
      throw Errors.planLimit(
        `Your ${status.planName} plan allows ${status.limit} client workspaces. Upgrade to add more.`,
        { kind: 'clientWorkspaces', limit: status.limit, current: status.used },
      );
  }

  async listClients(user: AuthUser, agencyWorkspaceId: string) {
    await this.requireAgencyManager(user, agencyWorkspaceId);
    const links = await this.prisma.agencyClientLink.findMany({
      where: { agencyWorkspaceId, status: { in: ['PENDING', 'ACTIVE'] } },
      include: linkInclude,
      orderBy: { createdAt: 'desc' },
    });
    const clientIds = links.map((l) => l.clientWorkspaceId);
    const [projects, approvals, tasks, owners] = await Promise.all([
      this.prisma.project.groupBy({
        by: ['workspaceId'],
        where: { workspaceId: { in: clientIds } },
        _count: true,
      }),
      this.prisma.approvalRequest.groupBy({
        by: ['workspaceId'],
        where: { workspaceId: { in: clientIds }, status: 'PENDING' },
        _count: true,
      }),
      this.prisma.task.groupBy({
        by: ['workspaceId'],
        where: {
          workspaceId: { in: clientIds },
          status: { in: ['TODO', 'IN_PROGRESS', 'BLOCKED', 'IN_REVIEW'] },
        },
        _count: true,
      }),
      this.prisma.workspaceMember.groupBy({
        by: ['workspaceId'],
        where: { workspaceId: { in: clientIds }, role: 'OWNER' },
        _count: true,
      }),
    ]);
    const count = (rows: { workspaceId: string; _count: number }[], id: string) =>
      rows.find((r) => r.workspaceId === id)?._count ?? 0;
    return {
      eligibility: await this.eligibility(agencyWorkspaceId),
      agencyCode: (await this.prisma.workspace.findUniqueOrThrow({ where: { id: agencyWorkspaceId } })).slug,
      clients: links.map((link) => ({
        ...toAgencyLinkDto(link),
        projects: count(projects, link.clientWorkspaceId),
        pendingApprovals: count(approvals, link.clientWorkspaceId),
        openTasks: count(tasks, link.clientWorkspaceId),
        hasClientOwner: count(owners, link.clientWorkspaceId) > 0,
      })),
    };
  }

  /** Creates a client workspace managed by the agency, optionally inviting the client's contact. */
  async createClient(
    user: AuthUser,
    agencyWorkspaceId: string,
    input: ClientWorkspaceCreateInput,
    ip: string,
  ) {
    await this.requireAgencyManager(user, agencyWorkspaceId);
    await this.assertCanAddClient(agencyWorkspaceId);
    await ensureDefaultPlans(this.prisma);
    const freePlan = await this.prisma.subscriptionPlan.findUniqueOrThrow({
      where: { key: DEFAULT_PLAN_KEY },
    });
    const { workspace, link } = await this.prisma.$transaction(async (tx) => {
      const ws = await tx.workspace.create({
        data: {
          name: input.name,
          slug: `${slugify(input.name, 40) || 'client'}-${randomToken(4).toLowerCase()}`,
        },
      });
      // Every workspace keeps its own subscription row; with AGENCY billing the agency's plan applies instead.
      await tx.subscription.create({ data: { workspaceId: ws.id, planId: freePlan.id, status: 'ACTIVE' } });
      const created = await tx.agencyClientLink.create({
        data: {
          agencyWorkspaceId,
          clientWorkspaceId: ws.id,
          status: 'ACTIVE',
          accessRole: 'ADMIN',
          approvalsDelegated: input.approvalsDelegated ?? false,
          billingMode: input.billingMode ?? 'AGENCY',
          invitedById: user.id,
          acceptedById: user.id,
          acceptedAt: new Date(),
        },
        include: linkInclude,
      });
      return { workspace: ws, link: created };
    });
    await recordAuditLog(this.prisma, {
      action: 'agency.client_created',
      actorUserId: user.id,
      workspaceId: agencyWorkspaceId,
      targetType: 'Workspace',
      targetId: workspace.id,
      ipAddress: ip,
      metadata: { billingMode: link.billingMode },
    });
    await emitEvent(this.prisma, {
      workspaceId: agencyWorkspaceId,
      type: 'agency.client_linked',
      entityType: 'AgencyClientLink',
      entityId: link.id,
      actorUserId: user.id,
      data: { clientWorkspaceId: workspace.id },
    });
    if (input.contactEmail) {
      await new WorkspaceService(this.deps).invite(
        user,
        workspace.id,
        input.contactEmail,
        input.contactRole ?? 'CLIENT',
        ip,
        { agencyHandover: true },
      );
    }
    return toAgencyLinkDto(link);
  }

  async acceptLink(user: AuthUser, agencyWorkspaceId: string, linkId: string) {
    await this.requireAgencyManager(user, agencyWorkspaceId);
    const link = await this.prisma.agencyClientLink.findFirst({ where: { id: linkId, agencyWorkspaceId } });
    if (!link) throw Errors.notFound('Client request');
    if (link.status !== 'PENDING') throw Errors.conflict('Only pending requests can be accepted.');
    await this.assertCanAddClient(agencyWorkspaceId);
    const updated = await this.prisma.agencyClientLink.update({
      where: { id: link.id },
      data: { status: 'ACTIVE', acceptedById: user.id, acceptedAt: new Date() },
      include: linkInclude,
    });
    await this.notifyClientManagers(
      updated,
      `${updated.agencyWorkspace.name} now has access to this workspace.`,
    );
    await recordAuditLog(this.prisma, {
      action: 'agency.link_accepted',
      actorUserId: user.id,
      workspaceId: link.clientWorkspaceId,
      targetType: 'AgencyClientLink',
      targetId: link.id,
    });
    return toAgencyLinkDto(updated);
  }

  /** Ends the agency's access from the agency side (only once a client owner exists to keep the workspace). */
  async endLink(user: AuthUser, agencyWorkspaceId: string, linkId: string) {
    await this.requireAgencyManager(user, agencyWorkspaceId);
    const link = await this.prisma.agencyClientLink.findFirst({
      where: { id: linkId, agencyWorkspaceId, status: { in: ['PENDING', 'ACTIVE'] } },
    });
    if (!link) throw Errors.notFound('Client');
    if (link.status === 'ACTIVE') {
      const owners = await this.prisma.workspaceMember.count({
        where: { workspaceId: link.clientWorkspaceId, role: 'OWNER' },
      });
      if (owners === 0)
        throw Errors.conflict(
          'This client workspace has no owner of its own yet. Invite the client as an owner, or delete the workspace.',
        );
    }
    return this.revoke(link, user.id, 'agency');
  }

  /** Deletes a client workspace the agency created and never handed over to a client owner. */
  async deleteClient(user: AuthUser, agencyWorkspaceId: string, clientWorkspaceId: string) {
    await this.requireAgencyManager(user, agencyWorkspaceId);
    const link = await this.prisma.agencyClientLink.findFirst({
      where: { agencyWorkspaceId, clientWorkspaceId, status: 'ACTIVE' },
    });
    if (!link) throw Errors.notFound('Client');
    const owners = await this.prisma.workspaceMember.count({
      where: { workspaceId: clientWorkspaceId, role: 'OWNER' },
    });
    if (owners > 0)
      throw Errors.conflict(
        'The client owns this workspace. End your access instead; only the client can delete it.',
      );
    await removeReportFiles(this.prisma, { workspaceId: clientWorkspaceId });
    await this.prisma.workspace.delete({ where: { id: clientWorkspaceId } });
    await recordAuditLog(this.prisma, {
      action: 'agency.client_deleted',
      actorUserId: user.id,
      workspaceId: agencyWorkspaceId,
      targetType: 'Workspace',
      targetId: clientWorkspaceId,
    });
  }

  // ---------------- Client side ----------------

  async clientLink(user: AuthUser, clientWorkspaceId: string) {
    await requireWorkspaceAccess(this.prisma, user, clientWorkspaceId, 'workspace.read');
    const link = await this.prisma.agencyClientLink.findFirst({
      where: { clientWorkspaceId, status: { in: ['PENDING', 'ACTIVE'] } },
      include: linkInclude,
      orderBy: { createdAt: 'desc' },
    });
    return link ? toAgencyLinkDto(link) : null;
  }

  private async requireClientOwner(user: AuthUser, clientWorkspaceId: string, allowAdmin = false) {
    const access = await requireWorkspaceAccess(this.prisma, user, clientWorkspaceId, 'workspace.read');
    const allowed =
      access.via === 'DIRECT' && (access.role === 'OWNER' || (allowAdmin && access.role === 'ADMIN'));
    if (!allowed)
      throw Errors.forbidden(
        allowAdmin
          ? "Only the workspace's own owners and admins can change agency access."
          : "Only the workspace's own owners can grant or change agency access.",
      );
    return access;
  }

  /** The client asks an agency (by its code) to manage this workspace; the agency must accept. */
  async requestLink(user: AuthUser, clientWorkspaceId: string, input: AgencyLinkRequestInput) {
    await this.requireClientOwner(user, clientWorkspaceId);
    const agency = await this.prisma.workspace.findUnique({ where: { slug: input.agencyCode } });
    if (!agency || agency.id === clientWorkspaceId) throw Errors.notFound('Agency');
    const status = await this.eligibility(agency.id);
    if (!status.eligible) throw Errors.notFound('Agency');
    const existing = await this.prisma.agencyClientLink.findFirst({
      where: { clientWorkspaceId, status: { in: ['PENDING', 'ACTIVE'] } },
    });
    if (existing)
      throw Errors.conflict('This workspace already has an agency. Revoke it before adding another.');
    const link = await this.prisma.agencyClientLink.upsert({
      where: { agencyWorkspaceId_clientWorkspaceId: { agencyWorkspaceId: agency.id, clientWorkspaceId } },
      update: {
        status: 'PENDING',
        accessRole: input.accessRole ?? 'ADMIN',
        approvalsDelegated: input.approvalsDelegated ?? false,
        billingMode: 'CLIENT',
        invitedById: user.id,
        acceptedById: null,
        acceptedAt: null,
        revokedById: null,
        revokedAt: null,
      },
      create: {
        agencyWorkspaceId: agency.id,
        clientWorkspaceId,
        status: 'PENDING',
        accessRole: input.accessRole ?? 'ADMIN',
        approvalsDelegated: input.approvalsDelegated ?? false,
        billingMode: 'CLIENT',
        invitedById: user.id,
      },
      include: linkInclude,
    });
    const managers = await workspaceParticipants(this.prisma, agency.id, ['OWNER', 'ADMIN']);
    if (managers.length)
      await this.prisma.notification.createMany({
        data: managers
          .filter((m) => m.via === 'DIRECT')
          .map((m) => ({
            userId: m.userId,
            workspaceId: agency.id,
            type: 'agency_request',
            title: `${link.clientWorkspace.name} asked your agency to manage their workspace`,
            link: '/app/agency',
          })),
      });
    await recordAuditLog(this.prisma, {
      action: 'agency.link_requested',
      actorUserId: user.id,
      workspaceId: clientWorkspaceId,
      targetType: 'AgencyClientLink',
      targetId: link.id,
      metadata: {
        agencyWorkspaceId: agency.id,
        accessRole: link.accessRole,
        approvalsDelegated: link.approvalsDelegated,
      },
    });
    return toAgencyLinkDto(link);
  }

  async updateLink(user: AuthUser, clientWorkspaceId: string, input: AgencyLinkUpdateInput) {
    await this.requireClientOwner(user, clientWorkspaceId);
    const link = await this.prisma.agencyClientLink.findFirst({
      where: { clientWorkspaceId, status: { in: ['PENDING', 'ACTIVE'] } },
    });
    if (!link) throw Errors.notFound('Agency access');
    const updated = await this.prisma.agencyClientLink.update({
      where: { id: link.id },
      data: {
        ...(input.accessRole ? { accessRole: input.accessRole } : {}),
        ...(input.approvalsDelegated !== undefined ? { approvalsDelegated: input.approvalsDelegated } : {}),
      },
      include: linkInclude,
    });
    await recordAuditLog(this.prisma, {
      action: 'agency.link_updated',
      actorUserId: user.id,
      workspaceId: clientWorkspaceId,
      targetType: 'AgencyClientLink',
      targetId: link.id,
      metadata: { accessRole: updated.accessRole, approvalsDelegated: updated.approvalsDelegated },
    });
    return toAgencyLinkDto(updated);
  }

  /** The client revokes agency access; it ends immediately. */
  async revokeLink(user: AuthUser, clientWorkspaceId: string) {
    await this.requireClientOwner(user, clientWorkspaceId, true);
    const link = await this.prisma.agencyClientLink.findFirst({
      where: { clientWorkspaceId, status: { in: ['PENDING', 'ACTIVE'] } },
    });
    if (!link) throw Errors.notFound('Agency access');
    return this.revoke(link, user.id, 'client');
  }

  private async revoke(link: AgencyClientLink, userId: string, by: 'agency' | 'client') {
    const updated = await this.prisma.agencyClientLink.update({
      where: { id: link.id },
      data: { status: 'REVOKED', revokedById: userId, revokedAt: new Date() },
      include: linkInclude,
    });
    // Unassign agency staff from open work in the client workspace.
    const agencyMembers = await this.prisma.workspaceMember.findMany({
      where: { workspaceId: link.agencyWorkspaceId },
      select: { userId: true },
    });
    const directMembers = new Set(
      (
        await this.prisma.workspaceMember.findMany({
          where: { workspaceId: link.clientWorkspaceId },
          select: { userId: true },
        })
      ).map((m) => m.userId),
    );
    const staff = agencyMembers.map((m) => m.userId).filter((id) => !directMembers.has(id));
    if (staff.length)
      await this.prisma.$transaction([
        this.prisma.task.updateMany({
          where: { workspaceId: link.clientWorkspaceId, assigneeId: { in: staff } },
          data: { assigneeId: null },
        }),
        this.prisma.recommendation.updateMany({
          where: { project: { workspaceId: link.clientWorkspaceId }, assigneeId: { in: staff } },
          data: { assigneeId: null },
        }),
        this.prisma.contentDocument.updateMany({
          where: { project: { workspaceId: link.clientWorkspaceId }, assigneeId: { in: staff } },
          data: { assigneeId: null },
        }),
      ]);
    await this.notifyClientManagers(
      updated,
      by === 'client'
        ? `Access for ${updated.agencyWorkspace.name} was revoked.`
        : `${updated.agencyWorkspace.name} no longer manages this workspace.`,
    );
    await recordAuditLog(this.prisma, {
      action: by === 'client' ? 'agency.link_revoked' : 'agency.link_ended',
      actorUserId: userId,
      workspaceId: link.clientWorkspaceId,
      targetType: 'AgencyClientLink',
      targetId: link.id,
    });
    await emitEvent(this.prisma, {
      workspaceId: link.clientWorkspaceId,
      type: 'agency.client_unlinked',
      entityType: 'AgencyClientLink',
      entityId: link.id,
      actorUserId: userId,
      data: { by },
    });
    return toAgencyLinkDto(updated);
  }

  private async notifyClientManagers(link: LinkRow, title: string) {
    const managers = await this.prisma.workspaceMember.findMany({
      where: { workspaceId: link.clientWorkspaceId, role: { in: ['OWNER', 'ADMIN'] } },
      select: { userId: true },
    });
    if (managers.length)
      await this.prisma.notification.createMany({
        data: managers.map((m) => ({
          userId: m.userId,
          workspaceId: link.clientWorkspaceId,
          type: 'agency_access',
          title,
          link: '/app/settings?tab=agency',
        })),
      });
  }
}
