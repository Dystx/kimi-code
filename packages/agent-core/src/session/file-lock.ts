/**
 * SessionFileLock — cross-agent file locking to prevent conflicting edits.
 *
 * Locks are scoped to the session and auto-expire after a timeout.
 */

export interface FileLock {
  readonly path: string;
  readonly agentId: string;
  readonly acquiredAt: number;
  readonly expiresAt: number;
}

const DEFAULT_LOCK_TTL_MS = 5 * 60 * 1000; // 5 minutes

export class SessionFileLock {
  private locks = new Map<string, FileLock>();

  acquire(path: string, agentId: string, ttlMs = DEFAULT_LOCK_TTL_MS): FileLock | undefined {
    this.evictExpired();
    const normalized = this.normalizePath(path);
    const existing = this.locks.get(normalized);
    if (existing !== undefined && existing.agentId !== agentId) {
      return undefined;
    }
    const lock: FileLock = {
      path: normalized,
      agentId,
      acquiredAt: Date.now(),
      expiresAt: Date.now() + ttlMs,
    };
    this.locks.set(normalized, lock);
    return lock;
  }

  release(path: string, agentId: string): boolean {
    this.evictExpired();
    const normalized = this.normalizePath(path);
    const existing = this.locks.get(normalized);
    if (existing === undefined || existing.agentId !== agentId) {
      return false;
    }
    this.locks.delete(normalized);
    return true;
  }

  isLocked(path: string): { locked: boolean; by?: string; expiresAt?: number } {
    this.evictExpired();
    const normalized = this.normalizePath(path);
    const existing = this.locks.get(normalized);
    if (existing === undefined) {
      return { locked: false };
    }
    return { locked: true, by: existing.agentId, expiresAt: existing.expiresAt };
  }

  list(agentId?: string): FileLock[] {
    this.evictExpired();
    const all = Array.from(this.locks.values());
    if (agentId !== undefined) {
      return all.filter((l) => l.agentId === agentId);
    }
    return all;
  }

  private evictExpired(): void {
    const now = Date.now();
    for (const [path, lock] of this.locks) {
      if (lock.expiresAt <= now) {
        this.locks.delete(path);
      }
    }
  }

  private normalizePath(path: string): string {
    return path.replace(/\\/g, '/').replace(/\/+/g, '/');
  }
}
