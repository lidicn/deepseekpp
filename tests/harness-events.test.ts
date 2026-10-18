import { describe, expect, it } from 'vitest';
import {
  buildLoopDepthHistogram,
  countContinuations,
  countToolCallResults,
  createHarnessEventBuffer,
  g2UserInterventionRate,
  type ContinuationReason,
  type HarnessEvent,
} from '../core/debug/harness-events';

const base = 1_700_000_000_000;
let seq = 0;
function ts(): number {
  return base + seq++ * 10;
}

function toolStart(turnId: string, toolName: string, depth = 0, callIndex = 0): HarnessEvent {
  return { type: 'tool_call_start', turnId, toolName, depth, callIndex, timestamp: ts() };
}
function toolEnd(turnId: string, toolName: string, success: boolean, durationMs = 42, errorType?: string): HarnessEvent {
  return { type: 'tool_call_end', turnId, toolName, success, durationMs, errorType, timestamp: ts() };
}

describe('HarnessEvent 联合类型可构造（编译约束）', () => {
  it('五种事件都能构造，reason 受限于联合类型', () => {
    const events: HarnessEvent[] = [
      toolStart('turn-1', 'shell_exec', 0, 0),
      toolEnd('turn-1', 'shell_exec', true, 42),
      { type: 'loop_depth_incremented', turnId: 'turn-1', newDepth: 1, timestamp: ts() },
      { type: 'continuation_triggered', turnId: 'turn-1', reason: 'model_requested', timestamp: ts() },
      { type: 'turn_finished', turnId: 'turn-1', finalDepth: 1, toolCallCount: 1, timestamp: ts() },
    ];
    expect(events).toHaveLength(5);
    // reason 仅允许这两个字面量（此处显式标注联合类型，非法值编译期报错）
    const reasons: ContinuationReason[] = ['model_requested', 'user_continued'];
    expect(reasons).toEqual(['model_requested', 'user_continued']);
  });
});

describe('ring buffer 满则淘汰最早', () => {
  it('容量内全部保留，超出后只留最新 N 条', () => {
    const buf = createHarnessEventBuffer(3);
    for (let i = 0; i < 5; i++) {
      buf.push({
        type: 'turn_finished',
        turnId: `turn-${i}`,
        finalDepth: 0,
        toolCallCount: 0,
        timestamp: ts(),
      });
    }
    expect(buf.size()).toBe(3);
    const ids = buf.list().map((e) => (e.type === 'turn_finished' ? e.turnId : null));
    expect(ids).toEqual(['turn-2', 'turn-3', 'turn-4']);
  });

  it('clear 清空缓冲', () => {
    const buf = createHarnessEventBuffer(10);
    buf.push(toolStart('t', 'shell_exec'));
    buf.clear();
    expect(buf.size()).toBe(0);
    expect(buf.list()).toEqual([]);
  });

  it('容量非正时退化为 1，且永不抛错', () => {
    const buf = createHarnessEventBuffer(0);
    buf.push(toolStart('a', 'x'));
    buf.push(toolStart('b', 'y'));
    expect(buf.size()).toBe(1);
  });
});

describe('G2 续跑分组（单一事件 + reason，无双计数）', () => {
  it('1 次 user_continued + 2 次 model_requested → 1/3 ≈ 33.3%', () => {
    const events: HarnessEvent[] = [
      { type: 'continuation_triggered', turnId: 't1', reason: 'user_continued', timestamp: ts() },
      { type: 'continuation_triggered', turnId: 't2', reason: 'model_requested', timestamp: ts() },
      { type: 'continuation_triggered', turnId: 't3', reason: 'model_requested', timestamp: ts() },
    ];
    const counts = countContinuations(events);
    expect(counts).toEqual({ modelRequestedCount: 2, userContinuedCount: 1 });
    const rate = g2UserInterventionRate(counts);
    expect(rate).toBeCloseTo(1 / 3, 5);
  });

  it('无续跑样本返回 null（区别于 0%）', () => {
    expect(g2UserInterventionRate(countContinuations([]))).toBeNull();
  });

  it('纯用户续跑时干预率为 1', () => {
    const counts = countContinuations([
      { type: 'continuation_triggered', turnId: 't', reason: 'user_continued', timestamp: ts() },
    ]);
    expect(g2UserInterventionRate(counts)).toBe(1);
  });
});

describe('3 轮 turn 事件序列', () => {
  function buildThreeTurns(): HarnessEvent[] {
    const events: HarnessEvent[] = [];
    // turn-1：2 工具（1 成功 1 失败），深度 0，模型自动续跑
    events.push(toolStart('turn-1', 'shell_exec', 0, 0));
    events.push(toolEnd('turn-1', 'shell_exec', true, 40));
    events.push(toolStart('turn-1', 'web_fetch', 0, 1));
    events.push(toolEnd('turn-1', 'web_fetch', false, 120, 'http_404'));
    events.push({ type: 'continuation_triggered', turnId: 'turn-1', reason: 'model_requested', timestamp: ts() });
    events.push({ type: 'turn_finished', turnId: 'turn-1', finalDepth: 0, toolCallCount: 2, timestamp: ts() });
    // turn-2：深度 +1，1 工具成功，用户主动续跑
    events.push({ type: 'loop_depth_incremented', turnId: 'turn-2', newDepth: 1, timestamp: ts() });
    events.push(toolStart('turn-2', 'shell_exec', 1, 0));
    events.push(toolEnd('turn-2', 'shell_exec', true, 30));
    events.push({ type: 'continuation_triggered', turnId: 'turn-2', reason: 'user_continued', timestamp: ts() });
    events.push({ type: 'turn_finished', turnId: 'turn-2', finalDepth: 1, toolCallCount: 1, timestamp: ts() });
    // turn-3：深度 2，1 工具成功，模型自动续跑
    events.push({ type: 'loop_depth_incremented', turnId: 'turn-3', newDepth: 2, timestamp: ts() });
    events.push(toolStart('turn-3', 'python_exec', 2, 0));
    events.push(toolEnd('turn-3', 'python_exec', true, 90));
    events.push({ type: 'continuation_triggered', turnId: 'turn-3', reason: 'model_requested', timestamp: ts() });
    events.push({ type: 'turn_finished', turnId: 'turn-3', finalDepth: 2, toolCallCount: 1, timestamp: ts() });
    return events;
  }

  it('序列全部进入 buffer，条数与构造一致', () => {
    const events = buildThreeTurns();
    const buf = createHarnessEventBuffer(500);
    events.forEach((e) => buf.push(e));
    expect(buf.size()).toBe(events.length);
  });

  it('G2 = 1/(1+2) = 33.3%，成功 3 / 失败 1', () => {
    const events = buildThreeTurns();
    const counts = countContinuations(events);
    expect(counts).toEqual({ modelRequestedCount: 2, userContinuedCount: 1 });
    expect(g2UserInterventionRate(counts)).toBeCloseTo(1 / 3, 5);
    const results = countToolCallResults(events);
    expect(results).toEqual({ success: 3, failure: 1 });
  });

  it('深度直方图按 turn 最终深度聚合：0→1, 1→1, 2→1', () => {
    const events = buildThreeTurns();
    const hist = buildLoopDepthHistogram(events);
    expect(hist).toEqual({ 0: 1, 1: 1, 2: 1 });
  });
});
