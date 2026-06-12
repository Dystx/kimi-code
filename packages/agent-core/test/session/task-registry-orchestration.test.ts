import { describe, expect, it, vi } from 'vitest';
import { SessionTaskRegistry } from '../../src/session/task-registry';

describe('SessionTaskRegistry orchestration events', () => {
  it('emits task.created with totalTaskCount', () => {
    const emit = vi.fn();
    const registry = new SessionTaskRegistry({ emit } as unknown as import('../../src/session/orchestration-hooks').OrchestrationHooks);

    registry.create('Task A');
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'task.created',
        payload: expect.objectContaining({
          title: 'Task A',
          totalTaskCount: 1,
        }),
      }),
    );
  });

  it('emits task.unblocked when dependency completes', async () => {
    const emit = vi.fn();
    const registry = new SessionTaskRegistry({ emit } as unknown as import('../../src/session/orchestration-hooks').OrchestrationHooks);

    const dep = registry.create('Dependency');
    const dependent = registry.create('Dependent', { dependencies: [dep.id] });
    expect(dependent.status).toBe('blocked');

    // Clear previous emits
    emit.mockClear();

    registry.update(dep.id, { status: 'completed' });

    // Wait for microtask flush
    await new Promise<void>((resolve) =>{  queueMicrotask(() =>{  resolve(); }); });

    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'task.unblocked',
        payload: expect.objectContaining({
          taskId: dependent.id,
          title: 'Dependent',
        }),
      }),
    );
  });

  it('passes hasActiveGoal in task.created', () => {
    const emit = vi.fn();
    const registry = new SessionTaskRegistry({ emit } as unknown as import('../../src/session/orchestration-hooks').OrchestrationHooks);

    registry.setGoalActive(true);
    registry.create('Task with goal');

    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'task.created',
        payload: expect.objectContaining({
          hasActiveGoal: true,
        }),
      }),
    );
  });
});
