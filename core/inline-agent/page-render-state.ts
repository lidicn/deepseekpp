/**
 * 页面渲染状态探测。
 *
 * 2026-10-22 真机定位：DeepSeek 新建/刷新对话后，**要 30–90 秒**才把消息
 * 渲染进虚拟列表（正常应 1–3 秒）。实测：硬刷新后 `.ds-message` 保持 0
 * 达 32 秒；同一会话过 45 秒再测已恢复为 2 条。
 *
 * 而扩展的锚点快速等待窗只有 15 秒 —— 必然超时，于是弹
 * 「Agent 启动失败，请重试」。但那时工具其实已经执行成功了
 * （SW 诊断有 tool start/finished ok），只是 DOM 里什么都没有。
 *
 * 所以需要在「等不到锚点」时区分两种情况：
 *   - hasAnyMessage=false → 页面还没画完，该继续等（中性提示）
 *   - hasAnyMessage=true  → 页面画完了但锚点匹配不上，才算真失败
 *
 * 本模块只做只读探测，不修改 DOM、不做昂贵扫描。
 */
export interface PageRenderState {
  /** 对话虚拟列表当前可见行数。 */
  readonly visibleItems: number;
  /** 页面上 `.ds-message` 的数量。 */
  readonly dsMessage: number;
  /** 是否至少有一条可锚定的消息。 */
  readonly hasAnyMessage: boolean;
}

export interface ProbePageRenderStateOptions {
  /** 文档根，默认取全局 document；测试可注入。 */
  readonly documentRoot?: Document;
}

export function probePageRenderState(
  options: ProbePageRenderStateOptions = {},
): PageRenderState {
  const doc = options.documentRoot
    ?? (typeof document === 'undefined' ? null : document);
  if (!doc) {
    return { visibleItems: 0, dsMessage: 0, hasAnyMessage: false };
  }

  const dsMessage = doc.querySelectorAll('.ds-message').length;
  const list = doc.querySelector('.ds-virtual-list--printable');
  const visibleItems = list
    ? list.querySelectorAll('.ds-virtual-list-visible-items > *').length
    : 0;

  return {
    visibleItems,
    dsMessage,
    hasAnyMessage: dsMessage > 0 || visibleItems > 0,
  };
}
