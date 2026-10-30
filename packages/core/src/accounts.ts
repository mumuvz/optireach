// Account deletion once the grace period after a deletion request has passed (runs daily from the
// maintenance queue). Workspaces where the user is the only member are deleted with the account;
// shared workspaces keep their data. The account is kept, and the user is told why, if the user is
// still the sole owner of a shared workspace or a workspace being deleted still has an active paid
// subscription, because cancelling at the payment provider must be a deliberate step.
import { recordAuditLog } from './audit-log';
import type { PrismaClient } from './db';
import type { Logger } from './logger';
import { createNotification } from './notifications';
import { removeReportFiles } from './reports';

export const ACCOUNT_DELETION_GRACE_DAYS = 14;
const DAY_MS = 24 * 3600 * 1000;

export interface AccountDeletionDeps {
  prisma: PrismaClient;
  logger: Logger;
  now?: () => Date;
}

export interface AccountDeletionResult {
  deleted: number;
  deferred: { id: string; reason: string }[];
}

export async function processAccountDeletions(deps: AccountDeletionDeps): Promise<AccountDeletionResult> {
  const { prisma } = deps;
  const now = deps.now?.() ?? new Date();
  const due = await prisma.user.findMany({
    where: { deletionRequestedAt: { lte: new Date(now.getTime() - ACCOUNT_DELETION_GRACE_DAYS * DAY_MS) } },
    select: { id: true },
    take: 100,
  });
  const result: AccountDeletionResult = { deleted: 0, deferred: [] };

  for (const { id: userId } of due) {
    const memberships = await prisma.workspaceMember.findMany({
      where: { userId },
      include: { workspace: { include: { members: { select: { role: true } }, subscription: true } } },
    });
    const soleOwnerOfShared = memberships.find(
      (m) =>
        m.role === 'OWNER' &&
        m.workspace.members.length > 1 &&
        m.workspace.members.filter((x) => x.role === 'OWNER').length <= 1,
    );
    const soloWorkspaces = memberships
      .filter((m) => m.workspace.members.length === 1)
      .map((m) => m.workspace);
    const paid = soloWorkspaces.find(
      (w) =>
        w.subscription &&
        (w.subscription.provider === 'STRIPE' || w.subscription.provider === 'RAZORPAY') &&
        w.subscription.status !== 'CANCELED',
    );
    const reason = soleOwnerOfShared
      ? `You are the only owner of "${soleOwnerOfShared.workspace.name}", which has other members. Transfer ownership so your account can be deleted.`
      : paid
        ? `"${paid.name}" still has an active paid subscription. Cancel it in Billing so your account can be deleted.`
        : null;

    if (reason) {
      result.deferred.push({ id: userId, reason });
      const recent = await prisma.notification.findFirst({
        where: {
          userId,
          type: 'account_deletion_blocked',
          createdAt: { gt: new Date(now.getTime() - 7 * DAY_MS) },
        },
        select: { id: true },
      });
      if (!recent)
        await createNotification(prisma, userId, {
          type: 'account_deletion_blocked',
          title: 'Your account deletion is on hold',
          body: reason,
          link: '/app/settings',
        });
      continue;
    }

    const workspaceIds = soloWorkspaces.map((w) => w.id);
    await removeReportFiles(prisma, { workspaceId: { in: workspaceIds } });
    await prisma.$transaction([
      prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } }),
      // Delivery records hold the recipient address and have no foreign key, so remove them explicitly.
      prisma.emailDelivery.deleteMany({ where: { userId } }),
      prisma.user.delete({ where: { id: userId } }),
    ]);
    await recordAuditLog(prisma, {
      action: 'user.deleted',
      targetType: 'User',
      targetId: userId,
      metadata: { reason: 'deletion_grace_period_elapsed', workspacesDeleted: workspaceIds.length },
    });
    result.deleted += 1;
  }
  if (result.deleted || result.deferred.length)
    deps.logger.info(
      { deleted: result.deleted, deferred: result.deferred.length },
      'Account deletions processed',
    );
  return result;
}
