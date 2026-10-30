import { listAccessibleWorkspaces } from '@surfaced/core/access';
import { approvalActorFor, decideApproval, withdrawApproval } from '@surfaced/core/approvals';
import { recordAuditLog } from '@surfaced/core/audit-log';
import type { ApprovalRequest, Prisma } from '@surfaced/core/db';
import { Errors } from '@surfaced/core/errors';
import {
  approvalDecisionSchema,
  approvalListQuerySchema,
  can,
  idSchema,
  type ApprovalEntityType,
  type ApprovalRequestDetailDto,
  type ApprovalRequestDto,
} from '@surfaced/shared';
import { z } from 'zod';
import { iso, ok, pageMeta, paginate } from '../lib/http';
import { route, type AnyRoute } from '../lib/router';
import { requireProjectAccess, requireWorkspaceAccess } from '../services/access';
import type { AppDeps, AuthUser } from '../types';

const approvalInclude = {
  workspace: { select: { name: true } },
  requestedBy: { select: { id: true, name: true } },
  decidedBy: { select: { id: true, name: true } },
} satisfies Prisma.ApprovalRequestInclude;

type ApprovalRow = ApprovalRequest & {
  workspace: { name: string };
  requestedBy: { id: string; name: string } | null;
  decidedBy: { id: string; name: string } | null;
};

function toApprovalDto(row: ApprovalRow, canDecide: boolean): ApprovalRequestDto {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    workspaceName: row.workspace.name,
    projectId: row.projectId,
    entityType: row.entityType as ApprovalEntityType,
    entityId: row.entityId,
    title: row.title,
    summary: row.summary,
    status: row.status,
    requestedBy: row.requestedBy,
    requestedAt: row.requestedAt.toISOString(),
    decidedBy: row.decidedBy,
    decidedAt: iso(row.decidedAt),
    decisionNote: row.decisionNote,
    decidedVia: row.decidedVia,
    dueAt: iso(row.dueAt),
    canDecide: canDecide && row.status === 'PENDING',
  };
}

