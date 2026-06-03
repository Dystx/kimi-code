/**
 * Hook management tools — dynamically register, list, and remove session hooks.
 *
 * Hooks are deterministic guardrails that fire at specific lifecycle events.
 * Unlike CLAUDE.md instructions which are advisory, hooks ALWAYS execute.
 */

import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import { ToolAccesses } from '../../../loop/tool-access';
import type { ExecutableToolResult, ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';
import type { HookEngine } from '../../../session/hooks/engine';
import { HOOK_EVENT_TYPES } from '../../../session/hooks/types';

// ── RegisterHook ─────────────────────────────────────────────────────

export const RegisterHookInputSchema = z.object({
  event: z
    .enum(HOOK_EVENT_TYPES)
    .describe('Lifecycle event to hook into. Hooks fire deterministically when this event occurs.'),
  command: z
    .string()
    .describe(
      'Shell command to execute when the hook fires. The command receives event data as JSON on stdin. Exit 0 to allow, exit 2 to block (for blocking events), any other exit to allow.',
    ),
  matcher: z
    .string()
    .optional()
    .describe(
      'Optional regex pattern. The hook only fires when the event\'s matcher value (e.g. tool name) matches this pattern. Empty matches everything.',
    ),
  timeout: z
    .number()
    .int()
    .min(1)
    .max(600)
    .optional()
    .describe('Maximum seconds the hook command may run. Defaults to 30.'),
});

export type RegisterHookInput = z.infer<typeof RegisterHookInputSchema>;

export class RegisterHookTool implements BuiltinTool<RegisterHookInput> {
  readonly name = 'RegisterHook';
  readonly description =
    'Dynamically register a lifecycle hook that fires deterministically at a specific event (e.g. PreToolUse, PostToolUse, UserPromptSubmit). Hooks ALWAYS execute — unlike advisory instructions, they are guaranteed to run. Use this to add guardrails, logging, or automation mid-session.';
  readonly parameters: Record<string, unknown> = toInputJsonSchema(RegisterHookInputSchema);

  constructor(private readonly hooks: HookEngine) {}

  resolveExecution(args: RegisterHookInput): ToolExecution {
    return {
      description: `Registering ${args.event} hook`,
      accesses: ToolAccesses.none(),
      approvalRule: this.name,
      execute: () => this.execution(args),
    };
  }

  private execution(args: RegisterHookInput): Promise<ExecutableToolResult> {
    const id = this.hooks.register({
      event: args.event,
      command: args.command,
      matcher: args.matcher,
      timeout: args.timeout,
    });
    return Promise.resolve({
      output: `Hook registered: ${id}\nevent: ${args.event}\nmatcher: ${args.matcher ?? '(any)'}\ncommand: ${args.command}`,
    });
  }
}

// ── ListHooks ────────────────────────────────────────────────────────

export const ListHooksInputSchema = z.object({
  event: z
    .string()
    .optional()
    .describe('Filter by event type. Omit to list all hooks.'),
});

export type ListHooksInput = z.infer<typeof ListHooksInputSchema>;

export class ListHooksTool implements BuiltinTool<ListHooksInput> {
  readonly name = 'ListHooks';
  readonly description =
    'List all active session hooks with their IDs, events, matchers, and commands. Use this to inspect current guardrails before registering new ones or to find a hook ID for removal.';
  readonly parameters: Record<string, unknown> = toInputJsonSchema(ListHooksInputSchema);

  constructor(private readonly hooks: HookEngine) {}

  resolveExecution(_args: ListHooksInput): ToolExecution {
    return {
      description: 'Listing active hooks',
      accesses: ToolAccesses.none(),
      approvalRule: this.name,
      execute: () => this.execution(),
    };
  }

  private execution(): Promise<ExecutableToolResult> {
    const hooks = this.hooks.list();
    if (hooks.length === 0) {
      return Promise.resolve({ output: 'No active hooks.' });
    }
    const lines = ['Active Hooks', '============', ''];
    for (const { id, hook } of hooks) {
      lines.push(`id: ${id}`);
      lines.push(`  event: ${hook.event}`);
      lines.push(`  matcher: ${hook.matcher ?? '(any)'}`);
      lines.push(`  command: ${hook.command}`);
      lines.push(`  timeout: ${hook.timeout ?? 30}s`);
      lines.push('');
    }
    return Promise.resolve({ output: lines.join('\n') });
  }
}

// ── RemoveHook ───────────────────────────────────────────────────────

export const RemoveHookInputSchema = z.object({
  hook_id: z.string().describe('The ID of the hook to remove, as returned by RegisterHook or ListHooks.'),
});

export type RemoveHookInput = z.infer<typeof RemoveHookInputSchema>;

export class RemoveHookTool implements BuiltinTool<RemoveHookInput> {
  readonly name = 'RemoveHook';
  readonly description =
    'Remove a dynamically registered hook by ID. Use this to disable guardrails or clean up temporary hooks.';
  readonly parameters: Record<string, unknown> = toInputJsonSchema(RemoveHookInputSchema);

  constructor(private readonly hooks: HookEngine) {}

  resolveExecution(args: RemoveHookInput): ToolExecution {
    return {
      description: `Removing hook ${args.hook_id}`,
      accesses: ToolAccesses.none(),
      approvalRule: this.name,
      execute: () => this.execution(args),
    };
  }

  private execution(args: RemoveHookInput): Promise<ExecutableToolResult> {
    const removed = this.hooks.remove(args.hook_id);
    if (removed) {
      return Promise.resolve({ output: `Hook ${args.hook_id} removed.` });
    }
    return Promise.resolve({ output: `Hook ${args.hook_id} not found.`, isError: true });
  }
}
