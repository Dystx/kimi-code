/**
 * RollbackTool — restore files from a named checkpoint.
 *
 * Reverts all files captured in a checkpoint to their saved state.
 * This is the safety net for risky operations — instant undo without
 * relying on git or manual recovery.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'pathe';
import { z } from 'zod';

import type { Kaos } from '@moonshot-ai/kaos';
import type { BuiltinTool } from '../../../agent/tool';
import type { ExecutableToolResult, ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';

export const ROLLBACK_TOOL_NAME = 'Rollback' as const;

export const RollbackInputSchema = z.object({
  checkpoint: z.string().describe('Name of the checkpoint to restore (as given to Checkpoint)'),
  confirm: z
    .boolean()
    .describe('Must be true to execute rollback. This prevents accidental restores.'),
});

export type RollbackInput = z.infer<typeof RollbackInputSchema>;

interface CheckpointEntry {
  readonly path: string;
  readonly content: string;
}

interface CheckpointData {
  readonly createdAt: string;
  readonly files: CheckpointEntry[];
}

export class RollbackTool implements BuiltinTool<RollbackInput> {
  readonly name = ROLLBACK_TOOL_NAME;
  readonly description = `Restore files from a named checkpoint created by the Checkpoint tool. Set confirm=true to execute. This instantly reverts files to their checkpointed state — use it when a refactor or edit went wrong.`;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(RollbackInputSchema);

  constructor(
    private readonly kaos: Kaos,
    private readonly checkpointsDir: string,
  ) {}

  resolveExecution(args: RollbackInput): ToolExecution {
    return {
      description: `Rollback to checkpoint "${args.checkpoint}"`,
      approvalRule: this.name,
      execute: async () => this.execution(args),
    };
  }

  private async execution(args: RollbackInput): Promise<ExecutableToolResult> {
    if (args.confirm !== true) {
      return {
        isError: true,
        output: 'Rollback requires confirm=true. This is a safety guard against accidental restores.',
      };
    }

    const checkpointPath = join(this.checkpointsDir, `${args.checkpoint}.json`);
    let data: CheckpointData;
    try {
      const raw = await readFile(checkpointPath, 'utf-8');
      data = JSON.parse(raw) as CheckpointData;
    } catch {
      return {
        isError: true,
        output: `Checkpoint "${args.checkpoint}" not found. Use Checkpoint first to save a snapshot.`,
      };
    }

    const restored: string[] = [];
    const failed: string[] = [];

    for (const entry of data.files) {
      try {
        await this.kaos.writeText(entry.path, entry.content);
        restored.push(entry.path);
      } catch (error) {
        failed.push(`${entry.path}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const lines: string[] = [
      `Rollback "${args.checkpoint}" complete.`,
      `Restored: ${restored.length} files`,
      ...restored.map((p) => `  ✓ ${p}`),
    ];
    if (failed.length > 0) {
      lines.push(`Failed: ${failed.length} files`);
      lines.push(...failed.map((m) => `  ✗ ${m}`));
    }

    return { isError: failed.length > 0, output: lines.join('\n') };
  }
}
