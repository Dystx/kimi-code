/**
 * OrchestrationPanel — detailed live view of session orchestration state.
 *
 * Mounts into the editor container (like HelpPanel / ApprovalPanel) and
 * shows the full plan tracker, active subagents, hooks, health metrics,
 * and background tasks. Dismiss with Esc / Enter / q.
 */

import {
  Container,
  matchesKey,
  Key,
  decodeKittyPrintable,
  type Focusable,
  truncateToWidth,
  visibleWidth,
} from '@earendil-works/pi-tui';
import chalk from 'chalk';

import type { ColorPalette } from '#/tui/theme/colors';
import { formatTokenCount } from '#/utils/usage/usage-format';
import type { SessionStatusSnapshot } from '@moonshot-ai/kimi-code-sdk';

export interface OrchestrationPanelOptions {
  readonly snapshot: SessionStatusSnapshot | null | undefined;
  readonly colors: ColorPalette;
  readonly onClose: () => void;
  /** Terminal height — used to decide the scroll window. */
  readonly maxVisible?: number;
}

const PLAN_STATUS_ICONS: Record<string, string> = {
  pending: '○',
  in_progress: '●',
  done: '✓',
  blocked: '⊘',
  skipped: '−',
};

const PLAN_STATUS_COLORS: Record<string, keyof ColorPalette> = {
  pending: 'textDim',
  in_progress: 'primary',
  done: 'success',
  blocked: 'warning',
  skipped: 'textMuted',
};

function formatElapsed(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
}

export class OrchestrationPanelComponent extends Container implements Focusable {
  focused = false;
  private readonly opts: OrchestrationPanelOptions;
  private scrollTop = 0;

  constructor(opts: OrchestrationPanelOptions) {
    super();
    this.opts = opts;
  }

  handleInput(data: string): void {
    const printable = decodeKittyPrintable(data) ?? data;
    if (
      matchesKey(data, Key.escape) ||
      matchesKey(data, Key.enter) ||
      printable === 'q' ||
      printable === 'Q'
    ) {
      this.opts.onClose();
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.scrollTop = Math.max(0, this.scrollTop - 1);
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.scrollTop += 1;
      return;
    }
    if (matchesKey(data, Key.pageUp)) {
      this.scrollTop = Math.max(0, this.scrollTop - 10);
      return;
    }
    if (matchesKey(data, Key.pageDown)) {
      this.scrollTop += 10;
    }
  }

