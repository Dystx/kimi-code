/**
 * /status — show a full session status panel in the transcript.
 */

import chalk from 'chalk';
import type { SlashCommandHost } from './dispatch';

export interface ParsedStatusCommand {
  readonly filter?: 'tasks' | 'cost' | 'health' | 'all';
}

export function parseStatusCommand(rawArgs: string): ParsedStatusCommand | { readonly error: string } {
  const args = rawArgs.trim();
  if (args.length === 0) return { filter: 'all' };

  switch (args.toLowerCase()) {
    case 'tasks':
      return { filter: 'tasks' };
    case 'cost':
      return { filter: 'cost' };
    case 'health':
      return { filter: 'health' };
    case 'all':
      return { filter: 'all' };
    default:
      return { error: `Unknown status filter: "${args}". Use tasks, cost, health, or all.` };
  }
}

export async function handleStatusCommand(host: SlashCommandHost, args: string): Promise<void> {
  const parsed = parseStatusCommand(args);
  if ('error' in parsed) {
    host.showError(parsed.error);
    return;
  }

  const snapshot = host.state.appState.statusSnapshot;
  if (snapshot === null || snapshot === undefined) {
    host.showStatus('No status snapshot available yet.');
    return;
  }

  const lines: string[] = [];

  if (parsed.filter === 'all' || parsed.filter === 'tasks') {
    if (snapshot.tasks.total > 0) {
      lines.push(
        `Tasks: ${snapshot.tasks.total} total (${snapshot.tasks.pending} pending, ${snapshot.tasks.done} done, ${snapshot.tasks.blocked} blocked)`,
      );
    }
  }

  if (parsed.filter === 'all') {
    if (snapshot.goal !== null) {
      lines.push(`Goal: ${snapshot.goal.status} · ${snapshot.goal.objective}`);
    }
    if (snapshot.loop !== null) {
      lines.push(
        `Loop: "${snapshot.loop.task}" — iteration ${snapshot.loop.iteration}/${snapshot.loop.maxIterations}`,
      );
    }
    if (snapshot.locks > 0) {
      lines.push(`File Locks: ${snapshot.locks} active`);
    }
  }

  if (parsed.filter === 'all' || parsed.filter === 'health') {
    if (snapshot.health !== null) {
      lines.push(
        `Health: ${Math.round(snapshot.health.tokenBurnRate)} tokens/min, ` +
          `${(snapshot.health.avgTurnDuration / 1000).toFixed(1)}s avg turn, ` +
          `${(snapshot.health.errorRate * 100).toFixed(0)}% errors`,
      );
    }
  }

  if (parsed.filter === 'all' || parsed.filter === 'cost') {
    if (snapshot.cost !== null) {
      const budget =
        snapshot.cost.budgetRemaining !== undefined
          ? ` / $${snapshot.cost.budgetRemaining.toFixed(2)} remaining`
          : '';
      lines.push(`Cost: $${snapshot.cost.totalDollars.toFixed(4)}${budget}`);
    }
  }

  if (parsed.filter === 'all') {
    if (snapshot.backgroundTasks > 0) {
      lines.push(`Background: ${snapshot.backgroundTasks} tasks`);
    }
    if (snapshot.subagents > 0) {
      lines.push(`Subagents: ${snapshot.subagents} active`);
    }
    if (snapshot.hooks > 0) {
      lines.push(`Hooks: ${snapshot.hooks} registered`);
    }
    lines.push(
      `Context: ${(snapshot.contextUsage * 100).toFixed(1)}% ` +
        `(${snapshot.contextTokens.toLocaleString()} / ${snapshot.maxContextTokens.toLocaleString()} tokens)`,
    );
  }

  if (lines.length === 0) {
    lines.push('No active status to display.');
  }

  // Render as a bordered status block in the transcript
  const { StatusMessageComponent } = await import('../components/messages/status-message');
  host.state.transcriptContainer.addChild(
    new StatusMessageComponent(lines.join('\n'), host.state.theme.colors),
  );
  host.state.ui.requestRender();
}
