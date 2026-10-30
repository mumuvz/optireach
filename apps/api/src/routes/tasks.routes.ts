import { listAccessibleWorkspaces, resolveMembership } from '@surfaced/core/access';
import type { Prisma, PrismaClient, Task } from '@surfaced/core/db';
import { Errors } from '@surfaced/core/errors';
import { emitEvent } from '@surfaced/core/events';
import { createNotification } from '@surfaced/core/notifications';
import {
  can,
  idSchema,
  taskCreateSchema,
  taskListQuerySchema,
  taskUpdateSchema,
  timeEntryCreateSchema,
  type TaskDto,
  type TaskListQuery,
  type TaskType,
  type TimeEntryDto,
  type WorkspaceRole,
} from '@surfaced/shared';
import { z } from 'zod';
import { created, iso, noContent, ok, pageMeta, paginate } from '../lib/http';
import { route, type AnyRoute } from '../lib/router';
import { requireProjectAccess, requireWorkspaceAccess } from '../services/access';
import type { AppDeps, AuthUser } from '../types';

const taskInclude = {
  project: { select: { name: true } },
  assignee: { select: { id: true, name: true } },
  createdBy: { select: { id: true, name: true } },
} satisfies Prisma.TaskInclude;

type TaskRow = Task & {
  project: { name: string } | null;
  assignee: { id: string; name: string } | null;
  createdBy: { id: string; name: string } | null;
};

function toTaskDto(row: TaskRow, minutesLogged: number): TaskDto {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    projectName: row.project?.name ?? null,
    type: row.type as TaskType,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    assignee: row.assignee,
    dueDate: row.dueDate ? row.dueDate.toISOString().slice(0, 10) : null,
    periodKey: row.periodKey,
    clientVisible: row.clientVisible,
    entityType: row.entityType,
    entityId: row.entityId,
    createdBy: row.createdBy,
    completedAt: iso(row.completedAt),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    minutesLogged,
  };
}

async function minutesByTask(prisma: PrismaClient, taskIds: string[]): Promise<Map<string, number>> {
  if (!taskIds.length) return new Map();
  const grouped = await prisma.taskTimeEntry.groupBy({
    by: ['taskId'],
    where: { taskId: { in: taskIds } },
    _sum: { minutes: true },
  });
  return new Map(grouped.map((g) => [g.taskId, g._sum.minutes ?? 0]));
}

/**
 * Records a task may point to, with the check that the record belongs to the same workspace. Later modules add
 * their own types here.
 */
const LINKABLE: Record<string, (db: PrismaClient, id: string) => Promise<string | null>> = {
  Recommendation: async (db, id) =>
    (
      await db.recommendation.findUnique({
        where: { id },
        select: { project: { select: { workspaceId: true } } },
      })
    )?.project.workspaceId ?? null,
  AuditIssue: async (db, id) =>
    (
      await db.auditIssue.findUnique({
        where: { id },
        select: { project: { select: { workspaceId: true } } },
      })
    )?.project.workspaceId ?? null,
  ContentDocument: async (db, id) =>
    (
      await db.contentDocument.findUnique({
        where: { id },
        select: { project: { select: { workspaceId: true } } },
      })
    )?.project.workspaceId ?? null,
  ContentBrief: async (db, id) =>
    (
      await db.contentBrief.findUnique({
        where: { id },
        select: { project: { select: { workspaceId: true } } },
      })
    )?.project.workspaceId ?? null,
  ApprovalRequest: async (db, id) =>
    (await db.approvalRequest.findUnique({ where: { id }, select: { workspaceId: true } }))?.workspaceId ??
    null,
};

