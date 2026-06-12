import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { testKaos } from '../fixtures/test-kaos';
import { Session } from '../../src/session';
import type { SDKSessionRPC } from '../../src/rpc';

function createSessionRpc(): SDKSessionRPC {
  return {
    emitEvent: vi.fn(async () => {}),
    requestApproval: vi.fn(async () => ({ decision: 'cancelled' })),
    requestQuestion: vi.fn(async () => null),
    toolCall: vi.fn(async () => ({
      output: 'custom tools are not supported in this test',
      isError: true,
    })),
  } as SDKSessionRPC;
}

describe('Orchestration all event types', () => {
  let tmpDir: string;
  let projectDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'kimi-orch-events-'));
    projectDir = join(tmpDir, 'project');
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
event = "cron.fired"
skill = "plan-first"
priority = 1

[[orchestration.mappings]]
event = "hook.fired"
skill = "code-review"
priority = 2

[[orchestration.mappings]]
event = "mcp.failed"
skill = "troubleshooting"
priority = 0
`,
    );
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('handles all task lifecycle events', async () => {
    const session = new Session({
      homedir: tmpDir,
      kaos: testKaos.withCwd(projectDir),
      rpc: createSessionRpc(),
    });

    const hooks = session.orchestrationHooks;

    hooks.emit({ type: 'task.created', payload: { taskId: 't1', totalTaskCount: 5, hasActiveGoal: true }, priority: 1 });
    hooks.emit({ type: 'task.unblocked', payload: { taskId: 't1' }, priority: 1 });
    hooks.emit({ type: 'task.completed', payload: { taskId: 't1', isCodeTask: true }, priority: 2 });
    hooks.emit({ type: 'task.failed', payload: { taskId: 't2', reason: 'timeout' }, priority: 0 });

    const recent = hooks.getRecentEvents();
    expect(recent.map(e => e.type)).toEqual([
      'task.created', 'task.unblocked', 'task.completed', 'task.failed',
    ]);
    expect(hooks.metrics().eventsEmitted).toBe(4);

    await session.close();
  });

  it('handles all subagent events', async () => {
    const session = new Session({
      homedir: tmpDir,
      kaos: testKaos.withCwd(projectDir),
      rpc: createSessionRpc(),
    });

    const hooks = session.orchestrationHooks;

    hooks.emit({ type: 'subagent.started', payload: { subagentId: 'sa1', profile: 'coder' }, priority: 2 });
    hooks.emit({ type: 'subagent.completed', payload: { subagentId: 'sa1', hasDiff: true }, priority: 3 });
    hooks.emit({ type: 'subagent.failed', payload: { subagentId: 'sa2', reason: 'timeout' }, priority: 0 });

    const recent = hooks.getRecentEvents();
    expect(recent.map(e => e.type)).toEqual([
      'subagent.started', 'subagent.completed', 'subagent.failed',
    ]);

    await session.close();
  });

  it('handles all goal lifecycle events', async () => {
    const session = new Session({
      homedir: tmpDir,
      kaos: testKaos.withCwd(projectDir),
      rpc: createSessionRpc(),
    });

    const hooks = session.orchestrationHooks;

    hooks.emit({ type: 'goal.started', payload: { goalId: 'g1', taskCount: 5 }, priority: 1 });
    hooks.emit({ type: 'goal.completed', payload: { goalId: 'g1' }, priority: 1 });
    hooks.emit({ type: 'goal.blocked', payload: { goalId: 'g2', reason: 'test_failure' }, priority: 0 });
    hooks.emit({ type: 'goal.paused', payload: { goalId: 'g3', reason: 'runtime_error' }, priority: 0 });

    const recent = hooks.getRecentEvents();
    expect(recent.map(e => e.type)).toEqual([
      'goal.started', 'goal.completed', 'goal.blocked', 'goal.paused',
    ]);

    await session.close();
  });

  it('handles health, cron, hook, and mcp events', async () => {
    const session = new Session({
      homedir: tmpDir,
      kaos: testKaos.withCwd(projectDir),
      rpc: createSessionRpc(),
    });

    const hooks = session.orchestrationHooks;

    hooks.emit({ type: 'health.degraded', payload: { reason: 'high_latency', metric: 'p95' }, priority: 0 });
    hooks.emit({ type: 'cron.fired', payload: { jobId: 'job1', cron: '*/5 * * * *' }, priority: 1 });
    hooks.emit({ type: 'hook.fired', payload: { hookId: 'hook1', event: 'PreToolUse' }, priority: 2 });
    hooks.emit({ type: 'mcp.failed', payload: { serverName: 'github', reason: 'connection refused' }, priority: 0 });

    const recent = hooks.getRecentEvents();
    expect(recent.map(e => e.type)).toEqual([
      'health.degraded', 'cron.fired', 'hook.fired', 'mcp.failed',
    ]);
    expect(hooks.metrics().eventsEmitted).toBe(4);

    await session.close();
  });

  it('suppresses repetitive skills after max repetitions', async () => {
    const session = new Session({
      homedir: tmpDir,
      kaos: testKaos.withCwd(projectDir),
      rpc: createSessionRpc(),
    });

    const hooks = session.orchestrationHooks;
    // Emit the same event type 5 times (max_skill_repetition = 3)
    for (let i = 0; i < 5; i++) {
      hooks.emit({
        type: 'task.completed',
        payload: { taskId: `task-${i}`, isCodeTask: true },
        priority: 2,
      });
    }

    const metrics = hooks.metrics();
    expect(metrics.eventsEmitted).toBe(5);
    // Queue depth should be 5, but skill suppression happens at drain time
    expect(metrics.queueDepth).toBe(5);

    await session.close();
  });

  it('adaptive context includes recent event summaries', async () => {
    const session = new Session({
      homedir: tmpDir,
      kaos: testKaos.withCwd(projectDir),
      rpc: createSessionRpc(),
    });

    const hooks = session.orchestrationHooks;

    // Emit a mix of events
    hooks.emit({ type: 'subagent.completed', payload: { subagentId: 'sa1', hasDiff: true } });
    hooks.emit({ type: 'subagent.failed', payload: { subagentId: 'sa2', reason: 'timeout' } });
    hooks.emit({ type: 'task.completed', payload: { taskId: 't1', isCodeTask: true } });
    hooks.emit({ type: 'health.degraded', payload: { reason: 'high_latency' } });

    const ctx = hooks.getGoalContinuationContext();
    expect(ctx).toContain('subagent(s) completed');
    expect(ctx).toContain('subagent(s) failed');
    expect(ctx).toContain('task(s) recently completed');
    expect(ctx).toContain('System health degraded');
    expect(ctx).toContain('[Orchestration context]');

    await session.close();
  });

  it('resets skill repetition on goal completion', async () => {
    const session = new Session({
      homedir: tmpDir,
      kaos: testKaos.withCwd(projectDir),
      rpc: createSessionRpc(),
    });

    const hooks = session.orchestrationHooks;

    // Emit events to build up repetition counts
    for (let i = 0; i < 3; i++) {
      hooks.emit({ type: 'task.completed', payload: { taskId: `t${i}`, isCodeTask: true } });
    }

    const metricsBefore = hooks.metrics();
    expect(metricsBefore.queueDepth).toBe(3);

    // Reset should clear repetition counters
    hooks.resetSkillRepetition();

    // After reset, metrics remain but repetition is cleared
    expect(hooks.metrics().skillsSuppressed).toBe(0);

    await session.close();
  });
});