export function approvalRoutes(deps: AppDeps): AnyRoute[] {
  const { prisma } = deps;
  const tags = ['Approvals'];

  /** Per-workspace "may this user decide approvals here" (cached per request). */
  async function decideMap(user: AuthUser, workspaceIds: string[]): Promise<Map<string, boolean>> {
    const entries = await Promise.all(
      [...new Set(workspaceIds)].map(
        async (id) => [id, (await approvalActorFor(prisma, user.id, id))?.canDecide ?? false] as const,
      ),
    );
    return new Map(entries);
  }

  async function loadApproval(user: AuthUser, approvalId: string) {
    const row = await prisma.approvalRequest.findUnique({
      where: { id: approvalId },
      include: approvalInclude,
    });
    if (!row) throw Errors.notFound('Approval request');
    const access = await requireWorkspaceAccess(prisma, user, row.workspaceId, 'approval.read');
    return { row, access };
  }

  return [
    route({
      method: 'get',
      path: '/',
      summary: 'Approval requests the current user can see (one workspace, one project or all)',
      tags,
      auth: 'user',
      query: approvalListQuerySchema,
      handler: async ({ user, query }) => {
        let workspaceIds: string[];
        if (query.projectId) {
          const { project } = await requireProjectAccess(prisma, user, query.projectId, 'approval.read');
          workspaceIds = [project.workspaceId];
        } else if (query.workspaceId) {
          await requireWorkspaceAccess(prisma, user, query.workspaceId, 'approval.read');
          workspaceIds = [query.workspaceId];
        } else {
          workspaceIds = (await listAccessibleWorkspaces(prisma, user.id))
            .filter((w) => can(w.role, 'approval.read'))
            .map((w) => w.workspaceId);
        }
        const decidable = await decideMap(user, workspaceIds);
        if (query.decidable) workspaceIds = workspaceIds.filter((id) => decidable.get(id));
        const where: Prisma.ApprovalRequestWhereInput = {
          workspaceId: { in: workspaceIds },
          ...(query.projectId ? { projectId: query.projectId } : {}),
          ...(query.status ? { status: { in: query.status } } : query.decidable ? { status: 'PENDING' } : {}),
          ...(query.entityType ? { entityType: { in: query.entityType } } : {}),
        };
        const [total, rows] = await Promise.all([
          prisma.approvalRequest.count({ where }),
          prisma.approvalRequest.findMany({
            where,
            include: approvalInclude,
            orderBy: { requestedAt: 'desc' },
            ...paginate(query.page, query.pageSize),
          }),
        ]);
        return ok(
          rows.map((r) => toApprovalDto(r, decidable.get(r.workspaceId) ?? false)),
          pageMeta(query.page, query.pageSize, total),
        );
      },
    }),
    route({
      method: 'get',
      path: '/:approvalId',
      summary: 'Approval request with the exact content to approve and the history for the same record',
      tags,
      auth: 'user',
      params: z.object({ approvalId: idSchema }),
      handler: async ({ user, params }) => {
        const { row } = await loadApproval(user, params.approvalId);
        const [actor, history] = await Promise.all([
          approvalActorFor(prisma, user.id, row.workspaceId),
          prisma.approvalRequest.findMany({
            where: { entityType: row.entityType, entityId: row.entityId, id: { not: row.id } },
            orderBy: { requestedAt: 'desc' },
            take: 20,
            select: { id: true, status: true, requestedAt: true, decidedAt: true, decisionNote: true },
          }),
        ]);
        const detail: ApprovalRequestDetailDto = {
          ...toApprovalDto(row, actor?.canDecide ?? false),
          snapshot: row.snapshot,
          snapshotHash: row.snapshotHash,
          history: history.map((h) => ({
            id: h.id,
            status: h.status,
            requestedAt: h.requestedAt.toISOString(),
            decidedAt: iso(h.decidedAt),
            decisionNote: h.decisionNote,
          })),
        };
        return ok(detail);
      },
    }),
    route({
      method: 'post',
      path: '/:approvalId/decision',
      summary: 'Approve, reject or request changes (client approvers only)',
      tags,
      auth: 'user',
      params: z.object({ approvalId: idSchema }),
      body: approvalDecisionSchema,
      handler: async ({ user, params, body, req }) => {
        const { row } = await loadApproval(user, params.approvalId);
        const decided = await decideApproval(prisma, {
          approvalId: row.id,
          decision: body.decision,
          note: body.note,
          actorUserId: user.id,
        });
        await recordAuditLog(prisma, {
          action: 'approval.decided',
          actorUserId: user.id,
          workspaceId: decided.workspaceId,
          targetType: 'ApprovalRequest',
          targetId: decided.id,
          ipAddress: req.clientIp,
          metadata: { decision: decided.status, recordType: decided.entityType, via: decided.decidedVia },
        });
        const fresh = await prisma.approvalRequest.findUniqueOrThrow({
          where: { id: decided.id },
          include: approvalInclude,
        });
        return ok(toApprovalDto(fresh, false));
      },
    }),
    route({
      method: 'post',
      path: '/:approvalId/withdraw',
      summary: 'Withdraw a pending request (its requester, or an owner/admin)',
      tags,
      auth: 'user',
      params: z.object({ approvalId: idSchema }),
      handler: async ({ user, params }) => {
        const { row, access } = await loadApproval(user, params.approvalId);
        const mayWithdraw =
          row.requestedById === user.id || (can(access.role, 'members.manage') && access.via === 'DIRECT');
        if (!mayWithdraw)
          throw Errors.forbidden('Only the requester or an owner/admin can withdraw this request.');
        await withdrawApproval(prisma, row.id);
        await recordAuditLog(prisma, {
          action: 'approval.withdrawn',
          actorUserId: user.id,
          workspaceId: row.workspaceId,
          targetType: 'ApprovalRequest',
          targetId: row.id,
        });
        const fresh = await prisma.approvalRequest.findUniqueOrThrow({
          where: { id: row.id },
          include: approvalInclude,
        });
        return ok(toApprovalDto(fresh, false));
      },
    }),
  ];
}
