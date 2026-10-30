/**
 * live 路径的最终答案"消费点"（审计 P3-12 / Y2）。
 *
 * 为什么单独抽出来：`routeFinalAnswer` 是纯函数、有 8 条用例，
 * 但**接线**（拿 action 去操作 DOM）一直写在 `content.ts` 里、零覆盖。
 * 审计用 Y2 变异证明：把 live 改回旧实现 `if (ownsFinalTurn) return;`（整步跳过），
 * 64 条测试**全绿** —— 抽象被测住了，接线却是无人区。
 *
 * 这里把"五种 action → 五种 DOM 操作"变成可注入依赖的纯调度，
 * 再由 `content.ts` 调用；配套用例覆盖每一种分支。
 */
import type { FinalAnswerAction } from './final-answer-routing';

export interface ApplyFinalAnswerDeps {
  /** 最后一步的元素；可能不存在（例如流式期间未建 step）。 */
  step: HTMLElement | null;
  /** agent 容器（append 用）。 */
  container: HTMLElement;
  loopId: string;
  /** 整步清空（含工具记录）。 */
  clearStep: (step: HTMLElement) => void;
  /** 只清正文，保留工具记录。 */
  clearText: (step: HTMLElement) => void;
  /** 用最终答案替换正文。 */
  replaceText: (step: HTMLElement, text: string) => void;
  /** 追加一段旁白到容器。 */
  appendText: (container: HTMLElement, text: string, loopId: string) => void;
  /** replace 之后刷新代码块运行器（可缺省）。 */
  refreshCodeRunners?: (step: HTMLElement) => void;
}

/** 把路由结果落到 DOM。五种 action 一一对应，`none` 不动。 */
export function applyFinalAnswerAction(action: FinalAnswerAction, deps: ApplyFinalAnswerDeps): void {
  switch (action.kind) {
    case 'none':
      return;
    case 'clear-step':
      if (deps.step) deps.clearStep(deps.step);
      return;
    case 'clear-text':
      if (deps.step) deps.clearText(deps.step);
      return;
    case 'replace':
      if (deps.step) {
        deps.replaceText(deps.step, action.text);
        deps.refreshCodeRunners?.(deps.step);
      }
      return;
    case 'append':
      deps.appendText(deps.container, action.text, deps.loopId);
      return;
  }
}
