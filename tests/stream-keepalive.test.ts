/**
 * 保活守卫（2026-10-31，A/B 实证：扩展开启才出现「服务器暂时不可用」）。
 *
 * 变异（可判红）：
 *   - 去掉 `suppressing` 判定 ⇒ 用例 2 红（不抑制时也保活 = 无意义写流）
 *   - 去掉 `finished` 判定 ⇒ 用例 3 红（上游结束后仍保活 = 页面等不到结束）
 *   - 把比较从 `>=` 改成 `>` 且阈值取相等 ⇒ 用例 1 红
 */
import { describe, expect, it } from 'vitest';
import { STREAM_KEEPALIVE_MS, shouldEmitKeepAlive } from '../core/interceptor/stream-keepalive';

describe('页面流保活', () => {
  it('★★ 抑制中且空闲达到阈值 ⇒ 必须保活（否则页面被饿死）', () => {
    expect(shouldEmitKeepAlive({ suppressing: true, idleMs: STREAM_KEEPALIVE_MS })).toBe(true);
    expect(shouldEmitKeepAlive({ suppressing: true, idleMs: 5_000 })).toBe(true);
  });

  it('★ 没有抑制 ⇒ 不保活（正常帧自己在写）', () => {
    expect(shouldEmitKeepAlive({ suppressing: false, idleMs: 5_000 })).toBe(false);
  });

  it('★ 上游已结束 ⇒ 不保活（要让页面收到结束）', () => {
    expect(shouldEmitKeepAlive({ suppressing: true, idleMs: 5_000, finished: true })).toBe(false);
  });

  it('负控：空闲未到阈值 ⇒ 不保活', () => {
    expect(shouldEmitKeepAlive({ suppressing: true, idleMs: STREAM_KEEPALIVE_MS - 1 })).toBe(false);
  });

  it('阈值必须有限且不太大（防止退化成"不保活"）', () => {
    expect(Number.isFinite(STREAM_KEEPALIVE_MS)).toBe(true);
    expect(STREAM_KEEPALIVE_MS).toBeGreaterThanOrEqual(200);
    expect(STREAM_KEEPALIVE_MS).toBeLessThanOrEqual(2_000);
  });
});
