import { describe, expect, it, vi } from 'vitest';
import { CronManager } from '../../src/agent/cron/manager';
import type { Agent } from '../../src/agent';

describe('CronManager orchestration events', () => {
  it('emits cron.fired orchestration event on handleFire', () => {
    const emit = vi.fn();
    const agent = {
      type: 'main',
      homedir: undefined,
      turn: { steer: vi.fn(), hasActiveTurn: false },
      telemetry: { track: vi.fn() },
      emitEvent: vi.fn(),
      log: { warn: vi.fn() },
      orchestrationHooks: { emit },
    } as unknown as Agent;

    const manager = new CronManager(agent, { pollIntervalMs: null });
    manager.store.add({
      cron: '0 9 * * *',
      prompt: 'daily check',
      recurring: true,
    }, Date.now());

    const task = manager.store.list()[0];
    if (task !== undefined) {
      // Directly invoke handleFire via reflection to test emission.
      // Bind to the manager because handleFire is an instance method.
      const handleFire = (manager as unknown as Record<string, (t: typeof task, ctx: { readonly coalescedCount: number }) => void>)['handleFire'];
      handleFire?.call(manager, task, { coalescedCount: 0 });
      expect(emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'cron.fired',
          payload: expect.objectContaining({
            jobId: task.id,
            cron: '0 9 * * *',
          }),
        }),
      );
    }
  });
});