export function taskRoutes(deps: AppDeps): { project: AnyRoute[]; workspace: AnyRoute[]; tasks: AnyRoute[] } {
  const { prisma } = deps;
  const tags = ['Tasks'];

  function listWhere(query: TaskListQuery, userId: string): Prisma.TaskWhereInput {
    return {
      ...(query.projectId ? { projectId: query.projectId } : {}),
      ...(query.status ? { status: { in: query.status } } : {}),
      ...(query.type ? { type: { in: query.type } } : {}),
      ...(query.assignee === 'me'
        ? { assigneeId: userId }
        : query.assignee === 'none'
          ? { assigneeId: null }
          : query.assignee
            ? { assigneeId: query.assignee }
            : {}),
      ...(query.dueBefore ? { dueDate: { lte: query.dueBefore } } : {}),
      ...(query.periodKey ? { periodKey: query.periodKey } : {}),
      ...(query.q ? { title: { contains: query.q } } : {}),
    };
  }

  async function listTasks(where: Prisma.TaskWhereInput, query: TaskListQuery) {
    const [total, rows] = await Promise.all([
      prisma.task.count({ where }),
      prisma.task.findMany({
        where,
        include: taskInclude,
        orderBy: [{ status: 'asc' }, { dueDate: 'asc' }, { createdAt: 'desc' }],
        ...paginate(query.page, query.pageSize),
      }),
    ]);
    const minutes = await minutesByTask(
      prisma,
      rows.map((r) => r.id),
    );
    return ok(
      rows.map((r) => toTaskDto(r, minutes.get(r.id) ?? 0)),
      pageMeta(query.page, query.pageSize, total),
    );
  }

  /** Client-role users only see tasks marked visible to the client. */
  const clientFilter = (role: WorkspaceRole): Prisma.TaskWhereInput =>
    role === 'CLIENT' ? { clientVisible: true } : {};

  async function validateAssignee(workspaceId: string, assigneeId: string | null | undefined) {
    if (!assigneeId) return null;
    const membership = await resolveMembership(prisma, assigneeId, workspaceId);
    if (!membership) throw Errors.badRequest('The assignee must be able to access this workspace.');
    return membership;
  }

  async function validateLink(workspaceId: string, entityType?: string, entityId?: string) {
    if (!entityType && !entityId) return;
    if (!entityType || !entityId) throw Errors.badRequest('Provide both entityType and entityId.');
    const resolve = LINKABLE[entityType];
    if (!resolve) throw Errors.badRequest(`Tasks cannot be linked to ${entityType} records.`);
    if ((await resolve(prisma, entityId)) !== workspaceId)
      throw Errors.badRequest('The linked record was not found.');
  }

  async function createTask(
    user: AuthUser,
    workspaceId: string,
    projectId: string | null,
    body: z.output<typeof taskCreateSchema>,
  ) {
    const assignee = await validateAssignee(workspaceId, body.assigneeId);
    await validateLink(workspaceId, body.entityType, body.entityId);
    const task = await prisma.task.create({
      data: {
        workspaceId,
        projectId,
        type: body.type,
        title: body.title,
        description: body.description ?? null,
        status: body.status,
        priority: body.priority,
        assigneeId: body.assigneeId ?? null,
        dueDate: body.dueDate ?? null,
        periodKey: body.periodKey ?? null,
        // Work assigned to a client is always visible to them.
        clientVisible: body.clientVisible || assignee?.role === 'CLIENT',
        entityType: body.entityType ?? null,
        entityId: body.entityId ?? null,
        createdById: user.id,
        completedAt: body.status === 'DONE' ? new Date() : null,
      },
      include: taskInclude,
    });
    if (task.assigneeId && task.assigneeId !== user.id)
      await createNotification(prisma, task.assigneeId, {
        workspaceId,
        type: 'task_assigned',
        title: `Task assigned to you: ${task.title}`,
        link: `/app/tasks/${task.id}`,
      });
    await emitEvent(prisma, {
      workspaceId,
      projectId,
      type: 'task.created',
      entityType: 'Task',
      entityId: task.id,
      actorUserId: user.id,
      data: { type: task.type, status: task.status },
    });
    return created(toTaskDto(task, 0));
  }

  async function loadTask(user: AuthUser, taskId: string, permission: 'task.read' | 'task.manage') {
    const task = await prisma.task.findUnique({ where: { id: taskId }, include: taskInclude });
    if (!task) throw Errors.notFound('Task');
    const access = await requireWorkspaceAccess(prisma, user, task.workspaceId, permission);
    if (access.role === 'CLIENT' && !task.clientVisible) throw Errors.notFound('Task');
    return { task, access };
  }

  const project: AnyRoute[] = [
    route({
      method: 'get',
      path: '/:projectId/tasks',
      summary: 'Tasks for a project',
      tags,
      auth: 'user',
      params: z.object({ projectId: idSchema }),
      query: taskListQuerySchema,
      handler: async ({ user, params, query }) => {
        const { role } = await requireProjectAccess(prisma, user, params.projectId, 'task.read');
        return listTasks(
          { ...listWhere(query, user.id), projectId: params.projectId, ...clientFilter(role) },
          query,
        );
      },
    }),
    route({
      method: 'post',
      path: '/:projectId/tasks',
      summary: 'Create a task for a project',
      tags,
      auth: 'user',
      params: z.object({ projectId: idSchema }),
      body: taskCreateSchema,
      successStatus: 201,
      handler: async ({ user, params, body }) => {
        const { project: p } = await requireProjectAccess(prisma, user, params.projectId, 'task.manage');
        return createTask(user, p.workspaceId, p.id, body);
      },
    }),
  ];

  const workspace: AnyRoute[] = [
    route({
      method: 'get',
      path: '/:workspaceId/tasks',
      summary: 'Tasks across a workspace (project and workspace-level)',
      tags,
      auth: 'user',
      params: z.object({ workspaceId: idSchema }),
      query: taskListQuerySchema,
      handler: async ({ user, params, query }) => {
        const { role } = await requireWorkspaceAccess(prisma, user, params.workspaceId, 'task.read');
        return listTasks(
          { ...listWhere(query, user.id), workspaceId: params.workspaceId, ...clientFilter(role) },
          query,
        );
      },
    }),
    route({
      method: 'post',
      path: '/:workspaceId/tasks',
      summary: 'Create a workspace-level task',
      tags,
      auth: 'user',
      params: z.object({ workspaceId: idSchema }),
      body: taskCreateSchema,
      successStatus: 201,
      handler: async ({ user, params, body }) => {
        await requireWorkspaceAccess(prisma, user, params.workspaceId, 'task.manage');
        return createTask(user, params.workspaceId, null, body);
      },
    }),
  ];

  const tasks: AnyRoute[] = [
    route({
      method: 'get',
      path: '/',
      summary: 'My work: tasks across every workspace I can reach (assigned to me by default)',
      tags,
      auth: 'user',
      query: taskListQuerySchema,
      handler: async ({ user, query }) => {
        const accessible = (await listAccessibleWorkspaces(prisma, user.id)).filter((w) =>
          can(w.role, 'task.read'),
        );
        const scoped = query.workspaceId
          ? accessible.filter((w) => w.workspaceId === query.workspaceId)
          : accessible;
        const teamIds = scoped.filter((w) => w.role !== 'CLIENT').map((w) => w.workspaceId);
        const clientIds = scoped.filter((w) => w.role === 'CLIENT').map((w) => w.workspaceId);
        const effective = { ...query, assignee: query.assignee ?? 'me' };
        return listTasks(
          {
            ...listWhere(effective, user.id),
            OR: [{ workspaceId: { in: teamIds } }, { workspaceId: { in: clientIds }, clientVisible: true }],
          },
          effective,
        );
      },
    }),
    route({
      method: 'get',
      path: '/:taskId',
      summary: 'Task detail with time entries',
      tags,
      auth: 'user',
      params: z.object({ taskId: idSchema }),
      handler: async ({ user, params }) => {
        const { task, access } = await loadTask(user, params.taskId, 'task.read');
        const entries =
          access.role === 'CLIENT'
            ? []
            : await prisma.taskTimeEntry.findMany({
                where: { taskId: task.id },
                include: { user: { select: { id: true, name: true } } },
                orderBy: { workDate: 'desc' },
              });
        const minutes = entries.reduce((sum, e) => sum + e.minutes, 0);
        const timeEntries: TimeEntryDto[] = entries.map((e) => ({
          id: e.id,
          user: e.user,
          minutes: e.minutes,
          workDate: e.workDate.toISOString().slice(0, 10),
          note: e.note,
          createdAt: e.createdAt.toISOString(),
        }));
        return ok({ ...toTaskDto(task, minutes), timeEntries });
      },
    }),
    route({
      method: 'patch',
      path: '/:taskId',
      summary: 'Update a task (status, assignee, due date, priority, details)',
      tags,
      auth: 'user',
      params: z.object({ taskId: idSchema }),
      body: taskUpdateSchema,
      handler: async ({ user, params, body }) => {
        const { task } = await loadTask(user, params.taskId, 'task.manage');
        const assignee =
          body.assigneeId !== undefined ? await validateAssignee(task.workspaceId, body.assigneeId) : null;
        const data: Prisma.TaskUncheckedUpdateInput = {};
        if (body.title !== undefined) data.title = body.title;
        if (body.description !== undefined) data.description = body.description;
        if (body.type !== undefined) data.type = body.type;
        if (body.priority !== undefined) data.priority = body.priority;
        if (body.dueDate !== undefined) data.dueDate = body.dueDate;
        if (body.periodKey !== undefined) data.periodKey = body.periodKey;
        if (body.clientVisible !== undefined) data.clientVisible = body.clientVisible;
        if (body.assigneeId !== undefined) {
          data.assigneeId = body.assigneeId;
          if (assignee?.role === 'CLIENT') data.clientVisible = true;
        }
        if (body.status !== undefined && body.status !== task.status) {
          data.status = body.status;
          data.completedAt = body.status === 'DONE' ? new Date() : null;
        }
        const updated = await prisma.task.update({ where: { id: task.id }, data, include: taskInclude });
        if (updated.assigneeId && updated.assigneeId !== task.assigneeId && updated.assigneeId !== user.id)
          await createNotification(prisma, updated.assigneeId, {
            workspaceId: updated.workspaceId,
            type: 'task_assigned',
            title: `Task assigned to you: ${updated.title}`,
            link: `/app/tasks/${updated.id}`,
          });
        if (data.status)
          await emitEvent(prisma, {
            workspaceId: updated.workspaceId,
            projectId: updated.projectId,
            type: updated.status === 'DONE' ? 'task.completed' : 'task.updated',
            entityType: 'Task',
            entityId: updated.id,
            actorUserId: user.id,
            data: { from: task.status, to: updated.status },
          });
        const minutes = await minutesByTask(prisma, [updated.id]);
        return ok(toTaskDto(updated, minutes.get(updated.id) ?? 0));
      },
    }),
    route({
      method: 'delete',
      path: '/:taskId',
      summary: 'Delete a task',
      tags,
      auth: 'user',
      params: z.object({ taskId: idSchema }),
      handler: async ({ user, params }) => {
        const { task } = await loadTask(user, params.taskId, 'task.manage');
        await prisma.task.delete({ where: { id: task.id } });
        return noContent();
      },
    }),
    route({
      method: 'post',
      path: '/:taskId/time',
      summary: 'Log time spent on a task (used for service margins)',
      tags,
      auth: 'user',
      params: z.object({ taskId: idSchema }),
      body: timeEntryCreateSchema,
      successStatus: 201,
      handler: async ({ user, params, body }) => {
        const { task } = await loadTask(user, params.taskId, 'task.manage');
        const entry = await prisma.taskTimeEntry.create({
          data: {
            taskId: task.id,
            userId: user.id,
            minutes: body.minutes,
            workDate: body.workDate,
            note: body.note,
          },
          include: { user: { select: { id: true, name: true } } },
        });
        return created({
          id: entry.id,
          user: entry.user,
          minutes: entry.minutes,
          workDate: entry.workDate.toISOString().slice(0, 10),
          note: entry.note,
          createdAt: entry.createdAt.toISOString(),
        } satisfies TimeEntryDto);
      },
    }),
    route({
      method: 'delete',
      path: '/:taskId/time/:entryId',
      summary: 'Delete a time entry (your own, or any as owner/admin)',
      tags,
      auth: 'user',
      params: z.object({ taskId: idSchema, entryId: idSchema }),
      handler: async ({ user, params }) => {
        const { task, access } = await loadTask(user, params.taskId, 'task.manage');
        const entry = await prisma.taskTimeEntry.findFirst({
          where: { id: params.entryId, taskId: task.id },
        });
        if (!entry) throw Errors.notFound('Time entry');
        if (entry.userId !== user.id && !can(access.role, 'members.manage'))
          throw Errors.forbidden('You can delete only your own time entries.');
        await prisma.taskTimeEntry.delete({ where: { id: entry.id } });
        return noContent();
      },
    }),
  ];

  return { project, workspace, tasks };
}

// Exported for later modules that let tasks point at their records.
export function registerTaskLink(
  entityType: string,
  resolveWorkspaceId: (db: PrismaClient, id: string) => Promise<string | null>,
): void {
  LINKABLE[entityType] = resolveWorkspaceId;
}
