/**
 * 「最终答案归谁」的**唯一判定点** + 渲染路由的**纯函数**。
 *
 * 历史与教训（2026-10-29 两次根因评审）：
 *  1. live 收尾（content.ts:6676）与刷新恢复（content.ts:9648）各写了一份判据，
 *     恢复态多一个 `toolExecutions.length === 0`，于是同一轮会被相反裁决 ⇒ 双份。
 *  2. 我第一版把两处统一成"原生拥有就清空"，但**清空用的是
 *     `updateStepStreamText(step, '')`，它会把整个 step 删掉**（render-steps.ts:172-177），
 *     连带删掉这个 step 里的工具记录 ⇒ 工具历史丢失。
 *     ⇒ 恢复侧那个 `toolExecutions.length === 0` 其实**不是判定 bug，是渲染安全护栏**。
 *
 * 所以本模块把两件事**分开**：
 *   - **答案归谁**（ownership）：只看"是否已提交原生历史 + 是否预算暂停"。
 *   - **这个 step 能不能动**（render safety）：只有"它确实装着最终答案"才动；
 *     有工具记录时只清正文文本，保留 step 本体。
 *
 * 关键约束：live 与 restore **共用** `traceOwnsFinalTurn`；不要再给判定加额外条件
 * （那会重新制造跨刷新不一致），额外条件只能出现在"能不能动这个 step"这一层。
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
  /** 原生拥有 + 该 step 装着答案 + **没有**工具记录 ⇒ 整个 step 移除。 */
  | { kind: 'clear-step' }
  /** 原生拥有 + 该 step 装着答案 + **有**工具记录 ⇒ 只清正文，保留工具记录。 */
  | { kind: 'clear-text' }
  /** 扩展拥有，且最后一步就是这个答案：就地替换。 */
  | { kind: 'replace'; text: string }
  /** 扩展拥有，但最后一步不是答案：追加一条 narration。 */
  | { kind: 'append'; text: string }
  /** 什么都不做（原生拥有但该 step 不装答案 ⇒ 不能因为"原生拥有"就删工具记录）。 */
  | { kind: 'none' };

export interface FinalAnswerRoutingInput {
  ownsFinalTurn: boolean;
  finalText: string;
  resolvedAnswer: { answer: string; fromStep: boolean };
  /** 最后一个已完成 step 的当前可见文本（空串表示没有）。 */
  lastStepText: string;
  /** 该 step 内是否有工具记录（决定能不能整块删除）。 */
  lastStepHasToolEntries: boolean;
  /** 判断"最后一步是否就是最终答案"的谓词（content.ts 注入，避免本模块依赖 DOM）。 */
  isFinalStepText: (lastStepText: string, finalText: string) => boolean;
}

/**
 * 路由（纯函数）：
 *   1. 原生拥有：
 *      a. 该 step 不装答案 ⇒ `none`（**不许删工具记录**）
 *      b. 装答案 + 有工具记录 ⇒ `clear-text`
 *      c. 装答案 + 无工具记录 ⇒ `clear-step`
 *   2. 扩展拥有 + 最后一步就是答案 ⇒ `replace`
 *   3. 扩展拥有 + 有正文 ⇒ `append`
 *   4. 否则 `none`
 */
export function routeFinalAnswer(input: FinalAnswerRoutingInput): FinalAnswerAction {
  const hasFinalText = Boolean(input.finalText);
  const hasStep = Boolean(input.lastStepText);

  if (input.ownsFinalTurn) {
    // "装着答案"的判据：fromStep（解析器认为答案就在 step 里），或两边构成前缀关系。
    // finalText 为空时 isFinalStepText 恒 false（谓词要求两边都非空），
    // 因此"空正文 + 原生拥有" ⇒ none：没有证据说明这一步装着答案，就不许动它。
    const stepHoldsAnswer =
      hasStep &&
      (input.resolvedAnswer.fromStep ||
        (hasFinalText && input.isFinalStepText(input.lastStepText, input.finalText)));
    if (!stepHoldsAnswer) return { kind: 'none' };
    return input.lastStepHasToolEntries ? { kind: 'clear-text' } : { kind: 'clear-step' };
  }

  if (hasFinalText && hasStep) {
    const isAnswerStep =
      input.resolvedAnswer.fromStep ||
      input.isFinalStepText(input.lastStepText, input.finalText);
    if (isAnswerStep) return { kind: 'replace', text: input.finalText };
  }
  if (hasFinalText) return { kind: 'append', text: input.finalText };
  return { kind: 'none' };
}
/**
 * restore 侧的单步动作（2.4 对齐）。
 *
 * 恢复循环原来只处理了「末步是纯答案 ⇒ 跳过」，
 * 但末步**带工具**且同时是答案时，它会把答案再渲染一遍 ⇒ 与原生重复。
 * 这里把三种动作显式化：
 *   - 原生拥有 + 末步 + 无工具 ⇒ `skip`（整步不渲染，本来就没东西可留）
 *   - 原生拥有 + 末步 + 有工具 ⇒ `render-without-answer`（保留工具记录，去掉答案正文）
 *   - 其余 ⇒ `render`
 */
export type RestoreStepAction = 'skip' | 'render-without-answer' | 'render';

export function decideRestoreStepAction(input: {
  ownsFinalTurn: boolean;
  isLastStep: boolean;
  hasToolEntries: boolean;
}): RestoreStepAction {
  if (!input.ownsFinalTurn || !input.isLastStep) return 'render';
  return input.hasToolEntries ? 'render-without-answer' : 'skip';
}