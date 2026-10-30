// Session state for the SPA. The session itself is an HTTP-only cookie; the client only knows
// what /auth/me returns. A 401 from any authenticated request clears the cached session and
// sends the user to the login page with a safe "next" path.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Navigate, Outlet, useLocation, useNavigate } from 'react-router';
import { can, canDecideApproval, type MeDto, type MembershipDto, type Permission } from '@surfaced/shared';
import { Spinner } from '@/components/ui/feedback';
import { api, ApiError, setUnauthenticatedHandler } from './api';

export const ME_KEY = ['me'] as const;

export function useMe() {
  return useQuery({
    queryKey: ME_KEY,
    queryFn: async (): Promise<MeDto | null> => {
      try {
        return await api.get<MeDto>('/auth/me', undefined, { silent401: true });
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) return null;
        throw error;
      }
    },
    staleTime: 60_000,
  });
}

/** Membership of the current workspace (role drives what the UI offers; the API enforces it). */
export function useCurrentMembership(): MembershipDto | null {
  const { data } = useMe();
  if (!data) return null;
  return (
    data.memberships.find((m) => m.workspaceId === data.currentWorkspaceId) ?? data.memberships[0] ?? null
  );
}

/** Whether the current role allows an action. Only hides or disables UI; the API enforces permissions. */
export function useCan(permission: Permission): boolean {
  const membership = useCurrentMembership();
  return membership ? can(membership.role, permission) : false;
}

/**
 * Whether the user may decide approvals in the current workspace: the client's own owners, admins and client
 * users, or an agency the client delegated approvals to. The API enforces the same rule.
 */
export function useApprovalRights(): boolean {
  const membership = useCurrentMembership();
  return membership
    ? canDecideApproval({
        role: membership.role,
        via: membership.via,
        approvalsDelegated: membership.approvalsDelegated,
      })
    : false;
}

/** Client-portal users see a reduced, read-mostly app. */
export function useIsClientPortal(): boolean {
  return useCurrentMembership()?.role === 'CLIENT';
}

/** Accepts only same-site paths ("/app/..."), never protocol-relative or absolute URLs. */
export function safeNextPath(next: string | null | undefined, fallback = '/app'): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return fallback;
  return next;
}

/** True after the first client render; use it for UI that depends on the URL query or browser APIs on prerendered pages. */
export function useHydrated(): boolean {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  return hydrated;
}

/** Registers the global 401 handler; rendered once inside the router. */
export function SessionWatcher() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  useEffect(() => {
    setUnauthenticatedHandler(() => {
      queryClient.setQueryData(ME_KEY, null);
      if (window.location.pathname.startsWith('/app')) {
        const next = `${window.location.pathname}${window.location.search}`;
        void navigate(`/login?next=${encodeURIComponent(next)}&expired=1`, { replace: true });
      }
    });
    return () => setUnauthenticatedHandler(null);
  }, [queryClient, navigate, location.key]);
  return null;
}

export function FullPageSpinner({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="flex min-h-dvh items-center justify-center">
      <Spinner className="size-6" label={label} />
    </div>
  );
}

/** Guards /app routes. */
export function RequireAuth() {
  const me = useMe();
  const location = useLocation();
  if (me.isPending) return <FullPageSpinner />;
  if (me.isError) {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="font-medium">We could not reach the server.</p>
        <p className="text-sm text-muted-foreground">Check your connection, then reload the page.</p>
        <button
          type="button"
          className="text-sm font-medium text-primary underline"
          onClick={() => void me.refetch()}
        >
          Try again
        </button>
      </div>
    );
  }
  if (!me.data)
    return (
      <Navigate to={`/login?next=${encodeURIComponent(`${location.pathname}${location.search}`)}`} replace />
    );
  return <Outlet />;
}

export function RequireAdmin() {
  const me = useMe();
  if (me.data?.user.platformRole !== 'ADMIN') return <Navigate to="/app" replace />;
  return <Outlet />;
}

export function useLogout() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  return useMutation({
    mutationFn: () => api.post('/auth/logout'),
    onSettled: () => {
      queryClient.clear();
      queryClient.setQueryData(ME_KEY, null);
      void navigate('/login', { replace: true });
    },
  });
}
