/**
 * 页面流"保活"判定（2026-10-31，A/B 实证）。
 *
 * 事故：dpp 用自己的 ReadableStream 替换了页面收到的响应体
 *（`response-interceptor.ts`）。当 `XmlToolStreamFilter` 进入 SUPPRESSING
 *（工具块开了没闭合）时，**一个字节都不写给页面**。
 *
 * A/B 实测（同一提示词）：
 *   扩展关闭 → 2/2 正常（346 / 434 字），无「服务器暂时不可用」
 *   扩展开启 → 191 字处出现「服务器暂时不可用」，随后断流
 *
 * 结论：工具块越长，页面被饿死越久 → 页面自己的空闲判定报错 → 关流 → 断流。
 * 修法：抑制期间按固定节奏写一个**零长度块**，让页面知道流还活着。
 */

/** 抑制期间向页面写保活块的最小间隔。 */
export const STREAM_KEEPALIVE_MS = 800;

export interface KeepAliveDecisionInput {
  /** 当前是否因为要隐藏工具 XML 而扣着帧不发。 */
  suppressing: boolean;
  /** 距离上一次向页面写数据过去了多久。 */
  idleMs: number;
  /** 上游是否已经读完（读完就不再保活）。 */
  finished?: boolean;
  thresholdMs?: number;
}

/**
 * 该不该给页面写一个保活块。
 *
 * 只在一件事上保守：上游已结束就不保活（否则页面永远等不到结束）。
 */
export function shouldEmitKeepAlive(input: KeepAliveDecisionInput): boolean {
  if (input.finished === true) return false;
  if (!input.suppressing) return false;
  const threshold = input.thresholdMs ?? STREAM_KEEPALIVE_MS;
  return input.idleMs >= threshold;
}
