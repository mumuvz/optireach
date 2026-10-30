// In-app notifications shown in the dashboard header.
import type { WorkspaceRole } from '@surfaced/shared';
import type { Prisma, PrismaClient } from './db';

export interface NotificationInput {
  type: string;
  title: string;
  body?: string;
  /** Relative app path, e.g. "/app/p/<projectId>/audits/<auditId>". */
  link?: string;
  workspaceId?: string | null;
}

export function createNotification(
  prisma: PrismaClient | Prisma.TransactionClient,
  userId: string,
  input: NotificationInput,
) {
  return prisma.notification.create({
    data: {
      userId,
      workspaceId: input.workspaceId ?? null,
      type: input.type.slice(0, 60),
      title: input.title.slice(0, 255),
      body: input.body,
      link: input.link?.slice(0, 500),
    },
  });
}

/** Notifies every member of a workspace (optionally limited to some roles). Returns the user ids notified. */
export async function notifyWorkspace(
  prisma: PrismaClient,
  workspaceId: string,
  input: Omit<NotificationInput, 'workspaceId'>,
  roles?: WorkspaceRole[],
): Promise<string[]> {
  const members = await prisma.workspaceMember.findMany({
    where: { workspaceId, ...(roles ? { role: { in: roles } } : {}), user: { disabledAt: null } },
    select: { userId: true },
  });
  if (members.length === 0) return [];
  await prisma.notification.createMany({
    data: members.map((m) => ({
      userId: m.userId,
      workspaceId,
      type: input.type.slice(0, 60),
      title: input.title.slice(0, 255),
      body: input.body ?? null,
      link: input.link?.slice(0, 500) ?? null,
    })),
  });
  return members.map((m) => m.userId);
}
