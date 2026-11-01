/**
 * trace 终态口径（t3-B，2026-11-01）。
 *
 * 问题：`content.ts` 的 `finishTraceRun(stopReason, hasFinalText)` 以前只看
 * 「finalized + 有文本」就记 `finished=true`。中断轮（服务端 EOF 无 FINISHED →
 * partial/'length' → 结算层出「已中断」提示）的 finalText 恰好是那段提示文案，
 * 于是 **中断被记成完成**，报告/验收永远看不出这是断流。
 *
 * 口径：中断就是中断 —— trace 里 `stopReason=interrupted` 且 `finished=false`，
 * 即使 finalText 是可读提示也不算「用户拿到东西了」。
 */

export const TRACE_INTERRUPTED_STOP_REASON = 'interrupted';

/** 终态 stopReason：中断轮把 finalized 改写为 interrupted。 */
export function resolveTraceStopReason(stopReason: string, interrupted: boolean): string {
  if (interrupted && stopReason === 'finalized') return TRACE_INTERRUPTED_STOP_REASON;
  return stopReason;
}

/** 是否记为 finished（= 用户真的拿到答案）：只有 finalized 且 finalText 非空。 */
export function isTraceRunFinished(stopReason: string, hasFinalText: boolean): boolean {
  return stopReason === 'finalized' && hasFinalText;
}
