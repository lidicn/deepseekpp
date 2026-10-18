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
});
