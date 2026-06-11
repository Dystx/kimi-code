import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';
import { describe, it, expect } from 'vitest';

import { testKaos } from '../fixtures/test-kaos';
import { Session } from '../../src/session';
import type { SDKSessionRPC } from '../../src/rpc';
import type { SkillRegistry, SkillDefinition } from '../../src/skill';

function createSessionRpc(): SDKSessionRPC {
  return {
    emitEvent: async () => {},
    requestApproval: async () => ({ decision: 'cancelled' }),
    requestQuestion: async () => null,
    toolCall: async () => ({
      output: 'custom tools are not supported in this test',
      isError: true,
    }),
  } as SDKSessionRPC;
}

function createMockSkillRegistry(): SkillRegistry {
  const skills = new Map<string, SkillDefinition>([
    ['quality-gate', { name: 'quality-gate', description: 'Run quality gates', body: 'Run lint, typecheck, and tests before finishing.', parameters: { type: 'object', properties: {}, additionalProperties: false }, tags: [] }],
    ['code-review', { name: 'code-review', description: 'Review code changes', body: 'Review the diff for correctness, style, and potential issues.', parameters: { type: 'object', properties: {}, additionalProperties: false }, tags: [] }],
    ['plan-first', { name: 'plan-first', description: 'Plan before acting', body: 'Break the task into steps and create a plan before implementation.', parameters: { type: 'object', properties: {}, additionalProperties: false }, tags: [] }],
    ['troubleshooting', { name: 'troubleshooting', description: 'Troubleshoot issues', body: 'Identify the root cause and propose fixes.', parameters: { type: 'object', properties: {}, additionalProperties: false }, tags: [] }],
    ['evidence-contract', { name: 'evidence-contract', description: 'Require evidence', body: 'Every claim must be backed by test output, logs, or code references.', parameters: { type: 'object', properties: {}, additionalProperties: false }, tags: [] }],
    ['test-debug-loop', { name: 'test-debug-loop', description: 'Debug test failures', body: 'Run tests, analyze failures, fix the root cause, re-run.', parameters: { type: 'object', properties: {}, additionalProperties: false }, tags: [] }],
  ]);

  return {
    getSkill: (name: string) => skills.get(name),
    renderSkillPrompt: (skill: SkillDefinition, _args: string) => skill.body,
    listSkills: () => Array.from(skills.values()),
    hasSkill: (name: string) => skills.has(name),
  } as SkillRegistry;
}

