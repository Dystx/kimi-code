import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'pathe';
import type { Agent } from '../../agent';
import type { SkillDefinition, SkillRegistry } from '../../skill';
import {
  DEFAULT_AGENT_REC_THRESHOLD,
  DEFAULT_COOLDOWN_MS,
  DEFAULT_SKILL_INJECT_THRESHOLD,
  DEFAULT_SKILL_REC_THRESHOLD,
  MAX_DEDUP_SIZE,
  MAX_HISTORY_SIZE,
  MAX_INJECTION_SIZE,
  MAX_QUEUE_SIZE,
  MAX_SKILL_REPETITION,
} from './constants';
import { DEFAULT_SKILL_MAPPINGS } from './mapper';
import type {
  OrchestrationEvent,
  OrchestrationMetrics,
  OrchestrationOptions,
  PersistedQueue,
  SkillEffectivenessReport,
  SkillMapping,
  SkillOutcomeRecord,
} from './types';
import { recommendAgentProfile, recommendSkillsForWork } from './keyword-matcher';

/**
 * OrchestrationHooks maintains a queue of orchestration events and maps them
 * to skill activations.  Events are emitted by the task registry, subagent
 * host, goal system, health monitor, cron, hooks, and MCP.
 *
 * Features:
 * - Rate limiting (cooldown per event type)
 * - Bounded queue + dedup
 * - Priority ordering (lower number = higher priority)
 * - Rolling event history
 * - Skill injection deduplication across turns
 * - Effectiveness tracking
 * - Queue persistence
 * - Configurable mappings
 */
export class OrchestrationHooks {
  private readonly queue: OrchestrationEvent[] = [];
  private readonly history: OrchestrationEvent[] = [];
  private readonly dedup = new Set<string>();
  private agent: Agent | null = null;
  private lastEmitTime = new Map<string, number>();
  private injectedThisTurn = new Set<string>();
  private skillRepetitionCount = new Map<string, number>();
  private _metrics = {
    eventsEmitted: 0,
    eventsDeduped: 0,
    eventsDropped: 0,
    skillsTriggered: 0,
    skillsSuppressed: 0,
  };
  private homedir: string | undefined;
  private _midTurnDrainListeners: Array<() => void> = [];
  private recentOutcomes: SkillOutcomeRecord[] = [];
  private pendingOutcomes: Array<{ skillName: string; eventType: OrchestrationEvent['type'] }> = [];

  private readonly maxQueueSize: number;
  private readonly maxInjectionSize: number;
  private readonly cooldownMs: number;
  private readonly maxSkillRepetition: number;
  private readonly agentRecThreshold: number;
  private readonly skillRecThreshold: number;
  private readonly skillInjectThreshold: number;

  constructor(
    private readonly mappings: readonly SkillMapping[] = DEFAULT_SKILL_MAPPINGS,
    options: OrchestrationOptions = {},
  ) {
    this.maxQueueSize = options.maxQueueSize ?? MAX_QUEUE_SIZE;
    this.maxInjectionSize = options.maxInjectionSize ?? MAX_INJECTION_SIZE;
    this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.maxSkillRepetition = options.maxSkillRepetition ?? MAX_SKILL_REPETITION;
    this.agentRecThreshold = options.agentRecThreshold ?? DEFAULT_AGENT_REC_THRESHOLD;
    this.skillRecThreshold = options.skillRecThreshold ?? DEFAULT_SKILL_REC_THRESHOLD;
    this.skillInjectThreshold = options.skillInjectThreshold ?? DEFAULT_SKILL_INJECT_THRESHOLD;
  }

  /** Attach a homedir for queue persistence. */
  setHomedir(homedir: string): void {
    this.homedir = homedir;
  }

  /** Bind the hooks to the main agent.  Idempotent — subsequent calls replace. */
  setAgent(agent: Agent): void {
    if (agent.type !== 'main') return;
    this.agent = agent;
  }

