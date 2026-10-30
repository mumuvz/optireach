import type { PageMeta } from '@surfaced/shared';

/** Result returned by route handlers; the router serializes it as { data, meta }. */
export interface HandlerResult<T = unknown> {
  status?: number;
  data?: T;
  meta?: PageMeta;
}

export const ok = <T>(data: T, meta?: PageMeta): HandlerResult<T> => ({ status: 200, data, meta });
export const created = <T>(data: T): HandlerResult<T> => ({ status: 201, data });
export const accepted = <T>(data: T): HandlerResult<T> => ({ status: 202, data });
export const noContent = (): HandlerResult<never> => ({ status: 204 });

export function pageMeta(page: number, pageSize: number, total: number): PageMeta {
  return { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
}

/** Prisma skip/take for 1-based pagination. */
export function paginate(page: number, pageSize: number): { skip: number; take: number } {
  return { skip: (page - 1) * pageSize, take: pageSize };
}

export function iso(date: Date | null | undefined): string | null {
  return date ? date.toISOString() : null;
}

/** Reads a JSON column that should hold a string array. */
export function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}
