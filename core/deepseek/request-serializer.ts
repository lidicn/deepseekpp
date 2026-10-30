/**
 * 出站请求串行化（2.3，修法）。
 *
 * 假设（由 `request-activity` 观测验证）：新对话首条消息时，页面自己的 completion
 * 请求与 dpp 的 agent / 记忆提取请求在同一 `chat_session_id` 上重叠 ⇒ 服务端抢占
 * ⇒ 页面弹「服务器问题」。
 *
 * 设计原则（**页面请求永不被延迟**）：
 *   - `page` 请求：一律 `proceed`（延迟它等于让用户等，绝不能做）
 *   - `agent` / `memory` 请求：若同会话上有 `page` 请求在飞 ⇒ `wait`
 *   - 等待超过上限 ⇒ `timeout-proceed`（宁可并发，也不让 agent 卡死）
 *
 * 开关（无需改码）：`localStorage['dpp:requestSerializer']`
 *   - 缺省 / `'1'` ⇒ 启用（默认上限 5s）
 *   - `'0'` ⇒ 关闭（永不等）
 *   - 其他数字 ⇒ 自定义上限毫秒
 */

import type { RequestActivityEntry, RequestSource } from './request-activity';

export const DEFAULT_SERIALIZER_MAX_WAIT_MS = 5_000;
export const SERIALIZER_POLL_MS = 250;

export type SerializerDecision =
  | { action: 'proceed' }
  | { action: 'wait'; waitMs: number }
  | { action: 'timeout-proceed' };

export function decideSerialization(input: {
  selfSource: RequestSource;
  activeOnSameSession: readonly RequestActivityEntry[];
  waitedMs: number;
  maxWaitMs: number;
}): SerializerDecision {
  // 关闭 / 无需等待
  if (!(input.maxWaitMs > 0)) return { action: 'proceed' };
  // 页面请求永不等待
  if (input.selfSource === 'page' || input.selfSource === 'unknown') return { action: 'proceed' };
  // 同会话上没有页面请求在飞 ⇒ 直接走
  const pageInFlight = input.activeOnSameSession.some((entry) => entry.source === 'page');
  if (!pageInFlight) return { action: 'proceed' };
  if (input.waitedMs >= input.maxWaitMs) return { action: 'timeout-proceed' };
  return { action: 'wait', waitMs: Math.min(SERIALIZER_POLL_MS, input.maxWaitMs - input.waitedMs) };
}

/**
 * 读取上限（同步）。控制台回滚：`localStorage.setItem('dpp:requestSerializer','0')`。
 */
export function resolveSerializerMaxWaitMs(): number {
  try {
    const raw = globalThis.localStorage?.getItem('dpp:requestSerializer');
    if (typeof raw === 'string' && raw.trim().length > 0) {
      if (raw.trim() === '0') return 0;
      const parsed = Number(raw);
      if (Number.isFinite(parsed) && parsed >= 0) return parsed;
    }
  } catch {
    // 读不到用默认
  }
  return DEFAULT_SERIALIZER_MAX_WAIT_MS;
}
/**
 * 等待一个"请求槽位"（带上限）。返回实际等待毫秒数。
 *
 * 用法：`const waited = await awaitRequestSlot({ source, activeOnSameSession: () => [...] })`
 * 说明：本函数**不做登记**，登记仍由 `requestActivity.begin/end` 负责，
 * 这样调用方可以自由决定登记的时机（例如先登记再等待）。
 */
export async function awaitRequestSlot(input: {
  selfSource: RequestSource;
  /** 取当前同会话上仍在飞的请求（每次轮询重新取）。 */
  activeOnSameSession: () => readonly RequestActivityEntry[];
  maxWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}): Promise<{ waitedMs: number; timedOut: boolean }> {
  const maxWaitMs = input.maxWaitMs ?? resolveSerializerMaxWaitMs();
  if (!(maxWaitMs > 0)) return { waitedMs: 0, timedOut: false };
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = input.now ?? Date.now;
  const started = now();
  // 有界保护：即使时钟不前进（注入的 now 冻结）或决策异常，也绝不无限等待。
  // 变异验证记录：去掉上面的 timeout-proceed 守卫曾导致无限循环（任务被 kill）。
  const maxIterations = Math.ceil(maxWaitMs / Math.max(1, SERIALIZER_POLL_MS)) + 2;
  let iterations = 0;
  let waitedMs = 0;

  for (;;) {
    const decision = decideSerialization({
      selfSource: input.selfSource,
      activeOnSameSession: input.activeOnSameSession(),
      waitedMs,
      maxWaitMs,
    });
    if (decision.action === 'proceed') return { waitedMs, timedOut: false };
    if (decision.action === 'timeout-proceed') return { waitedMs, timedOut: true };
    iterations += 1;
    if (iterations > maxIterations) return { waitedMs, timedOut: true };
    await sleep(decision.waitMs);
    // 用真实时钟校正，避免注入的 sleep 与 waitedMs 漂移
    waitedMs = Math.max(waitedMs + decision.waitMs, now() - started);
  }
}