  /** Register a listener for mid-turn drain events. */
  onMidTurnDrain(listener: () => void): () => void {
    this._midTurnDrainListeners.push(listener);
    return () => {
      const idx = this._midTurnDrainListeners.indexOf(listener);
      if (idx >= 0) this._midTurnDrainListeners.splice(idx, 1);
    };
  }

  /** Enqueue an orchestration event.  Safe to call from any thread. */
  emit(event: OrchestrationEvent): void {
    this._metrics.eventsEmitted++;

    // Rate limiting
    if (this.isRateLimited(event.type)) {
      return;
    }

    // Add to rolling history
    this.history.push(event);
    if (this.history.length > MAX_HISTORY_SIZE) {
      this.history.shift();
    }

    const dedupKey = this.makeDedupKey(event);
    if (this.dedup.has(dedupKey)) {
      this._metrics.eventsDeduped++;
      return;
    }

    // Bounded queue: evict oldest if at capacity
    if (this.queue.length >= this.maxQueueSize) {
      const dropped = this.queue.shift()!;
      this.dedup.delete(this.makeDedupKey(dropped));
      this._metrics.eventsDropped++;
    }

    // Bounded dedup set: evict oldest if at capacity
    if (this.dedup.size >= MAX_DEDUP_SIZE) {
      const first = this.dedup.values().next().value;
      if (first !== undefined) this.dedup.delete(first);
    }

    this.dedup.add(dedupKey);
    // Insert in priority order (lower number = higher priority); maintain FIFO for same priority
    const p = event.priority ?? 5;
    let idx = this.queue.length;
    while (idx > 0 && ((this.queue[idx - 1]!).priority ?? 5) > p) {
      idx--;
    }
    this.queue.splice(idx, 0, event);

    // Notify mid-turn drain listeners
    for (const listener of this._midTurnDrainListeners) {
      try { listener(); } catch {}
    }
  }

  /** Drain pending events and return rendered skill injections. */
  drain(): string[] {
    const registry: SkillRegistry | undefined = this.agent?.skills?.registry;
    if (registry === undefined) return [];

    const out: string[] = [];
    let totalSize = 0;
    const newlyInjected = new Set<string>();

    while (this.queue.length > 0) {
      const event = this.queue.shift()!;
      this.dedup.delete(this.makeDedupKey(event));

      for (const mapping of this.mappings) {
        if (mapping.eventType !== event.type) continue;
        if (mapping.condition !== undefined && !mapping.condition(event.payload)) continue;
        const skill = this.resolveSkill(registry, mapping.skillName);
        if (skill === undefined) continue;
        const prompt = registry.renderSkillPrompt(skill, mapping.args ?? '');
        if (prompt.length === 0) continue;

        // Repetition suppression
        const repKey = `${skill.name}:${event.type}`;
        const repCount = this.skillRepetitionCount.get(repKey) ?? 0;
        if (repCount >= this.maxSkillRepetition) {
          this._metrics.skillsSuppressed++;
          continue;
        }

        const injection = `<orchestration-skill event="${event.type}" skill="${skill.name}" correlation="${event.correlationId ?? ''}">\n${prompt}\n</orchestration-skill>`;
        if (totalSize + injection.length > this.maxInjectionSize) {
          // Queue the remaining events back for next drain
          this.queue.unshift(event);
          this.dedup.add(this.makeDedupKey(event));
          this.injectedThisTurn = newlyInjected;
          return out;
        }

        totalSize += injection.length;
        out.push(injection);
        newlyInjected.add(repKey);
        this.skillRepetitionCount.set(repKey, repCount + 1);
        this._metrics.skillsTriggered++;

        // Track for effectiveness learning
        this.pendingOutcomes.push({
          skillName: skill.name,
          eventType: event.type,
        });
      }
    }

    this.injectedThisTurn = newlyInjected;
    return out;
  }

