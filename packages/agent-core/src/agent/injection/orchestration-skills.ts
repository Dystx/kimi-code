import { DynamicInjector } from './injector';
import type { OrchestrationHooks } from '../../session/orchestration-hooks';

/**
 * Injects auto-triggered orchestration skills into the agent context.
 * Runs every step and drains any pending events from OrchestrationHooks.
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
    if (!this.hooks.hasPending) return undefined;
    const injections = this.hooks.drain();
    if (injections.length === 0) return undefined;
    return injections.join('\n\n');
  }
}
