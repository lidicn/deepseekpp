/**
 * R05 流式心跳纯判定 evaluateStreamStall 单测。
 * 零 IO：只验证「是否记一次停滞 / 去重 / 恢复帧」，定时器与诊断落盘在宿主。
 */
import { describe, expect, it } from 'vitest';
import { evaluateStreamStall } from '../core/deepseek/active-client';

const WARN = 30_000;

describe('R05 evaluateStreamStall 流式心跳判定', () => {
  it('未超 30s 阈值 → 不记，nextLoggedAt 保持原值', () => {
    const d = evaluateStreamStall(now(10_000), now(0), 0, WARN);
    expect(d.stalled).toBe(false);
    expect(d.nextLoggedAt).toBe(0);
  });

  it('超阈值且从未记过（lastLoggedAt=0）→ 记一次，nextLoggedAt=now', () => {
    const d = evaluateStreamStall(now(40_000), now(0), 0, WARN);
    expect(d.stalled).toBe(true);
    expect(d.nextLoggedAt).toBe(now(40_000));
  });

  it('超阈值但刚记过（间隔未超阈值）→ 去重不重复刷屏', () => {
    const d = evaluateStreamStall(now(45_000), now(0), now(40_000), WARN);
    expect(d.stalled).toBe(false);
    expect(d.nextLoggedAt).toBe(now(40_000));
  });

  it('恢复帧刷新 lastFrameAt 后再次轮询 → 未停滞', () => {
    // 第 40s 记过一次，第 41s 收到帧（lastFrameAt 刷新到 41s），第 50s 轮询仍在阈值内。
    const d = evaluateStreamStall(now(50_000), now(41_000), now(40_000), WARN);
    expect(d.stalled).toBe(false);
    expect(d.nextLoggedAt).toBe(now(40_000));
  });

  it('记过一次后停滞再次超过阈值窗口 → 允许记第二次', () => {
    const d = evaluateStreamStall(now(80_000), now(0), now(40_000), WARN);
    expect(d.stalled).toBe(true);
    expect(d.nextLoggedAt).toBe(now(80_000));
  });
});

function now(ms: number): number {
  return 1_000_000_000_000 + ms;
}
