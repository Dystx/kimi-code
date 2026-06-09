import type { Agent } from '../agent';
import type { SkillRegistry } from '../skill';

export interface OrchestrationEvent {
  readonly type:
    | 'task.completed'
    | 'task.failed'
    | 'subagent.completed'
    | 'subagent.failed'
    | 'goal.started'
    | 'goal.completed'
    | 'goal.blocked'
    | 'health.degraded';
  readonly payload: Record<string, unknown>;
}

export interface SkillMapping {
  readonly eventType: OrchestrationEvent['type'];
  readonly skillName: string;
  readonly args?: string;
  readonly condition?: (payload: Record<string, unknown>) => boolean;
}

/**
 * Default skill mappings for coding orchestration.
 * These are checked at runtime against the SkillRegistry — missing skills
 * are silently skipped so the system degrades gracefully.
 */
const DEFAULT_SKILL_MAPPINGS: readonly SkillMapping[] = [
  {
    eventType: 'task.completed',
    skillName: 'omk-quality-gate',
    condition: (p) => p['isCodeTask'] === true,
  },
  {
    eventType: 'subagent.completed',
    skillName: 'omk-code-review',
    condition: (p) => (p['hasDiff'] as boolean | undefined) ?? false,
  },
  {
    eventType: 'goal.started',
    skillName: 'omk-plan-first',
    condition: (p) => ((p['taskCount'] as number | undefined) ?? 0) > 2,
  },
  {
    eventType: 'health.degraded',
    skillName: 'omk-troubleshooting',
  },
  {
    eventType: 'task.completed',
    skillName: 'omk-security-review',
    condition: (p) => p['touchesSensitiveFiles'] === true,
  },
  {
    eventType: 'subagent.completed',
    skillName: 'omk-evidence-contract',
    condition: (p) => (p['hasDiff'] as boolean | undefined) ?? false,
  },
  {
    eventType: 'goal.blocked',
    skillName: 'omk-test-debug-loop',
    condition: (p) => p['reason'] === 'test_failure',
  },
  {
    eventType: 'task.completed',
    skillName: 'omk-git-commit-pr',
    condition: (p) =>
      p['isCodeTask'] === true && ((p['gitDiffLines'] as number | undefined) ?? 0) > 10,
  },
];

/** Maximum number of deduplication keys to retain before evicting oldest. */
const MAX_DEDUP_SIZE = 1000;

/**
 * OrchestrationHooks maintains a queue of orchestration events and maps them
 * to skill activations.  Events are emitted by the task registry, subagent
 * host, goal system, and health monitor.  An injector drains the queue and
 * injects skill content into the agent context before each step.
 */
export class OrchestrationHooks {
  private readonly queue: OrchestrationEvent[] = [];
  private readonly dedup = new Set<string>();
  private agent: Agent | null = null;

  constructor(
    private readonly mappings: readonly SkillMapping[] = DEFAULT_SKILL_MAPPINGS,
  ) {}

  /** Bind the hooks to an agent once it is available. */
  setAgent(agent: Agent): void {
    this.agent = agent;
  }

  /** Enqueue an orchestration event.  Safe to call from any thread. */
  emit(event: OrchestrationEvent): void {
    const dedupKey = `${event.type}:${JSON.stringify(event.payload)}`;
    if (this.dedup.has(dedupKey)) return;
    if (this.dedup.size >= MAX_DEDUP_SIZE) {
      const first = this.dedup.values().next().value;
      if (first !== undefined) this.dedup.delete(first);
    }
    this.dedup.add(dedupKey);
    this.queue.push(event);
  }

  /** Drain pending events and return rendered skill injections. */
  drain(): string[] {
    const registry: SkillRegistry | undefined = this.agent?.skills?.registry;
    if (registry === undefined) return [];

    const out: string[] = [];
    while (this.queue.length > 0) {
      const event = this.queue.shift()!;
      this.dedup.delete(`${event.type}:${JSON.stringify(event.payload)}`);

      for (const mapping of this.mappings) {
        if (mapping.eventType !== event.type) continue;
        if (mapping.condition !== undefined && !mapping.condition(event.payload)) continue;
        const skill = registry.getSkill(mapping.skillName);
        if (skill === undefined) continue;
        const prompt = registry.renderSkillPrompt(skill, mapping.args ?? '');
        if (prompt.length > 0) {
          out.push(`<orchestration-skill event="${event.type}" skill="${mapping.skillName}">\n${prompt}\n</orchestration-skill>`);
        }
      }
    }
    return out;
  }

  /** Whether there are pending events in the queue. */
  get hasPending(): boolean {
    return this.queue.length > 0;
  }
}
