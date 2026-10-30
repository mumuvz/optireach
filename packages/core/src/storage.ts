// File storage for generated artifacts (reports). The local driver writes under STORAGE_LOCAL_DIR;
// keys are validated so they can never escape that directory.
import { createReadStream } from 'node:fs';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { findRepoRoot, getEnv } from './env';

export interface StorageDriver {
  put(key: string, data: Buffer | string): Promise<{ key: string; size: number }>;
  getStream(key: string): Promise<{ stream: Readable; size: number }>;
  exists(key: string): Promise<boolean>;
  remove(key: string): Promise<void>;
}

const KEY_RE = /^[a-z0-9][a-z0-9/_.-]{0,250}$/i;

export function assertSafeKey(key: string): void {
  if (!KEY_RE.test(key) || key.includes('..') || key.includes('//'))
    throw new Error(`Invalid storage key: ${key}`);
}

export class LocalStorageDriver implements StorageDriver {
  private readonly root: string;

  constructor(root?: string) {
    const configured = root ?? getEnv().STORAGE_LOCAL_DIR;
    this.root = path.resolve(
      path.isAbsolute(configured) ? configured : path.join(findRepoRoot(), configured),
    );
  }

  private resolve(key: string): string {
    assertSafeKey(key);
    const full = path.resolve(this.root, key);
    if (!full.startsWith(this.root + path.sep)) throw new Error('Storage key escapes the storage root');
    return full;
  }

  async put(key: string, data: Buffer | string) {
    const full = this.resolve(key);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, data);
    return { key, size: typeof data === 'string' ? Buffer.byteLength(data) : data.length };
  }

  async getStream(key: string) {
    const full = this.resolve(key);
    const info = await stat(full);
    return { stream: createReadStream(full), size: info.size };
  }

  async exists(key: string) {
    try {
      await stat(this.resolve(key));
      return true;
    } catch {
      return false;
    }
  }

  async remove(key: string) {
    await rm(this.resolve(key), { force: true });
  }
}

let driver: StorageDriver | null = null;

export function getStorage(): StorageDriver {
  driver ??= new LocalStorageDriver();
  return driver;
}

export function setStorageDriver(next: StorageDriver | null): void {
  driver = next;
}
