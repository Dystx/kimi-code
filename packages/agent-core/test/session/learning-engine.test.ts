import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SessionLearningEngine } from '../../src/session/learning-engine';
import { SessionOutcomeTracker } from '../../src/session/outcome-tracker';

describe('SessionLearningEngine', () => {
  let tmpDir: string;
  let tracker: SessionOutcomeTracker;
  let engine: SessionLearningEngine;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'kimi-learning-'));
    tracker = new SessionOutcomeTracker();
    engine = new SessionLearningEngine(tmpDir, tracker);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('detects reliable tool patterns', async () => {
    for (let i = 0; i < 3; i++) tracker.recordTool('Read', false);
    for (let i = 0; i < 3; i++) tracker.recordTool('Write', false);

    const report = await engine.analyze();
    expect(report.patterns.length).toBeGreaterThanOrEqual(2);
    expect(report.patterns.some((p) => p.type === 'tool-sequence' && p.description.includes('Read'))).toBe(true);
    expect(report.patterns.some((p) => p.type === 'tool-sequence' && p.description.includes('Write'))).toBe(true);
  });

  it('detects subagent preferences', async () => {
    tracker.recordSubagent('coder', false);
    tracker.recordSubagent('coder', false);
    tracker.recordSubagent('explore', true);

    const report = await engine.analyze();
    expect(report.patterns.some((p) => p.type === 'subagent-preference' && p.description.includes('coder'))).toBe(true);
  });

  it('detects error-avoidance patterns', async () => {
    for (let i = 0; i < 2; i++) tracker.recordTool('Edit', false);
    for (let i = 0; i < 3; i++) tracker.recordTool('Edit', true);

    const report = await engine.analyze();
    expect(report.patterns.some((p) => p.type === 'error-avoidance')).toBe(true);
    expect(report.soulSuggestions.length).toBeGreaterThan(0);
  });

  it('generates draft skills for reliable patterns', async () => {
    for (let i = 0; i < 5; i++) tracker.recordTool('Read', false);

    const report = await engine.analyze();
    expect(report.draftSkills.length).toBeGreaterThan(0);
    expect(report.draftSkills[0]!.confidence).toBe('high');
    expect(report.draftSkills[0]!.name).toContain('Read');
  });

  it('writes draft skills to disk', async () => {
    for (let i = 0; i < 3; i++) tracker.recordTool('Read', false);

    const report = await engine.analyze();
    await engine.writeDrafts(report);

    const drafts = await engine.listDrafts();
    expect(drafts.length).toBeGreaterThan(0);
    expect(drafts[0]!.body).toContain('When using');
  });

  it('promotes a draft to active skill', async () => {
    for (let i = 0; i < 3; i++) tracker.recordTool('Read', false);

    const report = await engine.analyze();
    await engine.writeDrafts(report);

    const drafts = await engine.listDrafts();
    expect(drafts.length).toBeGreaterThan(0);

    const skillPath = await engine.promoteDraft(drafts[0]!.id, 'read-pattern');
    expect(skillPath).toContain('skills/read-pattern/SKILL.md');

    const content = await readFile(skillPath, 'utf-8');
    expect(content).toContain('---');
    expect(content).toContain('name:');

    const remaining = await engine.listDrafts();
    expect(remaining.length).toBe(0);
  });

  it('returns empty report when no patterns exist', async () => {
    const report = await engine.analyze();
    expect(report.patterns.length).toBe(0);
    expect(report.draftSkills.length).toBe(0);
    expect(report.soulSuggestions.length).toBe(0);
    expect(report.memorySuggestions.length).toBe(0);
  });

  it('parses its own draft skill format', async () => {
    for (let i = 0; i < 3; i++) tracker.recordTool('Read', false);

    const report = await engine.analyze();
    await engine.writeDrafts(report);

    const drafts = await engine.listDrafts();
    expect(drafts.length).toBeGreaterThan(0);
    expect(drafts[0]!.name.length).toBeGreaterThan(0);
    expect(drafts[0]!.description.length).toBeGreaterThan(0);
  });
});
