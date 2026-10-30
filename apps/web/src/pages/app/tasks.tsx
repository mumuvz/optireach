import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ClipboardList, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import {
  OPEN_TASK_STATUSES,
  TASK_PRIORITIES,
  TASK_STATUSES,
  TASK_STATUS_LABELS,
  TASK_TYPES,
  TASK_TYPE_LABELS,
  type TaskDto,
  type TaskPriority,
  type TaskStatus,
  type TaskType,
  type TimeEntryDto,
} from '@surfaced/shared';
import { useParticipants, useProjects, useWorkspaceId } from '@/app/queries';
import { PageHeader, QueryState } from '@/components/app/page';
import { Badge, StatusBadge, humanize } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/dialog';
import { Alert, EmptyState } from '@/components/ui/feedback';
import { Checkbox, Field, Input, Label, NativeSelect, Textarea } from '@/components/ui/form';
import { Pagination, TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ApiError, api, errorMessage } from '@/lib/api';
import { useCan, useIsClientPortal } from '@/lib/auth';
import { formatDate, formatRelative } from '@/lib/format';

const PRIORITY_TONE = { HIGH: 'danger', MEDIUM: 'warning', LOW: 'neutral' } as const;

function minutesLabel(minutes: number): string {
  if (!minutes) return '—';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? `${h} h${m ? ` ${m} min` : ''}` : `${m} min`;
}

function isOverdue(task: TaskDto): boolean {
  return Boolean(
    task.dueDate &&
    OPEN_TASK_STATUSES.includes(task.status) &&
    task.dueDate < new Date().toISOString().slice(0, 10),
  );
}

