/**
 * CheckpointTool — save file snapshots for instant rollback.
 *
 * The LLM calls this tool before risky operations to create a named
 * checkpoint of specific files. If things go wrong, Rollback restores
 * those files to the checkpointed state.
 *
 * Checkpoints are stored per-session in the agent homedir.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'pathe';
import { z } from 'zod';

import type { Kaos } from '@moonshot-ai/kaos';
import type { BuiltinTool } from '../../../agent/tool';
import type { ExecutableToolResult, ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';

export const CHECKPOINT_TOOL_NAME = 'Checkpoint' as const;

const CheckpointFileSchema = z.object({
  path: z.string().describe('Absolute or relative path to the file to checkpoint'),
});

export const CheckpointInputSchema = z.object({
  name: z.string().describe('Unique name for this checkpoint (e.g. "before-refactor")'),
  files: z
    .array(CheckpointFileSchema)
    .min(1)
    .describe('Files to snapshot. Only existing files are captured.'),
});

export type CheckpointInput = z.infer<typeof CheckpointInputSchema>;

interface CheckpointEntry {
  readonly path: string;
  readonly content: string;
}

interface CheckpointData {
  readonly createdAt: string;
  readonly files: CheckpointEntry[];
}

export class CheckpointTool implements BuiltinTool<CheckpointInput> {
  readonly name = CHECKPOINT_TOOL_NAME;
  readonly description = `Save file snapshots under a named checkpoint. Use this before risky operations (large refactors, multi-file edits) so you can Rollback if something breaks. Checkpoints are stored per-session and persist across context compactions.`;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(CheckpointInputSchema);

  constructor(
    private readonly kaos: Kaos,
    private readonly checkpointsDir: string,
  ) {}

  resolveExecution(args: CheckpointInput): ToolExecution {
    return {
      description: `Checkpoint "${args.name}" (${args.files.length} files)`,
      approvalRule: this.name,
      execute: async () => this.execution(args),
    };
  }

  private async execution(args: CheckpointInput): Promise<ExecutableToolResult> {
    const saved: string[] = [];
    const missing: string[] = [];
    const entries: CheckpointEntry[] = [];

    for (const file of args.files) {
      try {
        const content = await this.kaos.readText(file.path);
        entries.push({ path: file.path, content });
        saved.push(file.path);
      } catch {
        missing.push(file.path);
      }
    }

    if (entries.length === 0) {
      return {
        isError: true,
        output: `No files could be checkpointed. Missing:\n${missing.join('\n')}`,
      };
    }

    const data: CheckpointData = {
      createdAt: new Date().toISOString(),
      files: entries,
    };

    const checkpointPath = join(this.checkpointsDir, `${args.name}.json`);
    try {
      await mkdir(dirname(checkpointPath), { recursive: true });
      await writeFile(checkpointPath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (error) {
      return {
        isError: true,
        output: `Failed to save checkpoint: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    const lines: string[] = [
      `Checkpoint "${args.name}" saved.`,
      `Files captured: ${saved.length}`,
      ...saved.map((p) => `  - ${p}`),
    ];
    if (missing.length > 0) {
      lines.push(`Missing (skipped): ${missing.length}`);
      lines.push(...missing.map((p) => `  - ${p}`));
    }

    return { isError: false, output: lines.join('\n') };
  }
}
