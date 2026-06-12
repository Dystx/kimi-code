/**
 * SessionOutcomeTracker — circular learning core.
 *
 * Records every tool call, subagent outcome, and turn result.
 * Feeds the reflection engine and performance reports.
 *
 * The circular loop:
 *   Agent acts → outcomes tracked → reflections written to memory
 *   → next session reads memory → agent adapts → repeat
 */

export interface ToolOutcome {
  readonly toolName: string;
  readonly isError: boolean;
  readonly timestamp: number;
  readonly durationMs?: number;
}

export interface SubagentOutcome {
  readonly profileName: string;
  readonly isError: boolean;
  readonly timestamp: number;
  readonly tokenUsage?: { input: number; output: number };
  readonly durationMs?: number;
  readonly fallbackUsed?: boolean;
  readonly cached?: boolean;
}

export interface TurnOutcome {
  readonly turnId: number;
  readonly steps: number;
  readonly stopReason: string;
  readonly failed: boolean;
  readonly durationMs: number;
  readonly timestamp: number;
}

export interface PlanTaskOutcome {
  readonly taskTitle: string;
  readonly planId: string;
  readonly completed: boolean;
  readonly timestamp: number;
}

export interface PerformanceSnapshot {
  readonly totalToolCalls: number;
  readonly toolErrors: number;
  readonly toolSuccessRate: number;
  readonly totalSubagents: number;
  readonly subagentErrors: number;
  readonly subagentSuccessRate: number;
  readonly totalTurns: number;
  readonly turnErrors: number;
  readonly topTools: Array<{ name: string; count: number; errorRate: number }>;
  readonly topSubagents: Array<{ name: string; count: number; errorRate: number }>;
  readonly totalPlanTasks: number;
  readonly completedPlanTasks: number;
  readonly windowMinutes: number;
}

const DEFAULT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const MAX_OUTCOMES = 500;

export class SessionOutcomeTracker {
  private toolOutcomes: ToolOutcome[] = [];
  private subagentOutcomes: SubagentOutcome[] = [];
  private turnOutcomes: TurnOutcome[] = [];
  private planTaskOutcomes: PlanTaskOutcome[] = [];

  recordTool(toolName: string, isError: boolean, durationMs?: number): void {
    this.toolOutcomes.push({ toolName, isError, timestamp: Date.now(), durationMs });
    if (this.toolOutcomes.length > MAX_OUTCOMES) {
      this.toolOutcomes.shift();
    }
  }

  recordSubagent(
    profileName: string,
    isError: boolean,
    options: {
      tokenUsage?: { input: number; output: number };
      durationMs?: number;
      fallbackUsed?: boolean;
      cached?: boolean;
    } = {},
  ): void {
    this.subagentOutcomes.push({
      profileName,
      isError,
      timestamp: Date.now(),
      tokenUsage: options.tokenUsage,
      durationMs: options.durationMs,
      fallbackUsed: options.fallbackUsed,
      cached: options.cached,
    });
    if (this.subagentOutcomes.length > MAX_OUTCOMES) {
      this.subagentOutcomes.shift();
    }
  }

  recordTurn(turnId: number, steps: number, stopReason: string, failed: boolean, durationMs: number): void {
    this.turnOutcomes.push({ turnId, steps, stopReason, failed, durationMs, timestamp: Date.now() });
    if (this.turnOutcomes.length > MAX_OUTCOMES) {
      this.turnOutcomes.shift();
    }
  }

  recordPlanTask(taskTitle: string, planId: string, completed: boolean): void {
    this.planTaskOutcomes.push({ taskTitle, planId, completed, timestamp: Date.now() });
    if (this.planTaskOutcomes.length > MAX_OUTCOMES) {
      this.planTaskOutcomes.shift();
    }
  }

