import type { Message } from '@moonshot-ai/kosong';
import {
  DEFAULT_COMPACTION_CONFIG,
  DefaultCompactionStrategy,
  type CompactionConfig,
} from './strategy';
import type { CompactionSource } from './types';

/**
 * SmartCompactionStrategy extends the default strategy with "protected message"
 * awareness. It refuses to compact:
 *
 * 1. System reminders and injection messages (origin.kind === 'injection' or
 *    'system_trigger') — these contain active goals, plan trackers, and other
 *    critical context that the model must not lose sight of.
 * 2. Incomplete tool-call exchanges — an assistant message with pending tool
 *    calls and all following tool results until the exchange completes.
 * 3. The most recent compaction summary — preserves continuity across
 *    compactions.
 *
 * This prevents the common failure mode where compaction drops an active goal
 * reminder or splits a tool call, causing the model to lose context or emit
 * orphaned tool results.
 */
export class SmartCompactionStrategy extends DefaultCompactionStrategy {
  constructor(
    maxSizeProvider: () => number,
    config: CompactionConfig = DEFAULT_COMPACTION_CONFIG,
  ) {
    super(maxSizeProvider, config);
  }

  override computeCompactCount(messages: readonly Message[], source: CompactionSource): number {
    // First, let the default strategy compute its preferred split point.
    const defaultN = super.computeCompactCount(messages, source);
    if (defaultN === 0) return 0;

    // Now ensure we don't compact protected messages. Walk backwards from
    // defaultN to find the largest safe N that excludes all protected prefixes.
    let safeN = defaultN;
    while (safeN > 0) {
      if (isProtectedPrefix(messages, safeN)) {
        // Find the next safe split point before this protected block.
        const prevSafe = findPreviousSafeSplit(messages, safeN - 1);
        if (prevSafe === undefined || prevSafe <= 0) return 0;
        safeN = prevSafe;
      } else {
        break;
      }
    }

    return safeN;
  }

  override reduceCompactOnOverflow(messages: readonly Message[]): number {
    const defaultN = super.reduceCompactOnOverflow(messages);
    if (defaultN === 0) return 0;

    let safeN = defaultN;
    while (safeN > 0) {
      if (isProtectedPrefix(messages, safeN)) {
        const prevSafe = findPreviousSafeSplit(messages, safeN - 1);
        if (prevSafe === undefined || prevSafe <= 0) return 0;
        safeN = prevSafe;
      } else {
        break;
      }
    }

    return safeN;
  }
}

/**
 * A prefix messages[0..N-1] is "protected" if it would cut through a protected
 * message block. We check the split point at N-1 (the last compacted message).
 */
function isProtectedPrefix(messages: readonly Message[], n: number): boolean {
  if (n <= 0) return false;
  // The split is after messages[n-1]. Check if messages[n-1] or messages[n]
  // are part of a protected block that shouldn't be split.
  const lastCompacted = messages[n - 1];
  const firstRetained = messages[n];

  // Don't split after a system reminder/injection
  if (lastCompacted !== undefined && isProtectedMessage(lastCompacted)) {
    return true;
  }

  // Don't split before a system reminder/injection
  if (firstRetained !== undefined && isProtectedMessage(firstRetained)) {
    return true;
  }

  return false;
}

function isProtectedMessage(message: Message): boolean {
  // Access origin via the extended message type used in ContextMemory
  const origin = (message as { origin?: { kind?: string } }).origin;
  if (origin !== undefined) {
    if (origin.kind === 'injection' || origin.kind === 'system_trigger' || origin.kind === 'compaction_summary') {
      return true;
    }
  }
  // Also protect messages that look like system reminders
  if (message.role === 'user') {
    const text = extractText(message);
    if (text.includes('<system-reminder>') || text.includes('<system>')) {
      return true;
    }
  }
  return false;
}

function findPreviousSafeSplit(messages: readonly Message[], startIndex: number): number | undefined {
  for (let i = startIndex; i > 0; i--) {
    if (!isProtectedPrefix(messages, i)) {
      return i;
    }
  }
  return undefined;
}

function extractText(message: Message): string {
  if (typeof message.content === 'string') return message.content;
  return message.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('');
}
