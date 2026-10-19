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
  /** 工具所在的工具循环轮次（0 起），供 R09 步骤时间线分组。 */
  step?: number;
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
  step?: number;
  startedAt: number;
  /** undefined = 运行中；true/false = 已结算。 */
  ok?: boolean;
  durationMs?: number;
  summary?: string;
}

/** R09：一个步骤（工具循环轮次）内的工具集合，纯文本时间线分组单元。 */
export interface StepTimelineGroup {
  /** 轮次号（0 起）；无 step 信息（旧事件/平铺）时为 null。 */
  step: number | null;
  tools: ToolRunRecord[];
  /** 组内已结算工具耗时之和（毫秒）。 */
  totalMs: number;
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
    return [...prev, { name: event.name, step: event.step, startedAt }];
  }

  const pendingIndex = prev.findIndex(
    (run) => run.ok === undefined && run.startedAt === startedAt,
  );

  const settled: ToolRunRecord = {
    name: event.name,
    step: event.step,
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
    { ...prev[pendingIndex], ...settled, step: settled.step ?? prev[pendingIndex].step },
    ...prev.slice(pendingIndex + 1),
  ];
}

/**
 * R09：把工具记录按 step（工具循环轮次）分组，供纯文本步骤时间线渲染。
 * 无 step 信息的记录归到同一平铺组（step=null），保持出现顺序。
 */
export function buildStepTimeline(
  runs: readonly ToolRunRecord[],
): StepTimelineGroup[] {
  const groups = new Map<number, StepTimelineGroup>();
  const order: number[] = [];
  for (const run of runs) {
    const key = run.step ?? -1;
    let group = groups.get(key);
    if (!group) {
      group = { step: run.step ?? null, tools: [], totalMs: 0 };
      groups.set(key, group);
      order.push(key);
    }
    group.tools.push(run);
    if (typeof run.durationMs === 'number') group.totalMs += run.durationMs;
  }
  return order.map((key) => groups.get(key) as StepTimelineGroup);
}

/** 毫秒格式化为简短耗时文本（如 1.2s / 340ms），供面板展示。 */
export function formatToolDuration(durationMs: number | undefined): string {
  if (durationMs === undefined) return '…';
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
  return `${(durationMs / 1000).toFixed(1)}s`;
}
