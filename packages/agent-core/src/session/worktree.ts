import { randomUUID } from 'node:crypto';
import { join } from 'pathe';

import type { Kaos } from '@moonshot-ai/kaos';

/**
 * Git worktree helper for subagent isolation.
 *
 * Creates a temporary git worktree so a subagent can edit files
 * without conflicting with the parent agent or sibling subagents.
 */
export interface WorktreeInfo {
  readonly path: string;
  readonly branch: string;
}

export async function createWorktree(
  kaos: Kaos,
  baseCwd: string,
  id: string,
): Promise<WorktreeInfo> {
  const branch = `kimi-agent-${id}`;
  const worktreesDir = join(baseCwd, '.kimi-worktrees');
  const worktreePath = join(worktreesDir, id);

  // Ensure worktrees directory exists
  try {
    await kaos.mkdir(worktreesDir, { parents: true, existOk: true });
  } catch {
    // ignore
  }

  const cwdKaos = kaos.withCwd(baseCwd);

  // Create the worktree
  const proc = await cwdKaos.execWithEnv(
    ['git', 'worktree', 'add', '-b', branch, worktreePath],
    { ...process.env as Record<string, string>, GIT_TERMINAL_PROMPT: '0' },
  );
  proc.stdin.end();
  const exitCode = await proc.wait();
  if (exitCode !== 0) {
    // Try without -b (branch might already exist from retry)
    const proc2 = await cwdKaos.execWithEnv(
      ['git', 'worktree', 'add', worktreePath],
      { ...process.env as Record<string, string>, GIT_TERMINAL_PROMPT: '0' },
    );
    proc2.stdin.end();
    const exitCode2 = await proc2.wait();
    if (exitCode2 !== 0) {
      throw new Error(
        `Failed to create git worktree at ${worktreePath} (exit ${exitCode2})`,
      );
    }
  }

  return { path: worktreePath, branch };
}

export async function removeWorktree(
  kaos: Kaos,
  baseCwd: string,
  worktreePath: string,
): Promise<void> {
  const cwdKaos = kaos.withCwd(baseCwd);
  const proc = await cwdKaos.execWithEnv(
    ['git', 'worktree', 'remove', '--force', worktreePath],
    { ...process.env as Record<string, string>, GIT_TERMINAL_PROMPT: '0' },
  );
  proc.stdin.end();
  try {
    await proc.wait();
  } catch {
    // Best-effort cleanup
  }
}
