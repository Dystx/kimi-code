/**
 * GetPerformanceReport — returns agent performance and outcome statistics.
 */

import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import { ToolAccesses } from '../../../loop/tool-access';
import type { ExecutableToolResult, ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';
import type { SessionOutcomeTracker } from '../../../session/outcome-tracker';

export const GetPerformanceReportInputSchema = z.object({
  window_minutes: z
    .number()
    .int()
    .min(1)
    .max(120)
    .optional()
    .describe('Lookback window in minutes. Defaults to 60.'),
  include_reflection: z
    .boolean()
    .optional()
    .describe('If true, also returns the generated reflection markdown. Defaults to false.'),
});

export type GetPerformanceReportInput = z.infer<typeof GetPerformanceReportInputSchema>;

export class GetPerformanceReportTool implements BuiltinTool<GetPerformanceReportInput> {
  readonly name = 'GetPerformanceReport';
  readonly description =
    'Returns a performance report for the current session: tool success rates, subagent success rates, top used tools/subagents, and error patterns. Optionally includes a generated reflection. Use this to diagnose which tools or subagents are failing, spot repetitive mistakes, and decide when to write a reflection to memory.';
  readonly parameters: Record<string, unknown> = toInputJsonSchema(GetPerformanceReportInputSchema);

  constructor(private readonly tracker: SessionOutcomeTracker) {}

  resolveExecution(args: GetPerformanceReportInput): ToolExecution {
    return {
      description: 'Getting performance report',
      accesses: ToolAccesses.none(),
      approvalRule: this.name,
      execute: () => this.execution(args),
    };
  }

  private execution(args: GetPerformanceReportInput): Promise<ExecutableToolResult> {
    const windowMs = (args.window_minutes ?? 60) * 60 * 1000;
    const snap = this.tracker.snapshot(windowMs);

    const lines = [
      'Performance Report',
      '==================',
      '',
      `Window: last ${args.window_minutes ?? 60} minutes`,
      '',
      'Tools:',
      `  Total calls: ${snap.totalToolCalls}`,
      `  Errors: ${snap.toolErrors}`,
      `  Success rate: ${Math.round(snap.toolSuccessRate * 100)}%`,
      '',
      'Subagents:',
      `  Total spawns: ${snap.totalSubagents}`,
      `  Errors: ${snap.subagentErrors}`,
      `  Success rate: ${Math.round(snap.subagentSuccessRate * 100)}%`,
      '',
      'Turns:',
      `  Total turns: ${snap.totalTurns}`,
      `  Failed: ${snap.turnErrors}`,
      '',
    ];

    if (snap.topTools.length > 0) {
      lines.push('Top Tools:');
      for (const t of snap.topTools.slice(0, 5)) {
        lines.push(`  ${t.name}: ${t.count} calls, ${Math.round(t.errorRate * 100)}% error`);
      }
      lines.push('');
    }

    if (snap.topSubagents.length > 0) {
      lines.push('Top Subagent Profiles:');
      for (const s of snap.topSubagents.slice(0, 5)) {
        lines.push(`  ${s.name}: ${s.count} spawns, ${Math.round(s.errorRate * 100)}% error`);
      }
      lines.push('');
    }

    const problematicTools = snap.topTools.filter((t) => t.errorRate > 0.3 && t.count >= 3);
    const problematicProfiles = snap.topSubagents.filter((s) => s.errorRate > 0.3 && s.count >= 2);

    if (problematicTools.length > 0 || problematicProfiles.length > 0) {
      lines.push('Warnings:');
      for (const t of problematicTools) {
        lines.push(`  Tool "${t.name}" has ${Math.round(t.errorRate * 100)}% error rate (${t.count} calls).`);
      }
      for (const s of problematicProfiles) {
        lines.push(`  Subagent "${s.name}" has ${Math.round(s.errorRate * 100)}% error rate (${s.count} spawns).`);
      }
      lines.push('');
    }

    if (args.include_reflection) {
      lines.push('---');
      lines.push('');
      lines.push(this.tracker.generateReflection());
    }

    return Promise.resolve({ output: lines.join('\n') });
  }
}
