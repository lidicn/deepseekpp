/**
 * 首轮安全重试守卫（审计 P2-1）。
 *
 * 变异（可判红）：
 *   - 去掉 `receivedAnyChunk` 判定 ⇒ 用例 2 红（会重发已提交的响应，分叉会话链）
 *   - 去掉 `attemptsLeft` 判定 ⇒ 用例 3 红（无限重试）
 *   - 去掉 `aborted` 判定 ⇒ 用例 4 红（取消后还在重试）
 */
import { describe, expect, it } from 'vitest';
import {
  FIRST_TURN_MAX_ATTEMPTS,
  shouldRetryFirstTurn,
  type FirstTurnRetryInput,
} from '../core/deepseek/first-turn-retry';

const base: FirstTurnRetryInput = { receivedAnyChunk: false, attemptsLeft: 1, aborted: false };

describe('shouldRetryFirstTurn', () => {
  it('★★ 一个 chunk 都没收到 ⇒ 可安全重试（这就是"服务器问题"的修法）', () => {
    expect(shouldRetryFirstTurn(base)).toEqual({ retry: true, reason: 'safe-to-retry' });
  });

  it('★★ 收到过增量 ⇒ 绝不重试（重发会分叉会话链）', () => {
    expect(shouldRetryFirstTurn({ ...base, receivedAnyChunk: true })).toEqual({
      retry: false,
      reason: 'chunk-received',
    });
  });

  it('★ 次数用尽 ⇒ 不重试', () => {
    expect(shouldRetryFirstTurn({ ...base, attemptsLeft: 0 })).toEqual({
      retry: false,
      reason: 'exhausted',
    });
  });

  it('★ 已取消 ⇒ 不重试', () => {
    expect(shouldRetryFirstTurn({ ...base, aborted: true })).toEqual({
      retry: false,
      reason: 'aborted',
    });
  });

  it('负控：默认上限是 2 次（首发 + 1 次重试）', () => {
    expect(FIRST_TURN_MAX_ATTEMPTS).toBe(2);
  });
});
