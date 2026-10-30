/**
 * 保活守卫（2026-10-31，独立评审 §3.4 修正版）。
 *
 * 这一版专门堵评审指出的退化：
 *   旧调用点把常量当 idleMs 传 ⇒ 判据恒真（suppressing && !finished），"空闲"没被测量。
 *   现在 `decidePageKeepAlive` 只收时间戳，空闲由本模块算，**调用方无法伪造**。
 *
 * 变异（可判红）：
 *   - 把 `now - lastWriteAt` 换成常量 ⇒ 用例 2 红（空闲 0ms 也会保活）
 *   - 去掉 finished 判定 ⇒ 用例 4 红
 *   - 去掉 suppressing 判定 ⇒ 用例 3 红
 */
import { describe, expect, it } from 'vitest';
import {
  STREAM_KEEPALIVE_MS,
  decidePageKeepAlive,
  pageIdleMs,
} from '../core/interceptor/stream-keepalive';

describe('页面流保活（基于真实空闲时间）', () => {
  it('★★ 抑制中且空闲达到阈值 ⇒ 必须保活', () => {
    expect(
      decidePageKeepAlive({ suppressing: true, lastWriteAt: 1_000, now: 1_000 + STREAM_KEEPALIVE_MS }),
    ).toBe(true);
  });

  it('★★ 抑制中但刚写过（空闲 0ms）⇒ **不**保活（堵住"常量当空闲"的退化）', () => {
    expect(decidePageKeepAlive({ suppressing: true, lastWriteAt: 5_000, now: 5_000 })).toBe(false);
    expect(decidePageKeepAlive({ suppressing: true, lastWriteAt: 5_000, now: 5_000 + STREAM_KEEPALIVE_MS - 1 })).toBe(false);
  });

  it('★ 没有抑制 ⇒ 不保活', () => {
    expect(decidePageKeepAlive({ suppressing: false, lastWriteAt: 0, now: 99_999 })).toBe(false);
  });

  it('★ 上游已结束 ⇒ 不保活', () => {
    expect(decidePageKeepAlive({ suppressing: true, lastWriteAt: 0, now: 99_999, finished: true })).toBe(false);
  });

  it('负控：时钟回退/NaN ⇒ 保守放行（宁可多写一个空块）', () => {
    expect(decidePageKeepAlive({ suppressing: true, lastWriteAt: 1_000, now: 500 })).toBe(true);
    expect(decidePageKeepAlive({ suppressing: true, lastWriteAt: Number.NaN, now: 500 })).toBe(true);
  });

  it('pageIdleMs 对异常输入归零（诊断不炸）', () => {
    expect(pageIdleMs(1_000, 1_800)).toBe(800);
    expect(pageIdleMs(1_000, 500)).toBe(0);
    expect(pageIdleMs(Number.NaN, 500)).toBe(0);
  });

  it('阈值必须有限且不太大（防止退化成"不保活"）', () => {
    expect(Number.isFinite(STREAM_KEEPALIVE_MS)).toBe(true);
    expect(STREAM_KEEPALIVE_MS).toBeGreaterThanOrEqual(200);
    expect(STREAM_KEEPALIVE_MS).toBeLessThanOrEqual(2_000);
  });
});
