/**
 * Harness Events — M0 度量基座的纯事件 schema 与纯聚合函数。
 *
 * 设计约束（AGENTS.md / v2 计划 §4）：
 *   - 本文件**零 IO、零存储键、零门控依赖**：只定义事件形状、ring buffer 与纯统计，
 *     可独立单测，也可移植给 studio；持久化与门控由 refactor-telemetry（M0-2）负责。
 *   - 只承载计数/深度/成功标志，**绝不携带 prompt 原文、请求体、工具参数**（MAIN world 不可信）。
 *   - continuation_triggered 是**单一事件 + reason 分组**，不再拆两类，避免 user_continued
 *     同时进分子分母造成双计数（v2 §4 G2 重定义）。
 *
 * G2（用户干预率）= userContinuedCount / (userContinuedCount + modelRequestedCount)，
 * 数字越低 = 模型自动续跑越健康。
 */

/** 续跑触发来源：模型自动请求 vs 用户主动发 continue。 */
export type ContinuationReason = 'model_requested' | 'user_continued';

/**
 * M0 harness 事件（旁路观测，不进 AGENT_* 事件协议，AGENTS.md:67）。
 * - tool_call_start / tool_call_end 必须成对（M0-2 在 finally 补发 end）。
 * - turnId 复用 inline agent 的 loopId（见 m0-phase0-调用链图.md §5）。
 */
export type HarnessEvent =
  | {
      type: 'tool_call_start';
      turnId: string;
      toolName: string;
      depth: number;
      callIndex: number;
      timestamp: number;
    }
  | {
      type: 'tool_call_end';
      turnId: string;
      toolName: string;
      success: boolean;
      durationMs: number;
      errorType?: string;
      timestamp: number;
    }
  | {
      type: 'loop_depth_incremented';
      turnId: string;
      newDepth: number;
      timestamp: number;
    }
  | {
      type: 'continuation_triggered';
      turnId: string;
      reason: ContinuationReason;
      timestamp: number;
    }
  | {
      type: 'turn_finished';
      turnId: string;
      finalDepth: number;
      toolCallCount: number;
      timestamp: number;
    };

/** ring buffer 容量上限（v2 §4：500 条，仅内存，不持久化）。 */
export const HARNESS_EVENT_BUFFER_LIMIT = 500;

/** 有界环形事件缓冲：满了淘汰最早一条。纯内存，不触碰存储。 */
export interface HarnessEventBuffer {
  push(event: HarnessEvent): void;
  list(): readonly HarnessEvent[];
  clear(): void;
  size(): number;
}

export function createHarnessEventBuffer(
  limit: number = HARNESS_EVENT_BUFFER_LIMIT,
): HarnessEventBuffer {
  const capacity = Math.max(1, Math.floor(limit));
  let items: HarnessEvent[] = [];
  return {
    push(event) {
      items.push(event);
      if (items.length > capacity) items = items.slice(items.length - capacity);
    },
    list() {
      return items;
    },
    clear() {
      items = [];
    },
    size() {
      return items.length;
    },
  };
}

/** 按 reason 分组的续跑计数（G2 分子/分母同源，消除双计数）。 */
export interface ContinuationCounts {
  modelRequestedCount: number;
  userContinuedCount: number;
}

/** 从事件流统计两类续跑次数。 */
export function countContinuations(
  events: readonly HarnessEvent[],
): ContinuationCounts {
  let modelRequestedCount = 0;
  let userContinuedCount = 0;
  for (const event of events) {
    if (event.type !== 'continuation_triggered') continue;
    if (event.reason === 'user_continued') {
      userContinuedCount++;
    } else {
      modelRequestedCount++;
    }
  }
  return { modelRequestedCount, userContinuedCount };
}

/**
 * G2 用户干预率 ∈ [0,1]；无续跑样本时返回 null（区别于 0%，供 summary 输出"样本不足"）。
 */
export function g2UserInterventionRate(
  counts: ContinuationCounts,
): number | null {
  const total = counts.modelRequestedCount + counts.userContinuedCount;
  if (total === 0) return null;
  return counts.userContinuedCount / total;
}

/**
 * 深度直方图：以每个 turn 的最终深度（turn_finished.finalDepth）为样本，
 * key=深度、value=出现次数。纯函数，不修改入参。
 */
export function buildLoopDepthHistogram(
  events: readonly HarnessEvent[],
): Record<number, number> {
  const histogram: Record<number, number> = {};
  for (const event of events) {
    if (event.type !== 'turn_finished') continue;
    const depth = event.finalDepth;
    histogram[depth] = (histogram[depth] || 0) + 1;
  }
  return histogram;
}

/** 统计一个 turn（按 turnId 聚合）内成功/失败工具调用数，供 G1 交叉核对。 */
export function countToolCallResults(
  events: readonly HarnessEvent[],
): { success: number; failure: number } {
  let success = 0;
  let failure = 0;
  for (const event of events) {
    if (event.type !== 'tool_call_end') continue;
    if (event.success) success++;
    else failure++;
  }
  return { success, failure };
}
