// Domain events (docs/extension-plan.md D-030): an append-only record of things that happened in a workspace.
// Webhook deliveries and alert evaluation read from this log; emitting never fails the caller's operation.
import type { DomainEvent, Prisma, PrismaClient } from './db';
import { getLogger } from './logger';

type Db = PrismaClient | Prisma.TransactionClient;

export interface DomainEventInput {
  workspaceId: string;
  projectId?: string | null;
  /** Dotted name, e.g. "approval.requested", "placement.verified". */
  type: string;
  entityType?: string | null;
  entityId?: string | null;
  actorUserId?: string | null;
  /** Ids, statuses and numbers only: never secrets, tokens or personal data beyond ids. */
  data?: Prisma.InputJsonValue;
}

export type DomainEventHook = (db: Db, event: DomainEvent) => Promise<void>;

const hooks: DomainEventHook[] = [];

/** Registers a hook that runs after every emitted event (webhook fan-out, alerts). Errors are logged. */
export function onDomainEvent(hook: DomainEventHook): () => void {
  hooks.push(hook);
  return () => {
    const index = hooks.indexOf(hook);
    if (index >= 0) hooks.splice(index, 1);
  };
}

export async function emitEvent(db: Db, input: DomainEventInput): Promise<DomainEvent | null> {
  try {
    const event = await db.domainEvent.create({
      data: {
        workspaceId: input.workspaceId,
        projectId: input.projectId ?? null,
        type: input.type.slice(0, 60),
        entityType: input.entityType?.slice(0, 40) ?? null,
        entityId: input.entityId ?? null,
        actorUserId: input.actorUserId ?? null,
        data: input.data,
      },
    });
    for (const hook of hooks) {
      await hook(db, event).catch((error: unknown) =>
        getLogger('events').warn({ err: error, type: event.type }, 'Domain event hook failed'),
      );
    }
    return event;
  } catch (error) {
    getLogger('events').error({ err: error, type: input.type }, 'Could not record domain event');
    return null;
  }
}
