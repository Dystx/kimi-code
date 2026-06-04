/**
 * GetPlanStatus — read plan progress from disk even when plan mode is not active.
 */

import { readFile } from 'node:fs/promises';
import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import { ToolAccesses } from '../../../loop/tool-access';
import type { ExecutableToolResult, ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';

export const GetPlanStatusInputSchema = z.object({});

export type GetPlanStatusInput = z.infer<typeof GetPlanStatusInputSchema>;

export class GetPlanStatusTool implements BuiltinTool<GetPlanStatusInput> {
  readonly name = 'GetPlanStatus';
  readonly description =
    'Reads the current durable plan tracker state from disk and reports progress. Works even when plan mode is not currently active — use this to check status of a long-running plan across sessions, or to resume work after a context compaction.';
  readonly parameters: Record<string, unknown> = toInputJsonSchema(GetPlanStatusInputSchema);

  constructor(private readonly planTrackerFilePath: string) {}

  resolveExecution(_args: GetPlanStatusInput): ToolExecution {
    return {
      description: 'Reading plan status',
      accesses: ToolAccesses.none(),
      approvalRule: this.name,
      execute: () => this.execution(),
    };
  }

  private async execution(): Promise<ExecutableToolResult> {
    try {
      const raw = await readFile(this.planTrackerFilePath, 'utf-8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;

      if (!parsed['id'] || !Array.isArray(parsed['tasks'])) {
        return { output: 'No active plan found.' };
      }

      const tasks = parsed['tasks'] as Array<{
        id: string;
        title: string;
        status: string;
        description?: string;
        dependencies?: string[];
      }>;
      const currentTaskId = parsed['currentTaskId'] as string | undefined;
      const title = (parsed['title'] as string) || 'Untitled Plan';
      const planId = (parsed['id'] as string) || 'unknown';

      const total = tasks.length;
      const done = tasks.filter((t) => t.status === 'done').length;
      const inProgress = tasks.filter((t) => t.status === 'in_progress').length;
      const blocked = tasks.filter((t) => t.status === 'blocked').length;
      const pending = tasks.filter((t) => t.status === 'pending').length;
      const skipped = tasks.filter((t) => t.status === 'skipped').length;

      const lines = [
        `Plan: ${title}`,
        `ID: ${planId}`,
        `Progress: ${done}/${total} done, ${inProgress} in progress, ${blocked} blocked, ${pending} pending, ${skipped} skipped`,
        '',
      ];

      if (currentTaskId) {
        const current = tasks.find((t) => t.id === currentTaskId);
        if (current) {
          lines.push(`Current task: [${current.status}] ${current.title}`);
          if (current.description) lines.push(current.description);
          lines.push('');
        }
      }

      lines.push('All tasks:');
      for (const t of tasks) {
        const marker =
          t.id === currentTaskId ? '→ ' : t.status === 'done' ? '✓ ' : t.status === 'blocked' ? '! ' : '  ';
        const depNote = t.dependencies?.length ? ` (depends: ${t.dependencies.join(', ')})` : '';
        lines.push(`${marker}[${t.status}] ${t.title}${depNote}`);
      }

      return { output: lines.join('\n') };
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === 'ENOENT') {
        return { output: 'No plan tracker file found. No plan has been approved yet.' };
      }
      return { output: `Error reading plan: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
}
