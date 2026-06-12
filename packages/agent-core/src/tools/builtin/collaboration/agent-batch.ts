/**
 * AgentBatchTool — parallel subagent orchestration.
 *
 * Spawns multiple subagents concurrently, waits for all to complete,
 * and returns structured aggregated results. This is the multi-agent
 * equivalent of Promise.all() — use it when several independent tasks
 * can run in parallel (e.g. "explore 3 different directories",
 * "review 5 files", "test + lint simultaneously").
 *
 * Each subagent runs in its own isolated context. Results are merged
 * into a single structured response so the parent agent can act on
 * the combined output.
 */

import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import type { ExecutableToolResult, ToolExecution } from '../../../loop/types';
import type { ResolvedAgentProfile } from '../../../profile';
import type { SessionSubagentHost, SubagentHandle } from '../../../session/subagent-host';
import { inputTotal } from '@moonshot-ai/kosong';
import { toInputJsonSchema } from '../../support/input-schema';
import { ToolAccesses } from '../../../loop/tool-access';

const AgentBatchItemSchema = z.object({
  prompt: z.string().describe('Task prompt for this subagent'),
  description: z.string().describe('Short description (3-5 words) for UI'),
  subagent_type: z
    .string()
    .optional()
    .describe('Profile name. Defaults to "coder"'),
  token_budget: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Maximum total tokens this subagent may consume'),
  time_budget_ms: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Maximum wall-clock milliseconds this subagent may run'),
  stream_updates: z
    .boolean()
    .optional()
    .describe('If true, emit progress events for this subagent as it works'),
});

export const AgentBatchInputSchema = z.object({
  tasks: z
    .array(AgentBatchItemSchema)
    .min(2)
    .max(8)
    .describe('2-8 parallel subagent tasks'),
  aggregate_mode: z
    .enum(['concat', 'vote', 'best_of'])
    .optional()
    .describe(
      'Aggregation mode: concat (default) joins all results; vote counts agreement when all agents answer the same question; best_of returns the most common result when running identical prompts multiple times.',
    ),
  aggregate_prompt: z
    .string()
    .optional()
    .describe(
      'Optional prompt suffix added to each subagent result before aggregation. Use this to request a specific merge format (e.g. "summarize conflicts", "combine into a single todo list").',
    ),
});

export type AgentBatchInput = z.infer<typeof AgentBatchInputSchema>;

export class AgentBatchTool implements BuiltinTool<AgentBatchInput> {
  readonly name = 'AgentBatch' as const;
  readonly description = `Spawn multiple subagents in parallel and aggregate their results. Use this when you have 2-8 independent tasks that can run simultaneously (e.g. exploring different parts of the codebase, reviewing multiple files, or running tests + lint in parallel). Each subagent gets its own context window and runs concurrently. Results are returned as a structured map.`;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(AgentBatchInputSchema);

  constructor(
    private readonly subagentHost: SessionSubagentHost,
    private readonly subagents?: ResolvedAgentProfile['subagents'] | undefined,
  ) {}

  resolveExecution(args: AgentBatchInput): ToolExecution {
    return {
      description: `Launching ${args.tasks.length} parallel agents`,
      accesses: ToolAccesses.none(),
      approvalRule: this.name,
      execute: (ctx) => this.execution(args, ctx.signal),
    };
  }

