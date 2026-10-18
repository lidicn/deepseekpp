import { describe, it, expect } from 'vitest';
import { evaluateFork, probeForkWithTimeout } from '../core/chat/fork-detector';

describe('evaluateFork', () => {
  it('尾消息一致 → 未分叉', () => {
    const tail = {
      sessionId: 'test',
      tailMessageId: 12345,
      tailRole: 'assistant' as const,
      messageCount: 5,
      fetchedAt: Date.now(),
    };
    const result = evaluateFork(12345, tail, null);
    expect(result.forked).toBe(false);
    expect(result.reason).toBe('tail_matches');
  });

  it('尾消息变了 → 分叉', () => {
    const tail = {
      sessionId: 'test',
      tailMessageId: 99999,
      tailRole: 'user' as const,
      messageCount: 6,
      fetchedAt: Date.now(),
    };
    const result = evaluateFork(12345, tail, null);
    expect(result.forked).toBe(true);
    expect(result.reason).toBe('tail_moved');
  });

  it('探测异常 → unknown', () => {
    const result = evaluateFork(12345, null, new Error('network'));
    expect(result.unknown).toBe(true);
    expect(result.reason).toBe('probe_failed');
  });

  it('超时 → unknown', () => {
    const error = new DOMException('TimeoutError', 'TimeoutError');
    const result = evaluateFork(12345, null, error);
    expect(result.unknown).toBe(true);
    expect(result.reason).toBe('probe_timeout');
  });
});

describe('probeForkWithTimeout', () => {
  it('正常返回', async () => {
    const probe = {
      readSessionChainTail: async () => ({
        sessionId: 'test',
        tailMessageId: 12345,
        tailRole: 'assistant' as const,
        messageCount: 5,
        fetchedAt: Date.now(),
      }),
    };
    const result = await probeForkWithTimeout(probe, {
      chatSessionId: 'test',
      clientHeaders: {},
      expectedParentMessageId: 12345,
    }, 5000);
    expect(result.forked).toBe(false);
  });

  it('超时降级', async () => {
    const probe = {
      readSessionChainTail: (_input: unknown, signal: AbortSignal) => new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('TimeoutError', 'TimeoutError')));
      }) as never,
    };
    const result = await probeForkWithTimeout(probe, {
      chatSessionId: 'test',
      clientHeaders: {},
      expectedParentMessageId: 12345,
    }, 100);
    expect(result.unknown).toBe(true);
  }, 5000);
});
