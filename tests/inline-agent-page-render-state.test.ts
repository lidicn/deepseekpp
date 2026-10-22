// 2026-10-22 真机定位回归：DeepSeek 新建/刷新对话后要 30–90 秒才渲染出消息
// （正常 1–3 秒）。扩展的锚点快速等待窗只有 15 秒 → 必然超时 → 弹
// 「Agent 启动失败」。但那不是失败，是页面还没画完。
//
// 本测试锁定「区分页面仍空 / 页面已渲染」这个判据：
//   hasAnyMessage=false → 该继续等（中性提示）
//   hasAnyMessage=true  → 才算锚点匹配失败
import { describe, expect, it } from 'vitest';
import { probePageRenderState } from '../core/inline-agent/page-render-state';

function makeDoc(html: string): Document {
  return new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
}

describe('probePageRenderState', () => {
  it('页面完全空白（新建对话还没渲染）→ hasAnyMessage=false', () => {
    const doc = makeDoc('<div id="root"><div class="cb86951c"></div></div>');
    expect(probePageRenderState({ documentRoot: doc })).toEqual({
      visibleItems: 0,
      dsMessage: 0,
      hasAnyMessage: false,
    });
  });

  it('虚拟列表容器在但 0 个可见项 → 仍算没渲染完', () => {
    const doc = makeDoc(`
      <div class="ds-virtual-list ds-virtual-list--printable">
        <div class="ds-virtual-list-items">
          <div class="ds-virtual-list-visible-items"></div>
        </div>
      </div>
    `);
    expect(probePageRenderState({ documentRoot: doc })).toEqual({
      visibleItems: 0,
      dsMessage: 0,
      hasAnyMessage: false,
    });
  });

  it('有 .ds-message → hasAnyMessage=true（页面已渲染）', () => {
    const doc = makeDoc(`
      <div class="ds-message"><div class="ds-markdown">答案</div></div>
    `);
    const state = probePageRenderState({ documentRoot: doc });
    expect(state.dsMessage).toBe(1);
    expect(state.hasAnyMessage).toBe(true);
  });

  it('只有虚拟列表可见项、没有 .ds-message → 也算已渲染', () => {
    const doc = makeDoc(`
      <div class="ds-virtual-list ds-virtual-list--printable">
        <div class="ds-virtual-list-visible-items">
          <div>你是一个验收执行员</div>
          <div>已思考（用时 1 秒）</div>
        </div>
      </div>
    `);
    const state = probePageRenderState({ documentRoot: doc });
    expect(state.visibleItems).toBe(2);
    expect(state.hasAnyMessage).toBe(true);
  });

  it('没有 document 上下文时安全回落，不抛错', () => {
    const state = probePageRenderState({ documentRoot: undefined });
    expect(state.hasAnyMessage).toBe(false);
    expect(state.visibleItems).toBe(0);
  });
});
