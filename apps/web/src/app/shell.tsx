import { useMutation } from '@tanstack/react-query';
import {
  Bell,
  BookOpen,
  Building2,
  Check,
  ChevronsLeft,
  ChevronsRight,
  ChevronsUpDown,
  ClipboardList,
  CreditCard,
  FileBarChart,
  FileText,
  FolderKanban,
  KeyRound,
  LayoutDashboard,
  ListChecks,
  LogOut,
  MapPin,
  MapPinned,
  MessageCircleQuestion,
  MessageSquarePlus,
  MessageSquareText,
  Menu,
  Plug,
  Plus,
  Radar,
  Scale,
  ScanSearch,
  Settings,
  Shield,
  ShieldCheck,
  ShoppingBag,
  Store,
  Swords,
  Target,
  TrendingUp,
  User,
  type LucideIcon,
} from 'lucide-react';
import { ROLE_LABELS, can, type Permission } from '@surfaced/shared';
import { Dialog as RadixDialog } from 'radix-ui';
import { Suspense, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useMatch, useNavigate } from 'react-router';
import { toast } from 'sonner';
import { LogoMark } from '@/components/brand/logo';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { SheetContent } from '@/components/ui/dialog';
import { Alert, LoadingBlock, Spinner } from '@/components/ui/feedback';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/menu';
import { api, errorMessage } from '@/lib/api';
import { useCurrentMembership, useLogout, useMe } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { formatDate, formatRelative } from '@/lib/format';
import { getLastProject, readFlag, writeFlag } from './last-project';
import {
  useMarkNotifications,
  useNotifications,
  usePlanLimits,
  useProjects,
  useSwitchWorkspace,
  useWorkspace,
  useWorkspaceId,
} from './queries';

interface NavItem {
  label: string;
  icon: LucideIcon;
  /** Path under /app/p/:projectId (project-scoped) or an absolute app path. */
  project?: string;
  to?: string;
  end?: boolean;
  /** Shown to client-portal (Client role) users. */
  client?: boolean;
  /** Hidden unless the current role has this permission. */
  permission?: Permission;
  /** Only for workspaces that can manage clients (agency plans and the service provider). */
  agency?: boolean;
}

interface NavGroup {
  label: string | null;
  items: NavItem[];
}

const NAV: NavGroup[] = [
  {
    label: null,
    items: [
      { label: 'Overview', icon: LayoutDashboard, project: '', end: true, client: true },
      { label: 'Projects', icon: FolderKanban, to: '/app/projects' },
    ],
  },
  {
    label: 'Local',
    items: [
      { label: 'Local visibility', icon: MapPin, project: '/local', end: true, client: true },
      { label: 'Rank tracker', icon: MapPinned, project: '/local/rank' },
      { label: 'Business Profile', icon: MessageSquareText, project: '/local/profile' },
      { label: 'Profile posts', icon: MessageSquarePlus, project: '/local/posts' },
      { label: 'Merchant Center', icon: ShoppingBag, project: '/local/merchant' },
      { label: 'Locations', icon: Store, project: '/locations' },
    ],
  },
  {
    label: 'SEO',
    items: [
      { label: 'Website Audit', icon: ScanSearch, project: '/audits' },
      { label: 'SEO comparison', icon: Scale, project: '/seo-comparison' },
      { label: 'Keyword Research', icon: KeyRound, project: '/keywords' },
      { label: 'Keyword trends', icon: TrendingUp, project: '/trends' },
      { label: 'Content Studio', icon: FileText, project: '/content' },
    ],
  },
  {
    label: 'AI',
    items: [
      { label: 'AI Visibility', icon: Radar, project: '/visibility' },
      { label: 'Answerability', icon: MessageCircleQuestion, project: '/answerability' },
      { label: 'Competitor gaps', icon: Target, project: '/gaps' },
    ],
  },
  {
    label: 'Insights',
    items: [
      { label: 'Competitors', icon: Swords, project: '/competitors' },
      { label: 'Recommendations', icon: ListChecks, project: '/recommendations' },
      { label: 'Reports', icon: FileBarChart, project: '/reports', client: true },
    ],
  },
  {
    label: 'Operations',
    items: [
      { label: 'Approvals', icon: ShieldCheck, to: '/app/approvals', client: true },
      { label: 'Tasks', icon: ClipboardList, to: '/app/tasks', client: true },
      {
        label: 'Agency clients',
        icon: Building2,
        to: '/app/agency',
        permission: 'agency.manage',
        agency: true,
      },
    ],
  },
  {
    label: 'Setup',
    items: [
      { label: 'Integrations', icon: Plug, project: '/integrations', permission: 'integration.read' },
      { label: 'Billing', icon: CreditCard, to: '/app/billing', permission: 'billing.read' },
      { label: 'Settings', icon: Settings, to: '/app/settings', client: true },
    ],
  },
];