  /**
   * Find skills matching keywords in the work description and return rendered
   * skill injections.  This allows multiple skills to be injected simultaneously
   * based on the current prompt context, alongside event-driven injections.
   */
  drainKeywords(workDescription: string): string[] {
    const registry: SkillRegistry | undefined = this.agent?.skills?.registry;
    if (registry === undefined) return [];

    const matches = recommendSkillsForWork(workDescription, registry, this.skillInjectThreshold);
    if (matches.length === 0) return [];

    const out: string[] = [];
    let totalSize = 0;
    const newlyInjected = new Set<string>();

    for (const { skill, score } of matches) {
      const prompt = registry.renderSkillPrompt(skill, '');
      if (prompt.length === 0) continue;

      // Repetition suppression (shared with event-based drain)
      const repKey = `${skill.name}:keyword`;
      const repCount = this.skillRepetitionCount.get(repKey) ?? 0;
      if (repCount >= this.maxSkillRepetition) {
        this._metrics.skillsSuppressed++;
        continue;
      }

      const injection = `<orchestration-skill source="keyword" skill="${skill.name}" confidence="${(score * 100).toFixed(0)}%">\n${prompt}\n</orchestration-skill>`;
      if (totalSize + injection.length > this.maxInjectionSize) {
        break;
      }

      totalSize += injection.length;
      out.push(injection);
      newlyInjected.add(repKey);
      this.skillRepetitionCount.set(repKey, repCount + 1);
      this._metrics.skillsTriggered++;

      // Track for effectiveness learning
      this.pendingOutcomes.push({
        skillName: skill.name,
        eventType: 'keyword.matched',
      });
    }

    this.injectedThisTurn = new Set([...this.injectedThisTurn, ...newlyInjected]);
    return out;
  }

  /** Reset per-turn injection tracking. Call at turn boundary. */
  resetTurn(): void {
    this.injectedThisTurn.clear();
  }

  /** Reset skill repetition counters — call when a major phase ends (e.g. goal completed). */
  resetSkillRepetition(): void {
    this.skillRepetitionCount.clear();
  }

  /**
   * Record the outcome of the current turn for all skills injected since the last
   * drain. Call after turn completion (success or failure).
   */
  recordTurnOutcome(outcome: 'success' | 'failure'): void {
    const now = Date.now();
    for (const pending of this.pendingOutcomes) {
      this.recentOutcomes.push({
        skillName: pending.skillName,
        eventType: pending.eventType,
        timestamp: now,
        outcome,
      });
    }
    this.pendingOutcomes = [];
    // Trim rolling window to last 100 records in-place
    if (this.recentOutcomes.length > 100) {
      this.recentOutcomes.splice(0, this.recentOutcomes.length - 100);
    }
  }

  /** Generate effectiveness report for all tracked skills. */
  effectivenessReport(): SkillEffectivenessReport[] {
    const bySkill = new Map<string, { total: number; successes: number; failures: number; eventTypes: Set<string> }>();

    for (const record of this.recentOutcomes) {
      if (record.outcome === 'pending') continue;
      const entry = bySkill.get(record.skillName) ?? {
        total: 0,
        successes: 0,
        failures: 0,
        eventTypes: new Set<string>(),
      };
      entry.total++;
      entry.eventTypes.add(record.eventType);
      if (record.outcome === 'success') {
        entry.successes++;
      } else {
        entry.failures++;
      }
      bySkill.set(record.skillName, entry);
    }

    return Array.from(bySkill.entries()).map(([skillName, data]) => ({
      skillName,
      total: data.total,
      successes: data.successes,
      failures: data.failures,
      successRate: data.total > 0 ? data.successes / data.total : 0,
      eventTypes: Array.from(data.eventTypes),
    }));
  }