export function CreateTaskDialog({
  open,
  onOpenChange,
  defaultProjectId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultProjectId?: string | null;
}) {
  const workspaceId = useWorkspaceId();
  const projects = useProjects();
  const participants = useParticipants();
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    title: '',
    description: '',
    type: 'OTHER' as TaskType,
    priority: 'MEDIUM' as TaskPriority,
    projectId: defaultProjectId ?? '',
    assigneeId: '',
    dueDate: '',
    clientVisible: false,
  });
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) =>
    setForm((f) => ({ ...f, [key]: value }));
  const create = useMutation({
    mutationFn: () =>
      api.post<TaskDto>(
        form.projectId ? `/projects/${form.projectId}/tasks` : `/workspaces/${workspaceId}/tasks`,
        {
          title: form.title,
          description: form.description || undefined,
          type: form.type,
          priority: form.priority,
          assigneeId: form.assigneeId || null,
          dueDate: form.dueDate || null,
          clientVisible: form.clientVisible,
        },
      ),
    onSuccess: () => {
      toast.success('Task created');
      void queryClient.invalidateQueries({ queryKey: ['tasks'] });
      onOpenChange(false);
      setForm((f) => ({ ...f, title: '', description: '', assigneeId: '', dueDate: '' }));
    },
  });
  const fieldError = (name: string) =>
    create.error instanceof ApiError
      ? (create.error.fieldErrors[`body.${name}`] ?? create.error.fieldErrors[name])
      : undefined;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader
          title="New task"
          description="Tasks can belong to a project or to the whole workspace."
        />
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <Field label="Title" error={fieldError('title')}>
            <Input
              value={form.title}
              onChange={(e) => set('title', e.target.value)}
              autoFocus
              maxLength={255}
            />
          </Field>
          <Field label="Details (optional)">
            <Textarea
              rows={3}
              value={form.description}
              onChange={(e) => set('description', e.target.value)}
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Project">
              <NativeSelect value={form.projectId} onChange={(e) => set('projectId', e.target.value)}>
                <option value="">Whole workspace</option>
                {projects.data?.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field label="Area">
              <NativeSelect value={form.type} onChange={(e) => set('type', e.target.value as TaskType)}>
                {TASK_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {TASK_TYPE_LABELS[t]}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field label="Assignee">
              <NativeSelect value={form.assigneeId} onChange={(e) => set('assigneeId', e.target.value)}>
                <option value="">Unassigned</option>
                {participants.data?.map((p) => (
                  <option key={p.userId} value={p.userId}>
                    {p.name}
                    {p.via === 'AGENCY' ? ' (agency)' : p.role === 'CLIENT' ? ' (client)' : ''}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field label="Priority">
              <NativeSelect
                value={form.priority}
                onChange={(e) => set('priority', e.target.value as TaskPriority)}
              >
                {TASK_PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {humanize(p)}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field label="Due date" error={fieldError('dueDate')}>
              <Input type="date" value={form.dueDate} onChange={(e) => set('dueDate', e.target.value)} />
            </Field>
          </div>
          <label className="flex items-start gap-2 text-sm">
            <Checkbox
              checked={form.clientVisible}
              onCheckedChange={(v) => set('clientVisible', v === true)}
            />
            <span>
              Visible to the client
              <span className="block text-xs text-muted-foreground">
                Client users see only tasks marked visible.
              </span>
            </span>
          </label>
          {create.isError && !fieldError('title') && !fieldError('dueDate') ? (
            <Alert tone="danger">{errorMessage(create.error)}</Alert>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={create.isPending} disabled={form.title.trim().length < 2}>
              Create task
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function TaskTable({ rows, showProject = true }: { rows: TaskDto[]; showProject?: boolean }) {
  return (
    <Table>
      <THead>
        <TR>
          <TH>Task</TH>
          {showProject ? <TH>Project</TH> : null}
          <TH>Assignee</TH>
          <TH>Due</TH>
          <TH>Status</TH>
        </TR>
      </THead>
      <TBody>
        {rows.map((t) => (
          <TR key={t.id}>
            <TD>
              <Link to={`/app/tasks/${t.id}`} className="font-medium hover:text-primary">
                {t.title}
              </Link>
              <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                {TASK_TYPE_LABELS[t.type] ?? humanize(t.type)}
                <Badge tone={PRIORITY_TONE[t.priority]}>{humanize(t.priority)}</Badge>
                {t.clientVisible ? <Badge tone="info">Client</Badge> : null}
              </span>
            </TD>
            {showProject ? <TD className="text-sm">{t.projectName ?? 'Workspace'}</TD> : null}
            <TD className="text-sm">
              {t.assignee?.name ?? <span className="text-muted-foreground">Unassigned</span>}
            </TD>
            <TD className={isOverdue(t) ? 'text-sm font-medium text-red-600' : 'text-sm'}>
              {t.dueDate ? formatDate(t.dueDate) : '—'}
              {isOverdue(t) ? <span className="block text-xs">Overdue</span> : null}
            </TD>
            <TD>
              <StatusBadge status={t.status} label={TASK_STATUS_LABELS[t.status]} />
            </TD>
          </TR>
        ))}
      </TBody>
    </Table>
  );
}

export function TasksPage() {
  const workspaceId = useWorkspaceId();
  const canManage = useCan('task.manage');
  const isClient = useIsClientPortal();
  const projects = useProjects();
  const [tab, setTab] = useState<'mine' | 'workspace'>(isClient ? 'workspace' : 'mine');
  const [statusGroup, setStatusGroup] = useState<'open' | 'done' | 'all'>('open');
  const [type, setType] = useState('');
  const [projectId, setProjectId] = useState('');
  const [page, setPage] = useState(1);
  const [createOpen, setCreateOpen] = useState(false);
  const status =
    statusGroup === 'open' ? OPEN_TASK_STATUSES.join(',') : statusGroup === 'done' ? 'DONE' : undefined;
  const query = useQuery({
    queryKey: ['tasks', tab, workspaceId, statusGroup, type, projectId, page],
    queryFn: () =>
      api.page<TaskDto>(tab === 'mine' ? '/tasks' : `/workspaces/${workspaceId}/tasks`, {
        status,
        type: type || undefined,
        projectId: projectId || undefined,
        page,
        pageSize: 25,
      }),
    enabled: tab === 'mine' || Boolean(workspaceId),
    placeholderData: keepPreviousData,
  });
  return (
    <>
      <PageHeader
        title="Tasks"
        description={
          isClient
            ? 'Work your agency shared with you, including items they need from you.'
            : 'Assignable work across projects: content, local SEO, Merchant Center, outreach and strategy.'
        }
        actions={
          canManage ? (
            <Button onClick={() => setCreateOpen(true)}>
              <Plus /> New task
            </Button>
          ) : null
        }
      />
      <Tabs
        value={tab}
        onValueChange={(v) => {
          setTab(v as 'mine' | 'workspace');
          setPage(1);
        }}
      >
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
          {isClient ? (
            <span />
          ) : (
            <TabsList>
              <TabsTrigger value="mine">Assigned to me</TabsTrigger>
              <TabsTrigger value="workspace">This workspace</TabsTrigger>
            </TabsList>
          )}
          <div className="flex flex-wrap items-end gap-2">
            <div className="grid gap-1">
              <Label htmlFor="task-status" className="text-xs">
                Status
              </Label>
              <NativeSelect
                id="task-status"
                className="h-9 w-32"
                value={statusGroup}
                onChange={(e) => {
                  setStatusGroup(e.target.value as 'open' | 'done' | 'all');
                  setPage(1);
                }}
              >
                <option value="open">Open</option>
                <option value="done">Done</option>
                <option value="all">All</option>
              </NativeSelect>
            </div>
            <div className="grid gap-1">
              <Label htmlFor="task-type" className="text-xs">
                Area
              </Label>
              <NativeSelect
                id="task-type"
                className="h-9 w-44"
                value={type}
                onChange={(e) => {
                  setType(e.target.value);
                  setPage(1);
                }}
              >
                <option value="">All areas</option>
                {TASK_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {TASK_TYPE_LABELS[t]}
                  </option>
                ))}
              </NativeSelect>
            </div>
            {tab === 'workspace' ? (
              <div className="grid gap-1">
                <Label htmlFor="task-project" className="text-xs">
                  Project
                </Label>
                <NativeSelect
                  id="task-project"
                  className="h-9 w-44"
                  value={projectId}
                  onChange={(e) => {
                    setProjectId(e.target.value);
                    setPage(1);
                  }}
                >
                  <option value="">All projects</option>
                  {projects.data?.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </NativeSelect>
              </div>
            ) : null}
          </div>
        </div>
      </Tabs>
      <Card>
        <QueryState query={query}>
          {(data) =>
            data.items.length ? (
              <>
                <TaskTable rows={data.items} />
                <Pagination meta={data.meta} onPage={setPage} />
              </>
            ) : (
              <CardContent>
                <EmptyState
                  icon={ClipboardList}
                  title={tab === 'mine' ? 'No tasks assigned to you' : 'No tasks match these filters'}
                  description="Create tasks from recommendations, approvals or here, and assign them to the team."
                />
              </CardContent>
            )
          }
        </QueryState>
      </Card>
      {canManage ? <CreateTaskDialog open={createOpen} onOpenChange={setCreateOpen} /> : null}
    </>
  );
}

export function TaskDetailPage() {
  const { taskId } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const canManage = useCan('task.manage');
  const participants = useParticipants();
  const [minutes, setMinutes] = useState('30');
  const [workDate, setWorkDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [note, setNote] = useState('');
  const task = useQuery({
    queryKey: ['task', taskId],
    queryFn: () => api.get<TaskDto & { timeEntries: TimeEntryDto[] }>(`/tasks/${taskId}`),
    enabled: Boolean(taskId),
  });
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['task', taskId] });
    void queryClient.invalidateQueries({ queryKey: ['tasks'] });
  };
  const update = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.patch<TaskDto>(`/tasks/${taskId}`, body),
    onSuccess: refresh,
    onError: (e) => toast.error(errorMessage(e)),
  });
  const logTime = useMutation({
    mutationFn: () =>
      api.post(`/tasks/${taskId}/time`, { minutes: Number(minutes), workDate, note: note || undefined }),
    onSuccess: () => {
      toast.success('Time logged');
      setNote('');
      refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const removeEntry = useMutation({
    mutationFn: (entryId: string) => api.delete(`/tasks/${taskId}/time/${entryId}`),
    onSuccess: refresh,
    onError: (e) => toast.error(errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: () => api.delete(`/tasks/${taskId}`),
    onSuccess: () => {
      toast.success('Task deleted');
      void queryClient.invalidateQueries({ queryKey: ['tasks'] });
      void navigate('/app/tasks');
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <QueryState query={task} rows={6}>
      {(t) => (
        <>
          <PageHeader
            title={t.title}
            breadcrumbs={[{ label: 'Tasks', to: '/app/tasks' }, { label: t.projectName ?? 'Workspace' }]}
            description={`${TASK_TYPE_LABELS[t.type] ?? humanize(t.type)} · created ${formatRelative(t.createdAt)}${t.createdBy ? ` by ${t.createdBy.name}` : ''}`}
            actions={<StatusBadge status={t.status} label={TASK_STATUS_LABELS[t.status]} />}
          />
          <div className="grid gap-5 lg:grid-cols-[1fr_20rem]">
            <div className="space-y-5">
              <Card>
                <CardContent className="pt-5">
                  <h2 className="mb-2 text-sm font-semibold">Details</h2>
                  <p className="text-sm whitespace-pre-wrap">
                    {t.description || <span className="text-muted-foreground">No details.</span>}
                  </p>
                  {t.entityType ? (
                    <p className="mt-3 text-xs text-muted-foreground">Linked to {humanize(t.entityType)}.</p>
                  ) : null}
                </CardContent>
              </Card>
              {canManage ? (
                <Card>
                  <CardContent className="space-y-4 pt-5">
                    <div className="flex items-center justify-between">
                      <h2 className="text-sm font-semibold">Time</h2>
                      <span className="text-sm text-muted-foreground">
                        Total {minutesLabel(t.minutesLogged)}
                      </span>
                    </div>
                    <form
                      className="grid gap-3 sm:grid-cols-[6rem_10rem_1fr_auto] sm:items-end"
                      onSubmit={(e) => {
                        e.preventDefault();
                        logTime.mutate();
                      }}
                    >
                      <Field label="Minutes">
                        <Input
                          type="number"
                          min={1}
                          max={1440}
                          value={minutes}
                          onChange={(e) => setMinutes(e.target.value)}
                        />
                      </Field>
                      <Field label="Date">
                        <Input type="date" value={workDate} onChange={(e) => setWorkDate(e.target.value)} />
                      </Field>
                      <Field label="Note">
                        <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
                      </Field>
                      <Button type="submit" loading={logTime.isPending}>
                        Log time
                      </Button>
                    </form>
                    {t.timeEntries.length ? (
                      <ul className="divide-y divide-border text-sm">
                        {t.timeEntries.map((e) => (
                          <li key={e.id} className="flex items-center justify-between gap-3 py-2">
                            <span>
                              {minutesLabel(e.minutes)} · {formatDate(e.workDate)} ·{' '}
                              {e.user?.name ?? 'Former member'}
                              {e.note ? (
                                <span className="block text-xs text-muted-foreground">{e.note}</span>
                              ) : null}
                            </span>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              aria-label="Delete time entry"
                              onClick={() => removeEntry.mutate(e.id)}
                            >
                              <Trash2 />
                            </Button>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        No time logged yet. Logged time feeds service margins.
                      </p>
                    )}
                  </CardContent>
                </Card>
              ) : null}
            </div>
            <Card>
              <CardContent className="space-y-4 pt-5">
                <fieldset disabled={!canManage || update.isPending} className="space-y-4">
                  <div className="grid gap-1.5">
                    <Label htmlFor="task-status-edit">Status</Label>
                    <NativeSelect
                      id="task-status-edit"
                      value={t.status}
                      onChange={(e) => update.mutate({ status: e.target.value as TaskStatus })}
                    >
                      {TASK_STATUSES.map((s) => (
                        <option key={s} value={s}>
                          {TASK_STATUS_LABELS[s]}
                        </option>
                      ))}
                    </NativeSelect>
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="task-assignee-edit">Assignee</Label>
                    <NativeSelect
                      id="task-assignee-edit"
                      value={t.assignee?.id ?? ''}
                      onChange={(e) => update.mutate({ assigneeId: e.target.value || null })}
                    >
                      <option value="">Unassigned</option>
                      {participants.data?.map((p) => (
                        <option key={p.userId} value={p.userId}>
                          {p.name}
                          {p.via === 'AGENCY' ? ' (agency)' : p.role === 'CLIENT' ? ' (client)' : ''}
                        </option>
                      ))}
                    </NativeSelect>
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="task-priority-edit">Priority</Label>
                    <NativeSelect
                      id="task-priority-edit"
                      value={t.priority}
                      onChange={(e) => update.mutate({ priority: e.target.value })}
                    >
                      {TASK_PRIORITIES.map((p) => (
                        <option key={p} value={p}>
                          {humanize(p)}
                        </option>
                      ))}
                    </NativeSelect>
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="task-due-edit">Due date</Label>
                    <Input
                      id="task-due-edit"
                      type="date"
                      value={t.dueDate ?? ''}
                      onChange={(e) => update.mutate({ dueDate: e.target.value || null })}
                    />
                  </div>
                  <label className="flex items-start gap-2 text-sm">
                    <Checkbox
                      checked={t.clientVisible}
                      onCheckedChange={(v) => update.mutate({ clientVisible: v === true })}
                    />
                    <span>Visible to the client</span>
                  </label>
                </fieldset>
                {t.completedAt ? (
                  <p className="text-xs text-muted-foreground">Completed {formatRelative(t.completedAt)}.</p>
                ) : null}
                {canManage ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-red-600"
                    loading={remove.isPending}
                    onClick={() => remove.mutate()}
                  >
                    <Trash2 /> Delete task
                  </Button>
                ) : null}
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </QueryState>
  );
}

export default TasksPage;
