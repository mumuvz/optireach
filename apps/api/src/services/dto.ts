import type { AccessibleWorkspace } from '@surfaced/core/access';
import type { User, Workspace } from '@surfaced/core/db';
import {
  DEFAULT_NOTIFICATION_PREFS,
  notificationPrefsSchema,
  type MembershipDto,
  type MembershipVia,
  type NotificationPrefs,
  type UserDto,
  type WorkspaceDto,
  type WorkspaceRole,
} from '@surfaced/shared';

export function readNotificationPrefs(raw: unknown): NotificationPrefs {
  const parsed = notificationPrefsSchema.partial().safeParse(raw ?? {});
  return { ...DEFAULT_NOTIFICATION_PREFS, ...(parsed.success ? parsed.data : {}) };
}

export function toUserDto(user: User): UserDto {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    emailVerified: Boolean(user.emailVerifiedAt),
    platformRole: user.platformRole,
    notificationPrefs: readNotificationPrefs(user.notificationPrefs),
    deletionRequestedAt: user.deletionRequestedAt?.toISOString() ?? null,
    createdAt: user.createdAt.toISOString(),
  };
}

export function toMembershipDto(access: AccessibleWorkspace): MembershipDto {
  return {
    workspaceId: access.workspaceId,
    workspaceName: access.workspace.name,
    workspaceSlug: access.workspace.slug,
    role: access.role,
    via: access.via,
    agencyWorkspaceId: access.agencyWorkspaceId,
    approvalsDelegated: access.approvalsDelegated,
  };
}

export function toWorkspaceDto(
  workspace: Workspace,
  role: WorkspaceRole,
  via: MembershipVia = 'DIRECT',
): WorkspaceDto {
  const whiteLabel = (workspace.whiteLabel ?? null) as WorkspaceDto['whiteLabel'];
  return {
    id: workspace.id,
    name: workspace.name,
    slug: workspace.slug,
    role,
    via,
    isServiceProvider: workspace.isServiceProvider,
    whiteLabel,
    createdAt: workspace.createdAt.toISOString(),
  };
}
