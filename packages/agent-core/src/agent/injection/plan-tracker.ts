import type { ContextMessage } from '#/agent/context';
import { DynamicInjector } from './injector';

const PLAN_TRACKER_VARIANT = 'plan_tracker';
const PLAN_TRACKER_REMINDER_TURNS = 8;

/**
 * Injects the current plan-tracker summary into context so the LLM never
 * loses sight of the approved plan, even after full compaction.
 *
 * Injection cadence:
 *  - Immediately after plan mode exits (first injection)
 *  - After every compaction (via onContextCompacted → re-inject next turn)
 *  - Every N assistant turns as a refresh
 */
export class PlanTrackerInjector extends DynamicInjector {
  protected override readonly injectionVariant = PLAN_TRACKER_VARIANT;
  private compactedSinceLastInject = false;



  override onContextCompacted(_compactedCount: number): void {
    super.onContextCompacted(_compactedCount);
    this.compactedSinceLastInject = true;
  }

  override onContextClear(): void {
    super.onContextClear();
    this.compactedSinceLastInject = false;
  }

  protected override getInjection(): string | undefined {
    const tracker = this.agent.planTracker;
    if (!tracker.isActive || tracker.isComplete) return undefined;

    // Always inject right after compaction.
    if (this.compactedSinceLastInject) {
      this.compactedSinceLastInject = false;
      return tracker.getSummaryText();
    }

    // Inject on first opportunity after plan becomes active.
    if (this.injectedAt === null) {
      return tracker.getSummaryText();
    }

    // Periodic refresh every N assistant turns.
    const turnsSince = assistantTurnsSince(this.agent.context.history, this.injectedAt);
    if (turnsSince >= PLAN_TRACKER_REMINDER_TURNS) {
      return tracker.getSummaryText();
    }

    return undefined;
  }
}

function assistantTurnsSince(history: readonly ContextMessage[], injectedAt: number): number {
  let count = 0;
  for (let i = injectedAt + 1; i < history.length; i++) {
    if (history[i]?.role === 'assistant') {
      count++;
    }
  }
  return count;
}