/** Project in the URL, else the last one opened in this workspace, else the first project. */
export function useActiveProjectId(): string | null {
  const match = useMatch('/app/p/:projectId/*');
  const workspaceId = useWorkspaceId();
  const projects = useProjects();
  const fromUrl = match?.params.projectId ?? null;
  if (fromUrl) return fromUrl;
  const last = getLastProject(workspaceId);
  const list = projects.data ?? [];
  if (last && list.some((p) => p.id === last)) return last;
  return list[0]?.id ?? null;
}

function useNavGroups(): NavGroup[] {
  const me = useMe();
  const membership = useCurrentMembership();
  const workspace = useWorkspace();
  const limits = usePlanLimits();
  const isClient = membership?.role === 'CLIENT';
  const canManageClients =
    membership?.via === 'DIRECT' &&
    (Boolean(workspace.data?.isServiceProvider) || (limits?.clientWorkspaces ?? 0) > 0);
  const groups = NAV.map((group) => ({
    ...group,
    items: group.items.filter(
      (item) =>
        (!isClient || item.client) &&
        (!item.permission || (membership ? can(membership.role, item.permission) : false)) &&
        (!item.agency || canManageClients),
    ),
  })).filter((group) => group.items.length);
  if (me.data?.user.platformRole === 'ADMIN')
    groups.push({ label: 'Platform', items: [{ label: 'Admin', icon: Shield, to: '/app/admin' }] });
  return groups;
}

function SidebarNav({ collapsed, onNavigate }: { collapsed: boolean; onNavigate?: () => void }) {
  const projectId = useActiveProjectId();
  const groups = useNavGroups();
  return (
    <nav aria-label="Dashboard" className="flex-1 overflow-y-auto px-2 py-3">
      {groups.map((group, index) => (
        <div key={group.label ?? 'main'} className={cn(index > 0 && 'mt-3')}>
          {group.label ? (
            collapsed ? (
              <div className="mx-3 mb-2 border-t border-border" aria-hidden />
            ) : (
              <p className="mb-1 px-3 text-[11px] font-semibold tracking-wide text-muted-foreground/80 uppercase">
                {group.label}
              </p>
            )
          ) : null}
          <div className="space-y-0.5">
            <NavItems
              items={group.items}
              projectId={projectId}
              collapsed={collapsed}
              onNavigate={onNavigate}
            />
          </div>
        </div>
      ))}
    </nav>
  );
}

function NavItems({
  items,
  projectId,
  collapsed,
  onNavigate,
}: {
  items: NavItem[];
  projectId: string | null;
  collapsed: boolean;
  onNavigate?: () => void;
}) {
  return (
    <>
      {items.map((item) => {
        const target = item.to ?? (projectId ? `/app/p/${projectId}${item.project}` : null);
        const Icon = item.icon;
        const content = (
          <>
            <Icon className="size-4 shrink-0" aria-hidden />
            <span className={cn('truncate', collapsed && 'sr-only')}>{item.label}</span>
          </>
        );
        if (!target) {
          return (
            <Link
              key={item.label}
              to="/app/projects/new"
              onClick={() => {
                toast.info('Create a project first', { description: `${item.label} works per project.` });
                onNavigate?.();
              }}
              title={collapsed ? item.label : undefined}
              className="flex items-center gap-3 rounded-md px-3 py-2 text-sm text-muted-foreground/70 hover:bg-muted"
            >
              {content}
            </Link>
          );
        }
        return (
          <NavLink
            key={item.label}
            to={target}
            end={item.end}
            onClick={onNavigate}
            title={collapsed ? item.label : undefined}
            className={({ isActive }) =>
              cn(
                'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                isActive
                  ? 'bg-accent text-accent-foreground'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                collapsed && 'justify-center px-2',
              )
            }
          >
            {content}
          </NavLink>
        );
      })}
    </>
  );
}