  /** Generate memory suggestions based on effectiveness data. */
  generateEffectivenessInsights(): string[] {
    const report = this.effectivenessReport();
    const insights: string[] = [];

    for (const skill of report) {
      if (skill.total < 3) continue; // Need minimum sample size
      if (skill.successRate >= 0.8) {
        insights.push(
          `Skill "${skill.skillName}" has a high success rate (${(skill.successRate * 100).toFixed(0)}%) ` +
          `when triggered by ${skill.eventTypes.join(', ')}. Continue using this mapping.`
        );
      } else if (skill.successRate <= 0.3) {
        insights.push(
          `Skill "${skill.skillName}" has a low success rate (${(skill.successRate * 100).toFixed(0)}%) ` +
          `when triggered by ${skill.eventTypes.join(', ')}. Consider revising the condition or removing this mapping.`
        );
      }
    }

    return insights;
  }

  /** Whether there are pending events in the queue. */
  get hasPending(): boolean {
    return this.queue.length > 0;
  }

  /** Rolling history of recent events. */
  getRecentEvents(limit = 10): OrchestrationEvent[] {
    return this.history.slice(-limit);
  }

  /**
   * Generate a short adaptive context string for goal continuation prompts.
   * Summarizes recent orchestration events so the model has situational awareness
   * without bloating the prompt. Returns empty string when nothing notable happened.
   */
  getGoalContinuationContext(): string {
    const recent = this.history.slice(-5);
    if (recent.length === 0) return '';

    const parts: string[] = [];
    const subagents = recent.filter((e) => e.type === 'subagent.completed' || e.type === 'subagent.failed');
    if (subagents.length > 0) {
      const completed = subagents.filter((e) => e.type === 'subagent.completed').length;
      const failed = subagents.filter((e) => e.type === 'subagent.failed').length;
      const summary: string[] = [];
      if (completed > 0) summary.push(`${completed} subagent(s) completed`);
      if (failed > 0) summary.push(`${failed} subagent(s) failed`);
      parts.push(`Recent: ${summary.join(', ')}.`);
    }

    const health = recent.filter((e) => e.type === 'health.degraded');
    if (health.length > 0) {
      parts.push('System health degraded — monitor for recurring issues.');
    }

    const tasks = recent.filter((e) => e.type === 'task.completed' || e.type === 'task.failed');
    if (tasks.length > 0) {
      const done = tasks.filter((e) => e.type === 'task.completed').length;
      const fail = tasks.filter((e) => e.type === 'task.failed').length;
      if (fail > 0) {
        parts.push(`${fail} task(s) recently failed — verify state before proceeding.`);
      } else if (done > 0) {
        parts.push(`${done} task(s) recently completed.`);
      }
    }

    const goals = recent.filter((e) => e.type === 'goal.blocked' || e.type === 'goal.paused');
    if (goals.length > 0) {
      parts.push('A goal was recently blocked or paused — check for external blockers.');
    }

    // Include effectiveness hint if a skill has been repeatedly failing
    const failingSkills = this.effectivenessReport().filter((r) => r.total >= 3 && r.successRate <= 0.3);
    if (failingSkills.length > 0) {
      parts.push(
        `Note: skill(s) ${failingSkills.map((s) => `"${s.skillName}"`).join(', ')} have low effectiveness — consider alternative approaches.`
      );
    }

    if (parts.length === 0) return '';
    return `[Orchestration context] ${parts.join(' ')}`;
  }

  /** Current metrics snapshot. */
  metrics(): OrchestrationMetrics {
    return {
      ...this._metrics,
      queueDepth: this.queue.length,
      historyDepth: this.history.length,
    };
  }

  /** Reset metrics (e.g., after reporting). */
  resetMetrics(): void {
    this._metrics = {
      eventsEmitted: 0,
      eventsDeduped: 0,
      eventsDropped: 0,
      skillsTriggered: 0,
      skillsSuppressed: 0,
    };
  }

