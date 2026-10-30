/**
 * 对话首轮 completion 的安全重试（2026-10-30，审计报告 P2-1）。
 *
 * 真机/探针实证：`submitWebPrompt` 首轮调用 **1 次**，服务端的
 * `服务器暂时不可用…` 文案被原样透传给用户 —— 这就是"新对话首条消息
 * 高概率出现「服务器问题」"的直接原因。
 *
 * 为什么"未收到任何 chunk 才可重试"：
 * 一旦收到过文本/思考增量，服务端可能已经提交了该响应，
 * 再用同一个 `parent_message_id` 重发会让会话链分叉
 * （该门控在 `core/inline-agent/pi/deepseek-stream-fn.ts` 的 `submitWithRetry`
 * 里已经实现过，只是没接到对话路径）。
 */

export interface FirstTurnRetryInput {
  /** 本次尝试是否已经收到过任何增量（文本或思考）。 */
  receivedAnyChunk: boolean;
  /** 剩余可重试次数。 */
  attemptsLeft: number;
  /** 用户/上层是否已取消。 */
  aborted: boolean;
}

export interface FirstTurnRetryDecision {
  retry: boolean;
  reason: 'chunk-received' | 'aborted' | 'exhausted' | 'safe-to-retry';
}

export const FIRST_TURN_MAX_ATTEMPTS = 2;
export const FIRST_TURN_RETRY_BACKOFF_MS = 600;

export function shouldRetryFirstTurn(input: FirstTurnRetryInput): FirstTurnRetryDecision {
  if (input.aborted) return { retry: false, reason: 'aborted' };
  if (input.attemptsLeft <= 0) return { retry: false, reason: 'exhausted' };
  // 关键：收到过增量就绝不重试（服务端可能已提交，重发会分叉会话链）
  if (input.receivedAnyChunk) return { retry: false, reason: 'chunk-received' };
  return { retry: true, reason: 'safe-to-retry' };
}

export interface FirstTurnResultRetryInput {
  /** 本次尝试是否收到过任何增量。 */
  receivedAnyChunk: boolean;
  /** 服务端是否给出"完成"信号（FINISHED）。 */
  finished: boolean;
  /** 本次尝试最终拿到的可见正文长度。 */
  textLength: number;
  attemptsLeft: number;
  /** 结果里是否已带上服务端故障文案（页面会原样透出）。 */
  serverErrorText: boolean;
}

export type FirstTurnResultRetryReason =
  | "retry-server-error"
  | "retry-empty-unfinished"
  | "chunk-received"
  | "finished"
  | "exhausted";

/**
 * **结果**层面的首轮重试判据（2026-10-30 真机补充）。
 *
 * 之前的判据只看"抛没抛异常"。但「服务器暂时不可用」这种情况里，
 * 请求往往**正常返回**（HTTP 200 + 错误文案），异常没抛 ⇒ 重试门没命中 ⇒
 * 用户照样看到「服务器问题」。所以要补两条结果判据：
 *
 *   1. 结果里带着服务端故障文案 ⇒ 重试
 *   2. 一个字都没收到、且没有 FINISHED ⇒ 重试
 *
 * 仍然保留铁律：**收到过任何增量就不重试**（服务端可能已提交，重发会分叉会话链）。
 */
export function shouldRetryFirstTurnResult(input: FirstTurnResultRetryInput): {
  retry: boolean;
  reason: FirstTurnResultRetryReason;
} {
  if (input.attemptsLeft <= 0) return { retry: false, reason: "exhausted" };
  if (input.receivedAnyChunk) return { retry: false, reason: "chunk-received" };
  if (input.serverErrorText) return { retry: true, reason: "retry-server-error" };
  if (!input.finished && input.textLength === 0) {
    return { retry: true, reason: "retry-empty-unfinished" };
  }
  return { retry: false, reason: "finished" };
}
