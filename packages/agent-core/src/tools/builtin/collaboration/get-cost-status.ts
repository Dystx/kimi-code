import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import type { SessionCostTracker } from '../../../session/cost-tracker';
import { ToolAccesses } from '../../../loop/tool-access';
import type { ExecutableToolResult, ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';

export const GetCostStatusInputSchema = z.object({});

export type GetCostStatusInput = z.infer<typeof GetCostStatusInputSchema>;

export class GetCostStatusTool implements BuiltinTool<GetCostStatusInput> {
  readonly name = 'GetCostStatus' as const;
  readonly description =
    'Get the current session cost status: total estimated spend, per-model breakdown, and remaining budget. Call this periodically to monitor API costs, especially when running many subagents.';
  readonly parameters: Record<string, unknown> = toInputJsonSchema(GetCostStatusInputSchema);

  constructor(private readonly tracker: SessionCostTracker) {}

  resolveExecution(_args: GetCostStatusInput): ToolExecution {
    return {
      description: 'Getting cost status',
      accesses: ToolAccesses.none(),
      approvalRule: this.name,
      execute: () => this.execution(),
    };
  }

  private execution(): Promise<ExecutableToolResult> {
    const status = this.tracker.status();
    const lines: string[] = [
      '## Session Cost Status',
      `Total estimated spend: $${status.totalDollars.toFixed(4)}`,
    ];

    if (status.budget !== undefined) {
      lines.push(`Budget: $${status.budget.maxDollars.toFixed(2)}`);
      lines.push(`Remaining: $${status.remainingDollars?.toFixed(4) ?? 'N/A'}`);
      lines.push(`Used: ${Math.round((status.fractionUsed ?? 0) * 100)}%`);
    }

    const models = Object.entries(status.byModel);
    if (models.length > 0) {
      lines.push('');
      lines.push('Per-model breakdown:');
      for (const [model, info] of models) {
        lines.push(`  ${model}: ${info.tokens.toLocaleString()} tokens (~$${info.dollars.toFixed(4)})`);
      }
    }

    return Promise.resolve({ output: lines.join('\n') });
  }
}