  /** Persist queue + history to disk. */
  async save(): Promise<void> {
    if (this.homedir === undefined) return;
    const path = join(this.homedir, 'state', 'orchestration.json');
    await mkdir(dirname(path), { recursive: true });
    const data: PersistedQueue = {
      version: 1,
      queue: [...this.queue],
      history: [...this.history],
    };
    await writeFile(path, JSON.stringify(data), 'utf-8');
  }

  /** Load queue + history from disk. */
  async load(): Promise<void> {
    if (this.homedir === undefined) return;
    try {
      const path = join(this.homedir, 'state', 'orchestration.json');
      const text = await readFile(path, 'utf-8');
      const data = JSON.parse(text) as PersistedQueue;
      if (data.version === 1) {
        for (const event of data.queue ?? []) {
          this.queue.push(event);
          this.dedup.add(this.makeDedupKey(event));
        }
        for (const event of data.history ?? []) {
          this.history.push(event);
        }
        if (this.history.length > MAX_HISTORY_SIZE) {
          this.history.splice(0, this.history.length - MAX_HISTORY_SIZE);
        }
      }
    } catch {
      // ignore
    }
  }

  /**
   * Analyze a work description (goal title, task description, user prompt)
   * and recommend the best agent profile + matching skills from the registry.
   */
  analyzeWorkContext(workDescription: string): {
    agentRecommendation?: { profile: string; score: number; description: string };
    skillRecommendations: Array<{ skillName: string; score: number }>;
  } {
    const registry: SkillRegistry | undefined = this.agent?.skills?.registry;

    const agentRecommendation = recommendAgentProfile(workDescription);
    const skillRecommendations =
      registry !== undefined
        ? recommendSkillsForWork(workDescription, registry).map((r) => ({
            skillName: r.skill.name,
            score: r.score,
          }))
        : [];

    return { agentRecommendation, skillRecommendations };
  }

  /**
   * Generate an injection string that recommends an agent profile and relevant skills
   * based on keyword analysis of the current work context.
   */
  renderWorkContextAdvice(workDescription: string): string {
    const { agentRecommendation, skillRecommendations } = this.analyzeWorkContext(workDescription);
    const parts: string[] = [];

    if (agentRecommendation !== undefined && agentRecommendation.score >= this.agentRecThreshold) {
      parts.push(
        `[Agent recommendation] Based on the work description, consider deploying a **${agentRecommendation.profile}** subagent ` +
        `(confidence: ${(agentRecommendation.score * 100).toFixed(0)}%). ${agentRecommendation.description}. ` +
        `Use \`/agent @${agentRecommendation.profile} <task>\` to dispatch.`
      );
    }

    const filteredSkills = skillRecommendations.filter((s) => s.score >= this.skillRecThreshold);
    if (filteredSkills.length > 0) {
      const topSkills = filteredSkills.slice(0, 3);
      parts.push(
        `[Skill recommendations] Relevant skills for this work: ${topSkills
          .map((s) => `"${s.skillName}" (${(s.score * 100).toFixed(0)}%)`)
          .join(', ')}.`
      );
    }

    if (parts.length === 0) return '';
    return `[Work context analysis]\n${parts.join('\n')}`;
  }

  private isRateLimited(type: OrchestrationEvent['type']): boolean {
    if (type !== 'health.degraded') return false;
    const now = Date.now();
    const last = this.lastEmitTime.get(type);
    if (last !== undefined && now - last < this.cooldownMs) {
      return true;
    }
    this.lastEmitTime.set(type, now);
    return false;
  }

  private makeDedupKey(event: OrchestrationEvent): string {
    const { type, payload } = event;
    const id =
      payload['subagentId'] ?? payload['taskId'] ?? payload['goalId'] ?? payload['reason'] ?? payload['jobId'] ?? payload['hookId'] ?? payload['serverName'] ?? '';
    return `${type}:${id}:${event.correlationId ?? ''}`;
  }

  private resolveSkill(registry: SkillRegistry, name: string): SkillDefinition | undefined {
    return registry.getSkill(name);
  }
}
