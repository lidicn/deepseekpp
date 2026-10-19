import { describe, it, expect } from 'vitest';
import {
  createInMemoryConfirmedParentStore,
  decideResumeAfterForkCheck,
  evaluateFork,
  probeForkWithTimeout,
} from '../core/chat/fork-detector';

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

describe('decideResumeAfterForkCheck (W31 门控)', () => {
  it('一致（tail_matches）→ 放行', () => {
    const decision = decideResumeAfterForkCheck(evaluateFork(12345, {
      sessionId: 's', tailMessageId: 12345, tailRole: 'assistant', messageCount: 5, fetchedAt: 0,
    }, null));
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe('tail_matches');
  });

  it('不一致（tail_moved）→ 拒绝 fork_detected', () => {
    const decision = decideResumeAfterForkCheck(evaluateFork(12345, {
      sessionId: 's', tailMessageId: 99999, tailRole: 'user', messageCount: 6, fetchedAt: 0,
    }, null));
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('fork_detected');
  });

  it('无服务端数据（probe_failed）→ 保守放行', () => {
    const decision = decideResumeAfterForkCheck(evaluateFork(12345, null, new Error('network')));
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe('probe_unknown_allow');
  });

  it('超时兜底（probe_timeout）→ 保守放行', () => {
    const decision = decideResumeAfterForkCheck(
      evaluateFork(12345, null, new DOMException('TimeoutError', 'TimeoutError')),
    );
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe('probe_unknown_allow');
  });
});

describe('createInMemoryConfirmedParentStore (W31 本地记录骨架)', () => {
  it('set 后 get 返回已确认 id，未记录返回 null，clear 后归零', () => {
    const store = createInMemoryConfirmedParentStore();
    expect(store.get('s1')).toBeNull();
    store.set('s1', 12345);
    expect(store.get('s1')).toBe(12345);
    expect(store.get('s2')).toBeNull();
    store.clear('s1');
    expect(store.get('s1')).toBeNull();
  });
});
