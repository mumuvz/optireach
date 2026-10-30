// Shared dashboard queries (workspace, projects, usage, notifications).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  MembershipVia,
  PageMeta,
  ProjectDto,
  ProjectSummaryDto,
  WorkspaceDto,
  WorkspaceRole,
} from '@surfaced/shared';
import { usePlans } from '@/components/marketing/pricing';
import { api } from '@/lib/api';
import { ME_KEY, useMe } from '@/lib/auth';

export function useWorkspaceId(): string | null {
  const { data } = useMe();
  return data?.currentWorkspaceId ?? data?.memberships[0]?.workspaceId ?? null;
}

export function useProjects() {
  const workspaceId = useWorkspaceId();
  return useQuery({
    queryKey: ['projects', workspaceId],
    queryFn: () => api.get<ProjectSummaryDto[]>('/projects', { workspaceId }),
    enabled: Boolean(workspaceId),
  });
}

export function useProjectQuery(projectId: string | undefined) {
  return useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api.get<ProjectDto>(`/projects/${projectId}`),
    enabled: Boolean(projectId),
  });
}

export interface WorkspaceDetail extends WorkspaceDto {
  plan: { key: string; name: string };
}

export function useWorkspace() {
  const workspaceId = useWorkspaceId();
  return useQuery({
    queryKey: ['workspace', workspaceId],
    queryFn: () => api.get<WorkspaceDetail>(`/workspaces/${workspaceId}`),
    enabled: Boolean(workspaceId),
  });
}

/** Limits of the current workspace's plan (from the public plan list). Null while loading. */
export function usePlanLimits() {
  const workspace = useWorkspace();
  const plans = usePlans();
  const plan = plans.data?.plans.find((p) => p.key === workspace.data?.plan.key);
  return workspace.data && plan && !plans.isPlaceholderData ? plan.limits : null;
}

export interface Participant {
  userId: string;
  name: string;
  email: string;
  role: WorkspaceRole;
  via: MembershipVia;
}

/** Everyone who can work in the current workspace (members and the managing agency team), for assignee pickers. */
export function useParticipants(workspaceId?: string | null) {
  const current = useWorkspaceId();
  const id = workspaceId ?? current;
  return useQuery({
    queryKey: ['participants', id],
    queryFn: () => api.get<Participant[]>(`/workspaces/${id}/participants`),
    enabled: Boolean(id),
    staleTime: 60_000,
  });
}

export function useSwitchWorkspace() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (workspaceId: string) => api.post(`/workspaces/${workspaceId}/switch`),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ME_KEY });
      queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== 'me' });
    },
  });
}

export interface UsageSummary {
  periodKey: string;
  plan: { key: string; name: string };
  metrics: { metric: string; label: string; used: number; limit: number | null }[];
  counts: { kind: string; label: string; used: number; limit: number }[];
}

export function useUsage() {
  const workspaceId = useWorkspaceId();
  return useQuery({
    queryKey: ['usage', workspaceId],
    queryFn: () => api.get<UsageSummary>('/usage', { workspaceId }),
    enabled: Boolean(workspaceId),
  });
}

export interface NotificationItem {
  id: string;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  read: boolean;
  createdAt: string;
}

export function useNotifications(pageSize = 8) {
  return useQuery({
    queryKey: ['notifications', pageSize],
    queryFn: () =>
      api.getWithMeta<{ unread: number; items: NotificationItem[] }>('/notifications', { pageSize }),
    refetchInterval: 60_000,
  });
}

export function useMarkNotifications() {
  const queryClient = useQueryClient();
  const done = () => queryClient.invalidateQueries({ queryKey: ['notifications'] });
  return {
    one: useMutation({ mutationFn: (id: string) => api.post(`/notifications/${id}/read`), onSuccess: done }),
    all: useMutation({ mutationFn: () => api.post('/notifications/read-all'), onSuccess: done }),
  };
}

export type { PageMeta };
