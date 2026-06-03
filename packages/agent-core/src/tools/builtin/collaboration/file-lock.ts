/**
 * File lock tools — cross-agent file locking to prevent conflicting edits.
 */

import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import { ToolAccesses } from '../../../loop/tool-access';
import type { ExecutableToolResult, ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';
import type { SessionFileLock } from '../../../session/file-lock';

// ── AcquireLock ──────────────────────────────────────────────────────

export const AcquireLockInputSchema = z.object({
  path: z.string().describe('File or directory path to lock'),
  ttl_seconds: z
    .number()
    .int()
    .min(10)
    .max(3600)
    .optional()
    .describe('Lock duration in seconds. Defaults to 300 (5 minutes).'),
});

export type AcquireLockInput = z.infer<typeof AcquireLockInputSchema>;

export class AcquireLockTool implements BuiltinTool<AcquireLockInput> {
  readonly name = 'AcquireLock';
  readonly description =
    'Acquire an exclusive lock on a file or directory. If another agent already holds the lock, this fails. Locks auto-expire after the TTL. Use this before editing files that other subagents might also touch.';
  readonly parameters: Record<string, unknown> = toInputJsonSchema(AcquireLockInputSchema);

  constructor(
    private readonly locks: SessionFileLock,
    private readonly agentId: string,
  ) {}

  resolveExecution(args: AcquireLockInput): ToolExecution {
    return {
      description: `Acquiring lock on ${args.path}`,
      accesses: ToolAccesses.none(),
      approvalRule: this.name,
      execute: () => this.execution(args),
    };
  }

  private execution(args: AcquireLockInput): Promise<ExecutableToolResult> {
    const ttlMs = (args.ttl_seconds ?? 300) * 1000;
    const lock = this.locks.acquire(args.path, this.agentId, ttlMs);
    if (lock === undefined) {
      const info = this.locks.isLocked(args.path);
      return Promise.resolve({
        output: `Lock on "${args.path}" is already held by agent ${info.by} (expires at ${info.expiresAt ? new Date(info.expiresAt).toISOString() : 'unknown'}).`,
        isError: true,
      });
    }
    return Promise.resolve({
      output: `Lock acquired on "${lock.path}" (expires at ${new Date(lock.expiresAt).toISOString()}).`,
    });
  }
}

// ── ReleaseLock ──────────────────────────────────────────────────────

export const ReleaseLockInputSchema = z.object({
  path: z.string().describe('File or directory path to release'),
});

export type ReleaseLockInput = z.infer<typeof ReleaseLockInputSchema>;

export class ReleaseLockTool implements BuiltinTool<ReleaseLockInput> {
  readonly name = 'ReleaseLock';
  readonly description =
    'Release a lock held by this agent. Use this after finishing edits to let other agents proceed.';
  readonly parameters: Record<string, unknown> = toInputJsonSchema(ReleaseLockInputSchema);

  constructor(
    private readonly locks: SessionFileLock,
    private readonly agentId: string,
  ) {}

  resolveExecution(args: ReleaseLockInput): ToolExecution {
    return {
      description: `Releasing lock on ${args.path}`,
      accesses: ToolAccesses.none(),
      approvalRule: this.name,
      execute: () => this.execution(args),
    };
  }

  private execution(args: ReleaseLockInput): Promise<ExecutableToolResult> {
    const released = this.locks.release(args.path, this.agentId);
    if (released) {
      return Promise.resolve({ output: `Lock on "${args.path}" released.` });
    }
    const info = this.locks.isLocked(args.path);
    if (!info.locked) {
      return Promise.resolve({ output: `No lock on "${args.path}".` });
    }
    return Promise.resolve({
      output: `Lock on "${args.path}" is held by agent ${info.by}, not you.`,
      isError: true,
    });
  }
}

// ── ListLocks ────────────────────────────────────────────────────────

export const ListLocksInputSchema = z.object({
  mine_only: z
    .boolean()
    .optional()
    .describe('Only show locks held by this agent'),
});

export type ListLocksInput = z.infer<typeof ListLocksInputSchema>;

export class ListLocksTool implements BuiltinTool<ListLocksInput> {
  readonly name = 'ListLocks';
  readonly description = 'List all active file locks in the session.';
  readonly parameters: Record<string, unknown> = toInputJsonSchema(ListLocksInputSchema);

  constructor(
    private readonly locks: SessionFileLock,
    private readonly agentId: string,
  ) {}

  resolveExecution(_args: ListLocksInput): ToolExecution {
    return {
      description: 'Listing locks',
      accesses: ToolAccesses.none(),
      approvalRule: this.name,
      execute: () => this.execution(),
    };
  }

  private execution(): Promise<ExecutableToolResult> {
    const all = this.locks.list();
    if (all.length === 0) {
      return Promise.resolve({ output: 'No active locks.' });
    }
    const lines = ['Active Locks', '============', ''];
    for (const lock of all) {
      lines.push(`path: ${lock.path}`);
      lines.push(`  agent: ${lock.agentId}`);
      lines.push(`  expires: ${new Date(lock.expiresAt).toISOString()}`);
      lines.push('');
    }
    return Promise.resolve({ output: lines.join('\n') });
  }
}
