// Remembers the last opened project per workspace in this browser (a convenience only; storage can
// be unavailable in private windows, so every access is guarded).
const KEY = 'sf:lastProject';

function read(): Record<string, string> {
  try {
    const raw = window.localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export function getLastProject(workspaceId: string | null): string | null {
  if (!workspaceId) return null;
  return read()[workspaceId] ?? null;
}

export function setLastProject(workspaceId: string, projectId: string): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify({ ...read(), [workspaceId]: projectId }));
  } catch {
    // Ignore: the dashboard works without it.
  }
}

export function readFlag(key: string, fallback: boolean): boolean {
  try {
    const v = window.localStorage.getItem(key);
    return v === null ? fallback : v === '1';
  } catch {
    return fallback;
  }
}

export function writeFlag(key: string, value: boolean): void {
  try {
    window.localStorage.setItem(key, value ? '1' : '0');
  } catch {
    // Ignore.
  }
}
