import { grandTotal } from '@moonshot-ai/kosong';
import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import type { SessionSubagentHost } from '../../../session/subagent-host';
import { toInputJsonSchema } from '../../support/input-schema';
import { ToolAccesses } from '../../../loop/tool-access';
import type { ToolExecution } from '../../../loop/types';

export const SubagentStatusInputSchema = z.object({
  filter: z
    .enum(['all', 'running', 'completed', 'failed'])
    .optional()
    .default('all')
    .describe('Filter by status'),
});

export type SubagentStatusInput = z.infer<typeof SubagentStatusInputSchema>;

export class SubagentStatusTool implements BuiltinTool<SubagentStatusInput> {
  readonly name = 'SubagentStatus' as const;
  readonly description =
    'Get a real-time status overview of all subagents spawned by this agent. Returns running, completed, and failed subagents with their runtimes, token usage, and results. Use this to monitor parallel work, check if batch tasks finished, or diagnose stuck subagents.';
  readonly parameters: Record<string, unknown> = toInputJsonSchema(SubagentStatusInputSchema);

  constructor(private readonly subagentHost: SessionSubagentHost) {}

  resolveExecution(args: SubagentStatusInput): ToolExecution {
    return {
      description: 'Querying subagent status',
      accesses: ToolAccesses.none(),
      approvalRule: this.name,
      execute: () => this.execution(args),
    };
  }

  private execution(args: SubagentStatusInput) {
    const statuses = this.subagentHost.getStatuses();
    if (statuses.size === 0) {
      return Promise.resolve({ output: 'No subagents have been spawned yet.' });
    }

    const lines: string[] = [`## Subagent Status (${statuses.size} total)`];

    let runningCount = 0;
    let completedCount = 0;
    let failedCount = 0;

    for (const [agentId, status] of statuses) {
      if (args.filter !== 'all' && status.kind !== args.filter) continue;

      lines.push('');
      if (status.kind === 'running') {
        runningCount++;
        const elapsedSec = Math.round((Date.now() - status.startedAt) / 1000);
        lines.push(`- **${agentId}** — ⏳ running (${elapsedSec}s elapsed)`);
      } else if (status.kind === 'completed') {
        completedCount++;
        const durationSec = Math.round((status.completedAt - status.startedAt) / 1000);
        const usage = status.usage
          ? ` | ${grandTotal(status.usage)} tokens`
          : '';
        lines.push(`- **${agentId}** — ✅ completed (${durationSec}s${usage})`);
        if (status.result.length > 0) {
          const preview = status.result.slice(0, 200).replaceAll('\n', ' ');
          lines.push(`  result: ${preview}${status.result.length > 200 ? '...' : ''}`);
        }
      } else {
        failedCount++;
        const durationSec = Math.round((status.failedAt - status.startedAt) / 1000);
        lines.push(`- **${agentId}** — ❌ failed (${durationSec}s)`);
        lines.push(`  error: ${status.error}`);
      }
    }

    lines.push('');
    lines.push(`Summary: ${runningCount} running, ${completedCount} completed, ${failedCount} failed`);

    return Promise.resolve({ output: lines.join('\n') });
  }
}
