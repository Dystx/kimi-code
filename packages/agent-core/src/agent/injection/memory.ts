import type { ContextMessage } from '#/agent/context';
import type { Agent } from '..';
import { DynamicInjector } from './injector';

const MEMORY_VARIANT = 'memory';
const MEMORY_REMINDER_TURNS = 6;

/**
 * Injects relevant cross-session memories into context so the LLM benefits
 * from past session wisdom without waiting for a new session start.
 *
 * Injection cadence:
 *  - After every compaction (memories may have been updated mid-session)
 *  - Every N assistant turns as a refresh
 */
export class MemoryInjector extends DynamicInjector {
  protected override readonly injectionVariant = MEMORY_VARIANT;
  private compactedSinceLastInject = false;

  constructor(agent: Agent) {
    super(agent);
  }

  override onContextCompacted(_compactedCount: number): void {
    super.onContextCompacted(_compactedCount);
    this.compactedSinceLastInject = true;
  }

  override onContextClear(): void {
    super.onContextClear();
    this.compactedSinceLastInject = false;
  }

  protected override getInjection(): Promise<string | undefined> | undefined {
    const store = this.agent.memoryStore;
    if (store === undefined) return undefined;

    // Always inject right after compaction (memories may have changed).
    if (this.compactedSinceLastInject) {
      this.compactedSinceLastInject = false;
      return this.buildInjection(store);
    }

    // Periodic refresh every N assistant turns.
    const turnsSince = assistantTurnsSince(this.agent.context.history, this.injectedAt);
    if (turnsSince >= MEMORY_REMINDER_TURNS) {
      return this.buildInjection(store);
    }

    return undefined;
  }

  private async buildInjection(store: import('../../session/memory-store').MemoryStore): Promise<string | undefined> {
    try {
      // Use the last user message as the relevance query
      const lastUserText = this.getLastUserMessage();
      if (lastUserText.length === 0) return undefined;

      const workDirTag = `workdir:${this.agent.config.cwd}`;
      const relevant = await store.findRelevant(lastUserText.slice(0, 500), undefined, 5, workDirTag);
      if (relevant.length === 0) return undefined;

      return store.formatForInjection(relevant);
    } catch {
      return undefined;
    }
  }

  private getLastUserMessage(): string {
    for (let i = this.agent.context.history.length - 1; i >= 0; i--) {
      const msg = this.agent.context.history[i];
      if (msg?.role === 'user') {
        return msg.content
          .filter((p) => p.type === 'text')
          .map((p) => p.text)
          .join(' ');
      }
    }
    return '';
  }
}

function assistantTurnsSince(history: readonly ContextMessage[], injectedAt: number | null): number {
  const start = injectedAt ?? -1;
  let count = 0;
  for (let i = start + 1; i < history.length; i++) {
    if (history[i]?.role === 'assistant') {
      count++;
    }
  }
  return count;
}
