/**
 * W29 事件采集器（2026-10-21 接线）。
 *
 * `core/trace/report.ts` 定义了 TraceEvent 并提供了 renderTraceReport，但从没有人往里面发事件——
 * 这正是「断流」类问题长期无法定位的根因：观测器具造好了却没接上线。
 *
 * 本模块提供两件事：
 * 1. 一个有上限的收集器（事件条数封顶，避免 SSE 帧撑爆持久化预算）；
 * 2. 一个模块级 sink——因为 inline agent 循环与内容脚本跑在同一个上下文
 *    （content.ts 直接 await runInlineAgentLoop），loop-adapter 可以直接 emit，
 *    由内容脚本把事件挂到当前 trace 上。
 *
 * 注意：sink 是模块级单例。本模块只应在单一上下文内使用（当前仅内容脚本）。
 * 跨上下文需要事件回流时，走消息通道而不是这个 sink。
 */

import type { ContinuationReason, TraceEvent } from './report';

/** 单条 trace 保存的事件上限。超出后丢弃最旧的事件（保留最近的现场）。 */
export const TRACE_EVENT_LIMIT = 200;

/**
 * 外部（如 loop-adapter）能上报的事件子集。
 *
 * loop-adapter 不知道当前 turnId（轮次由内容脚本按 step 划分），所以它只上报「判定结果」，
 * 由内容脚本的 tracker 补齐 turnId/timestamp。其余事件由内容脚本直接从消息流产生。
 */
export interface ExternalTraceEvent {
  t: 'continuation.decision';
  reason: ContinuationReason;
  triggered: boolean;
}

type TraceEventSink = (event: ExternalTraceEvent) => void;

let activeSink: TraceEventSink | null = null;

/** 绑定当前 trace 的事件接收器；传 null 解绑（loop 结束后必须解绑）。 */
export function setTraceEventSink(sink: TraceEventSink | null): void {
  activeSink = sink;
}

/** 上报一条外部轨迹事件。没有绑定 sink 时静默丢弃——观测永远不能影响主流程。 */
export function emitTraceEvent(event: ExternalTraceEvent): void {
  try {
    activeSink?.(event);
  } catch {
    // 观测失败绝不影响 agent 循环。
  }
}

export interface TraceEventCollector {
  push(event: TraceEvent): void;
  snapshot(): readonly TraceEvent[];
  readonly size: number;
  /** 因超出上限而被丢弃的事件数（用于判断现场是否完整）。 */
  readonly dropped: number;
}

export function createTraceEventCollector(limit = TRACE_EVENT_LIMIT): TraceEventCollector {
  const events: TraceEvent[] = [];
  let dropped = 0;

  return {
    push(event: TraceEvent): void {
      events.push(event);
      while (events.length > limit) {
        events.shift();
        dropped += 1;
      }
    },
    snapshot(): readonly TraceEvent[] {
      return events.slice();
    },
    get size(): number {
      return events.length;
    },
    get dropped(): number {
      return dropped;
    },
  };
}
