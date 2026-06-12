import { describe, expect, it, vi, type MockInstance } from 'vitest';

import {
  configuredModel,
  extractUsage,
  formatTurnEndedFailure,
  hasTurnId,
  installHeadlessHandlers,
  installHeadlessTerminationCleanup,
  requireConfiguredModel,
} from '#/headless/runner';

describe('configuredModel', () => {
  it('returns the first defined non-empty model', () => {
    expect(configuredModel(undefined, 'gpt-4', 'gpt-3')).toBe('gpt-4');
    expect(configuredModel('claude', undefined, 'gpt-4')).toBe('claude');
  });

  it('skips empty or whitespace-only strings', () => {
    expect(configuredModel('', '  ', 'valid')).toBe('valid');
    expect(configuredModel(undefined, '', undefined)).toBeUndefined();
  });

  it('returns undefined when no models are valid', () => {
    expect(configuredModel()).toBeUndefined();
    expect(configuredModel(undefined, undefined)).toBeUndefined();
  });
});

describe('requireConfiguredModel', () => {
  it('returns the first valid model', () => {
    expect(requireConfiguredModel(undefined, 'gpt-4')).toBe('gpt-4');
  });

  it('throws when no model is configured', () => {
    expect(() => requireConfiguredModel()).toThrow('No model configured');
    expect(() => requireConfiguredModel(undefined, '')).toThrow('No model configured');
  });
});

describe('formatTurnEndedFailure', () => {
  it('formats error events', () => {
    const event = {
      type: 'turn.ended' as const,
      agentId: 'main',
      sessionId: 'session-1',
      turnId: 1,
      reason: 'failed' as const,
      error: { code: 'internal' as const, message: 'Something broke', retryable: false },
    };
    expect(formatTurnEndedFailure(event)).toBe('internal: Something broke');
  });

  it('formats non-error reasons', () => {
    const event = {
      type: 'turn.ended' as const,
      agentId: 'main',
      sessionId: 'session-1',
      turnId: 1,
      reason: 'cancelled' as const,
    };
    expect(formatTurnEndedFailure(event)).toBe('Prompt turn ended with reason: cancelled');
  });
});

describe('hasTurnId', () => {
  it('returns true for events with turnId', () => {
    expect(
      hasTurnId({
        type: 'turn.ended',
        agentId: 'main',
        sessionId: 'session-1',
        turnId: 1,
        reason: 'completed',
      }),
    ).toBe(true);
    expect(
      hasTurnId({
        type: 'assistant.delta',
        agentId: 'main',
        sessionId: 'session-1',
        turnId: 1,
        delta: 'hi',
      }),
    ).toBe(true);
  });

  it('returns false for events without turnId', () => {
    expect(hasTurnId({ type: 'session.meta.updated', agentId: 'main', sessionId: 'session-1' })).toBe(false);
    expect(
      hasTurnId({
        type: 'error',
        agentId: 'main',
        sessionId: 'session-1',
        code: 'internal',
        message: 'msg',
        retryable: false,
      }),
    ).toBe(false);
  });
});

describe('extractUsage', () => {
  it('extracts token totals from session usage', async () => {
    const session = {
      getUsage: vi.fn().mockResolvedValue({
        total: {
          inputOther: 100,
          inputCacheRead: 50,
          inputCacheCreation: 25,
          output: 75,
        },
      }),
    } as unknown as Parameters<typeof extractUsage>[0];

    const result = await extractUsage(session);
    expect(result).toEqual({ cost: 0, tokens: 250 });
  });

  it('returns zero when total is missing', async () => {
    const session = {
      getUsage: vi.fn().mockResolvedValue({}),
    } as unknown as Parameters<typeof extractUsage>[0];

    const result = await extractUsage(session);
    expect(result).toEqual({ cost: 0, tokens: 0 });
  });

  it('returns zero on error', async () => {
    const session = {
      getUsage: vi.fn().mockRejectedValue(new Error('boom')),
    } as unknown as Parameters<typeof extractUsage>[0];

    const result = await extractUsage(session);
    expect(result).toEqual({ cost: 0, tokens: 0 });
  });
});

describe('installHeadlessHandlers', () => {
  it('sets approval and question handlers that auto-approve and ignore questions', async () => {
    const session = {
      setApprovalHandler: vi.fn(),
      setQuestionHandler: vi.fn(),
    } as unknown as Parameters<typeof installHeadlessHandlers>[0];

    installHeadlessHandlers(session);

    const approvalHandler = (session.setApprovalHandler as unknown as MockInstance).mock.calls[0]![0];
    const questionHandler = (session.setQuestionHandler as unknown as MockInstance).mock.calls[0]![0];

    expect(approvalHandler()).toEqual({ decision: 'approved' });
    expect(questionHandler()).toBeNull();
  });
});

describe('installHeadlessTerminationCleanup', () => {
  it('registers SIGINT and SIGTERM handlers', () => {
    const processMock = {
      once: vi.fn(),
      off: vi.fn(),
      exit: vi.fn(),
    } as unknown as NodeJS.Process;

    const cleanup = vi.fn().mockResolvedValue(undefined);
    const remove = installHeadlessTerminationCleanup(processMock, cleanup);

    expect(processMock.once).toHaveBeenCalledTimes(2);
    expect(processMock.once).toHaveBeenCalledWith('SIGINT', expect.any(Function));
    expect(processMock.once).toHaveBeenCalledWith('SIGTERM', expect.any(Function));

    // Calling remove should unregister handlers
    remove();
    expect(processMock.off).toHaveBeenCalledTimes(2);
  });
});
