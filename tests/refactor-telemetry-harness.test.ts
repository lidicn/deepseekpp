import { beforeEach, describe, expect, it } from 'vitest';
import { refactorTelemetry } from '../core/debug/refactor-telemetry';
import { applyTelemetryGate, isTelemetryCaptureEnabled } from '../core/debug/telemetry-gate';
import { buildLastTurnSummary, type HarnessEvent } from '../core/debug/harness-events';

function cont(reason: 'model_requested' | 'user_continued', turnId = 't'): HarnessEvent {
  return { type: 'continuation_triggered', turnId, reason, timestamp: Date.now() };
}
function finished(turnId: string, finalDepth: number): HarnessEvent {
  return { type: 'turn_finished', turnId, finalDepth, toolCallCount: 1, timestamp: Date.now() };
}

function persistedRaw(): Record<string, unknown> {
  return JSON.parse(window.localStorage.getItem('dpp_telemetry_aggregates') ?? '{}') as Record<string, unknown>;
}

beforeEach(() => {
  refactorTelemetry.reset();
  window.localStorage.clear();
  applyTelemetryGate(true);
});

describe('M0 recordHarnessEvent G2 分组与持久化', () => {
  it('1 user_continued + 2 model_requested → summary G2 = 33.3%，并落 localStorage', () => {
    refactorTelemetry.recordHarnessEvent(cont('user_continued', 't1'));
    refactorTelemetry.recordHarnessEvent(cont('model_requested', 't2'));
    refactorTelemetry.recordHarnessEvent(cont('model_requested', 't3'));

    const summary = refactorTelemetry.summary();
    expect(summary.modelRequestedCount).toBe(2);
    expect(summary.userContinuedCount).toBe(1);
    expect(String(summary.g2UserInterventionRate)).toBe('33.3%');

    const raw = persistedRaw();
    expect(raw.modelRequestedCount).toBe(2);
    expect(raw.userContinuedCount).toBe(1);
  });

  it('recordToolCall 计入近 7 天窗口成功率（3 成功 1 失败 = 75%）并落盘', () => {
    refactorTelemetry.recordToolCall(true);
    refactorTelemetry.recordToolCall(true);
    refactorTelemetry.recordToolCall(true);
    refactorTelemetry.recordToolCall(false, 'http_404');
    const summary = refactorTelemetry.summary();
    expect(String(summary.toolCallSuccessRate)).toBe('75%');
    expect(String(summary.toolCallSuccessRate7d)).toBe('75%');
    expect(summary.toolCallWindowDays).toBe(7);
    const raw = persistedRaw();
    const byDay = raw.toolCallByDay as Record<string, { success: number; failure: number }>;
    const keys = Object.keys(byDay);
    expect(keys).toHaveLength(1);
    expect(byDay[keys[0]]).toEqual({ success: 3, failure: 1 });
  });

  it('无工具调用样本时近 7 天成功率输出“样本不足”', () => {
    expect(String(refactorTelemetry.summary().toolCallSuccessRate7d)).toBe('样本不足');
  });

  it('无续跑样本时 summary 输出“样本不足”', () => {
    expect(String(refactorTelemetry.summary().g2UserInterventionRate)).toBe('样本不足');
  });

  it('turn_finished 累加深度直方图并持久化', () => {
    refactorTelemetry.recordHarnessEvent(finished('t1', 0));
    refactorTelemetry.recordHarnessEvent(finished('t2', 0));
    refactorTelemetry.recordHarnessEvent(finished('t3', 2));
    const summary = refactorTelemetry.summary();
    expect(summary.loopDepthHistogram).toEqual({ 0: 2, 2: 1 });
    expect(persistedRaw().loopDepthHistogram).toEqual({ 0: 2, 2: 1 });
  });

  it('门控关闭时不记录、不写盘', () => {
    applyTelemetryGate(false);
    expect(isTelemetryCaptureEnabled()).toBe(false);
    refactorTelemetry.recordHarnessEvent(cont('user_continued'));
    expect(refactorTelemetry.summary().userContinuedCount).toBe(0);
    expect(window.localStorage.getItem('dpp_telemetry_aggregates')).toBeNull();
    applyTelemetryGate(true);
  });

  it('reset 清空 G2 计数与直方图', () => {
    refactorTelemetry.recordHarnessEvent(cont('model_requested'));
    refactorTelemetry.recordHarnessEvent(finished('t', 1));
    refactorTelemetry.reset();
    expect(refactorTelemetry.summary().modelRequestedCount).toBe(0);
    expect(refactorTelemetry.summary().userContinuedCount).toBe(0);
    expect(refactorTelemetry.summary().loopDepthHistogram).toEqual({});
  });
});