describe('Orchestration live demo', () => {
  it('runs a full orchestration workflow', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'kimi-orch-live-'));
    const projectDir = join(tmpDir, 'project');
    await mkdir(projectDir, { recursive: true });
    await mkdir(join(projectDir, '.kimi-code'), { recursive: true });

    await writeFile(
      join(projectDir, '.kimi-code', 'config.toml'),
      `default_model = "kimi-k2.6"

[orchestration]
enabled = true
max_queue_size = 50
max_injection_size = 4000
cooldown_ms = 300000
max_skill_repetition = 3

[[orchestration.mappings]]
event = "task.completed"
skill = "quality-gate"
condition = "isCodeTask"
priority = 2

[[orchestration.mappings]]
event = "subagent.completed"
skill = "code-review"
condition = "hasDiff"
priority = 3

[[orchestration.mappings]]
event = "goal.started"
skill = "plan-first"
condition = "taskCountGt2"
priority = 1

[[orchestration.mappings]]
event = "health.degraded"
skill = "troubleshooting"
priority = 0

[[orchestration.mappings]]
event = "subagent.completed"
skill = "evidence-contract"
condition = "hasDiff"
priority = 3

[[orchestration.mappings]]
event = "goal.blocked"
skill = "test-debug-loop"
condition = "testFailure"
priority = 0

[[orchestration.mappings]]
event = "goal.paused"
skill = "troubleshooting"
condition = "runtimeError"
priority = 0

[[orchestration.mappings]]
event = "task.created"
skill = "plan-first"
condition = "taskCountGt2"
priority = 1
`,
    );

    console.log('════════════════════════════════════════════════════════════');
    console.log('  ORCHESTRATION LIVE DEMO');
    console.log('  Project:', projectDir);
    console.log('════════════════════════════════════════════════════════════');

    try {
      console.log('\n▶ PHASE 1: Session creation with orchestration config');
      const session = new Session({
        cwd: projectDir,
        homedir: tmpDir,
        kaos: testKaos.withCwd(projectDir),
        rpc: createSessionRpc(),
      });

      const hooks = session.orchestrationHooks!;
      console.log('  ✓ Session created');
      console.log('  ✓ Orchestration hooks active');
      console.log('  ✓ Initial metrics:', hooks.metrics());

      console.log('\n▶ PHASE 2: Task lifecycle events');
      hooks.emit({ type: 'task.created', payload: { taskId: 't1', totalTaskCount: 5, hasActiveGoal: true }, priority: 1 });
      hooks.emit({ type: 'task.unblocked', payload: { taskId: 't1' }, priority: 1 });
      hooks.emit({ type: 'task.completed', payload: { taskId: 't1', isCodeTask: true }, priority: 2 });
      hooks.emit({ type: 'task.failed', payload: { taskId: 't2', reason: 'timeout' }, priority: 0 });
      console.log('  ✓ Emitted: task.created, task.unblocked, task.completed, task.failed');
      console.log('  ✓ History:', hooks.getRecentEvents().map(e => e.type));
      console.log('  ✓ Metrics:', hooks.metrics());

      console.log('\n▶ PHASE 3: Subagent events');
      hooks.emit({ type: 'subagent.started', payload: { subagentId: 'sa1', profile: 'coder' }, priority: 2 });
      hooks.emit({ type: 'subagent.completed', payload: { subagentId: 'sa1', hasDiff: true }, priority: 3 });
      hooks.emit({ type: 'subagent.failed', payload: { subagentId: 'sa2', reason: 'timeout' }, priority: 0 });
      console.log('  ✓ Emitted: subagent.started, subagent.completed, subagent.failed');
      console.log('  ✓ History:', hooks.getRecentEvents().map(e => e.type));

      console.log('\n▶ PHASE 4: Goal lifecycle events');
      hooks.emit({ type: 'goal.started', payload: { goalId: 'g1', taskCount: 5 }, priority: 1 });
      hooks.emit({ type: 'goal.completed', payload: { goalId: 'g1' }, priority: 1 });
      hooks.emit({ type: 'goal.blocked', payload: { goalId: 'g2', reason: 'test_failure' }, priority: 0 });
      hooks.emit({ type: 'goal.paused', payload: { goalId: 'g3', reason: 'runtime_error' }, priority: 0 });
      console.log('  ✓ Emitted: goal.started, goal.completed, goal.blocked, goal.paused');
      console.log('  ✓ History:', hooks.getRecentEvents().map(e => e.type));

      console.log('\n▶ PHASE 5: System events');
      hooks.emit({ type: 'health.degraded', payload: { reason: 'high_latency', metric: 'p95' }, priority: 0 });
      hooks.emit({ type: 'cron.fired', payload: { jobId: 'job1', cron: '*/5 * * * *' }, priority: 1 });
      hooks.emit({ type: 'hook.fired', payload: { hookId: 'hook1', event: 'PreToolUse' }, priority: 2 });
      hooks.emit({ type: 'mcp.failed', payload: { serverName: 'github', reason: 'connection refused' }, priority: 0 });
      console.log('  ✓ Emitted: health.degraded, cron.fired, hook.fired, mcp.failed');
      console.log('  ✓ History (last 5):', hooks.getRecentEvents(5).map(e => e.type));

      console.log('\n▶ PHASE 6: Skill injection (drain with mock registry)');
      const mockAgent = {
        type: 'main',
        skills: { registry: createMockSkillRegistry() },
      } as any;
      hooks.setAgent(mockAgent);

      const injections = hooks.drain();
      console.log('  ✓ Skills injected:', injections.length);
      for (let i = 0; i < injections.length; i++) {
        const skillName = injections[i]!.match(/skill="([^"]+)"/)?.[1] ?? 'unknown';
        const eventType = injections[i]!.match(/event="([^"]+)"/)?.[1] ?? 'unknown';
        console.log(`    [${i + 1}] ${eventType} → ${skillName}`);
      }
      console.log('  ✓ Post-drain metrics:', hooks.metrics());

      console.log('\n▶ PHASE 7: Effectiveness tracking');
      hooks.recordTurnOutcome('success');
      console.log('  ✓ Recorded turn outcome: success');
      console.log('  ✓ Effectiveness report:', hooks.effectivenessReport());
      console.log('  ✓ Insights:', hooks.generateEffectivenessInsights());

      console.log('\n▶ PHASE 8: Adaptive goal continuation context');
      const ctx = hooks.getGoalContinuationContext();
      console.log('  ✓ Context:', ctx);

      console.log('\n▶ PHASE 9: Persistence');
      await hooks.save();
      const statePath = join(tmpDir, 'state', 'orchestration.json');
      const stateContent = await readFile(statePath, 'utf-8');
      const state = JSON.parse(stateContent);
      console.log('  ✓ Saved to:', statePath);
      console.log('  ✓ Version:', state.version);
      console.log('  ✓ Queue entries:', state.queue.length);
      console.log('  ✓ History entries:', state.history.length);

      console.log('\n▶ PHASE 10: Load into fresh hooks');
      await hooks.load();
      console.log('  ✓ Loaded history:', hooks.getRecentEvents().map(e => e.type));

      console.log('\n▶ PHASE 11: Rate limiting');
      hooks.emit({ type: 'health.degraded', payload: { reason: 'cpu_high' }, priority: 0 });
      hooks.emit({ type: 'health.degraded', payload: { reason: 'cpu_high' }, priority: 0 });
      hooks.emit({ type: 'health.degraded', payload: { reason: 'cpu_high' }, priority: 0 });
      const metrics = hooks.metrics();
      console.log('  ✓ Emitted 3 health.degraded events');
      console.log('  ✓ Events emitted:', metrics.eventsEmitted);
      console.log('  ✓ Queue depth (only 1 allowed by cooldown):', metrics.queueDepth);

      console.log('\n▶ PHASE 12: Deduplication');
      const beforeDedup = hooks.metrics().eventsDeduped;
      hooks.emit({ type: 'task.completed', payload: { taskId: 'dedup-task', isCodeTask: true }, priority: 2 });
      hooks.emit({ type: 'task.completed', payload: { taskId: 'dedup-task', isCodeTask: true }, priority: 2 });
      const afterDedup = hooks.metrics().eventsDeduped;
      console.log('  ✓ Emitted 2 identical task.completed events');
      console.log('  ✓ Deduped:', afterDedup - beforeDedup);

      await session.close();

      console.log('\n════════════════════════════════════════════════════════════');
      console.log('  DEMO COMPLETE');
      console.log('════════════════════════════════════════════════════════════');
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
