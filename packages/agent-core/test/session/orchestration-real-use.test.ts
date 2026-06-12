import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
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

describe('Orchestration real-use integration', () => {
  let tmpDir: string;
  let projectDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'kimi-orch-e2e-'));
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
event = "health.degraded"
skill = "troubleshooting"
priority = 0
`,
    );
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('loads orchestration config from project config.toml', async () => {
    const session = new Session({
      homedir: tmpDir,
      kaos: testKaos.withCwd(projectDir),
      rpc: createSessionRpc(),
    });

    expect(session.orchestrationHooks).toBeDefined();
    const metrics = session.orchestrationHooks.metrics();
    expect(metrics.queueDepth).toBe(0);
    expect(metrics.historyDepth).toBe(0);

    await session.close();
  });

  it('emits events and tracks them in history', async () => {
    const session = new Session({
      homedir: tmpDir,
      kaos: testKaos.withCwd(projectDir),
      rpc: createSessionRpc(),
    });

    session.orchestrationHooks.emit({
      type: 'subagent.completed',
      payload: { hasDiff: true, subagentId: 'sub-1' },
      priority: 3,
    });
    session.orchestrationHooks.emit({
      type: 'task.completed',
      payload: { isCodeTask: true, taskId: 'task-1' },
      priority: 2,
    });
    session.orchestrationHooks.emit({
      type: 'goal.started',
      payload: { taskCount: 5, goalId: 'goal-1' },
      priority: 1,
    });

    const recent = session.orchestrationHooks.getRecentEvents();
    expect(recent.map(e => e.type)).toEqual([
      'subagent.completed',
      'task.completed',
      'goal.started',
    ]);

    const metrics = session.orchestrationHooks.metrics();
    expect(metrics.eventsEmitted).toBe(3);
    expect(metrics.queueDepth).toBe(3);

    await session.close();
  });

  it('generates adaptive goal continuation context', async () => {
    const session = new Session({
      homedir: tmpDir,
      kaos: testKaos.withCwd(projectDir),
      rpc: createSessionRpc(),
    });

    session.orchestrationHooks.emit({
      type: 'subagent.completed',
      payload: { hasDiff: true, subagentId: 'sub-1' },
      priority: 3,
    });
    session.orchestrationHooks.emit({
      type: 'task.completed',
      payload: { isCodeTask: true, taskId: 'task-1' },
      priority: 2,
    });

    const ctx = session.orchestrationHooks.getGoalContinuationContext();
    expect(ctx).toContain('subagent(s) completed');
    expect(ctx).toContain('task(s) recently completed');
    expect(ctx).toContain('[Orchestration context]');

    await session.close();
  });

  it('persists queue and history across sessions', async () => {
    const session1 = new Session({
      homedir: tmpDir,
      kaos: testKaos.withCwd(projectDir),
      rpc: createSessionRpc(),
    });

    session1.orchestrationHooks.emit({
      type: 'goal.started',
      payload: { taskCount: 3, goalId: 'goal-1' },
      priority: 1,
    });

    await session1.close();

    // Verify persistence file exists
    const statePath = join(tmpDir, 'state', 'orchestration.json');
    const stateContent = await readFile(statePath, 'utf-8');
    const state = JSON.parse(stateContent);
    expect(state.version).toBe(1);
    expect(state.history).toHaveLength(1);
    expect(state.history[0].type).toBe('goal.started');

    // Load into new session
    const session2 = new Session({
      homedir: tmpDir,
      kaos: testKaos.withCwd(projectDir),
      rpc: createSessionRpc(),
    });

    await session2.orchestrationHooks.load();

    const recent = session2.orchestrationHooks.getRecentEvents();
    expect(recent.map(e => e.type)).toEqual(['goal.started']);

    await session2.close();
  });

  it('rate-limits health.degraded events', async () => {
    const session = new Session({
      homedir: tmpDir,
      kaos: testKaos.withCwd(projectDir),
      rpc: createSessionRpc(),
    });

    session.orchestrationHooks.emit({
      type: 'health.degraded',
      payload: { reason: 'high_latency' },
      priority: 0,
    });
    session.orchestrationHooks.emit({
      type: 'health.degraded',
      payload: { reason: 'high_latency' },
      priority: 0,
    });
    session.orchestrationHooks.emit({
      type: 'health.degraded',
      payload: { reason: 'memory_pressure' },
      priority: 0,
    });

    const metrics = session.orchestrationHooks.metrics();
    // All 3 emitted, but 2 should be rate-limited (same cooldown bucket)
    expect(metrics.eventsEmitted).toBe(3);
    // Only 1 should be in queue due to cooldown
    expect(metrics.queueDepth).toBe(1);

    await session.close();
  });

  it('deduplicates identical events', async () => {
    const session = new Session({
      homedir: tmpDir,
      kaos: testKaos.withCwd(projectDir),
      rpc: createSessionRpc(),
    });

    session.orchestrationHooks.emit({
      type: 'task.completed',
      payload: { taskId: 'same-task', isCodeTask: true },
      priority: 2,
    });
    session.orchestrationHooks.emit({
      type: 'task.completed',
      payload: { taskId: 'same-task', isCodeTask: true },
      priority: 2,
    });

    const metrics = session.orchestrationHooks.metrics();
    expect(metrics.eventsEmitted).toBe(2);
    expect(metrics.eventsDeduped).toBe(1);
    expect(metrics.queueDepth).toBe(1);

    await session.close();
  });
});
