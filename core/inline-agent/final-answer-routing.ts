/**
 * 「最终答案归谁」的**唯一判定点** + 渲染路由的**纯函数**。
 *
 * 为什么要有这个文件（2026-10-29 根因定位 `二次结论-根因定位-20261029.md` §2.4）：
 * 原来 live 收尾（content.ts:6676）与刷新恢复（content.ts:9648）各写了一份判据，
 * 恢复态还多了一个 `lastStepRecord?.toolExecutions.length === 0`。于是同一轮 run
 * 可以「收尾时判原生拥有、刷新后判扩展拥有」—— 这正是"有时一份、有时两份"的来源。
 *
 * 现在两处**都必须**调用 `traceOwnsFinalTurn()`，且**禁止**再传额外条件。
 *
 * 另一个关键点（原实现漏掉的）：`ownsFinalTurn === true` 时正确动作不是"跳过再画"，
 * 而是 **清空已经流式画在屏上的那份**。否则原生有一份、扩展屏上还有一份，
 * 只是不再新增 —— 用户看到的依然是两份。
 */

import { isInlineAgentNativeHistoryBackedTrace } from './native-history';
import type { InlineAgentTraceRecord } from './types';

export interface FinalAnswerOwnershipOptions {
  /** 预算暂停/中断的轮次不算提交到原生历史。 */
  budgetPaused: boolean;
}

/**
 * 唯一判定：这一轮的最终答案是否由**原生消息**拥有（原生渲染即权威）。
 *
 * 约束：live 与 restore **共用**本函数；任何额外条件（如"最后一步不能有工具执行"）
 * 都会重新制造跨刷新不一致，**不要再加**。
 */
export function traceOwnsFinalTurn(
  trace: InlineAgentTraceRecord | null | undefined,
  options: FinalAnswerOwnershipOptions,
): boolean {
  if (options.budgetPaused) return false;
  if (!trace) return false;
  return isInlineAgentNativeHistoryBackedTrace(trace);
}

export type FinalAnswerAction =
  /** 原生拥有：把扩展已流式渲染的那份 step 清掉（不是跳过）。 */
  | { kind: 'clear' }
  /** 扩展拥有，且最后一步就是这个答案：就地替换。 */
  | { kind: 'replace'; text: string }
  /** 扩展拥有，但最后一步不是答案：追加一条 narration。 */
  | { kind: 'append'; text: string }
  | { kind: 'none' };

export interface FinalAnswerRoutingInput {
  ownsFinalTurn: boolean;
  finalText: string;
  resolvedAnswer: { answer: string; fromStep: boolean };
  /** 最后一个已完成 step 的当前可见文本（空串表示没有）。 */
  lastStepText: string;
  /** 判断"最后一步是否就是最终答案"的谓词（content.ts 注入，避免本模块依赖 DOM）。 */
  isFinalStepText: (lastStepText: string, finalText: string) => boolean;
}

/**
 * 路由（纯函数，好测）：
 *   1. 原生拥有 ⇒ clear（**即使 finalText 为空也要 clear**，屏上那份必须消失）
 *   2. 否则有最后一步且它就是答案 ⇒ replace
 *   3. 否则有正文 ⇒ append
 *   4. 否则 none
 */
export function routeFinalAnswer(input: FinalAnswerRoutingInput): FinalAnswerAction {
  if (input.ownsFinalTurn) return { kind: 'clear' };

  const hasFinalText = Boolean(input.finalText);
  const hasStep = Boolean(input.lastStepText);
  if (hasFinalText && hasStep) {
    const isAnswerStep =
      input.resolvedAnswer.fromStep ||
      input.isFinalStepText(input.lastStepText, input.finalText);
    if (isAnswerStep) return { kind: 'replace', text: input.finalText };
  }
  if (hasFinalText) return { kind: 'append', text: input.finalText };
  return { kind: 'none' };
}
