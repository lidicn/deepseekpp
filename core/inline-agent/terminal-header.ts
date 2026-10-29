/**
 * 收尾头部的 phase / 标签决策（F2：截断轮不得显示「已完成」）。
 *
 * 独立评审 §6 F2：截断轮 UI 仍显示「已完成 · 1 步 · 3 次工具」是对用户最大的误导。
 * 这里把「该显示什么」收敛成一个纯函数，便于测试与后续复用。
 */

export type TerminalPhase = 'complete' | 'paused' | 'error';

export interface TerminalHeaderDecision {
  phase: TerminalPhase;
  /** 需要覆盖默认标签时给出 i18n key；null 表示用默认文案。 */
  labelKey: 'content.agent.interruptedLabel' | null;
}

export function resolveTerminalHeader(input: {
  interrupted: boolean;
  budgetPaused: boolean;
  hadError?: boolean;
}): TerminalHeaderDecision {
  if (input.hadError) return { phase: 'error', labelKey: null };
  if (input.interrupted) return { phase: 'complete', labelKey: 'content.agent.interruptedLabel' };
  if (input.budgetPaused) return { phase: 'paused', labelKey: null };
  return { phase: 'complete', labelKey: null };
}
