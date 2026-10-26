// 「详情」按钮目标逻辑（core/inline-agent/tool-details-reveal）。
//
// 缺陷（2026-10-26 用户报告）：输入框上方状态条的「详情」按钮原来只有一句
//   if (inlineAgentContainer) inlineAgentContainer.scrollIntoView(...)
// ① 只滚动不展开 —— 用户点完仍看不到具体执行的命令/参数/结果；
// ② inlineAgentContainer 有 4 处会被置 null（含循环结束），此时点了完全没反应，
//    按钮看起来像坏的。
//
// 本测试锁定的两种卡片展开契约，均已核对源码，不是凭空设定：
//   · 新式 .dpp-agent-tool-group 折叠靠 CSS
//     [data-collapsed="true"] .dpp-agent-tool-group-items { display:none }
//     （agent-styles.ts:234），且 setAgentToolGroupCollapsed（render-steps.ts:149）
//     会同步 toggle 的 aria-expanded ⇒ 两者都要改。
//   · 旧式 .dpp-tool-block 折叠靠 CSS
//     [data-collapsed="true"] .dpp-tool-block-body { display:none }
//     ⇒ 只需改 data-collapsed。
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  hasVisibleToolCards,
  revealToolDetails,
} from '../core/inline-agent/tool-details-reveal';

/** 造一个当前文档里的节点，并预置 scrollIntoView（jsdom 未实现该方法） */
function mount(html: string): HTMLElement {
  // 只插一份：若同时设 body.innerHTML 再 appendChild，节点会重复，
  // 「文档顺序里最后一个」的断言就会被假象污染。
  document.body.innerHTML = '';
  const wrapper = document.createElement('div');
  wrapper.innerHTML = html;
  document.body.appendChild(wrapper);
  for (const el of Array.from(wrapper.querySelectorAll<HTMLElement>('*'))) {
    el.scrollIntoView = vi.fn();
  }
  return wrapper;
}

/** 新式工具组（结构照 render-steps.ts:315 createAgentToolGroup） */
function agentGroup(collapsed: boolean, title: string): string {
  return `<div class="dpp-agent-tool-group" data-collapsed="${collapsed ? 'true' : 'false'}">
    <button class="dpp-agent-tool-group-toggle" aria-expanded="${collapsed ? 'false' : 'true'}">
      <span class="dpp-agent-tool-group-title">${title}</span>
    </button>
    <div class="dpp-agent-tool-group-items"><div class="dpp-agent-tool-item">cmd</div></div>
  </div>`;
}

/** 旧式工具块（结构照 content.ts:9023 createToolBlockShell） */
function legacyBlock(collapsed: boolean): string {
  return `<div class="dpp-tool-block" data-collapsed="${collapsed ? 'true' : 'false'}">
    <div class="dpp-tool-block-header"><span class="dpp-tool-block-title">已调用 3 次工具</span></div>
    <div class="dpp-tool-block-body"><div class="dpp-tool-block-item">shell_exec</div></div>
  </div>`;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('详情按钮：没有可展示卡片时必须判定为不可用', () => {
  it('★ 核心：无卡片时 reveal 返回 false（调用方据此禁用按钮，而不是「点了没反应」）', () => {
    mount('<div class="ds-message">普通回答，没有工具卡片</div>');
    expect(revealToolDetails(document)).toBe(false);
    expect(hasVisibleToolCards(document)).toBe(false);
  });

  it('新式卡片存在 ⇒ 可用', () => {
    mount(agentGroup(true, 'Tool calls (1)'));
    expect(hasVisibleToolCards(document)).toBe(true);
    expect(revealToolDetails(document)).toBe(true);
  });

  it('旧式卡片存在 ⇒ 可用', () => {
    mount(legacyBlock(true));
    expect(hasVisibleToolCards(document)).toBe(true);
  });
});

describe('详情按钮：必须真的展开，而不是只滚动', () => {
  it('★ 核心：新式工具组要同时改 data-collapsed 与 toggle 的 aria-expanded', () => {
    const wrapper = mount(agentGroup(true, 'Tool calls (2)'));
    revealToolDetails(document);

    const group = wrapper.querySelector<HTMLElement>('.dpp-agent-tool-group')!;
    const toggle = wrapper.querySelector<HTMLElement>('.dpp-agent-tool-group-toggle')!;
    expect(group.getAttribute('data-collapsed')).toBe('false');
    // 只设 data-collapsed 不够：aria-expanded 是这套 UI 的可访问性契约
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
  });

  it('★ 核心：旧式工具块改 data-collapsed（CSS 据此显示 body）', () => {
    const wrapper = mount(legacyBlock(true));
    revealToolDetails(document);
    const block = wrapper.querySelector<HTMLElement>('.dpp-tool-block')!;
    expect(block.getAttribute('data-collapsed')).toBe('false');
  });

  it('定位的是「最后一个」卡片（最接近当前进行的一步），不是第一个', () => {
    // 历史恢复的旧卡片（折叠）在前，本轮新卡片在后
    const wrapper = mount(legacyBlock(true) + agentGroup(true, 'Tool calls (9)'));
    revealToolDetails(document);

    const block = wrapper.querySelector<HTMLElement>('.dpp-tool-block')!;
    const group = wrapper.querySelector<HTMLElement>('.dpp-agent-tool-group')!;
    // 后面的新式卡片被展开
    expect(group.getAttribute('data-collapsed')).toBe('false');
    // 前面的历史卡片不应被误动
    expect(block.getAttribute('data-collapsed')).toBe('true');
  });

  it('卡片已展开时保持展开（不做多余翻转）', () => {
    const wrapper = mount(agentGroup(false, 'Tool calls (1)'));
    revealToolDetails(document);
    const group = wrapper.querySelector<HTMLElement>('.dpp-agent-tool-group')!;
    expect(group.getAttribute('data-collapsed')).toBe('false');
    expect(
      wrapper.querySelector<HTMLElement>('.dpp-agent-tool-group-toggle')!.getAttribute('aria-expanded'),
    ).toBe('true');
  });

  it('调用 scrollIntoView 定位到目标卡片本身', () => {
    const wrapper = mount(agentGroup(true, 'Tool calls (1)'));
    const group = wrapper.querySelector<HTMLElement>('.dpp-agent-tool-group')!;
    revealToolDetails(document);
    expect(group.scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' });
  });

  it('断开的子树里的卡片不得被操作（真正考验 isConnected 过滤）', () => {
    // root 传 document 时 querySelectorAll 根本拿不到游离节点 ⇒ 用 document 测不出这条，
    // 必须传一个「未挂载但内部含卡片」的子树：节点能被查到、但 isConnected 为 false。
    // （PM 第一版写成 document，去掉 filter 后仍全绿 —— 是假守卫，已纠正。）
    const subtree = document.createElement('div');
    subtree.innerHTML = agentGroup(true, 'x');
    const group = subtree.querySelector<HTMLElement>('.dpp-agent-tool-group')!;
    // 预置 stub：万一过滤被去掉，失败表现为干净的断言不符，
    // 而不是 jsdom 未实现 scrollIntoView 抛出的 TypeError（那样信号会很吵）。
    group.scrollIntoView = vi.fn();
    expect(group.isConnected).toBe(false);

    expect(revealToolDetails(subtree)).toBe(false);
    // 且不得偷偷改动它
    expect(group.getAttribute('data-collapsed')).toBe('true');
    expect(group.scrollIntoView).not.toHaveBeenCalled();
  });
});
