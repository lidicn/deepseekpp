// wake-reconcile-timeout 回归：reconcile 挂住不能让侧边栏对话永久不可用。
//
// 真机背景：原实现 `await reconcileInterruptedOnWake()` 无超时，而 background 侧
// 持有的是模块级共享 promise。一旦挂住，之后每次 submitPrompt 都复用同一个
// 挂起的 promise → 整个侧边栏对话永久卡在「...」，只能清 storage + 重载扩展恢复。
import { describe, expect, it, vi } from 'vitest';
import { waitForWakeReconcile } from '../core/chat/wake-reconcile-timeout';

describe('waitForWakeReconcile', () => {
  it('reconcile 正常结束时立即放行，不引入额外延迟', async () => {
    const reconcile = vi.fn(async () => {});
    const onTimeout = vi.fn();

    await waitForWakeReconcile({
      reconcile,
      timeoutMs: 5_000,
      scheduleTimeout: (cb, ms) => setTimeout(cb, ms),
      clearScheduledTimeout: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
      onTimeout,
    });

    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('reconcile 挂住时到上限后放行，且不抛错、回调 onTimeout', async () => {
    const reconcile = vi.fn(() => new Promise<void>(() => {})); // 永远不 settle
    const onTimeout = vi.fn();

    const started = Date.now();
    await waitForWakeReconcile({
      reconcile,
      timeoutMs: 40,
      scheduleTimeout: (cb, ms) => setTimeout(cb, ms),
      clearScheduledTimeout: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
      onTimeout,
    });
    const elapsed = Date.now() - started;

    expect(elapsed).toBeGreaterThanOrEqual(30);
    expect(elapsed).toBeLessThan(2_000); // 不能真的等 5s 默认值
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it('timeoutMs <= 0 时退化为直接等待（不静默放行）', async () => {
    const reconcile = vi.fn(async () => {});
    await waitForWakeReconcile({
      reconcile,
      timeoutMs: 0,
      scheduleTimeout: (cb) => setTimeout(cb, 0),
      clearScheduledTimeout: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
    });
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it('reconcile 自己抛错时原样抛出（不吞异常）', async () => {
    const boom = new Error('reconcile failed');
    await expect(waitForWakeReconcile({
      reconcile: async () => { throw boom; },
      timeoutMs: 1_000,
      scheduleTimeout: (cb) => setTimeout(cb, 0),
      clearScheduledTimeout: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
    })).rejects.toBe(boom);
  });

  it('超时后清理定时器，不留下悬挂 timer', async () => {
    const clearSpy = vi.fn();
    const timers: Array<() => void> = [];
    await waitForWakeReconcile({
      reconcile: () => new Promise<void>(() => {}),
      timeoutMs: 30,
      scheduleTimeout: (cb) => { const t = setTimeout(cb, 30); timers.push(() => clearTimeout(t)); return t; },
      clearScheduledTimeout: (t) => { clearSpy(); clearTimeout(t as ReturnType<typeof setTimeout>); },
    });
    expect(clearSpy).toHaveBeenCalledTimes(1);
  });
});
