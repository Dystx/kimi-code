/**
 * AgentTool — collaboration tool for spawning task subagents.
 *
 * Unlike the built-in tools (Read/Write/Edit/Bash/Grep/Glob), this is a
 * "collaboration tool". It uses `SessionSubagentHost` (injected via the
 * constructor rather than through the Runtime) to create in-process subagent
 * loop instances.
 *
 * Two modes:
 *   - **Foreground** (default): blocks the parent turn, `await handle.completion`
 *   - **Background**: returns the agent id immediately; the result is delivered
 *     via a notification.
 *
 * `ToolResult.content` is textual; the structured output exposed by
 * `AgentToolOutputSchema` is only used for drift-guard and is not consumed at
 * runtime.
 */

import { sleep } from '@antfu/utils';
import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import type { Logger } from '../../../logging';
import { ToolAccesses } from '../../../loop/tool-access';
import { isAbortError } from '../../../loop/errors';
import type { ExecutableToolContext, ExecutableToolResult, ToolExecution } from '../../../loop/types';
import type { ResolvedAgentProfile } from '../../../profile';
import {
  DEFAULT_SUBAGENT_TIMEOUT_DESCRIPTION,
  DEFAULT_SUBAGENT_TIMEOUT_MS,
  type SessionSubagentHost,
  type SubagentHandle,
} from '../../../session/subagent-host';
import {
  createDeadlineAbortSignal,
  isUserCancellation,
  type DeadlineAbortSignal,
} from '../../../utils/abort';
import { AgentBackgroundTask, type BackgroundManager } from '../../../agent/background';
import { toInputJsonSchema } from '../../support/input-schema';
import { matchesGlobRuleSubject } from '../../support/rule-match';
import type { SubagentResultCache } from '../../../session/subagent-cache';
import AGENT_BACKGROUND_DISABLED_DESCRIPTION from './agent-background-disabled.md?raw';
import AGENT_BACKGROUND_DESCRIPTION from './agent-background-enabled.md?raw';
import AGENT_DESCRIPTION_BASE from './agent.md?raw';

// ── AgentTool input ──────────────────────────────────────────────────

export const AgentToolInputSchema = z.preprocess(
  (input) => {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      return input;
    }
    const record = input as Record<string, unknown>;
    const normalized = { ...record };
    const hasResumeId =
      typeof normalized['resume'] === 'string' && normalized['resume'].trim().length > 0;
    const hasSubagentType =
      typeof normalized['subagent_type'] === 'string' && normalized['subagent_type'].length > 0;
    if (!hasSubagentType && !hasResumeId) {
      normalized['subagent_type'] = 'coder';
    } else if (!hasSubagentType) {
      delete normalized['subagent_type'];
    }
    return normalized;
  },
  z.object({
    prompt: z.string().describe('Full task prompt for the subagent'),
    description: z.string().describe('Short task description (3-5 words) for UI display'),
    subagent_type: z
      .string()
      .optional()
      .describe(
        'One of the available agent types (see "Available agent types" in this tool description). Defaults to "coder" when omitted.',
      ),
    resume: z
      .string()
      .optional()
      .describe('Optional agent ID to resume instead of creating a new instance'),
    run_in_background: z
      .boolean()
      .optional()
      .describe(
        'If true, return immediately without waiting for completion. Prefer false unless the task can run independently and there is a clear benefit to not waiting.',
      ),
    worktree: z
      .boolean()
      .optional()
      .describe(
        'If true, the subagent runs in an isolated git worktree. Use this when the subagent will edit files and you want to avoid conflicts with the parent agent or other subagents. The worktree is cleaned up automatically when the subagent finishes.',
      ),
    token_budget: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Maximum total tokens (input + output) the subagent may consume before being auto-killed. Use this to prevent runaway subagents from exhausting the parent context window.',
      ),
    time_budget_ms: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Maximum wall-clock milliseconds the subagent may run before being auto-killed. Use this to bound latency for time-sensitive tasks.',
      ),
    max_retries: z
      .number()
      .int()
      .min(0)
      .max(3)
      .optional()
      .describe(
        'Maximum number of automatic retries if the subagent fails with a transient error. Retries use exponential backoff. Not applied for user cancellations, timeouts, or budget exhaustion.',
      ),
    retry_delay_ms: z
      .number()
      .int()
      .min(100)
      .max(30000)
      .optional()
      .describe(
        'Base delay in milliseconds between retries. Defaults to 1000ms. Each retry doubles this value (exponential backoff).',
      ),
    stream_updates: z
      .boolean()
      .optional()
      .describe(
        'If true, the parent receives subagent.progress events after each subagent turn, showing partial results before the subagent completes. Use this for long-running subagents where seeing progress is valuable.',
      ),
    use_cache: z
      .boolean()
      .optional()
      .describe(
        'If true, check the subagent result cache before spawning. If an identical task (same profile + prompt + cwd) was recently completed, the cached result is returned instantly. Use this for repetitive or idempotent tasks.',
      ),
    cache_ttl_ms: z
      .number()
      .int()
      .min(1000)
      .max(86400000)
      .optional()
      .describe(
        'How long cached results remain valid in milliseconds. Defaults to 5 minutes (300000ms). Only used when use_cache is true.',
      ),
    fallback_profile: z
      .string()
      .optional()
      .describe(
        'If the subagent fails after all retries, automatically retry once with this fallback profile (e.g. "explore" or "plan"). Use this for self-healing when the primary profile is ill-suited to the task.',
      ),
  }),
);

