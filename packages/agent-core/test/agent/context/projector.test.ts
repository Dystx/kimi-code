import { describe, expect, it } from 'vitest';
import { trimTrailingOpenToolExchange } from '../../../src/agent/context/projector';
import type { Message } from '@moonshot-ai/kosong';

function user(text: string): Message {
  return { role: 'user', content: [{ type: 'text', text }], toolCalls: [] };
}

function assistant(text: string, toolCalls: { id: string; name: string }[] = []): Message {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    toolCalls: toolCalls.map((tc) => ({ type: 'function' as const, ...tc, arguments: null })),
  };
}

function tool(toolCallId: string, text: string): Message {
  return { role: 'tool', content: [{ type: 'text', text }], toolCalls: [], toolCallId };
}

describe('trimTrailingOpenToolExchange', () => {
  it('returns full history when no tool calls exist', () => {
    const history: Message[] = [user('hello'), assistant('hi')];
    expect(trimTrailingOpenToolExchange(history)).toEqual(history);
  });

  it('returns full history when all exchanges are closed', () => {
    const history: Message[] = [
      user('hello'),
      assistant('call tools', [{ id: 'a', name: 'A' }]),
      tool('a', 'result a'),
    ];
    expect(trimTrailingOpenToolExchange(history)).toEqual(history);
  });

  it('trims an incomplete exchange at the end', () => {
    const history: Message[] = [
      user('hello'),
      assistant('call tool', [{ id: 'a', name: 'A' }]),
    ];
    expect(trimTrailingOpenToolExchange(history)).toEqual([user('hello')]);
  });

  it('trims a partially resolved parallel exchange at the end', () => {
    const history: Message[] = [
      user('run both'),
      assistant('calling', [
        { id: 'a', name: 'A' },
        { id: 'b', name: 'B' },
      ]),
      tool('a', 'result a'),
    ];
    expect(trimTrailingOpenToolExchange(history)).toEqual([user('run both')]);
  });

  it('trims an incomplete exchange in the middle of history', () => {
    const history: Message[] = [
      user('old'),
      assistant('call a', [{ id: 'a', name: 'A' }]),
      user('new'),
      assistant('call b', [{ id: 'b', name: 'B' }]),
      tool('b', 'result b'),
    ];
    expect(trimTrailingOpenToolExchange(history)).toEqual([user('old')]);
  });

  it('trims when the first assistant has incomplete results and later ones are closed', () => {
    const history: Message[] = [
      user('start'),
      assistant('call a', [{ id: 'a', name: 'A' }]),
      assistant('call b', [{ id: 'b', name: 'B' }]),
      tool('b', 'result b'),
    ];
    expect(trimTrailingOpenToolExchange(history)).toEqual([user('start')]);
  });

  it('returns empty array when the very first message is an incomplete assistant', () => {
    const history: Message[] = [assistant('call tool', [{ id: 'a', name: 'A' }])];
    expect(trimTrailingOpenToolExchange(history)).toEqual([]);
  });

  it('handles empty history', () => {
    expect(trimTrailingOpenToolExchange([])).toEqual([]);
  });
});
