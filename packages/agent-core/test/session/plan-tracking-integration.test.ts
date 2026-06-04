import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PlanTracker } from '../../src/agent/plan/tracker';
import { SessionOutcomeTracker } from '../../src/session/outcome-tracker';
import { GetPlanStatusTool } from '../../src/tools/builtin/planning/get-plan-status';
import { createFakeKaos } from '../tools/fixtures/fake-kaos';

function fakeAgent(outcomeTracker: SessionOutcomeTracker) {
  return {
    kaos: createFakeKaos(),
    log: { warn: () => {} },
    outcomeTracker,
    records: { logRecord: () => {} },
    replayBuilder: { push: () => {} },
    emitStatusUpdated: () => {},
  } as unknown as import('../../src/agent').Agent;
}

describe('Plan tracking integration', () => {
  let tmpDir: string;
  let tracker: SessionOutcomeTracker;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'kimi-plan-'));
    tracker = new SessionOutcomeTracker();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('records plan task completion in outcome tracker', async () => {
    const planFile = join(tmpDir, 'plan-tracker.json');
    const agent = fakeAgent(tracker);
    const planTracker = new PlanTracker(agent, planFile);

    await planTracker.initializeFromPlan(
      '- [ ] Task A\n- [ ] Task B\n',
      'Test Plan',
    );

    const taskA = planTracker.data!.tasks[0]!;
    planTracker.updateTaskStatus(taskA.id, 'done');

    const snap = tracker.snapshot(60 * 60 * 1000);
    expect(snap.totalPlanTasks).toBe(1);
    expect(snap.completedPlanTasks).toBe(1);
  });

  it('does not record skipped tasks as completed', async () => {
    const planFile = join(tmpDir, 'plan-tracker.json');
    const agent = fakeAgent(tracker);
    const planTracker = new PlanTracker(agent, planFile);

    await planTracker.initializeFromPlan('- [ ] Task A\n', 'Test Plan');

    const taskA = planTracker.data!.tasks[0]!;
    planTracker.updateTaskStatus(taskA.id, 'skipped');

    const snap = tracker.snapshot(60 * 60 * 1000);
    expect(snap.totalPlanTasks).toBe(1);
    expect(snap.completedPlanTasks).toBe(0);
  });

  it('GetPlanStatusTool reads plan from disk', async () => {
    const planFile = join(tmpDir, 'plan-tracker.json');
    const data = {
      id: 'plan_123',
      title: 'Integration Test Plan',
      createdAt: new Date().toISOString(),
      tasks: [
        { id: 't1', title: 'Setup', status: 'done', description: 'Initial setup' },
        { id: 't2', title: 'Implement', status: 'in_progress' },
        { id: 't3', title: 'Test', status: 'pending', dependencies: ['t2'] },
      ],
      currentTaskId: 't2',
    };
    await writeFile(planFile, JSON.stringify(data, null, 2), 'utf-8');

    const tool = new GetPlanStatusTool(planFile);
    const exec = tool.resolveExecution({});
    if (exec.isError === true) throw new Error('Expected success');
    const result = await exec.execute({ signal: new AbortController().signal, turnId: '0', toolCallId: 'call_1' });

    expect(result.output).toContain('Integration Test Plan');
    expect(result.output).toContain('1/3 done');
    expect(result.output).toContain('1 in progress');
    expect(result.output).toContain('1 pending');
    expect(result.output).toContain('[in_progress] Implement');
    expect(result.output).toContain('Current task: [in_progress] Implement');
    expect(result.output).toContain('depends: t2');
  });

  it('GetPlanStatusTool handles missing file gracefully', async () => {
    const tool = new GetPlanStatusTool(join(tmpDir, 'nonexistent.json'));
    const exec = tool.resolveExecution({});
    if (exec.isError === true) throw new Error('Expected success');
    const result = await exec.execute({ signal: new AbortController().signal, turnId: '0', toolCallId: 'call_1' });

    expect(result.output).toContain('No plan tracker file found');
  });

  it('GetPlanStatusTool handles invalid JSON gracefully', async () => {
    const planFile = join(tmpDir, 'bad-plan.json');
    await writeFile(planFile, 'not json', 'utf-8');

    const tool = new GetPlanStatusTool(planFile);
    const exec = tool.resolveExecution({});
    if (exec.isError === true) throw new Error('Expected success');
    const result = await exec.execute({ signal: new AbortController().signal, turnId: '0', toolCallId: 'call_1' });

    expect(result.output).toContain('Error reading plan');
  });

  it('reflection includes plan task stats', async () => {
    const planFile = join(tmpDir, 'plan-tracker.json');
    const agent = fakeAgent(tracker);
    const planTracker = new PlanTracker(agent, planFile);

    await planTracker.initializeFromPlan('- [ ] A\n- [ ] B\n', 'Plan');
    planTracker.updateTaskStatus(planTracker.data!.tasks[0]!.id, 'done');

    const reflection = tracker.generateReflection();
    expect(reflection).toContain('Plan tasks:');
    expect(reflection).toContain('1 completed');
  });
});
