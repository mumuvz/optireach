// Approval requests (docs/extension-plan.md D-026). Anything published outside Surfaced needs an APPROVED request
// whose snapshot hash matches the exact content being published, so editing after approval needs a new approval.
import {
  APPROVAL_ENTITY_LABELS,
  canDecideApproval,
  type ApprovalActor,
  type ApprovalDecision,
  type ApprovalEntityType,
} from '@surfaced/shared';
import { resolveMembership, workspaceParticipants } from './access';
import { sha256Hex } from './crypto';
import type { ApprovalRequest, Prisma, PrismaClient } from './db';
import { Errors } from './errors';
import { emitEvent } from './events';
import { getLogger } from './logger';

/** JSON with object keys sorted recursively, so equal content always produces the same hash. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

export function snapshotHash(snapshot: unknown): string {
  return sha256Hex(stableStringify(snapshot));
}

export interface ApprovalRequestInput {
  workspaceId: string;
  projectId?: string | null;
  entityType: ApprovalEntityType;
  entityId: string;
  title: string;
  summary?: string | null;
  /** Exactly what will be published (fields, text, diff). */
  snapshot: Prisma.InputJsonValue;
  requestedById?: string | null;
  dueAt?: Date | null;
}

/**
 * Opens an approval request. An identical pending request is reused; other pending requests for the same record
 * are marked SUPERSEDED, so only the latest content can be approved.
 */
export async function requestApproval(
  prisma: PrismaClient,
  input: ApprovalRequestInput,
): Promise<ApprovalRequest> {
  const hash = snapshotHash(input.snapshot);
  const open = await prisma.approvalRequest.findMany({
    where: {
      workspaceId: input.workspaceId,
      entityType: input.entityType,
      entityId: input.entityId,
      status: 'PENDING',
    },
  });
  const same = open.find((r) => r.snapshotHash === hash);
  if (same) return same;
  const created = await prisma.$transaction(async (tx) => {
    if (open.length)
      await tx.approvalRequest.updateMany({
        where: { id: { in: open.map((o) => o.id) }, status: 'PENDING' },
        data: { status: 'SUPERSEDED' },
      });
    return tx.approvalRequest.create({
      data: {
        workspaceId: input.workspaceId,
        projectId: input.projectId ?? null,
        entityType: input.entityType,
        entityId: input.entityId,
        title: input.title.slice(0, 255),
        summary: input.summary ?? null,
        snapshot: input.snapshot,
        snapshotHash: hash,
        requestedById: input.requestedById ?? null,
        dueAt: input.dueAt ?? null,
      },
    });
  });
  await notifyApprovers(prisma, created).catch((error) =>
    getLogger('approvals').warn({ err: error, approvalId: created.id }, 'Approval notification failed'),
  );
  await emitEvent(prisma, {
    workspaceId: created.workspaceId,
    projectId: created.projectId,
    type: 'approval.requested',
    entityType: 'ApprovalRequest',
    entityId: created.id,
    actorUserId: created.requestedById,
    data: { recordType: created.entityType, recordId: created.entityId },
  });
  return created;
}

async function notifyApprovers(prisma: PrismaClient, request: ApprovalRequest): Promise<void> {
  const link = await prisma.agencyClientLink.findFirst({
    where: { clientWorkspaceId: request.workspaceId, status: 'ACTIVE' },
    select: { approvalsDelegated: true },
  });
  const participants = await workspaceParticipants(prisma, request.workspaceId, ['OWNER', 'ADMIN', 'CLIENT']);
  const approvers = participants.filter(
    (p) =>
      p.userId !== request.requestedById &&
      canDecideApproval({ role: p.role, via: p.via, approvalsDelegated: link?.approvalsDelegated }),
  );
  if (approvers.length === 0) return;
  const label = APPROVAL_ENTITY_LABELS[request.entityType as ApprovalEntityType] ?? 'Change';
  await prisma.notification.createMany({
    data: approvers.map((a) => ({
      userId: a.userId,
      workspaceId: request.workspaceId,
      type: 'approval_requested',
      title: `Approval needed: ${request.title}`.slice(0, 255),
      body: `${label} is waiting for your decision.`,
      link: `/app/approvals/${request.id}`,
    })),
  });
}

export interface ApprovalDecisionInput {
  approvalId: string;
  decision: ApprovalDecision;
  note?: string | null;
  actorUserId: string;
}

