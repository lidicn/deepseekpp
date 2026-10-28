/**
 * P1-5 · 步级节流令牌（审计 §8.2 结构防复发）。
 *
 * 验收：同一 stepKey 故意调用两次 → 只发生一次真实等待；
 * 不同 stepKey → 各等一次；不传 stepKey → 每次都等（重试退避语义不变）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  resetPacedStepKeys,
  waitBetweenDeepSeekRequestsKeyed,
} from '../core/inline-agent/step-control';

beforeEach(() => {
  vi.useFakeTimers();
  resetPacedStepKeys();
});

afterEach(() => {
  vi.useRealTimers();
  resetPacedStepKeys();
});

async function drain(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

describe('P1-5 · waitBetweenDeepSeekRequestsKeyed', () => {
  it('同一 stepKey 调用两次：只发生一次真实等待（第二次立即返回）', async () => {
    const signal = new AbortController().signal;
    const first = waitBetweenDeepSeekRequestsKeyed(signal, 'loop-1:req:1');
    // 第二次同键：不挂起
    let secondResolved = false;
    const second = waitBetweenDeepSeekRequestsKeyed(signal, 'loop-1:req:1').then(() => {
      secondResolved = true;
    });

    // 未推进时钟时第二次就应 settle
    await Promise.resolve();
    expect(secondResolved).toBe(true);

    await drain(7_000);
    await first;
    await second;
    // 若叠了两道，7s 推不完第二道 2.5–6.5s —— 能在这里 await 完本身就是单次证据
  });

  it('不同 stepKey 各等一次（跨步不误伤）', async () => {
    const signal = new AbortController().signal;
    const a = waitBetweenDeepSeekRequestsKeyed(signal, 'loop-1:req:1');
    const b = waitBetweenDeepSeekRequestsKeyed(signal, 'loop-1:req:2');

    let done = 0;
    void a.then(() => { done += 1; });
    void b.then(() => { done += 1; });

    await drain(3_000);
    // 两道都在跑（各自 2.5–6.5s），3s 时可能 0–2 个完成；推进到 7s 全完成
    await drain(7_000);
    await Promise.all([a, b]);
    expect(done).toBe(2);
  });

  it('不传 stepKey：每次都真实等待（失败重试退避不受令牌影响）', async () => {
    const signal = new AbortController().signal;
    const runs: number[] = [];
    const t0 = Date.now();
    const p1 = waitBetweenDeepSeekRequestsKeyed(signal).then(() => {
      runs.push(Date.now() - t0);
    });
    await drain(7_000);
    await p1;
    const t1 = Date.now();
    const p2 = waitBetweenDeepSeekRequestsKeyed(signal).then(() => {
      runs.push(Date.now() - t1);
    });
    await drain(7_000);
    await p2;

    expect(runs).toHaveLength(2);
    for (const waited of runs) {
      expect(waited).toBeGreaterThanOrEqual(2500);
      expect(waited).toBeLessThanOrEqual(6500);
    }
  });

  it('resetPacedStepKeys 后同键重新等待（跨 run 不串）', async () => {
    const signal = new AbortController().signal;
    const first = waitBetweenDeepSeekRequestsKeyed(signal, 'k');
    await drain(7_000);
    await first;

    resetPacedStepKeys();
    const second = waitBetweenDeepSeekRequestsKeyed(signal, 'k');
    let settled = false;
    void second.then(() => {
      settled = true;
    });
    await Promise.resolve();
    // 重置后同键应重新进入真实等待（未推进时钟前不 settle）
    expect(settled).toBe(false);
    await drain(7_000);
    await second;
    expect(settled).toBe(true);
  });
});
