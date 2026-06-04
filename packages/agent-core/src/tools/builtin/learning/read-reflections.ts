/**
 * ReadReflections — retrieve past session reflections for cross-session learning.
 */

import { readFile } from 'node:fs/promises';
import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import { ToolAccesses } from '../../../loop/tool-access';
import type { ExecutableToolResult, ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';

export const ReadReflectionsInputSchema = z.object({
  n_sessions: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe('Number of recent session reflections to retrieve. Defaults to 5.'),
});

export type ReadReflectionsInput = z.infer<typeof ReadReflectionsInputSchema>;

export class ReadReflectionsTool implements BuiltinTool<ReadReflectionsInput> {
  readonly name = 'ReadReflections';
  readonly description =
    'Reads past session reflections from ~/.kimi-code/.omk/memory/reflections.md. Use this at the start of a session to recall what worked and what failed in previous sessions, then adapt your approach accordingly.';
  readonly parameters: Record<string, unknown> = toInputJsonSchema(ReadReflectionsInputSchema);

  constructor(private readonly homedir: string) {}

  resolveExecution(args: ReadReflectionsInput): ToolExecution {
    return {
      description: 'Reading past session reflections',
      accesses: ToolAccesses.none(),
      approvalRule: this.name,
      execute: () => this.execution(args),
    };
  }

  private async execution(args: ReadReflectionsInput): Promise<ExecutableToolResult> {
    const path = `${this.homedir}/.omk/memory/reflections.md`;
    try {
      const content = await readFile(path, 'utf-8');
      const sessions = content
        .split(/(?=^# Session Reflection)/m)
        .filter((s) => s.trim().length > 0);

      const n = args.n_sessions ?? 5;
      const recent = sessions.slice(-n);

      if (recent.length === 0) {
        return { output: 'No past reflections found.' };
      }

      const output = [
        `Past Session Reflections (${recent.length} most recent)`,
        '=====================================================',
        '',
        ...recent,
      ].join('\n');

      return { output };
    } catch {
      return { output: 'No past reflections found.' };
    }
  }
}
