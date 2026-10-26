// M1-2c: fork-detector — 分叉检测
// 对比页面会话链尾的 tailMessageId 与 marker.parentMessageId
/**
 * @workitem M1-2c
 * @status  deferred
 * @since   2026-10-18 (introduced by 1787a0f)
 * @note    纯函数已交付并有用例；接线点：续跑/resume 拿到 marker 后比对页面 session chain tailMessageId（推断）
 */

export interface SessionChainTail {
  sessionId: string;
  tailMessageId: number;
  tailRole: 'user' | 'assistant';
  messageCount: number;
  fetchedAt: number;
}

export type ForkEvaluationResult =
  | { forked: false; unknown: false; reason: 'tail_matches' }
  | { forked: true; unknown: false; reason: 'tail_moved' }
  | { forked: false; unknown: true; reason: 'probe_failed' | 'probe_timeout' };

export function evaluateFork(
  expectedParentMessageId: number,
  tail: SessionChainTail | null,
  error: unknown,
): ForkEvaluationResult {
  if (error instanceof DOMException && error.name === 'TimeoutError') {
    return { forked: false, unknown: true, reason: 'probe_timeout' };
  }
  if (error) {
    return { forked: false, unknown: true, reason: 'probe_failed' };
  }
  if (!tail) {
    return { forked: false, unknown: true, reason: 'probe_failed' };
  }
  if (tail.tailMessageId === expectedParentMessageId) {
    return { forked: false, unknown: false, reason: 'tail_matches' };
  }
  return { forked: true, unknown: false, reason: 'tail_moved' };
}

export interface ForkProbeInput {
  chatSessionId: string;
  clientHeaders: Record<string, string>;
  expectedParentMessageId: number;
}

export interface ForkProbe {
  readSessionChainTail(
    input: ForkProbeInput,
    signal: AbortSignal,
  ): Promise<SessionChainTail>;
}

export async function probeForkWithTimeout(
  probe: ForkProbe,
  input: ForkProbeInput,
  timeoutMs: number,
): Promise<ForkEvaluationResult> {
  const controller = new AbortController();
  // 审计 #9（2026-10-24 报告 P1）：裸 `controller.abort()` 按规范把 signal.reason
  // 设为 AbortError，而 evaluateFork 判的是 `error.name === 'TimeoutError'` ——
  // 于是**超时分支是死代码**，所有超时都被归成 probe_failed，诊断信息失真。
  // 显式传一个 name='TimeoutError' 的 DOMException，让两条分支各自可达。
  const timeoutId = setTimeout(() => {
    controller.abort(new DOMException('Fork probe timed out.', 'TimeoutError'));
  }, timeoutMs);

  try {
    const tail = await probe.readSessionChainTail(input, controller.signal);
    return evaluateFork(input.expectedParentMessageId, tail, null);
  } catch (error) {
    return evaluateFork(input.expectedParentMessageId, null, error);
  } finally {
    clearTimeout(timeoutId);
  }
}

// ---- W31：续跑门控决策（纯函数） + 本地「上次确认 parentMessageId」记录骨架 ----

export interface ResumeGateDecision {
  /** 是否允许继续续跑。 */
  allowed: boolean;
  /** 决策原因：fork_detected 拒绝；tail_matches 放行；probe_unknown_allow 探测未知保守放行。 */
  reason: string;
}

/**
 * W31：把分叉评估结果转成续跑门控决策。
 * - tail_moved（forked）→ 拒绝续跑（避免把用户对话搞成两条分叉），reason=fork_detected；
 * - probe_failed / probe_timeout（unknown）→ 保守放行（探测不到服务端数据不应阻断），
 *   仅留日志；调用方据此记录 fork_detected 或告警。
 * - tail_matches → 放行。
 * 纯函数，不打日志、不触碰存储。
 */
export function decideResumeAfterForkCheck(
  result: ForkEvaluationResult,
): ResumeGateDecision {
  if (result.forked) {
    return { allowed: false, reason: 'fork_detected' };
  }
  if (result.unknown) {
    return { allowed: true, reason: 'probe_unknown_allow' };
  }
  return { allowed: true, reason: 'tail_matches' };
}

/**
 * 本地「上次已确认 parentMessageId」记录。生产可换成 chrome.storage 注入实现；
 * 雏形用内存 Map 立住接口（规格 W31 备选：只做本地 state 记录，不做服务端比对）。
 */
export interface ConfirmedParentStore {
  get(sessionId: string): number | null;
  set(sessionId: string, parentMessageId: number): void;
  clear(sessionId: string): void;
}

/** 内存版确认记录器骨架（按 sessionId 维度）。 */
export function createInMemoryConfirmedParentStore(): ConfirmedParentStore {
  const map = new Map<string, number>();
  return {
    get(sessionId) {
      const value = map.get(sessionId);
      return value === undefined ? null : value;
    },
    set(sessionId, parentMessageId) {
      map.set(sessionId, parentMessageId);
    },
    clear(sessionId) {
      map.delete(sessionId);
    },
  };
}
