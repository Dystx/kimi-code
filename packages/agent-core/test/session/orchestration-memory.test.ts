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
  ]);
  return {
    getSkill: (name: string) => skills.get(name),
    renderSkillPrompt: (skill: SkillDefinition, _args: string) => skill.body,
    listSkills: () => Array.from(skills.values()),
    hasSkill: (name: string) => skills.has(name),
  } as SkillRegistry;
}

describe('Orchestration memory integration', () => {
  it('persists effectiveness insights to memory store on session close', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'kimi-orch-mem-'));
    const projectDir = join(tmpDir, 'project');
    await mkdir(projectDir, { recursive: true });
    await mkdir(join(projectDir, '.kimi-code'), { recursive: true });

    await writeFile(
      join(projectDir, '.kimi-code', 'config.toml'),
      `default_model = "kimi-k2.6"

[orchestration]
enabled = true
max_skill_repetition = 3
`,
    );

    try {
      // Phase 1: Create session, emit events, record failures
      const session = new Session({
        cwd: projectDir,
        homedir: tmpDir,
        kaos: testKaos.withCwd(projectDir),
        rpc: createSessionRpc(),
      });

      const hooks = session.orchestrationHooks!;
      const mockAgent = {
        type: 'main',
        skills: { registry: createMockSkillRegistry() },
      } as any;
      hooks.setAgent(mockAgent);

      // Emit 5 task.completed events and drain them
      for (let i = 0; i < 5; i++) {
        hooks.emit({ type: 'task.completed', payload: { taskId: `t${i}`, isCodeTask: true } });
        hooks.drain();
        hooks.recordTurnOutcome('failure');
      }

      // Verify effectiveness data exists before close
      const report = hooks.effectivenessReport();
      expect(report.length).toBeGreaterThan(0);
      expect(report[0]!.successRate).toBe(0);

      const insights = hooks.generateEffectivenessInsights();
      expect(insights.length).toBeGreaterThan(0);
      expect(insights[0]).toContain('low success rate');

      // Phase 2: Close session — this should persist memories
      await session.close();

      // Phase 3: Verify memory store has the insight
      const memoryPath = join(projectDir, '.kimi-code', 'memory', 'entries.json');
      const memoryContent = await readFile(memoryPath, 'utf-8');
      const memories = JSON.parse(memoryContent);
      expect(Array.isArray(memories)).toBe(true);
      expect(memories.length).toBeGreaterThan(0);

      // Find the orchestration insight memory
      const orchestrationMemory = memories.find((m: any) =>
        m.content?.includes('low success rate') || m.tags?.includes('learning')
      );
      expect(orchestrationMemory).toBeDefined();
      expect(orchestrationMemory.source).toBe('reflection');
      expect(orchestrationMemory.tags).toContain('learning');

      // Phase 4: Load memories into new session and verify injection format
      const session2 = new Session({
        cwd: projectDir,
        homedir: tmpDir,
        kaos: testKaos.withCwd(projectDir),
        rpc: createSessionRpc(),
      });

      const loadedMemories = await session2.memoryStore!.loadMemories();
      expect(loadedMemories.length).toBeGreaterThan(0);

      const formatted = session2.memoryStore!.formatForInjection(loadedMemories);
      expect(formatted).toContain('## Cross-Session Memories');
      expect(formatted).toContain('low success rate');

      await session2.close();
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('adaptive context reflects memory of failing skills', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'kimi-orch-mem-ctx-'));
    const projectDir = join(tmpDir, 'project');
    await mkdir(projectDir, { recursive: true });
    await mkdir(join(projectDir, '.kimi-code'), { recursive: true });

    await writeFile(
      join(projectDir, '.kimi-code', 'config.toml'),
      `default_model = "kimi-k2.6"\n`,
    );

    try {
      const session = new Session({
        cwd: projectDir,
        homedir: tmpDir,
        kaos: testKaos.withCwd(projectDir),
        rpc: createSessionRpc(),
      });

      const hooks = session.orchestrationHooks!;

      // Seed history with mixed events
      hooks.emit({ type: 'subagent.completed', payload: { subagentId: 'sa1', hasDiff: true } });
      hooks.emit({ type: 'task.failed', payload: { taskId: 't1', reason: 'timeout' } });
      hooks.emit({ type: 'health.degraded', payload: { reason: 'high_latency' } });

      const ctx = hooks.getGoalContinuationContext();
      expect(ctx).toContain('subagent(s) completed');
      expect(ctx).toContain('task(s) recently failed');
      expect(ctx).toContain('System health degraded');

      await session.close();
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
