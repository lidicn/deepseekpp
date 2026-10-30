/**
 * 页面流"保活"判定（2026-10-31，独立评审 §3.4 修正版）。
 *
 * 事故背景：dpp 用自建 ReadableStream 替换页面响应体（`response-interceptor.ts`）。
 * 工具块开标签到达、闭标签未到时，滤镜进入 SUPPRESSING，**工具块的正文文本帧被扣留**
 * （结构帧/空帧/非响应事件仍照发 —— 见 `xml-tool-stream-filter.ts` 的帧分类）。
 *
 * 评审指出的实现缺陷：第一版调用点是
 *   `shouldEmitKeepAlive({ suppressing, idleMs: STREAM_KEEPALIVE_MS, finished })`
 * 把**常量**当"距上次写入的空闲毫秒"传进去，而阈值也是同一常量 ⇒ 判据恒真，
 * "空闲多久"根本没被测量。纯函数测不出来（它测的是自己）。
 *
 * 修法：把"空闲"的计算**收进本模块**，调用方只能给时间戳，给不了"伪空闲"。
 */

/** 抑制期间向页面写保活块的最小间隔。 */
export const STREAM_KEEPALIVE_MS = 800;

export interface KeepAliveDecisionInput {
  /** 当前是否因为要隐藏工具正文而扣着文本帧不发。 */
  suppressing: boolean;
  /** 上一次**真实写入页面流**的单调时间（`performance.now()` 或 `Date.now()`，同一时钟即可）。 */
  lastWriteAt: number;
  /** 现在的时间，时钟必须与 `lastWriteAt` 一致。 */
  now: number;
  /** 上游是否已经读完（读完就不再保活）。 */
  finished?: boolean;
  thresholdMs?: number;
}

/**
 * 该不该给页面写一个保活块。
 *
 * 只在一件事上保守：上游已结束就不保活（否则页面永远等不到结束）。
 */
export function decidePageKeepAlive(input: KeepAliveDecisionInput): boolean {
  if (input.finished === true) return false;
  if (!input.suppressing) return false;
  const threshold = input.thresholdMs ?? STREAM_KEEPALIVE_MS;
  const idleMs = input.now - input.lastWriteAt;
  // 时钟回退/初值未设置时保守放行（宁可多写一个零长度块，也不要让页面饿死）。
  if (!Number.isFinite(idleMs) || idleMs < 0) return true;
  return idleMs >= threshold;
}

/** 距上次写入的空闲毫秒数（供诊断使用）。 */
export function pageIdleMs(lastWriteAt: number, now: number): number {
  const idle = now - lastWriteAt;
  return Number.isFinite(idle) && idle >= 0 ? idle : 0;
}