  override render(width: number): string[] {
    const colors = this.opts.colors;
    const accent = chalk.hex(colors.primary);
    const dim = chalk.hex(colors.textDim);
    const muted = chalk.hex(colors.textMuted);
    const warn = chalk.hex(colors.warning);
    const err = chalk.hex(colors.error);
    const ok = chalk.hex(colors.success);

    const snap = this.opts.snapshot;
    const lines: string[] = [
      accent('─'.repeat(width)),
      accent.bold(' orchestration ') + muted('· Esc / Enter / q to close · ↑↓ scroll'),
      '',
    ];

    if (snap === null || snap === undefined) {
      lines.push(`  ${muted('No orchestration data available.')}`);
      lines.push('');
      lines.push(accent('─'.repeat(width)));
      return lines.map((l) => truncateToWidth(l, width));
    }

    // ── Plan ──
    if (snap.plan !== null) {
      lines.push(`  ${chalk.bold('Plan')}: ${accent(snap.plan.title)}`);
      const pct = snap.plan.totalTasks > 0
        ? Math.round((snap.plan.doneTasks / snap.plan.totalTasks) * 100)
        : 0;
      lines.push(
        `    ${dim(`${pct}% complete · ${snap.plan.doneTasks}/${snap.plan.totalTasks} tasks`)}`,
      );
      if (snap.plan.currentTaskTitle !== undefined) {
        lines.push(`    ${accent('▸')} ${snap.plan.currentTaskTitle}`);
      }
      lines.push('');
    }

    // ── Active Subagents ──
    if (snap.activeSubagents.length > 0) {
      lines.push(`  ${chalk.bold('Active Subagents')}`);
      const now = Date.now();
      for (const agent of snap.activeSubagents) {
        lines.push(
          `    ${accent('●')} ${agent.profileName}  ${muted(`running for ${formatElapsed(now - agent.startedAt)}`)}`,
        );
      }
      lines.push('');
    } else if (snap.subagents > 0) {
      // Subagent count > 0 but no active ones (all terminal)
      lines.push(`  ${chalk.bold('Subagents')}: ${muted(`${String(snap.subagents)} active (all terminal)`)}`);
      lines.push('');
    }

    // ── Hooks ──
    if (snap.hookSummary !== null && Object.keys(snap.hookSummary).length > 0) {
      lines.push(`  ${chalk.bold('Hooks')}`);
      for (const [event, count] of Object.entries(snap.hookSummary)) {
        lines.push(`    ${dim(`${event}:`)} ${String(count)}`);
      }
      lines.push('');
    } else if (snap.hooks > 0) {
      lines.push(`  ${chalk.bold('Hooks')}: ${String(snap.hooks)} registered`);
      lines.push('');
    }

    // ── Health ──
    if (snap.health !== null) {
      lines.push(`  ${chalk.bold('Health')}`);
      const burn = `${formatTokenCount(Math.round(snap.health.tokenBurnRate))}/min`;
      const avgTurn = `${(snap.health.avgTurnDuration / 1000).toFixed(1)}s/turn`;
      const errRate = `${(snap.health.errorRate * 100).toFixed(0)}%`;
      const burnColor = snap.health.tokenBurnRate > 5000 ? warn : dim;
      const errColor = snap.health.errorRate > 0.05 ? err : dim;
      lines.push(
        `    ${burnColor(`token burn: ${burn}`)}  ${dim(`avg turn: ${avgTurn}`)}  ${errColor(`errors: ${errRate}`)}`,
      );
      lines.push('');
    }

    // ── Tasks ──
    if (snap.tasks.total > 0) {
      lines.push(`  ${chalk.bold('Tasks')}`);
      lines.push(
        `    ${snap.tasks.total} total · ${snap.tasks.pending} pending · ${snap.tasks.done} done · ${snap.tasks.blocked} blocked`,
      );
      lines.push('');
    }

    // ── Background Tasks ──
    if (snap.backgroundTasks > 0) {
      lines.push(`  ${chalk.bold('Background')}: ${String(snap.backgroundTasks)} task${snap.backgroundTasks > 1 ? 's' : ''}`);
      lines.push('');
    }

    // ── File Locks ──
    if (snap.locks > 0) {
      lines.push(`  ${chalk.bold('File Locks')}: ${warn(String(snap.locks))}`);
      lines.push('');
    }

    // ── Loop ──
    if (snap.loop !== null) {
      lines.push(`  ${chalk.bold('Loop')}: "${snap.loop.task}" — ${snap.loop.iteration}/${snap.loop.maxIterations}`);
      lines.push('');
    }

    // ── Goal ──
    if (snap.goal !== null) {
      lines.push(`  ${chalk.bold('Goal')}: ${ok(snap.goal.status)} · ${snap.goal.objective}`);
      lines.push('');
    }

    // ── Cost ──
    if (snap.cost !== null) {
      const budget = snap.cost.budgetRemaining !== undefined
        ? ` / $${snap.cost.budgetRemaining.toFixed(2)} remaining`
        : '';
      const costColor = (snap.cost.fractionUsed ?? 0) > 0.7 ? warn : dim;
      lines.push(`  ${chalk.bold('Cost')}: ${costColor(`$${snap.cost.totalDollars.toFixed(4)}${budget}`)}`);
      lines.push('');
    }

    lines.push(accent('─'.repeat(width)));

    // Apply scroll windowing — keep the borders visible.
    const content = lines.slice(1, lines.length - 1);
    const maxVisible = Math.max(5, this.opts.maxVisible ?? 24);
    if (content.length > maxVisible) {
      this.scrollTop = Math.max(0, Math.min(this.scrollTop, content.length - maxVisible));
      const slice = content.slice(this.scrollTop, this.scrollTop + maxVisible);
      const scrollInfo = muted(
        ` showing ${String(this.scrollTop + 1)}-${String(this.scrollTop + slice.length)} of ${String(content.length)}`,
      );
      return [lines[0] ?? '', ...slice, scrollInfo, lines.at(-1) ?? ''].map((line) =>
        truncateToWidth(line, width),
      );
    }
    this.scrollTop = 0;
    return lines.map((line) => truncateToWidth(line, width));
  }
}
