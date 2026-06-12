import { describe, expect, it } from 'vitest';

import { FooterComponent } from '#/tui/components/chrome/footer';
import type { AppState } from '#/tui/types';
import type { SessionStatusSnapshot } from '@moonshot-ai/kimi-code-sdk';

const ANSI_SGR = /\u001B\[[0-9;]*m/g;
function strip(text: string): string {
  return text.replaceAll(ANSI_SGR, '');
}

function baseStatus(overrides: Partial<SessionStatusSnapshot> = {}): SessionStatusSnapshot {
  return {
    goal: null,
    queuedGoals: 0,
    tasks: { total: 0, pending: 0, done: 0, blocked: 0 },
    plan: null,
    loop: null,
    locks: 0,
    health: null,
    cost: null,
    backgroundTasks: 0,
    backgroundBashTasks: 0,
    backgroundAgentTasks: 0,
    subagents: 0,
    hooks: 0,
    contextUsage: 0,
    contextTokens: 0,
    maxContextTokens: 200_000,
    orchestration: {
      queueDepth: 0,
      historyDepth: 0,
      skillsTriggered: 0,
      skillsSuppressed: 0,
      eventsEmitted: 0,
    },
    ...overrides,
  };
}

function baseState(overrides: Partial<AppState> = {}): AppState {
  return {
    model: 'k2',
    workDir: '/tmp/proj',
    sessionId: 'sess_1',
    permissionMode: 'manual',
    planMode: false,
    thinking: false,
    contextUsage: 0,
    contextTokens: 0,
    maxContextTokens: 200_000,
    isCompacting: false,
    isReplaying: false,
    streamingPhase: 'idle',
    streamingStartTime: 0,
    theme: 'dark',
    version: 'test',
    editorCommand: null,
    notifications: { enabled: true, condition: 'unfocused' },
    availableModels: {},
    statusSnapshot: baseStatus(),
    ...overrides,
  } as AppState;
}

describe('FooterComponent — background task / agent badges', () => {
  it('omits both badges when counts are 0', () => {
    const footer = new FooterComponent(baseState());
    const [line1] = footer.render(120);
    expect(line1).toBeDefined();
    expect(strip(line1!)).not.toMatch(/shells? running/);
    expect(strip(line1!)).not.toMatch(/agents? running/);
  });

  it('renders the shell badge alone when only bash tasks are running', () => {
    const footer = new FooterComponent(
      baseState({ statusSnapshot: baseStatus({ backgroundBashTasks: 1 }) }),
    );
    const out = strip(footer.render(120)[0]!);
    expect(out).toMatch(/\[1 shell running\]/);
    expect(out).not.toMatch(/agents? running/);
  });

  it('renders the agent badge alone when only agent tasks are running', () => {
    const footer = new FooterComponent(
      baseState({ statusSnapshot: baseStatus({ backgroundAgentTasks: 1 }) }),
    );
    const out = strip(footer.render(120)[0]!);
    expect(out).toMatch(/\[1 agent running\]/);
    expect(out).not.toMatch(/tasks? running/);
  });

  it('renders both badges side by side when both are non-zero', () => {
    const footer = new FooterComponent(
      baseState({ statusSnapshot: baseStatus({ backgroundBashTasks: 2, backgroundAgentTasks: 3 }) }),
    );
    const out = strip(footer.render(120)[0]!);
    expect(out).toMatch(/\[2 shells running\]/);
    expect(out).toMatch(/\[3 agents running\]/);
    // Shell badge appears before agent badge in the line.
    expect(out.indexOf('2 shells')).toBeLessThan(out.indexOf('3 agents'));
  });

  it('pluralizes correctly across both badges', () => {
    const footer = new FooterComponent(
      baseState({ statusSnapshot: baseStatus({ backgroundBashTasks: 1, backgroundAgentTasks: 1 }) }),
    );
    const out = strip(footer.render(120)[0]!);
    expect(out).toMatch(/\[1 shell running\]/);
    expect(out).toMatch(/\[1 agent running\]/);
  });

  it('updates badges live when the status snapshot changes', () => {
    const footer = new FooterComponent(
      baseState({ statusSnapshot: baseStatus({ backgroundBashTasks: 2, backgroundAgentTasks: 1 }) }),
    );
    expect(strip(footer.render(120)[0]!)).toMatch(/\[2 shells running\]/);
    footer.setState(baseState({ statusSnapshot: baseStatus() }));
    const after = strip(footer.render(120)[0]!);
    expect(after).not.toMatch(/shells? running/);
    expect(after).not.toMatch(/agents? running/);
  });

  it('drops the badges when terminal is too narrow to fit them', () => {
    const footer = new FooterComponent(
      baseState({ statusSnapshot: baseStatus({ backgroundBashTasks: 4, backgroundAgentTasks: 3 }) }),
    );
    // Extremely narrow width: footer primary content fills the line, so leftLine wins.
    const [line1] = footer.render(20);
    expect(line1).toBeDefined();
    expect(strip(line1!)).not.toMatch(/\[4 shells running\]/);
    expect(strip(line1!)).not.toMatch(/\[3 agents running\]/);
  });
});
