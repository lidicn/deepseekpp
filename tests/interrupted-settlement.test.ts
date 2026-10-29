/**
 * 结算层守卫（独立评审 §6 F1）：**截断的流不得被结算成成功答案**。
 *
 * 旧代码（`loop-adapter.ts` `stopReason === 'length' && !lastTurnHasTools` 分支）：
 *   resolvedFinalText = lastTurnText; return true;
 * 把模型正在写的执行计划当成最终答案交出去，界面还显示「已完成」。
 *
 * 变异（可判红）：
 *   - `!continuable` 改成 return 'continue' ⇒ 用例 2 红（无链可续却硬续）
 *   - 去掉 `nudgeCount >= maxNudges` 上限 ⇒ 用例 3 红（无限续轮）
 */
import { describe, expect, it } from 'vitest';
import { decideInterruptedSettlement } from '../core/inline-agent/prompt';

describe('decideInterruptedSettlement', () => {
  it('★ 链可续 + 预算未耗尽 ⇒ continue（真正去要完整答案）', () => {
    expect(
      decideInterruptedSettlement({ continuable: true, nudgeCount: 0, maxNudges: 3, allowContinuation: true }),
    ).toBe('continue');
  });

  it('★★ 链不可续 ⇒ notice（显式提示，而不是把半截文本当答案）', () => {
    expect(
      decideInterruptedSettlement({ continuable: false, nudgeCount: 0, maxNudges: 3 }),
    ).toBe('notice');
  });

  it('★★ 预算耗尽 ⇒ notice（有界，不会无限续）', () => {
    expect(
      decideInterruptedSettlement({ continuable: true, nudgeCount: 3, maxNudges: 3, allowContinuation: true }),
    ).toBe('notice');
    expect(
      decideInterruptedSettlement({ continuable: true, nudgeCount: 2, maxNudges: 3, allowContinuation: true }),
    ).toBe('continue');
  });
});
describe('默认策略：先止血，不自动续轮', () => {
  it('★ 未显式开启 ⇒ 一律 notice（避免 53b4fbb 式挂起）', () => {
    expect(decideInterruptedSettlement({ continuable: true, nudgeCount: 0, maxNudges: 3 })).toBe('notice');
  });
});