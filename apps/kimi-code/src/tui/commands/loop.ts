/**
 * /loop — iterative verify-fix loop command.
 *
 * Usage:
 *   /loop <task description> [--verify <command>] [--max <n>]
 *
 * Examples:
 *   /loop fix all TypeScript errors
 *   /loop implement the auth middleware --verify "npm test auth"
 *   /loop refactor utils to async --verify "pnpm lint && pnpm test" --max 5
 *
 * The command sends a structured instruction that tells the agent to:
 * 1. Work on the task
 * 2. Run the verification command (if provided)
 * 3. If verification fails, analyze errors, fix, and retry
 * 4. Repeat up to max iterations (default 5)
 * 5. Report final result
 */

import type { SlashCommandHost } from './dispatch';

export interface ParsedLoopCommand {
  readonly task: string;
  readonly verifyCommand?: string;
  readonly maxIterations: number;
}

const DEFAULT_MAX_ITERATIONS = 5;
const MAX_MAX_ITERATIONS = 20;

export function parseLoopCommand(rawArgs: string): ParsedLoopCommand | { readonly error: string } {
  const args = rawArgs.trim();
  if (args.length === 0) {
    return {
      error: 'Provide a task, e.g. `/loop fix the failing tests`. Optional: `--verify "npm test"` and `--max 5`.',
    };
  }

  let verifyCommand: string | undefined;
  let maxIterations = DEFAULT_MAX_ITERATIONS;
  let taskParts: string[] = [];

  const tokens = args.split(/\s+/);
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i]!;
    if (token === '--verify') {
      i++;
      const cmdToken = tokens[i];
      if (cmdToken === undefined || !cmdToken.startsWith('"')) {
        return { error: '--verify requires a quoted command, e.g. `--verify "npm test"`.' };
      }
      // Accumulate tokens until closing quote
      let cmd = cmdToken.slice(1);
      i++;
      while (i < tokens.length && !tokens[i - 1]!.endsWith('"')) {
        cmd += ' ' + tokens[i]!;
        i++;
      }
      verifyCommand = cmd.replace(/"$/, '');
    } else if (token === '--max') {
      i++;
      const maxToken = tokens[i];
      if (maxToken === undefined) {
        return { error: '--max requires a number, e.g. `--max 5`.' };
      }
      const n = parseInt(maxToken, 10);
      if (isNaN(n) || n < 1 || n > MAX_MAX_ITERATIONS) {
        return { error: `--max must be between 1 and ${MAX_MAX_ITERATIONS}.` };
      }
      maxIterations = n;
      i++;
    } else {
      taskParts.push(token);
      i++;
    }
  }

  const task = taskParts.join(' ').trim();
  if (task.length === 0) {
    return { error: 'Task description is required before any flags.' };
  }

  return { task, verifyCommand, maxIterations };
}

export async function handleLoopCommand(host: SlashCommandHost, args: string): Promise<void> {
  const parsed = parseLoopCommand(args);
  if ('error' in parsed) {
    host.showError(parsed.error);
    return;
  }

  const session = host.session;
  if (host.state.appState.model.trim().length === 0 || session === undefined) {
    host.showError('No model configured. Set a model first.');
    return;
  }

  const lines: string[] = [
    `Task (iterative loop, max ${parsed.maxIterations} attempts):`,
    parsed.task,
  ];

  if (parsed.verifyCommand) {
    lines.push(
      '',
      `After each attempt, run this verification command:`,
      `\`\`\`bash`,
      parsed.verifyCommand,
      `\`\`\``,
      '',
      `If the verification fails, analyze the output, fix the issues, and retry. ` +
        `Stop when verification passes or after ${parsed.maxIterations} attempts. ` +
        `Report the final result (success or failure with remaining issues).`,
    );
  } else {
    lines.push(
      '',
      `Work iteratively. After each significant change, verify your work (run tests, lint, typecheck, or review the output). ` +
        `If something is wrong, fix it and retry. Stop when the task is complete or after ${parsed.maxIterations} attempts.`,
    );
  }

  const message = lines.join('\n');

  // Track loop state in TUI for footer badges
  host.setAppState({
    loopState: { task: parsed.task, iteration: 1, maxIterations: parsed.maxIterations },
  });

  host.sendNormalUserInput(message);
}
