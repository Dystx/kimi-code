/**
 * SessionStatusSnapshot — a point-in-time view of everything active in the session.
 *
 * Emitted as `session.status` events so the TUI can render a live dashboard.
 */

import type { GoalSnapshot } from '#/agent/goal';

export interface SessionStatusSnapshot {
  // Goals
  readonly goal: GoalSnapshot | null;
  readonly queuedGoals: number;

  // Tasks (from SessionTaskRegistry)
  readonly tasks: {
    readonly total: number;
    readonly pending: number;
    readonly done: number;
    readonly blocked: number;
  };

  // Plans (from PlanTracker)
  readonly plan: {
    readonly title: string;
    readonly totalTasks: number;
    readonly doneTasks: number;
  } | null;

  // Loops (from /loop command)
  readonly loop: {
    readonly task: string;
    readonly iteration: number;
    readonly maxIterations: number;
  } | null;

  // File locks
  readonly locks: number;

  // Health (from SessionHealthMonitor)
  readonly health: {
    readonly tokenBurnRate: number;
    readonly avgTurnDuration: number;
    readonly errorRate: number;
  } | null;

  // Cost (from SessionCostTracker)
  readonly cost: {
    readonly totalDollars: number;
    readonly budgetRemaining?: number;
    readonly fractionUsed?: number;
  } | null;

  // Background tasks
  readonly backgroundTasks: number;

  // Subagents
  readonly subagents: number;

  // Hooks
  readonly hooks: number;

  // Context
  readonly contextUsage: number;
  readonly contextTokens: number;
  readonly maxContextTokens: number;
}
