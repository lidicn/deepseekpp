/**
 * W29 执行轨迹文本报告（雏形，纯函数，零 IO）。
 *
 * 用途：用户报「断流」时，把一轮（turn）内的事件流渲染成可直接阅读的纯文本，
 * 回答：prompt 多大、吐了哪些 SSE 帧、工具 XML 解析成什么、续轮为何没触发、
 * 在哪一轮截断。本模块只做格式化，不采集事件、不触碰存储/网络。
 *
 * 事件结构独立于 M0 harness-events（harness 明确不携带帧计数/prompt 大小，
 * 无法表达断流取证所需的 sse.frame / request.sent），故此处定义更细的 TraceEvent。
 */

/** 单轮内出现的因果事件类型。 */
export type TraceEventType =
  | 'turn.start'
  | 'request.sent'
  | 'sse.frame'
  | 'tool.parsed'
  | 'tool.exec'
  | 'continuation.decision'
  | 'turn.end';

export type SseFrameKind = 'text' | 'think' | 'tool';

/** 续跑触发来源，与 harness ContinuationReason 对齐。 */
export type ContinuationReason = 'model_requested' | 'user_continued';

interface BaseTraceEvent {
  turnId: string;
  /** 毫秒时间戳（monotonic 或 epoch 均可，仅用于同轮内相对时长）。 */
  timestamp: number;
}

export interface TurnStartEvent extends BaseTraceEvent {
  t: 'turn.start';
}

export interface RequestSentEvent extends BaseTraceEvent {
  t: 'request.sent';
  /** 请求体字节数。 */
  bytes: number;
  /** PoW 求解耗时（毫秒），无则省略。 */
  powMs?: number;
}

export interface SseFrameEvent extends BaseTraceEvent {
  t: 'sse.frame';
  kind: SseFrameKind;
  /** 该条事件累计/代表的帧计数；同一轮多条按 kind 求和。 */
  count: number;
}

export interface ToolParsedEvent extends BaseTraceEvent {
  t: 'tool.parsed';
  name: string;
  status: 'OK' | 'FAIL';
}

export interface ToolExecEvent extends BaseTraceEvent {
  t: 'tool.exec';
  name: string;
  /**
   * 耗时（毫秒）。可能缺失：ToolCardResult 只有 {ok, summary, detail}，
   * 不携带耗时；MCP 的 data 里也没有 duration 字段。所以做成可选，
   * 渲染时缺失就不显示，而不是显示一个假的 0.0s。
   */
  durationMs?: number;
  ok: boolean;
}

export interface ContinuationDecisionEvent extends BaseTraceEvent {
  t: 'continuation.decision';
  reason: ContinuationReason;
  triggered: boolean;
}

export interface TurnEndEvent extends BaseTraceEvent {
  t: 'turn.end';
  stopReason: string;
  finished: boolean;
}

export type TraceEvent =
  | TurnStartEvent
  | RequestSentEvent
  | SseFrameEvent
  | ToolParsedEvent
  | ToolExecEvent
  | ContinuationDecisionEvent
  | TurnEndEvent;

/** 单轮聚合结果。 */
interface TurnGroup {
  turnId: string;
  events: TraceEvent[];
  firstTs: number;
  lastTs: number;
  ended: boolean;
  finished: boolean;
  stopReason: string | null;
}

type TurnStatus = 'DONE' | 'TRUNCATED' | 'OPEN';

function formatDurationMs(durationMs: number): string {
  const seconds = durationMs / 1000;
  return `${seconds.toFixed(1)}s`;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0B';
  if (bytes < 1024) return `${Math.round(bytes)}B`;
  return `${(bytes / 1024).toFixed(1)}KB`;
}

function groupTurns(events: readonly TraceEvent[]): TurnGroup[] {
  const order: string[] = [];
  const byId = new Map<string, TurnGroup>();

  for (const event of events) {
    let group = byId.get(event.turnId);
    if (!group) {
      group = {
        turnId: event.turnId,
        events: [],
        firstTs: event.timestamp,
        lastTs: event.timestamp,
        ended: false,
        finished: false,
        stopReason: null,
      };
      byId.set(event.turnId, group);
      order.push(event.turnId);
    }
    group.events.push(event);
    if (event.timestamp < group.firstTs) group.firstTs = event.timestamp;
    if (event.timestamp > group.lastTs) group.lastTs = event.timestamp;
    if (event.t === 'turn.end') {
      group.ended = true;
      group.finished = event.finished;
      group.stopReason = event.stopReason;
    }
  }

  return order.map((id) => byId.get(id) as TurnGroup);
}

function statusOf(group: TurnGroup): TurnStatus {
  if (group.ended && group.finished) return 'DONE';
  if (group.ended && !group.finished) return 'TRUNCATED';
  return 'OPEN';
}

/** 聚合一轮内 sse.frame 的各类计数。 */
function aggregateSse(group: TurnGroup): Record<SseFrameKind, number> {
  const totals: Record<SseFrameKind, number> = { text: 0, think: 0, tool: 0 };
  for (const event of group.events) {
    if (event.t !== 'sse.frame') continue;
    totals[event.kind] += Math.max(0, Math.floor(event.count));
  }
  return totals;
}

function renderDetailLines(group: TurnGroup): string[] {
  const lines: string[] = [];
  const sse = aggregateSse(group);
  let sseRendered = false;

  for (const event of group.events) {
    switch (event.t) {
      case 'request.sent': {
        const pow = event.powMs !== undefined ? `  pow=${event.powMs}ms` : '';
        lines.push(`request.sent    ${formatBytes(event.bytes)}${pow}`);
        break;
      }
      case 'sse.frame': {
        // sse 帧计数聚合为一行，避免每条 frame 刷屏。
        if (!sseRendered) {
          const parts = [
            `text×${sse.text}`,
            `think×${sse.think}`,
            `tool×${sse.tool}`,
          ].join(' ');
          lines.push(`sse: ${parts}`);
          sseRendered = true;
        }
        break;
      }
      case 'tool.parsed':
        lines.push(`tool.parsed     ${event.name}  ${event.status}`);
        break;
      case 'tool.exec': {
        // 耗时缺失时省略，而不是显示假的 0.0s。
        const duration = event.durationMs === undefined ? '' : `  ${formatDurationMs(event.durationMs)}`;
        lines.push(`tool.exec       ${event.name}${duration}  ${event.ok ? 'ok' : 'FAIL'}`);
        break;
      }
      case 'continuation.decision':
        lines.push(`continuation.decision: ${event.reason} → triggered=${String(event.triggered)}`);
        break;
      case 'turn.end':
        lines.push(`turn.end stopReason=${event.stopReason} finished=${String(event.finished)}`);
        break;
      default:
        break;
    }
  }
  return lines;
}

/**
 * 把事件流渲染为纯文本报告。空输入返回空字符串（不输出占位标题）。
 * 纯函数：不修改入参，不产生副作用。
 */
export function renderTraceReport(events: readonly TraceEvent[]): string {
  if (events.length === 0) return '';

  const groups = groupTurns(events);
  const out: string[] = [];

  groups.forEach((group, index) => {
    const status = statusOf(group);
    const duration = formatDurationMs(group.lastTs - group.firstTs);
    const suffix = status === 'TRUNCATED' ? '  ← 断在这里' : '';
    out.push(`turn ${index + 1} (${duration})  ${status}${suffix}`);

    const detailLines = renderDetailLines(group);
    detailLines.forEach((line, i) => {
      const branch = i === detailLines.length - 1 ? '└─' : '├─';
      out.push(`  ${branch} ${line}`);
    });
  });

  return out.join('\n');
}