/** Whether a user may decide approvals in a workspace (direct customer approver, or a delegated agency). */
export async function approvalActorFor(
  prisma: PrismaClient | Prisma.TransactionClient,
  userId: string,
  workspaceId: string,
): Promise<(ApprovalActor & { canDecide: boolean }) | null> {
  const membership = await resolveMembership(prisma, userId, workspaceId);
  if (!membership) return null;
  const actor: ApprovalActor = {
    role: membership.role,
    via: membership.via,
    approvalsDelegated: membership.approvalsDelegated,
  };
  return { ...actor, canDecide: canDecideApproval(actor) };
}

export async function decideApproval(
  prisma: PrismaClient,
  input: ApprovalDecisionInput,
): Promise<ApprovalRequest> {
  const request = await prisma.approvalRequest.findUnique({ where: { id: input.approvalId } });
  if (!request) throw Errors.notFound('Approval request');
  // Membership is resolved for the request's own workspace, never taken from the caller.
  const actor = await approvalActorFor(prisma, input.actorUserId, request.workspaceId);
  if (!actor) throw Errors.notFound('Approval request');
  if (!actor.canDecide)
    throw Errors.forbidden(
      actor.via === 'AGENCY'
        ? 'The client decides approvals for this workspace. They can delegate approvals to your agency.'
        : 'Only owners, admins and client users can decide approvals.',
    );
  if (input.decision !== 'APPROVED' && !input.note?.trim())
    throw Errors.badRequest('Add a note explaining what should change.');
  const updated = await prisma.approvalRequest.updateMany({
    where: { id: request.id, status: 'PENDING' },
    data: {
      status: input.decision,
      decidedById: input.actorUserId,
      decidedAt: new Date(),
      decisionNote: input.note?.trim().slice(0, 2000) || null,
      decidedVia: actor.via === 'DIRECT' ? 'DIRECT_MEMBER' : 'AGENCY_DELEGATED',
    },
  });
  if (updated.count !== 1)
    throw Errors.conflict('This request was already decided, withdrawn or replaced by a newer one.');
  const decided = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: request.id } });
  if (decided.requestedById && decided.requestedById !== input.actorUserId) {
    await prisma.notification
      .create({
        data: {
          userId: decided.requestedById,
          workspaceId: decided.workspaceId,
          type: 'approval_decided',
          title:
            `${decided.title}: ${decided.status === 'APPROVED' ? 'approved' : decided.status === 'REJECTED' ? 'rejected' : 'changes requested'}`.slice(
              0,
              255,
            ),
          body: decided.decisionNote,
          link: `/app/approvals/${decided.id}`,
        },
      })
      .catch(() => undefined);
  }
  await emitEvent(prisma, {
    workspaceId: decided.workspaceId,
    projectId: decided.projectId,
    type: 'approval.decided',
    entityType: 'ApprovalRequest',
    entityId: decided.id,
    actorUserId: input.actorUserId,
    data: { recordType: decided.entityType, recordId: decided.entityId, decision: decided.status },
  });
  return decided;
}

/** Withdraws a pending request (by its requester, or by someone who manages the workspace). */
export async function withdrawApproval(prisma: PrismaClient, approvalId: string): Promise<ApprovalRequest> {
  const updated = await prisma.approvalRequest.updateMany({
    where: { id: approvalId, status: 'PENDING' },
    data: { status: 'WITHDRAWN' },
  });
  if (updated.count !== 1) throw Errors.conflict('Only pending requests can be withdrawn.');
  return prisma.approvalRequest.findUniqueOrThrow({ where: { id: approvalId } });
}

export interface ApprovalTarget {
  workspaceId: string;
  entityType: ApprovalEntityType;
  entityId: string;
}

export function latestApproval(prisma: PrismaClient | Prisma.TransactionClient, target: ApprovalTarget) {
  return prisma.approvalRequest.findFirst({
    where: { workspaceId: target.workspaceId, entityType: target.entityType, entityId: target.entityId },
    orderBy: { requestedAt: 'desc' },
  });
}

/**
 * Returns the approval that covers the record's current content, or throws 409 when there is none. Publishing code
 * calls this immediately before writing to the external system. Approvals never cross workspaces.
 */
export async function assertApproved(
  prisma: PrismaClient | Prisma.TransactionClient,
  target: ApprovalTarget,
  snapshot: unknown,
): Promise<ApprovalRequest> {
  const approved = await prisma.approvalRequest.findFirst({
    where: {
      workspaceId: target.workspaceId,
      entityType: target.entityType,
      entityId: target.entityId,
      status: 'APPROVED',
      snapshotHash: snapshotHash(snapshot),
    },
    orderBy: { decidedAt: 'desc' },
  });
  if (!approved)
    throw Errors.conflict(
      'This change needs an approval for its current content before it can be published.',
      {
        reason: 'APPROVAL_REQUIRED',
      },
    );
  return approved;
}
