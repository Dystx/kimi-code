import { describe, expect, it, vi } from 'vitest';

import { OrchestrationHooks } from '../../src/session/orchestration-hooks';
import type { SkillDefinition, SkillRegistry } from '../../src/skill';

describe('Skill effectiveness learning', () => {
  function setupHooks(): {
    hooks: OrchestrationHooks;
    agent: import('../../src/agent').Agent;
  } {
    const skills: SkillDefinition[] = [
      {
        name: 'code-review',
        description: 'Review code changes',
        path: '/test/code-review',
        dir: '/test',
        content: 'Review',
        metadata: {},
        source: 'builtin',
      } as SkillDefinition,
    ];

    const registry = {
      getSkill: (name: string) => skills.find((s) => s.name === name),
      renderSkillPrompt: (skill: SkillDefinition) => `SKILL:${skill.name}`,
    } as unknown as SkillRegistry;

    const hooks = new OrchestrationHooks();
    const agent = {
      type: 'main',
      skills: { registry },
    } as unknown as import('../../src/agent').Agent;

    hooks.setAgent(agent);
    return { hooks, agent };
  }

  it('tracks skill injection as pending outcome', () => {
    const { hooks } = setupHooks();

    hooks.emit({ type: 'subagent.completed', payload: { subagentId: 's1', hasDiff: true } });
    hooks.drain();
    hooks.resetTurn();

    const report = hooks.effectivenessReport();
    expect(report).toHaveLength(0); // Still pending, no outcome recorded yet
  });

  it('records success outcome after turn completion', () => {
    const { hooks } = setupHooks();

    hooks.emit({ type: 'subagent.completed', payload: { subagentId: 's1', hasDiff: true } });
    hooks.drain();
    hooks.resetTurn();
    hooks.recordTurnOutcome('success');

    const report = hooks.effectivenessReport();
    expect(report).toHaveLength(1);
    expect(report[0]).toMatchObject({
      skillName: 'code-review',
      total: 1,
      successes: 1,
      failures: 0,
      successRate: 1,
    });
  });

  it('records failure outcome after turn failure', () => {
    const { hooks } = setupHooks();

    hooks.emit({ type: 'subagent.completed', payload: { subagentId: 's1', hasDiff: true } });
    hooks.drain();
    hooks.resetTurn();
    hooks.recordTurnOutcome('failure');

    const report = hooks.effectivenessReport();
    expect(report[0]).toMatchObject({
      skillName: 'code-review',
      total: 1,
      successes: 0,
      failures: 1,
      successRate: 0,
    });
  });

  it('aggregates multiple outcomes per skill', () => {
    const { hooks } = setupHooks();

    for (let i = 0; i < 5; i++) {
      hooks.emit({ type: 'subagent.completed', payload: { subagentId: `s${i}`, hasDiff: true } });
      hooks.drain();
      hooks.resetTurn();
      hooks.recordTurnOutcome(i < 3 ? 'success' : 'failure');
      // Reset repetition so each injection is tracked
      hooks.resetSkillRepetition();
    }

    const report = hooks.effectivenessReport();
    expect(report[0]).toMatchObject({
      skillName: 'code-review',
      total: 5,
      successes: 3,
      failures: 2,
      successRate: 0.6,
    });
  });

  it('generates insights for high-success skills', () => {
    const { hooks } = setupHooks();

    for (let i = 0; i < 5; i++) {
      hooks.emit({ type: 'subagent.completed', payload: { subagentId: `s${i}`, hasDiff: true } });
      hooks.drain();
      hooks.resetTurn();
      hooks.recordTurnOutcome('success');
    }

    const insights = hooks.generateEffectivenessInsights();
    expect(insights.length).toBeGreaterThan(0);
    expect(insights[0]).toContain('high success rate');
  });

  it('generates insights for low-success skills', () => {
    const { hooks } = setupHooks();

    for (let i = 0; i < 5; i++) {
      hooks.emit({ type: 'subagent.completed', payload: { subagentId: `s${i}`, hasDiff: true } });
      hooks.drain();
      hooks.resetTurn();
      hooks.recordTurnOutcome('failure');
    }

    const insights = hooks.generateEffectivenessInsights();
    expect(insights.length).toBeGreaterThan(0);
    expect(insights[0]).toContain('low success rate');
  });

  it('does not generate insights with insufficient sample size', () => {
    const { hooks } = setupHooks();

    hooks.emit({ type: 'subagent.completed', payload: { subagentId: 's1', hasDiff: true } });
    hooks.drain();
    hooks.resetTurn();
    hooks.recordTurnOutcome('success');

    const insights = hooks.generateEffectivenessInsights();
    expect(insights).toHaveLength(0);
  });

  it('clears pending outcomes after recording', () => {
    const { hooks } = setupHooks();

    hooks.emit({ type: 'subagent.completed', payload: { subagentId: 's1', hasDiff: true } });
    hooks.drain();
    hooks.resetTurn();
    hooks.recordTurnOutcome('success');

    // No new injections, but record again — should not duplicate
    hooks.recordTurnOutcome('success');

    const report = hooks.effectivenessReport();
    expect(report[0]!.total).toBe(1);
  });
});
