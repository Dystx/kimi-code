import { DynamicInjector } from './injector';
import type { OrchestrationHooks } from '../../session/orchestration-hooks';

/**
 * Injects auto-triggered orchestration skills into the agent context.
 * Runs every step and drains any pending events from OrchestrationHooks.
 * Also injects a rolling history of recent orchestration events.
 * Analyzes the current work context for keywords and recommends agent profiles + skills.
 * Skill content is injected once per event batch and then cleared.
 */
export class OrchestrationSkillInjector extends DynamicInjector {
  protected override readonly injectionVariant = 'orchestration_skills';

  constructor(
    agent: ConstructorParameters<typeof DynamicInjector>[0],
    private readonly hooks: OrchestrationHooks,
  ) {
    super(agent);
  }

  protected override getInjection(): string | undefined {
    const parts: string[] = [];

    // ── Keyword-based work context analysis ──
    const latestUserText = this.getLatestUserText();
    if (latestUserText.length > 0) {
      const workAdvice = this.hooks.renderWorkContextAdvice(latestUserText);
      if (workAdvice.length > 0) {
        parts.push(workAdvice);
      }
    }

    // Rolling history of recent events
    const history = this.hooks.getRecentEvents(10);
    if (history.length > 0) {
      const historyLines = history.map((e) => {
        const id = e.payload['subagentId'] ?? e.payload['taskId'] ?? e.payload['goalId'] ?? e.payload['jobId'] ?? '';
        return `  [${e.type}]${id ? ` ${id}` : ''}`;
      });
      parts.push(`<orchestration-history>\nRecent events:\n${historyLines.join('\n')}\n</orchestration-history>`);
    }

    // Drain pending skill activations (event-based)
    if (this.hooks.hasPending) {
      const injections = this.hooks.drain();
      if (injections.length > 0) {
        parts.push(...injections);
      }
    }

    // Drain keyword-matched skills (context-based) — allows multiple skills
    if (latestUserText.length > 0) {
      const keywordInjections = this.hooks.drainKeywords(latestUserText);
      if (keywordInjections.length > 0) {
        parts.push(...keywordInjections);
      }
    }

    // Reset per-turn tracking for next step
    this.hooks.resetTurn();

    if (parts.length === 0) return undefined;
    return parts.join('\n\n');
  }

  /** Extract the text from the most recent user message in context history. */
  private getLatestUserText(): string {
    const hist = this.agent.context.history;
    for (let i = hist.length - 1; i >= 0; i--) {
      const entry = hist[i];
      if (entry?.role === 'user' && Array.isArray(entry.content)) {
        const texts: string[] = [];
        for (const part of entry.content) {
          if (part && typeof part === 'object' && 'type' in part && part.type === 'text' && 'text' in part && typeof part.text === 'string') {
            texts.push(part.text);
          }
        }
        return texts.join(' ');
      }
    }
    return '';
  }
}
