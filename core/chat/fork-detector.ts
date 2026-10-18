// M1-2c: fork-detector — 分叉检测端口 + 判定逻辑
// 原则：fail-closed，探测不到 = 分叉 = 走 legacy

export interface SessionChainTail {
  sessionId: string;
  tailMessageId: number | null;
  tailRole: 'user' | 'assistant' | 'system' | 'tool' | 'unknown';
  messageCount: number;
  fetchedAt: number;
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

export type ForkReason =
  | 'tail_matches'
  | 'tail_moved'
  | 'parent_missing'
  | 'probe_failed'
  | 'probe_timeout'
  | 'not_applicable';

export interface ForkDecision {
  forked: boolean;
  unknown: boolean;
  reason: ForkReason;
  tail: SessionChainTail | null;
  checkedAt: number;
}

/**
 * 判定分叉
 * fail-closed：探测异常/超时 = unknown = 走 legacy
 */
export function evaluateFork(
  expectedParentMessageId: number,
  tail: SessionChainTail | null,
  error: unknown,
): ForkDecision {
  const checkedAt = Date.now();

  // 探测异常/超时 → unknown → 走 legacy
  if (error || !tail) {
    return {
      forked: false,
      unknown: true,
      reason: error instanceof DOMException && error.name === 'TimeoutError'
        ? 'probe_timeout'
        : 'probe_failed',
      tail: null,
      checkedAt,
    };
  }

  // 尾消息 id 与期望一致 → 未分叉
  if (tail.tailMessageId === expectedParentMessageId) {
    return {
      forked: false,
      unknown: false,
      reason: 'tail_matches',
      tail,
      checkedAt,
    };
  }

  // 尾消息 id 变了 → 分叉
  if (tail.tailMessageId !== null && tail.tailMessageId !== expectedParentMessageId) {
    return {
      forked: true,
      unknown: false,
      reason: 'tail_moved',
      tail,
      checkedAt,
    };
  }

  // 尾消息 id 为 null（链上找不到）→ 分叉
  return {
    forked: true,
    unknown: false,
    reason: 'parent_missing',
    tail,
    checkedAt,
  };
}

/**
 * 带超时的分叉探测
 */
export async function probeForkWithTimeout(
  probe: ForkProbe,
  input: ForkProbeInput,
  timeoutMs: number,
): Promise<ForkDecision> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const tail = await probe.readSessionChainTail(input, controller.signal);
    clearTimeout(timer);
    return evaluateFork(input.expectedParentMessageId, tail, null);
  } catch (error) {
    clearTimeout(timer);
    return evaluateFork(input.expectedParentMessageId, null, error);
  }
}
