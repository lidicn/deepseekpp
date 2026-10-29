/**
 * @deprecated 兼容 shim：旧入口（S1 之前唯一入口）保留一个版本周期。
 *
 * 新代码请 import from './index'（或 'core/vis'）。
 * 这里刻意**保持旧的 HTML 输出逐字节一致**，使既有单测无需改动——
 * 那是 S1「拆包不改变行为」的证明。
 */
import { escapeHtml, toText, truncateText } from './escape';
import { isSafeImageSrc } from './image-resolver';
import { readableTitle, renderVisNode, type VisRenderContext } from './registry';
import { registerCoreVisComponents } from './components';
import { createOutcome, DEFAULT_HUE, isRecordNode, MAX_DEPTH, MAX_TEXT_LENGTH, type RenderOutcome } from './legacy-support';

export { DEFAULT_HUE, escapeHtml, isSafeImageSrc, MAX_DEPTH, MAX_TEXT_LENGTH };

/** 旧入口：不校验 v，任何输入都不抛异常。 */
export function renderPocHtml(input: unknown): string {
  registerCoreVisComponents();
  const outcome: RenderOutcome = createOutcome();
  const ctx: VisRenderContext = {
    depth: 1,
    outcome,
    imageResolver: { resolve: (raw) => ({ src: isSafeImageSrc(raw) ? raw : null }) },
    counter: { nodes: 0 },
  };
  const root = isRecordNode(input) ? input.root : undefined;
  return `<div class="dppvis-root">${renderVisNode(root, ctx)}</div>`;
}

void escapeHtml; void toText; void truncateText; void readableTitle;
