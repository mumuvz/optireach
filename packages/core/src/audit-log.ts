// Accountability log for important account, workspace and administrative actions.
// Recording is best-effort: a logging failure must never break the user's request.
import type { Prisma, PrismaClient } from './db';
import { getLogger } from './logger';

export interface AuditLogEntry {
  action: string;
  actorUserId?: string | null;
  workspaceId?: string | null;
  targetType?: string;
  targetId?: string;
  ipAddress?: string | null;
  userAgent?: string | null;
  /** Must never contain passwords, tokens, secrets or payment data. */
  metadata?: Prisma.InputJsonValue;
}

const SENSITIVE_KEY = /pass(word)?|secret|token|authorization|cookie|api[-_]?key|card|cvc|iban/i;

/** Drops keys that look sensitive, as a second line of defence for callers. */
export function scrubMetadata(value: unknown, depth = 0): unknown {
  if (depth > 4 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => scrubMetadata(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE_KEY.test(key) ? '[REDACTED]' : scrubMetadata(inner, depth + 1);
  }
  return out;
}

export async function recordAuditLog(
  prisma: PrismaClient | Prisma.TransactionClient,
  entry: AuditLogEntry,
): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        action: entry.action.slice(0, 80),
        actorUserId: entry.actorUserId ?? null,
        workspaceId: entry.workspaceId ?? null,
        targetType: entry.targetType?.slice(0, 40),
        targetId: entry.targetId?.slice(0, 64),
        ipAddress: entry.ipAddress?.slice(0, 64) ?? null,
        userAgent: entry.userAgent?.slice(0, 400) ?? null,
        metadata:
          entry.metadata === undefined ? undefined : (scrubMetadata(entry.metadata) as Prisma.InputJsonValue),
      },
    });
  } catch (error) {
    getLogger('audit-log').error({ err: error, action: entry.action }, 'Failed to record audit log entry');
  }
}
