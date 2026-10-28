/**
 * W29 轮次跟踪器（2026-10-21 接线）。
 *
 * 把「消息流 → TraceEvent 流」的映射逻辑集中在纯模块里，内容脚本只负责调用，
 * 这样两件事都能成立：content.ts 的改动极小；映射逻辑可以单测，不必上真机。
 *
 * 关键设计：
 * - turnId 按「步」划分（loopId:stepIndex）。inline agent 的一次模型请求＝一个 turn。
 * - SSE 帧不逐帧记录，按 kind 累计，达到阈值或 flush 时只发一条聚合事件，
 *   避免事件数组被刷屏（100 帧就撑爆 200 条上限）。
 * - 每次 emit 都回调 onChange，由调用方决定「立即落盘」还是「防抖落盘」：
 *   turn.start 必须立即落盘——否则进程被杀时连「这一轮开始过」都查不到（Bug B 的取证前提）。
 */

import { createTraceEventCollector, type TraceEventCollector } from './collector';
import type {
  ContinuationReason,
  SseFrameKind,
  TraceEvent,
  TraceEventType,
} from './report';

/** SSE 累计到多少帧就发一条聚合事件。 */
export const SSE_FLUSH_THRESHOLD = 20;

export interface TraceEventChange {
  event: TraceEvent;
  events: readonly TraceEvent[];
}

export interface TurnTrackerOptions {
  limit?: number;
  now?: () => number;
  onChange?: (change: TraceEventChange) => void;
}

export interface SseCounts {
  text: number;
  think: number;
  tool: number;
}

export interface TurnTracker {
  /** 开始新的一轮。返回该轮的 turnId。 */
  startTurn(turnId: string): string;
  /**
   * 记录「请求真正发出」的观测点（第十批 P0-2）。
   * bytes = 序列化后 prompt 的 UTF-8 字节数；powMs 可省略（official-api 无 PoW）。
   */
  requestSent(bytes: number, powMs?: number): void;
  sseFrame(kind: SseFrameKind, count?: number): void;
  /** 把累计的 SSE 计数冲刷成一条 sse.frame 事件（若为 0 则不产生事件）。 */
  flushSse(): void;
  toolParsed(name: string, status: 'OK' | 'FAIL'): void;
  /** 记录一次工具执行；durationMs 可省略（工具结果不携带耗时）。 */
  toolExec(name: string, durationMs: number | undefined, ok: boolean): void;
  continuationDecision(reason: ContinuationReason, triggered: boolean): void;
  /** 结束当前轮。传入的 finished 表示「整轮 agent 是否全部结束」。 */
  endTurn(stopReason: string, finished: boolean): void;
  /** 当前轮是否已经发过 turn.end。用于避免重复收尾。 */
  readonly currentTurnEnded: boolean;
  readonly currentTurnId: string | null;
  readonly counts: SseCounts;
  snapshot(): readonly TraceEvent[];
  readonly dropped: number;
}

export function createTurnTracker(options: TurnTrackerOptions = {}): TurnTracker {
  const now = options.now ?? (() => Date.now());
  const collector: TraceEventCollector = createTraceEventCollector(options.limit);
  const counts: SseCounts = { text: 0, think: 0, tool: 0 };
  let turnId: string | null = null;
  let turnEnded = false;
  // P0-2 第 2.2 项：每轮第一帧立即 flush，避免 TTFT 被 20 帧聚合阈值高估。
  let firstFrameFlushed = false;
  // 轮次序号：turnId 必须全局唯一，否则渲染器会把两轮并成一组。
  // 真机教训：原来用 `${loopId}:${stepIndex}`，而 AGENT_STEP_STARTED 的 stepIndex
  // 在同一轮内可能重复（首轮与续轮都可能是 0），导致 turnId 碰撞，
  // 报告里出现「一个 turn 两个 turn.end」，无法判断到底是几轮。
  // 现在改用单调递增序号，调用方传的前缀只用于人读。
  let turnSeq = 0;

  const emit = (event: TraceEvent): void => {
    collector.push(event);
    try {
      options.onChange?.({ event, events: collector.snapshot() });
    } catch {
      // 观测回调失败绝不影响主流程。
    }
  };

  const emitWithTurn = (
    t: TraceEventType,
    extra: Record<string, unknown>,
  ): void => {
    if (!turnId) return; // 没有活动轮次时丢弃，避免产生无归属事件。
    emit({
      t,
      turnId,
      timestamp: now(),
      ...extra,
    } as TraceEvent);
  };

  return {
    startTurn(prefix: string): string {
      turnSeq += 1;
      // turnId = 前缀 + 序号，保证同一轮内与跨轮都唯一。
      turnId = `${prefix}#${turnSeq}`;
      turnEnded = false;
      firstFrameFlushed = false;
      counts.text = 0;
      counts.think = 0;
      counts.tool = 0;
      emitWithTurn('turn.start', {});
      return turnId;
    },

    requestSent(bytes: number, powMs?: number): void {
      emitWithTurn(
        'request.sent',
        powMs === undefined ? { bytes } : { bytes, powMs },
      );
    },

    sseFrame(kind: SseFrameKind, count = 1): void {
      if (!turnId) return;
      counts[kind] += count;
      // P0-2 第 2.2 项：本轮第一帧立即 flush —— 否则首条 sse.frame 的时间戳
      // 落在第 20 帧，拿它算 TTFT 会系统性高估。
      if (!firstFrameFlushed) {
        firstFrameFlushed = true;
        this.flushSse();
        return;
      }
      const total = counts.text + counts.think + counts.tool;
      if (total > 0 && total % SSE_FLUSH_THRESHOLD === 0) this.flushSse();
    },

    flushSse(): void {
      const total = counts.text + counts.think + counts.tool;
      if (!turnId || total === 0) return;
      // 一次只发一条：报告层按 kind 求和，逐条发没有额外信息量。
      emitWithTurn('sse.frame', { kind: dominantKind(counts), count: total });
      counts.text = 0;
      counts.think = 0;
      counts.tool = 0;
    },

    toolParsed(name: string, status: 'OK' | 'FAIL'): void {
      emitWithTurn('tool.parsed', { name, status });
    },

    /**
     * 记录一次工具执行。durationMs 可省略 —— 工具结果本身不携带耗时
     * （ToolCardResult 只有 {ok, summary, detail}），省略时报告不显示耗时，
     * 而不是显示一个假的 0.0s。
     */
    toolExec(name: string, durationMs: number | undefined, ok: boolean): void {
      emitWithTurn('tool.exec', durationMs === undefined ? { name, ok } : { name, durationMs, ok });
    },

    continuationDecision(reason: ContinuationReason, triggered: boolean): void {
      emitWithTurn('continuation.decision', { reason, triggered });
    },

    endTurn(stopReason: string, finished: boolean): void {
      if (!turnId || turnEnded) return;
      turnEnded = true;
      emitWithTurn('turn.end', { stopReason, finished });
    },

    get currentTurnEnded(): boolean {
      return turnEnded;
    },

    get currentTurnId(): string | null {
      return turnId;
    },

    get counts(): SseCounts {
      return { ...counts };
    },

    snapshot(): readonly TraceEvent[] {
      return collector.snapshot();
    },

    get dropped(): number {
      return collector.dropped;
    },
  };
}

function dominantKind(counts: SseCounts): SseFrameKind {
  if (counts.tool >= counts.text && counts.tool >= counts.think) return 'tool';
  if (counts.think >= counts.text) return 'think';
  return 'text';
}
