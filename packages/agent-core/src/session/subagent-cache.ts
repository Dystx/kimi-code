import { createHash } from 'node:crypto';

import type { TokenUsage } from '@moonshot-ai/kosong';

export interface CachedSubagentResult {
  readonly result: string;
  readonly usage?: TokenUsage | undefined;
  readonly changes?: string | undefined;
  readonly cachedAt: number;
  readonly ttlMs?: number | undefined;
}

/**
 * Simple in-memory cache for subagent results.
 *
 * Keyed by a hash of (profileName + cwd + prompt) so identical tasks
 * across the same workspace can be served from cache instead of re-running
 * the subagent. This saves tokens and latency for repetitive work.
 */
export class SubagentResultCache {
  private readonly cache = new Map<string, CachedSubagentResult>();

  private makeKey(profileName: string, cwd: string, prompt: string): string {
    return createHash('sha256').update(`${profileName}\u0000${cwd}\u0000${prompt}`).digest('hex');
  }

  get(profileName: string, cwd: string, prompt: string): CachedSubagentResult | undefined {
    const key = this.makeKey(profileName, cwd, prompt);
    const entry = this.cache.get(key);
    if (entry === undefined) return undefined;
    if (entry.ttlMs !== undefined && Date.now() - entry.cachedAt > entry.ttlMs) {
      this.cache.delete(key);
      return undefined;
    }
    return entry;
  }

  set(
    profileName: string,
    cwd: string,
    prompt: string,
    result: CachedSubagentResult,
  ): void {
    const key = this.makeKey(profileName, cwd, prompt);
    this.cache.set(key, result);
  }

  clear(): void {
    this.cache.clear();
  }

  size(): number {
    return this.cache.size;
  }
}