  private async execution(
    args: AgentBatchInput,
    signal: AbortSignal,
  ): Promise<ExecutableToolResult> {
    signal.throwIfAborted();

    const spawned: Array<{
      index: number;
      description: string;
      profileName: string;
      handle: SubagentHandle;
    }> = [];

    // Spawn all subagents concurrently.
    for (let i = 0; i < args.tasks.length; i++) {
      const task = args.tasks[i]!;
      const profileName = task.subagent_type?.length ? task.subagent_type : 'coder';
      const handle = await this.subagentHost.spawn({
        profileName,
        parentToolCallId: `agent-batch-${i}`,
        prompt: task.prompt,
        description: task.description,
        runInBackground: false,
        signal,
        tokenBudget: task.token_budget,
        timeBudgetMs: task.time_budget_ms,
        streamUpdates: task.stream_updates,
      });
      spawned.push({ index: i, description: task.description, profileName, handle });
    }

    // Wait for all completions.
    const results = await Promise.allSettled(
      spawned.map(async (s) => {
        const completion = await s.handle.completion;
        return {
          index: s.index,
          agentId: s.handle.agentId,
          profileName: s.profileName,
          description: s.description,
          result: completion.result,
          usage: completion.usage,
          changes: completion.changes,
        };
      }),
    );

    // Build structured output.
    const lines: string[] = [`## Parallel Agent Batch Results (${spawned.length} tasks)`];

    for (let i = 0; i < results.length; i++) {
      const r = results[i]!;
      const task = args.tasks[i]!;
      lines.push('');
      if (r.status === 'fulfilled') {
        const value = r.value;
        lines.push(`### [${value.index + 1}] ${value.description} (${value.profileName})`);
        lines.push(`agent_id: ${value.agentId}`);
        if (value.usage) {
          const totalInput = inputTotal(value.usage);
          lines.push(
            `usage: ${totalInput + value.usage.output} tokens (${totalInput} in / ${value.usage.output} out)`,
          );
        }
        lines.push('');
        lines.push(value.result);
        if (value.changes !== undefined && value.changes.length > 0) {
          lines.push('');
          lines.push('[changes]');
          lines.push(value.changes);
        }
      } else {
        lines.push(`### [${i + 1}] ${task.description} — FAILED`);
        const reason = r.reason instanceof Error ? r.reason.message : String(r.reason);
        lines.push(`error: ${reason}`);
      }
    }

    if (args.aggregate_prompt) {
      lines.push('');
      lines.push('---');
      lines.push('');
      lines.push(`Aggregation instruction: ${args.aggregate_prompt}`);
    }

    const hasFailure = results.some((r) => r.status === 'rejected');
    const mode = args.aggregate_mode ?? 'concat';

    if (mode === 'vote' || mode === 'best_of') {
      const successful: string[] = [];
      for (const r of results) {
        if (r.status === 'fulfilled') {
          successful.push(r.value.result.trim());
        }
      }
      const voteResult = aggregateVotes(successful, mode);
      lines.push('');
      lines.push('---');
      lines.push('');
      lines.push(voteResult);
    }

    if (args.aggregate_prompt) {
      lines.push('');
      lines.push('---');
      lines.push('');
      lines.push(`Aggregation instruction: ${args.aggregate_prompt}`);
    }

    return {
      isError: hasFailure,
      output: lines.join('\n'),
    };
  }
}

function aggregateVotes(results: string[], mode: 'vote' | 'best_of'): string {
  if (results.length === 0) return 'No successful results to aggregate.';

  // Count occurrences (case-insensitive, normalized whitespace)
  const counts = new Map<string, number>();
  for (const r of results) {
    const normalized = r.toLowerCase().replaceAll(/\s+/g, ' ').trim();
    counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
  }

  // Find the most common
  let best = '';
  let bestCount = 0;
  for (const [normalized, count] of counts) {
    if (count > bestCount) {
      bestCount = count;
      best = normalized;
    }
  }

  const agreement = Math.round((bestCount / results.length) * 100);
  const lines: string[] = [];

  if (mode === 'vote') {
    lines.push(`## Vote Result`);
    lines.push(`Agreement: ${bestCount}/${results.length} (${agreement}%)`);
    lines.push('');
    lines.push('Most common answer:');
    lines.push(best);
    lines.push('');
    lines.push('All answers:');
    for (let i = 0; i < results.length; i++) {
      const match = results[i]!.toLowerCase().replaceAll(/\s+/g, ' ').trim() === best ? '✅' : '❌';
      lines.push(`  [${i + 1}] ${match} ${results[i]!.slice(0, 120)}${results[i]!.length > 120 ? '...' : ''}`);
    }
  } else {
    lines.push(`## Best-of Result`);
    lines.push(`Most common result: ${bestCount}/${results.length} (${agreement}%)`);
    lines.push('');
    lines.push(best);
    if (agreement < 100) {
      lines.push('');
      lines.push('Other results:');
      const seen = new Set<string>();
      for (const r of results) {
        const normalized = r.toLowerCase().replaceAll(/\s+/g, ' ').trim();
        if (normalized !== best && !seen.has(normalized)) {
          seen.add(normalized);
          lines.push(`  - ${r.slice(0, 120)}${r.length > 120 ? '...' : ''}`);
        }
      }
    }
  }

  return lines.join('\n');
}
