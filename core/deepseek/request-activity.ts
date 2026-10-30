/**
 * 出站请求并发观测（2.3，先观测后修）。
 *
 * 假设待验：新对话首条消息时，页面自己的 completion 请求与 dpp 的
 * agent / 记忆提取请求在**同一 chat_session_id** 上重叠 ⇒ DeepSeek 抢占
 * ⇒ 页面弹「服务器问题」。
 *
 * 在拿到证据前**不改** `preempt`（独立评审 §6 F4 也要求先有判据）。
 * 本模块只做一件事：记录"同一会话上是否同时有多个请求在飞"。
 */

export type RequestSource = 'page' | 'agent' | 'memory' | 'unknown';

export interface RequestActivityEntry {
  requestId: string;
  chatSessionId: string | null;
  parentMessageId: number | null;
  source: RequestSource;
  startedAt: number;
}

export interface RequestActivityTracker {
  /** 登记一个开始；返回同一会话上**仍在飞**的其它请求（用于判并发）。 */
  begin(entry: {
    requestId: string;
    chatSessionId?: string | null;
    parentMessageId?: number | null;
    source?: RequestSource;
    now?: number;
  }): { entry: RequestActivityEntry; concurrent: RequestActivityEntry[] };
  end(requestId: string): void;
  snapshot(): RequestActivityEntry[];
  /** 仅测试用：清空。 */
  reset(): void;
}

const SESSION_KEY_UNKNOWN = '\u0000unknown';

function keyOf(chatSessionId: string | null): string {
  return chatSessionId ?? SESSION_KEY_UNKNOWN;
}

export function createRequestActivityTracker(): RequestActivityTracker {
  const active = new Map<string, RequestActivityEntry>();

  return {
    begin(input) {
      const entry: RequestActivityEntry = {
        requestId: input.requestId,
        chatSessionId: input.chatSessionId ?? null,
        parentMessageId: input.parentMessageId ?? null,
        source: input.source ?? 'unknown',
        startedAt: input.now ?? Date.now(),
      };
      const key = keyOf(entry.chatSessionId);
      const concurrent = [...active.values()].filter((item) => keyOf(item.chatSessionId) === key);
      active.set(entry.requestId, entry);
      return { entry, concurrent };
    },
    end(requestId) {
      active.delete(requestId);
    },
    snapshot() {
      return [...active.values()];
    },
    reset() {
      active.clear();
    },
  };
}

/** 进程级单例：页面请求、agent 请求、记忆请求共用一份账本。 */
export const requestActivity = createRequestActivityTracker();

/** 一行诊断文本（进 diagnosticLogBuffer.details）。 */
export function formatConcurrentRequest(
  self: RequestActivityEntry,
  others: readonly RequestActivityEntry[],
): string {
  const list = others
    .map((item) => `${item.source}@${item.startedAt}${item.parentMessageId === null ? '' : `#${item.parentMessageId}`}`)
    .join(',');
  return `self=${self.source} session=${self.chatSessionId ?? 'n/a'} others=${others.length} [${list}]`;
}
