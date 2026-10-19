// M1-2c: fork-detector — 分叉检测
// 对比页面会话链尾的 tailMessageId 与 marker.parentMessageId

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
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const tail = await probe.readSessionChainTail(input, controller.signal);
    return evaluateFork(input.expectedParentMessageId, tail, null);
  } catch (error) {
    return evaluateFork(input.expectedParentMessageId, null, error);
  } finally {
    clearTimeout(timeoutId);
  }
}
