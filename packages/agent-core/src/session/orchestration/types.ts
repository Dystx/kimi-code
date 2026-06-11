import type { OrchestrationMappingConfig } from '../../config/schema';

export type { OrchestrationMappingConfig };

export interface OrchestrationEvent {
  readonly type:
    | 'task.completed'
    | 'task.failed'
    | 'task.created'
    | 'task.unblocked'
    | 'subagent.completed'
    | 'subagent.failed'
    | 'subagent.started'
    | 'goal.started'
    | 'goal.completed'
    | 'goal.blocked'
    | 'goal.paused'
    | 'health.degraded'
    | 'cron.fired'
    | 'hook.fired'
    | 'mcp.failed'
    | 'keyword.matched';
  readonly payload: Record<string, unknown>;
  readonly correlationId?: string;
  readonly priority?: number;
}

export interface SkillMapping {
  readonly eventType: OrchestrationEvent['type'];
  readonly skillName: string;
  readonly args?: string;
  readonly condition?: (payload: Record<string, unknown>) => boolean;
  readonly priority?: number;
}

export interface OrchestrationOptions {
  readonly maxQueueSize?: number;
  readonly maxInjectionSize?: number;
  readonly cooldownMs?: number;
  readonly maxSkillRepetition?: number;
  /** Minimum keyword match score (0-1) to recommend an agent profile. Default 0.3. */
  readonly agentRecThreshold?: number;
  /** Minimum keyword match score (0-1) to show a skill in recommendations. Default 0.2. */
  readonly skillRecThreshold?: number;
  /** Minimum keyword match score (0-1) to inject a skill's full content. Default 0.25. */
  readonly skillInjectThreshold?: number;
}

export interface OrchestrationMetrics {
  readonly eventsEmitted: number;
  readonly eventsDeduped: number;
  readonly eventsDropped: number;
  readonly skillsTriggered: number;
  readonly skillsSuppressed: number;
  readonly queueDepth: number;
  readonly historyDepth: number;
}

export interface SkillOutcomeRecord {
  readonly skillName: string;
  readonly eventType: OrchestrationEvent['type'];
  readonly timestamp: number;
  readonly outcome: 'success' | 'failure' | 'pending';
}

export interface SkillEffectivenessReport {
  readonly skillName: string;
  readonly total: number;
  readonly successes: number;
  readonly failures: number;
  readonly successRate: number;
  readonly eventTypes: string[];
}

export interface PersistedQueue {
  readonly version: 1;
  readonly queue: OrchestrationEvent[];
  readonly history: OrchestrationEvent[];
}
