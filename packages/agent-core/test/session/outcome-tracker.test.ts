import { describe, expect, it } from 'vitest';

import { SessionOutcomeTracker } from '../../src/session/outcome-tracker';

describe('SessionOutcomeTracker', () => {
  it('records tool outcomes', () => {
    const tracker = new SessionOutcomeTracker();
    tracker.recordTool('Read', false, 100);
    tracker.recordTool('Write', false, 200);
    tracker.recordTool('Read', true, 50);

    const snap = tracker.snapshot(60 * 60 * 1000);
    expect(snap.totalToolCalls).toBe(3);
    expect(snap.toolErrors).toBe(1);
    expect(snap.toolSuccessRate).toBeCloseTo(2 / 3, 5);
  });

  it('records subagent outcomes', () => {
    const tracker = new SessionOutcomeTracker();
    tracker.recordSubagent('coder', false, { durationMs: 5000 });
    tracker.recordSubagent('coder', false, { durationMs: 6000 });
    tracker.recordSubagent('explore', true, { durationMs: 3000 });

    const snap = tracker.snapshot(60 * 60 * 1000);
    expect(snap.totalSubagents).toBe(3);
    expect(snap.subagentErrors).toBe(1);
    expect(snap.subagentSuccessRate).toBeCloseTo(2 / 3, 5);
  });

  it('records turn outcomes', () => {
    const tracker = new SessionOutcomeTracker();
    tracker.recordTurn(1, 5, 'completed', false, 1000);
    tracker.recordTurn(2, 8, 'completed', true, 2000);

    const snap = tracker.snapshot(60 * 60 * 1000);
    expect(snap.totalTurns).toBe(2);
    expect(snap.turnErrors).toBe(1);
  });

  it('respects the time window', async () => {
    const tracker = new SessionOutcomeTracker();
    tracker.recordTool('Read', false, 100);

    // Wait 20ms then snapshot with 10ms window — record should be excluded
    await new Promise((r) => setTimeout(r, 20));
    const snap = tracker.snapshot(10);
    expect(snap.totalToolCalls).toBe(0);
  });

  it('ranks top tools by usage count', () => {
    const tracker = new SessionOutcomeTracker();
    tracker.recordTool('Read', false);
    tracker.recordTool('Read', false);
    tracker.recordTool('Write', false);

    const snap = tracker.snapshot(60 * 60 * 1000);
    expect(snap.topTools[0]!.name).toBe('Read');
    expect(snap.topTools[0]!.count).toBe(2);
    expect(snap.topTools[1]!.name).toBe('Write');
    expect(snap.topTools[1]!.count).toBe(1);
  });

  it('caps outcomes at MAX_OUTCOMES', () => {
    const tracker = new SessionOutcomeTracker();
    for (let i = 0; i < 600; i++) {
      tracker.recordTool('Read', false);
    }
    const snap = tracker.snapshot(24 * 60 * 60 * 1000);
    expect(snap.totalToolCalls).toBe(500);
  });

  it('generates a reflection containing stats', () => {
    const tracker = new SessionOutcomeTracker();
    tracker.recordTool('Read', false, 100);
    tracker.recordTool('Read', false, 100);
    tracker.recordTool('Write', true, 200);
    tracker.recordSubagent('coder', false);
    tracker.recordTurn(1, 5, 'completed', false, 1000);

    const reflection = tracker.generateReflection();
    expect(reflection).toContain('Session Reflection');
    expect(reflection).toContain('Tool calls: 3');
    expect(reflection).toContain('Subagents: 1');
    expect(reflection).toContain('Turns: 1');
  });

  it('flags problematic tools in reflection', () => {
    const tracker = new SessionOutcomeTracker();
    // 5 calls, 2 errors = 40% error rate (above 30% threshold)
    for (let i = 0; i < 3; i++) tracker.recordTool('Edit', false);
    for (let i = 0; i < 2; i++) tracker.recordTool('Edit', true);

    const reflection = tracker.generateReflection();
    expect(reflection).toContain('Issues to Address');
    expect(reflection).toContain('Edit');
  });
});