describe('M0 瞬时事件不进持久化聚合', () => {
  it('tool_call_start / tool_call_end / loop_depth_incremented 不改变 G2 计数与直方图', () => {
    refactorTelemetry.recordHarnessEvent({
      type: 'tool_call_start', turnId: 't', toolName: 'shell_exec', depth: 0, callIndex: 0, timestamp: Date.now(),
    });
    refactorTelemetry.recordHarnessEvent({
      type: 'tool_call_end', turnId: 't', toolName: 'shell_exec', success: true, durationMs: 10, timestamp: Date.now(),
    });
    refactorTelemetry.recordHarnessEvent({
      type: 'loop_depth_incremented', turnId: 't', newDepth: 1, timestamp: Date.now(),
    });
    const summary = refactorTelemetry.summary();
    expect(summary.modelRequestedCount).toBe(0);
    expect(summary.userContinuedCount).toBe(0);
    expect(summary.loopDepthHistogram).toEqual({});
    // G1 由独立 recordToolCall 承担，recordHarnessEvent 不重复记 G1。
    expect(summary.toolCallSuccess).toBe(0);
  });
});

describe('R10 lastTurn() 最近一轮聚合', () => {
  it('buildLastTurnSummary 聚合收尾轮的 steps/tools/finished/durationMs', () => {
    const events: HarnessEvent[] = [
      { type: 'tool_call_start', turnId: 't1', toolName: 'shell_exec', depth: 0, callIndex: 0, timestamp: 1000 },
      { type: 'tool_call_end', turnId: 't1', toolName: 'shell_exec', success: true, durationMs: 10, timestamp: 1010 },
      { type: 'turn_finished', turnId: 't1', finalDepth: 2, toolCallCount: 1, timestamp: 1050 },
    ];
    const summary = buildLastTurnSummary(events);
    expect(summary.turnId).toBe('t1');
    expect(summary.steps).toBe(2);
    expect(summary.tools).toEqual(['shell_exec']);
    expect(summary.finished).toBe(true);
    expect(summary.durationMs).toBe(50);
    expect(summary.errors).toEqual([]);
    expect(summary.sseFrameCount).toBeNull();
    expect(summary.stopReason).toBeNull();
  });

  it('失败工具进入 errors 并带 errorType，未收尾 finished=false', () => {
    const events: HarnessEvent[] = [
      { type: 'tool_call_end', turnId: 't2', toolName: 'local_file_read', success: false, durationMs: 5, errorType: 'http_404', timestamp: 1000 },
    ];
    const summary = buildLastTurnSummary(events);
    expect(summary.finished).toBe(false);
    expect(summary.steps).toBeNull();
    expect(summary.errors).toEqual(['local_file_read (http_404)']);
    expect(summary.durationMs).toBeNull();
  });

  it('空事件返回全空快照', () => {
    const summary = buildLastTurnSummary([]);
    expect(summary.turnId).toBeNull();
    expect(summary.finished).toBe(false);
    expect(summary.tools).toEqual([]);
    expect(summary.errors).toEqual([]);
  });

  it('单例 recordHarnessEvent 后 lastTurn() 返回该轮，reset 后清空', () => {
    refactorTelemetry.recordHarnessEvent({
      type: 'tool_call_end', turnId: 'live', toolName: 'shell_exec', success: true, durationMs: 12, timestamp: 1000,
    });
    refactorTelemetry.recordHarnessEvent({
      type: 'turn_finished', turnId: 'live', finalDepth: 1, toolCallCount: 1, timestamp: 1020,
    });
    const live = refactorTelemetry.lastTurn();
    expect(live.turnId).toBe('live');
    expect(live.finished).toBe(true);
    expect(live.tools).toEqual(['shell_exec']);

    refactorTelemetry.reset();
    const afterReset = refactorTelemetry.lastTurn();
    expect(afterReset.turnId).toBeNull();
    expect(afterReset.finished).toBe(false);
    expect(afterReset.tools).toEqual([]);
  });
});