function WorkspaceSwitcher({ collapsed }: { collapsed: boolean }) {
  const me = useMe();
  const workspace = useWorkspace();
  const switcher = useSwitchWorkspace();
  const navigate = useNavigate();
  const current = workspace.data;
  const memberships = me.data?.memberships ?? [];
  if (collapsed) {
    return (
      <div className="flex justify-center py-3">
        <Link to="/app" aria-label="Dashboard home">
          <LogoMark />
        </Link>
      </div>
    );
  }
  return (
    <div className="px-3 pt-3">
      <Link to="/app" className="mb-3 flex items-center gap-2 px-1 font-semibold tracking-tight">
        <LogoMark className="size-6" /> Surfaced
      </Link>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-lg border border-border bg-card px-2.5 py-2 text-left hover:bg-muted"
          >
            <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-xs font-semibold text-primary">
              {current?.name.slice(0, 1).toUpperCase() ?? '·'}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{current?.name ?? 'Workspace'}</span>
              <span className="block text-xs text-muted-foreground">{current?.plan.name ?? '…'} plan</span>
            </span>
            <ChevronsUpDown className="size-4 text-muted-foreground" aria-hidden />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-[70vh] w-72 overflow-y-auto">
          {(['DIRECT', 'AGENCY'] as const).map((via) => {
            const group = memberships.filter((m) => m.via === via);
            if (!group.length) return null;
            return (
              <div key={via}>
                <DropdownMenuLabel>
                  {via === 'DIRECT' ? 'Your workspaces' : 'Client workspaces'}
                </DropdownMenuLabel>
                {group.map((m) => (
                  <DropdownMenuItem
                    key={m.workspaceId}
                    onSelect={() =>
                      m.workspaceId !== current?.id &&
                      switcher.mutate(m.workspaceId, {
                        onSuccess: () => void navigate('/app'),
                        onError: (e) => toast.error(errorMessage(e)),
                      })
                    }
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{m.workspaceName}</span>
                      {via === 'AGENCY' ? (
                        <span className="block truncate text-xs text-muted-foreground">
                          via{' '}
                          {memberships.find((x) => x.workspaceId === m.agencyWorkspaceId)?.workspaceName ??
                            'agency'}
                        </span>
                      ) : null}
                    </span>
                    <span className="text-xs text-muted-foreground">{ROLE_LABELS[m.role]}</span>
                    {m.workspaceId === current?.id ? <Check className="!text-primary" /> : null}
                  </DropdownMenuItem>
                ))}
              </div>
            );
          })}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => void navigate('/app/settings?tab=workspace&create=1')}>
            <Plus /> New workspace
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function ProjectSelector() {
  const projects = useProjects();
  const activeId = useActiveProjectId();
  const navigate = useNavigate();
  const location = useLocation();
  const active = projects.data?.find((p) => p.id === activeId);
  const switchTo = (id: string) => {
    // Keep the current section when switching projects (e.g. stay on AI Visibility).
    const section = /^\/app\/p\/[^/]+\/([^/]+)/.exec(location.pathname)?.[1];
    void navigate(section ? `/app/p/${id}/${section}` : `/app/p/${id}`);
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          className="max-w-[min(18rem,55vw)] justify-between gap-2"
          aria-label="Select project"
        >
          <span className="truncate">
            {projects.isPending ? 'Loading…' : (active?.name ?? 'Select a project')}
          </span>
          {active?.isDemo ? (
            <Badge tone="demo" className="hidden sm:inline-flex">
              Demo
            </Badge>
          ) : null}
          <ChevronsUpDown className="text-muted-foreground" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        <DropdownMenuLabel>Projects</DropdownMenuLabel>
        {projects.data?.length ? (
          projects.data.map((p) => (
            <DropdownMenuItem key={p.id} onSelect={() => switchTo(p.id)}>
              <span className="min-w-0 flex-1">
                <span className="block truncate">{p.name}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {p.domain ?? 'No website'}
                </span>
              </span>
              {p.id === activeId ? <Check className="!text-primary" /> : null}
            </DropdownMenuItem>
          ))
        ) : (
          <p className="px-2 py-1.5 text-sm text-muted-foreground">No projects yet.</p>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void navigate('/app/projects')}>
          <FolderKanban /> All projects
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void navigate('/app/projects/new')}>
          <Plus /> New project
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function NotificationsMenu() {
  const notifications = useNotifications();
  const mark = useMarkNotifications();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const unread = notifications.data?.data.unread ?? 0;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative"
          aria-label={unread ? `Notifications (${unread} unread)` : 'Notifications'}
        >
          <Bell className="size-[18px]" />
          {unread ? (
            <span className="absolute top-1.5 right-1.5 flex size-4 items-center justify-center rounded-full bg-primary text-[10px] font-semibold text-primary-foreground">
              {unread > 9 ? '9+' : unread}
            </span>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[min(92vw,24rem)]">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <p className="text-sm font-semibold">Notifications</p>
          <Button
            variant="link"
            size="sm"
            disabled={!unread || mark.all.isPending}
            onClick={() => mark.all.mutate()}
          >
            Mark all as read
          </Button>
        </div>
        <div className="max-h-[60vh] overflow-y-auto">
          {notifications.isPending ? (
            <LoadingBlock className="p-4" />
          ) : notifications.data?.data.items.length ? (
            <ul className="divide-y divide-border">
              {notifications.data.data.items.map((n) => (
                <li key={n.id}>
                  <button
                    type="button"
                    className={cn(
                      'flex w-full gap-3 px-4 py-3 text-left hover:bg-muted',
                      !n.read && 'bg-accent/40',
                    )}
                    onClick={() => {
                      if (!n.read) mark.one.mutate(n.id);
                      setOpen(false);
                      if (n.link) void navigate(n.link);
                    }}
                  >
                    <span
                      className={cn(
                        'mt-1.5 size-2 shrink-0 rounded-full',
                        n.read ? 'bg-transparent' : 'bg-primary',
                      )}
                      aria-hidden
                    />
                    <span className="min-w-0">
                      <span className="block text-sm font-medium">{n.title}</span>
                      {n.body ? (
                        <span className="mt-0.5 line-clamp-2 block text-[13px] text-muted-foreground">
                          {n.body}
                        </span>
                      ) : null}
                      <span className="mt-1 block text-xs text-muted-foreground">
                        {formatRelative(n.createdAt)}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground">You are all caught up.</p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function UserMenu() {
  const me = useMe();
  const logout = useLogout();
  const navigate = useNavigate();
  const user = me.data?.user;
  const initials = (user?.name ?? '?')
    .split(/\s+/)
    .map((p) => p[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex size-9 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground hover:bg-primary-hover"
          aria-label="Account menu"
        >
          {initials}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-60">
        <div className="px-2 py-1.5">
          <p className="truncate text-sm font-medium">{user?.name}</p>
          <p className="truncate text-xs text-muted-foreground">{user?.email}</p>
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void navigate('/app/settings')}>
          <User /> Account settings
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void navigate('/app/billing')}>
          <CreditCard /> Billing and usage
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => window.open('/api/docs', '_blank', 'noopener')}>
          <BookOpen /> API documentation
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => logout.mutate()} disabled={logout.isPending}>
          <LogOut /> Log out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function AccountBanners() {
  const me = useMe();
  const resend = useMutation({
    mutationFn: () => api.post('/auth/resend-verification'),
    onSuccess: () =>
      toast.success('Verification email sent', { description: 'Check your inbox for the link.' }),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const cancelDeletion = useMutation({
    mutationFn: () => api.delete('/users/me/deletion-request'),
    onSuccess: () => {
      toast.success('Account deletion cancelled');
      void me.refetch();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const user = me.data?.user;
  if (!user || (user.emailVerified && !user.deletionRequestedAt)) return null;
  return (
    <div className="mb-5 space-y-3">
      {user.deletionRequestedAt ? (
        <Alert
          tone="danger"
          title="Your account is scheduled for deletion"
          action={
            <Button
              size="sm"
              variant="outline"
              loading={cancelDeletion.isPending}
              onClick={() => cancelDeletion.mutate()}
            >
              Cancel deletion
            </Button>
          }
        >
          It will be deleted after{' '}
          {formatDate(new Date(new Date(user.deletionRequestedAt).getTime() + 14 * 86_400_000).toISOString())}
          .
        </Alert>
      ) : null}
      {!user.emailVerified ? (
        <Alert
          tone="warning"
          title="Verify your email address"
          action={
            <Button size="sm" variant="outline" loading={resend.isPending} onClick={() => resend.mutate()}>
              Resend email
            </Button>
          }
        >
          We sent a link to {user.email}. Paid plans and some notifications require a verified address.
        </Alert>
      ) : null}
    </div>
  );
}

export function AppShell() {
  const [collapsed, setCollapsed] = useState(() => readFlag('sf:sidebarCollapsed', false));
  const [mobileOpen, setMobileOpen] = useState(false);
  const toggle = () => {
    setCollapsed((c) => {
      writeFlag('sf:sidebarCollapsed', !c);
      return !c;
    });
  };
  return (
    <div className="flex min-h-dvh bg-background">
      <a href="#app-main" className="skip-link">
        Skip to content
      </a>
      <aside
        className={cn(
          'sticky top-0 hidden h-dvh shrink-0 flex-col border-r border-border bg-card transition-[width] lg:flex',
          collapsed ? 'w-16' : 'w-64',
        )}
      >
        <WorkspaceSwitcher collapsed={collapsed} />
        <SidebarNav collapsed={collapsed} />
        <div className="border-t border-border p-2">
          <Button
            variant="ghost"
            size="sm"
            className={cn('w-full', collapsed ? 'justify-center' : 'justify-start')}
            onClick={toggle}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {collapsed ? <ChevronsRight /> : <ChevronsLeft />}
            {collapsed ? null : 'Collapse'}
          </Button>
        </div>
      </aside>
      <RadixDialog.Root open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent side="left" className="w-72 p-0" aria-describedby={undefined}>
          <RadixDialog.Title className="sr-only">Navigation</RadixDialog.Title>
          <WorkspaceSwitcher collapsed={false} />
          <SidebarNav collapsed={false} onNavigate={() => setMobileOpen(false)} />
        </SheetContent>
      </RadixDialog.Root>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-border bg-card/95 px-3 backdrop-blur sm:px-5">
          <Button
            variant="ghost"
            size="icon"
            className="lg:hidden"
            onClick={() => setMobileOpen(true)}
            aria-label="Open navigation"
          >
            <Menu className="size-5" />
          </Button>
          <ProjectSelector />
          <div className="ml-auto flex items-center gap-1.5">
            <NotificationsMenu />
            <UserMenu />
          </div>
        </header>
        <main id="app-main" className="mx-auto w-full max-w-[1400px] flex-1 px-3 py-6 sm:px-6 lg:px-8">
          <AccountBanners />
          <Suspense
            fallback={
              <div className="flex justify-center py-20">
                <Spinner className="size-6" />
              </div>
            }
          >
            <Outlet />
          </Suspense>
        </main>
      </div>
    </div>
  );
}
