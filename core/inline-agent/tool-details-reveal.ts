/**
 * 「详情」按钮的目标逻辑（从 content.ts 抽出，便于单测）。
 *
 * 修复（2026-10-26 用户报告）：状态条上的「详情」按钮原来只有一句
 *   if (inlineAgentContainer) inlineAgentContainer.scrollIntoView(...)
 * 两个问题：
 *   ① 只滚动、**不展开**，用户点完仍看不到具体执行的命令/参数/结果；
 *   ② inlineAgentContainer 有 4 处会被置 null（含循环结束），此时点击**完全无响应**，
 *      按钮看起来像坏的。
 *
 * 两种工具卡片各自的展开契约不同（均已核对源码，不靠猜）：
 *   · 新式 `.dpp-agent-tool-group`：折叠靠 CSS
 *     `[data-collapsed="true"] .dpp-agent-tool-group-items { display: none }`
 *     （agent-styles.ts:234）；`setAgentToolGroupCollapsed`（render-steps.ts:149）
 *     同时把 toggle 的 `aria-expanded` 一起改。
 *   · 旧式 `.dpp-tool-block`：折叠靠 CSS
 *     `[data-collapsed="true"] .dpp-tool-block-body { display: none }`。
 *
 * 因此这里分别按各自契约展开，而不是"随便设一个属性"。
 */

/** 新式工具组：data-collapsed + toggle 的 aria-expanded 都要动 */
function expandAgentToolGroup(group: HTMLElement): void {
  group.setAttribute('data-collapsed', 'false');
  const toggle = group.querySelector<HTMLElement>('.dpp-agent-tool-group-toggle');
  toggle?.setAttribute('aria-expanded', 'true');
}

/** 旧式工具块：只靠 data-collapsed（CSS 控制 body 显隐） */
function expandLegacyToolBlock(block: HTMLElement): void {
  block.setAttribute('data-collapsed', 'false');
}

const TOOL_CARD_SELECTOR = '.dpp-agent-tool-group, .dpp-tool-block';

/**
 * 是否存在可查看的工具卡片（决定「详情」按钮可用态）。
 *
 * 卡片是异步出现的：agent 起步时还没有，跑完第一个工具才有，
 * 所以调用方要在每次刷新状态条时重新判定，不能只在创建时判一次。
 */
export function hasVisibleToolCards(root: ParentNode): boolean {
  return root.querySelector(TOOL_CARD_SELECTOR) !== null;
}

/**
 * 定位并展开最近一个工具卡片。
 *
 * @returns 是否成功展开；`false` 表示当前没有任何工具卡片可展示，
 *   调用方应据此把按钮置为禁用并给出说明 —— 宁可明示「暂无可看」，
 *   也不要留一个「点了没反应」的按钮。
 */
export function revealToolDetails(root: Document | DocumentFragment | HTMLElement): boolean {
  // 两种卡片都查，取文档顺序里最后一个 —— 最接近当前正在进行的这一步。
  // （历史恢复的卡片与本轮新卡片可能同时在页面上。）
  const candidates = Array.from(
    (root as ParentNode).querySelectorAll<HTMLElement>(TOOL_CARD_SELECTOR),
  ).filter((el) => el.isConnected);

  const target = candidates[candidates.length - 1];
  if (!target) return false;

  if (target.classList.contains('dpp-agent-tool-group')) {
    expandAgentToolGroup(target);
  } else {
    expandLegacyToolBlock(target);
  }
  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  return true;
}