export type AgentToolInput = z.infer<typeof AgentToolInputSchema>;

// ── AgentTool output ─────────────────────────────────────────────────

export const AgentToolOutputSchema = z.object({
  result: z.string().describe('Aggregated text output from the subagent'),
  usage: z
    .object({
      input: z.number().int().nonnegative(),
      output: z.number().int().nonnegative(),
      cache_read: z.number().int().nonnegative().optional(),
      cache_write: z.number().int().nonnegative().optional(),
    })
    .describe('Cumulative token usage'),
});

export type AgentToolOutput = z.infer<typeof AgentToolOutputSchema>;

const BACKGROUND_AGENT_UNAVAILABLE =
  'Background agent execution is not available for this agent because TaskList, TaskOutput, and TaskStop are not enabled.';

// ── AgentTool class ──────────────────────────────────────────────────

export class AgentTool implements BuiltinTool<AgentToolInput> {
  readonly name: string = 'Agent';
  readonly description: string;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(AgentToolInputSchema);
  constructor(
    private readonly subagentHost: SessionSubagentHost,
    private readonly backgroundManager?: BackgroundManager | undefined,
    subagents?: ResolvedAgentProfile['subagents'] | undefined,
    options?: {
      log?: Logger;
      subagentCache?: SubagentResultCache;
      cwd?: string;
    },
  ) {
    const log = options?.log;
    const typeLines = buildSubagentDescriptions(subagents);
    const baseDescription = `${AGENT_DESCRIPTION_BASE}\n\n${
      this.backgroundManager !== undefined ? AGENT_BACKGROUND_DESCRIPTION : AGENT_BACKGROUND_DISABLED_DESCRIPTION
    }`;
    this.description = typeLines
      ? `${baseDescription}\n\nAvailable agent types (pass via subagent_type):\n${typeLines}`
      : baseDescription;
    this.log = log;
    this.subagentCache = options?.subagentCache;
    this.cwd = options?.cwd;
  }

  private readonly log?: Logger;
  private readonly subagentCache?: SubagentResultCache;
  private readonly cwd?: string;