  snapshot(windowMs = DEFAULT_WINDOW_MS): PerformanceSnapshot {
    const now = Date.now();
    const cutoff = now - windowMs;

    const recentTools = this.toolOutcomes.filter((o) => o.timestamp >= cutoff);
    const recentSubagents = this.subagentOutcomes.filter((o) => o.timestamp >= cutoff);
    const recentTurns = this.turnOutcomes.filter((o) => o.timestamp >= cutoff);
    const recentPlanTasks = this.planTaskOutcomes.filter((o) => o.timestamp >= cutoff);

    const toolErrors = recentTools.filter((o) => o.isError).length;
    const subagentErrors = recentSubagents.filter((o) => o.isError).length;
    const turnErrors = recentTurns.filter((o) => o.failed).length;

    const topTools = this.aggregateByName(recentTools, 'toolName');
    const topSubagents = this.aggregateByName(recentSubagents, 'profileName');

    return {
      totalToolCalls: recentTools.length,
      toolErrors,
      toolSuccessRate: recentTools.length > 0 ? 1 - toolErrors / recentTools.length : 1,
      totalSubagents: recentSubagents.length,
      subagentErrors,
      subagentSuccessRate: recentSubagents.length > 0 ? 1 - subagentErrors / recentSubagents.length : 1,
      totalTurns: recentTurns.length,
      turnErrors,
      topTools,
      topSubagents,
      totalPlanTasks: recentPlanTasks.length,
      completedPlanTasks: recentPlanTasks.filter((o) => o.completed).length,
      windowMinutes: windowMs / 60000,
    };
  }

  generateReflection(): string {
    const snap = this.snapshot(DEFAULT_WINDOW_MS);
    const lines: string[] = [
      `# Session Reflection (${new Date().toISOString()})`,
      '',
      `## Outcomes (last ${snap.windowMinutes} min)`,
      `- Tool calls: ${snap.totalToolCalls} (${snap.toolErrors} errors, ${Math.round(snap.toolSuccessRate * 100)}% success)`,
      `- Subagents: ${snap.totalSubagents} (${snap.subagentErrors} errors, ${Math.round(snap.subagentSuccessRate * 100)}% success)`,
      `- Turns: ${snap.totalTurns} (${snap.turnErrors} failed)`,
      `- Plan tasks: ${snap.totalPlanTasks} (${snap.completedPlanTasks} completed)`,
      '',
    ];

    if (snap.topTools.length > 0) {
      lines.push('## Top Tools');
      for (const t of snap.topTools.slice(0, 5)) {
        lines.push(`- ${t.name}: ${t.count} calls, ${Math.round(t.errorRate * 100)}% error rate`);
      }
      lines.push('');
    }

    if (snap.topSubagents.length > 0) {
      lines.push('## Top Subagent Profiles');
      for (const s of snap.topSubagents.slice(0, 5)) {
        lines.push(`- ${s.name}: ${s.count} spawns, ${Math.round(s.errorRate * 100)}% error rate`);
      }
      lines.push('');
    }

    // Find problematic patterns
    const problematicTools = snap.topTools.filter((t) => t.errorRate > 0.3 && t.count >= 3);
    const problematicProfiles = snap.topSubagents.filter((s) => s.errorRate > 0.3 && s.count >= 2);

    if (problematicTools.length > 0 || problematicProfiles.length > 0) {
      lines.push('## Issues to Address');
      for (const t of problematicTools) {
        lines.push(`- Tool "${t.name}" fails ${Math.round(t.errorRate * 100)}% of the time. Review inputs or add validation.`);
      }
      for (const s of problematicProfiles) {
        lines.push(`- Subagent "${s.name}" fails ${Math.round(s.errorRate * 100)}% of the time. Consider a different profile or better prompts.`);
      }
      lines.push('');
    }

    lines.push('---');
    return lines.join('\n');
  }

  private aggregateByName<T extends Record<string, any>>(
    items: T[],
    nameKey: keyof T,
  ): Array<{ name: string; count: number; errorRate: number }> {
    const byName = new Map<string, { count: number; errors: number }>();
    for (const item of items) {
      const name = String(item[nameKey]);
      const entry = byName.get(name) ?? { count: 0, errors: 0 };
      entry.count++;
      if (item['isError' as keyof T]) entry.errors++;
      byName.set(name, entry);
    }
    return Array.from(byName.entries())
      .map(([name, { count, errors }]) => ({ name, count, errorRate: count > 0 ? errors / count : 0 }))
      .toSorted((a, b) => b.count - a.count);
  }
}
