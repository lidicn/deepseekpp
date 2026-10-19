/**
 * R08：工具运行事件归并（纯函数，无模块级可变状态，便于单测）。
 *
 * background 在工具派发前广播 `start`、结算后广播 `end`（成功/失败都发）；
 * 侧边栏用 reduceToolRuns 把一串事件归并成可渲染的 ToolRunRecord 列表。
 * start/end 靠 startedAt 精确配对；迟到的 end（无配对 start，例如续跑场景）
 * 直接落成一条已结束记录，不丢弃。
 */

export interface ToolRunEvent {
  phase: 'start' | 'end';
  name: string;
  /** start 时刻的 Date.now()，用于 start/end 配对。 */
  startedAt?: number;
  /** 仅 end：工具是否成功；undefined 表示仍在运行。 */
  ok?: boolean;
  /** 仅 end：本次执行耗时（毫秒）。 */
  durationMs?: number;
  /** 仅 end：截断到 200 字的结果摘要。 */
  summary?: string;
}

export interface ToolRunRecord {
  name: string;
  startedAt: number;
  /** undefined = 运行中；true/false = 已结算。 */
  ok?: boolean;
  durationMs?: number;
  summary?: string;
}

export function isToolRunActive(run: ToolRunRecord): boolean {
  return run.ok === undefined;
}

/**
 * 把一条事件归并进既有列表，返回新数组（不可变更新）。
 */
export function reduceToolRuns(
  prev: readonly ToolRunRecord[],
  event: ToolRunEvent,
): ToolRunRecord[] {
  const startedAt = event.startedAt ?? Date.now();

  if (event.phase === 'start') {
    return [...prev, { name: event.name, startedAt }];
  }

  const pendingIndex = prev.findIndex(
    (run) => run.ok === undefined && run.startedAt === startedAt,
  );

  const settled: ToolRunRecord = {
    name: event.name,
    startedAt,
    ok: event.ok ?? false,
    durationMs: event.durationMs,
    summary: event.summary,
  };

  if (pendingIndex === -1) {
    // 无配对 start（迟到/续跑事件）：直接登记已结束记录。
    return [...prev, settled];
  }

  return [
    ...prev.slice(0, pendingIndex),
    { ...prev[pendingIndex], ...settled },
    ...prev.slice(pendingIndex + 1),
  ];
}

/** 毫秒格式化为简短耗时文本（如 1.2s / 340ms），供面板展示。 */
export function formatToolDuration(durationMs: number | undefined): string {
  if (durationMs === undefined) return '…';
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
  return `${(durationMs / 1000).toFixed(1)}s`;
}