  async resolveExecution(args: AgentToolInput): Promise<ToolExecution> {
    let profileName = args.subagent_type?.length ? args.subagent_type : 'coder';
    const resumeAgentId = args.resume?.trim();
    if (resumeAgentId !== undefined && resumeAgentId.length > 0) {
      profileName = (await this.subagentHost.getProfileName?.(resumeAgentId)) ?? 'subagent';
    }
    const prefix = args.run_in_background === true ? 'Launching background' : 'Launching';
    return {
      description: `${prefix} ${profileName} agent: ${args.description}`,
      accesses: ToolAccesses.none(),
      display: {
        kind: 'agent_call',
        agent_name: profileName,
        prompt: args.prompt,
        background: args.run_in_background,
      },
      approvalRule: this.name,
      matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, profileName),
      execute: (ctx) => this.execution(args, ctx),
    };
  }

  private async execution(
    args: AgentToolInput,
    {
    toolCallId,
    signal,
    }: ExecutableToolContext,
  ): Promise<ExecutableToolResult> {
    let foregroundDeadline: DeadlineAbortSignal | undefined;
    try {
      signal.throwIfAborted();
      const runInBackground = args.run_in_background === true;
      const requestedProfileName = args.subagent_type?.length ? args.subagent_type : undefined;
      const resumeAgentId = args.resume?.trim();
      if (
        resumeAgentId !== undefined &&
        resumeAgentId.length > 0 &&
        requestedProfileName !== undefined
      ) {
        return {
          output: 'Cannot set subagent_type when resuming an existing agent. Resume by agent id only.',
          isError: true,
        };
      }

      if (runInBackground) {
        if (this.backgroundManager === undefined) {
          return {
            output: BACKGROUND_AGENT_UNAVAILABLE,
            isError: true,
          };
        }
      }

      // Check cache for identical tasks
      const cache = this.subagentCache;
      const cacheTtl = args.cache_ttl_ms ?? 300_000;
      const cacheCwd = this.cwd ?? '';
      if (args.use_cache === true && cache !== undefined && resumeAgentId === undefined) {
        const profileName = requestedProfileName ?? 'coder';
        const cached = cache.get(profileName, cacheCwd, args.prompt);
        if (cached !== undefined) {
          const lines = [
            `agent_id: (cached)`,
            `actual_subagent_type: ${profileName}`,
            'status: completed (from cache)',
            '',
            '[summary]',
            cached.result,
          ];
          if (cached.changes !== undefined && cached.changes.length > 0) {
            lines.push('');
            lines.push('[changes]');
            lines.push(cached.changes);
          }
          return { output: lines.join('\n') };
        }
      }

      const backgroundController = runInBackground ? new AbortController() : undefined;
      foregroundDeadline =
        !runInBackground ? createDeadlineAbortSignal(signal, DEFAULT_SUBAGENT_TIMEOUT_MS) : undefined;

      const options = {
        parentToolCallId: toolCallId,
        prompt: args.prompt,
        description: args.description,
        runInBackground,
        worktree: args.worktree === true,
        signal: backgroundController?.signal ?? foregroundDeadline?.signal ?? signal,
        tokenBudget: args.token_budget,
        timeBudgetMs: args.time_budget_ms,
        streamUpdates: args.stream_updates,
      };

      let handle: SubagentHandle;
      const operation = resumeAgentId !== undefined && resumeAgentId.length > 0 ? 'resume' : 'spawn';
      try {
        if (resumeAgentId !== undefined && resumeAgentId.length > 0) {
          handle = await this.subagentHost.resume(resumeAgentId, options);
        } else {
          const profileName = requestedProfileName ?? 'coder';
          handle = await this.subagentHost.spawn({
            profileName,
            ...options,
          });
        }
      } catch (error) {
        this.log?.warn('subagent launch failed', {
          toolCallId,
          runInBackground,
          operation,
          agentId: resumeAgentId,
          subagentType: operation === 'spawn' ? requestedProfileName ?? 'coder' : undefined,
          error,
        });
        throw error;
      }

      if (runInBackground) {
        let taskId: string;
        try {
          taskId = this.backgroundManager!.registerTask(
            new AgentBackgroundTask(handle.completion, args.description, {
              timeoutMs: DEFAULT_SUBAGENT_TIMEOUT_MS,
              agentId: handle.agentId,
              subagentType: handle.profileName,
              abort: () => {
                backgroundController?.abort();
              },
            }),
          );
        } catch (error) {
          backgroundController?.abort();
          void handle.completion.catch(() => {});
          this.log?.warn('background agent task registration failed', {
            toolCallId,
            agentId: handle.agentId,
            subagentType: handle.profileName,
            error,
          });
          return {
            output: error instanceof Error ? error.message : String(error),
            isError: true,
          };
        }
        const lines = [
          `task_id: ${taskId}`,
          'status: running',
          `agent_id: ${handle.agentId}`,
          `actual_subagent_type: ${handle.profileName}`,
          'automatic_notification: true',
          '',
          `description: ${args.description}`,
          '',
          `next_step: The completion arrives automatically in a later turn — no polling needed. To peek at progress without blocking, call TaskOutput(task_id="${taskId}", block=false).`,
          `resume_hint: To continue or recover this same subagent later, call Agent(resume="${handle.agentId}", prompt="..."). The parameter is agent_id ("${handle.agentId}"), NOT task_id ("${taskId}") or source_id from a later <notification>. Recovery cases: a later <notification type="task.lost" | "task.failed" | "task.killed"> for this subagent — its conversation history is preserved across session restarts and resume will pick it up.`,
        ];
        return { output: lines.join('\n') };
      }

      const maxRetries = args.max_retries ?? 0;
      const baseDelayMs = args.retry_delay_ms ?? 1000;
      let attempt = 0;
      let fallbackAttempted = false;

      while (true) {
        try {
          const result = await handle.completion;

          // Store in cache if caching is enabled
          if (args.use_cache === true && cache !== undefined && resumeAgentId === undefined) {
            cache.set(
              handle.profileName,
              cacheCwd,
              args.prompt,
              {
                result: result.result,
                usage: result.usage,
                changes: result.changes,
                cachedAt: Date.now(),
                ttlMs: cacheTtl,
              },
            );
          }

          const lines = [
            `agent_id: ${handle.agentId}`,
            `actual_subagent_type: ${handle.profileName}`,
            'status: completed',
            '',
            '[summary]',
            result.result,
          ];
          if (result.changes !== undefined && result.changes.length > 0) {
            lines.push('');
            lines.push('[changes]');
            lines.push(result.changes);
          }
          return { output: lines.join('\n') };
        } catch (error) {
          let message: string;
          const timedOut = foregroundDeadline?.timedOut() === true;
          if (timedOut) {
            message = `Agent timed out after ${DEFAULT_SUBAGENT_TIMEOUT_DESCRIPTION}.`;
          } else if (isUserCancellation(signal.reason)) {
            message =
              'The user manually interrupted this subagent (and any sibling agents launched alongside it). This was a deliberate user action, not a system error, a timeout, or a capacity/concurrency limit. Do not retry automatically or speculate about why it failed — wait for the user\'s next instruction.';
          } else if (isAbortError(error)) {
            message = 'The subagent was stopped before it finished.';
          } else {
            message = error instanceof Error ? error.message : String(error);
          }

          // Determine if retryable
          const isRetryable =
            attempt < maxRetries &&
            !isUserCancellation(signal.reason) &&
            !timedOut &&
            !isAbortError(error) &&
            !message.includes('budget');

          if (isRetryable) {
            attempt++;
            const delayMs = baseDelayMs * Math.pow(2, attempt - 1);
            this.log?.info('subagent retry', {
              toolCallId,
              agentId: handle.agentId,
              attempt,
              maxRetries,
              delayMs,
              error: message,
            });
            await sleep(delayMs);
            // Re-spawn the subagent for retry
            try {
              handle = await this.subagentHost.spawn({
                profileName: requestedProfileName ?? 'coder',
                ...options,
                parentToolCallId: toolCallId,
              });
            } catch (spawnError) {
              this.log?.warn('subagent retry spawn failed', {
                toolCallId,
                attempt,
                error: spawnError,
              });
              const lines = [
                `agent_id: ${handle.agentId}`,
                `actual_subagent_type: ${handle.profileName}`,
                'status: failed',
                '',
                `subagent error: ${message}`,
                `retry attempt ${attempt} failed: ${spawnError instanceof Error ? spawnError.message : String(spawnError)}`,
              ];
              if (timedOut) {
                lines.push(
                  `resume_hint: Continue with Agent(resume="${handle.agentId}", prompt="continue"). Use agent_id only; do not set subagent_type. The subagent retains its prior context; redo any unfinished tool call if its result was lost.`,
                );
              }
              return { output: lines.join('\n'), isError: true };
            }
            continue;
          }

          // Self-healing: try fallback profile once if set and not yet attempted
          const fallbackProfile = args.fallback_profile?.trim();
          if (
            fallbackProfile !== undefined &&
            fallbackProfile.length > 0 &&
            !fallbackAttempted &&
            !isUserCancellation(signal.reason) &&
            !timedOut &&
            !isAbortError(error) &&
            !message.includes('budget')
          ) {
            fallbackAttempted = true;
            this.log?.info('subagent fallback profile', {
              toolCallId,
              failedProfile: handle.profileName,
              fallbackProfile,
              error: message,
            });
            try {
              handle = await this.subagentHost.spawn({
                profileName: fallbackProfile,
                ...options,
                parentToolCallId: toolCallId,
              });
              attempt = 0; // reset retries for the fallback
              continue;
            } catch (spawnError) {
              this.log?.warn('subagent fallback spawn failed', {
                toolCallId,
                fallbackProfile,
                error: spawnError,
              });
              const lines = [
                `agent_id: ${handle.agentId}`,
                `actual_subagent_type: ${handle.profileName}`,
                'status: failed',
                '',
                `subagent error: ${message}`,
                `fallback profile "${fallbackProfile}" spawn failed: ${spawnError instanceof Error ? spawnError.message : String(spawnError)}`,
              ];
              if (timedOut) {
                lines.push(
                  `resume_hint: Continue with Agent(resume="${handle.agentId}", prompt="continue"). Use agent_id only; do not set subagent_type. The subagent retains its prior context; redo any unfinished tool call if its result was lost.`,
                );
              }
              return { output: lines.join('\n'), isError: true };
            }
          }

          const lines = [
            `agent_id: ${handle.agentId}`,
            `actual_subagent_type: ${handle.profileName}`,
            'status: failed',
            '',
            `subagent error: ${message}`,
          ];
          if (timedOut) {
            lines.push(
              `resume_hint: Continue with Agent(resume="${handle.agentId}", prompt="continue"). Use agent_id only; do not set subagent_type. The subagent retains its prior context; redo any unfinished tool call if its result was lost.`,
            );
          }
          return { output: lines.join('\n'), isError: true };
        }
      }
    } catch (error) {
      let message: string;
      if (foregroundDeadline?.timedOut() === true) {
        message = `Agent timed out after ${DEFAULT_SUBAGENT_TIMEOUT_DESCRIPTION}.`;
      } else if (isUserCancellation(signal.reason)) {
        message =
          'The user manually interrupted this subagent (and any sibling agents launched alongside it). This was a deliberate user action, not a system error, a timeout, or a capacity/concurrency limit. Do not retry automatically or speculate about why it failed — wait for the user\'s next instruction.';
      } else if (isAbortError(error)) {
        message = 'The subagent was stopped before it finished.';
      } else {
        message = error instanceof Error ? error.message : String(error);
      }
      return { output: `subagent error: ${message}`, isError: true };
    } finally {
      foregroundDeadline?.clear();
    }
  }
}

function buildSubagentDescriptions(subagents: ResolvedAgentProfile['subagents']): string {
  if (subagents === undefined) return '';
  return Object.entries(subagents)
    .map(([name, subagent]) => {
      const details = [subagent.description, subagent.whenToUse].filter(
        (part): part is string => part !== undefined && part.length > 0,
      );
      const header = details.length === 0 ? `- ${name}` : `- ${name}: ${details.join(' ')}`;
      if (subagent.tools.length === 0) return header;
      return `${header}\n  Tools: ${subagent.tools.join(', ')}`;
    })
    .join('\n');
}
