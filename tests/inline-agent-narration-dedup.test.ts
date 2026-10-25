import { afterEach, describe, expect, it } from 'vitest';
import { resetNarrationDedup, shouldRenderNarration } from '../core/inline-agent/narration-dedup';

// P0-2: 同一 loopId 的 narration 只渲染一次；不同 loopId 互不影响；空 id 不拦截。
describe('narration-dedup（P0-2 渲染幂等守卫）', () => {
  afterEach(() => resetNarrationDedup());

  it('同一 loopId 触发两次收尾，append 只执行一次', () => {
    let rendered = 0;
    const append = (loopId: string) => {
      if (shouldRenderNarration(loopId)) rendered += 1;
    };

    append('loop-A');
    append('loop-A');

    expect(rendered).toBe(1);
  });

  it('不同 loopId 各自渲染，互不去重', () => {
    let rendered = 0;
    const append = (loopId: string) => {
      if (shouldRenderNarration(loopId)) rendered += 1;
    };

    append('loop-A');
    append('loop-B');

    expect(rendered).toBe(2);
  });

  it('空/缺失 loopId 不被守卫拦截', () => {
    expect(shouldRenderNarration('')).toBe(true);
    expect(shouldRenderNarration(null)).toBe(true);
    expect(shouldRenderNarration(undefined)).toBe(true);
  });

  // 审计 #29（2026-10-24 报告 P1）：模块级 Set 只增不删 ⇒ 长时间使用无界增长。
  // 修法：超过上限后按插入顺序淘汰最早的；去重的有效窗口很短，淘汰老 id 不失效。
  it('登记数量有上限，不会无界增长', () => {
    for (let i = 0; i < 1200; i += 1) {
      expect(shouldRenderNarration(`loop-${i}`)).toBe(true);
    }
    // 最近的 id 仍被记住（去重仍生效）
    expect(shouldRenderNarration('loop-1199')).toBe(false);
    // 最早的已被淘汰 ⇒ 重新放行；这正是「上限生效」的证据
    expect(shouldRenderNarration('loop-0')).toBe(true);
  });

  it('淘汰后新增仍能正常去重（负控：别把去重搞坏）', () => {
    for (let i = 0; i < 600; i += 1) shouldRenderNarration(`cap-${i}`);
    expect(shouldRenderNarration('cap-599')).toBe(false);
    expect(shouldRenderNarration('cap-599')).toBe(false);
  });
});
