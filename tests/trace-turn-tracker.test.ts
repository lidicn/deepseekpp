import { describe, expect, it } from 'vitest';
import { createTurnTracker } from '../core/trace/turn-tracker';
import { renderTraceReport } from '../core/trace/report';

describe('W29 turn tracker · 事件映射', () => {
  it('开始一轮立即产生 turn.start（Bug B 取证前提：进程被杀也要能查到开始过）', () => {
    let clock = 1000;
    const tracker = createTurnTracker({ now: () => clock });
    tracker.startTurn('loop-1:0');

    const events = tracker.snapshot();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ t: 'turn.start', turnId: 'loop-1:0#1', timestamp: 1000 });
  });

  it('同一前缀重复开轮也产生唯一 turnId（真机教训：stepIndex 会重复）', () => {
    // 真机上 AGENT_STEP_STARTED 的 stepIndex 在同一次运行里会重复（首轮与续轮
    // 都可能为 0），用 loopId:stepIndex 当 turnId 会让两轮撞成同一个 id，
    // 渲染器把它们并成一组，报告里出现「一个 turn 两个 turn.end」。
    const tracker = createTurnTracker({ now: () => 1 });
    tracker.startTurn('loop-9:0');
    tracker.endTurn('step_advanced', false);
    tracker.startTurn('loop-9:0');
    tracker.endTurn('finalized', true);

    const starts = tracker.snapshot().filter((e) => e.t === 'turn.start');
    const ends = tracker.snapshot().filter((e) => e.t === 'turn.end');
    expect(starts).toHaveLength(2);
    expect(new Set(starts.map((e) => e.turnId)).size).toBe(2);
    // 两个 turn.end 必须属于不同轮次，否则报告会把两轮并成一组。
    expect(ends[0].turnId).not.toBe(ends[1].turnId);
    expect(ends.map((e) => e.stopReason)).toEqual(['step_advanced', 'finalized']);
  });

  it('没有活动轮次时丢弃事件，不产生无归属记录', () => {
    const tracker = createTurnTracker();
    tracker.toolParsed('shell_exec', 'OK');
    tracker.endTurn('end_turn', true);
    expect(tracker.snapshot()).toHaveLength(0);
  });

  it('SSE 帧：第一帧立即 flush（P0-2），后续按阈值聚合', () => {
    // P0-2 第 2.2 项：首帧立即发出，否则 sse.frame 时间戳落在第 20 帧，
    // 拿它算 TTFT 会系统性高估。
    const tracker = createTurnTracker({ now: () => 1 });
    tracker.startTurn('t');
    tracker.sseFrame('text'); // 第 1 帧 → 立即 flush（count=1）
    for (let i = 0; i < 4; i += 1) tracker.sseFrame('text');
    for (let i = 0; i < 2; i += 1) tracker.sseFrame('think');
    tracker.flushSse();

    const sseEvents = tracker.snapshot().filter((e) => e.t === 'sse.frame');
    expect(sseEvents).toHaveLength(2);
    expect(sseEvents[0]).toMatchObject({ count: 1, kind: 'text' });
    expect(sseEvents[1]).toMatchObject({ count: 6, kind: 'text' });
  });

  it('达到阈值自动冲刷，不会把事件数组刷屏（含首帧立即 flush）', () => {
    const tracker = createTurnTracker({ now: () => 1, limit: 200 });
    tracker.startTurn('t');
    for (let i = 0; i < 45; i += 1) tracker.sseFrame('text');
    const sseEvents = tracker.snapshot().filter((e) => e.t === 'sse.frame');
    // 首帧立即 1 条 + 其后每满 20 帧 1 条（第 21、41 帧）= 3 条；余 4 帧仍在计数里
    // 45 - 1 - 20 - 20 = 4
    expect(sseEvents).toHaveLength(3);
    expect(sseEvents[0]).toMatchObject({ count: 1 });
    expect(tracker.counts.text).toBe(4);
  });

  it('工具解析/执行/续轮判定产生对应事件', () => {
    const tracker = createTurnTracker({ now: () => 7 });
    tracker.startTurn('t');
    tracker.toolParsed('shell_exec', 'OK');
    tracker.toolExec('shell_exec', 2600, true);
    tracker.continuationDecision('model_requested', true);

    const byType = (t: string) => tracker.snapshot().filter((e) => e.t === t);
    expect(byType('tool.parsed')[0]).toMatchObject({ name: 'shell_exec', status: 'OK' });
    expect(byType('tool.exec')[0]).toMatchObject({ name: 'shell_exec', durationMs: 2600, ok: true });
    expect(byType('continuation.decision')[0]).toMatchObject({
      reason: 'model_requested',
      triggered: true,
    });
  });

  it('tool.exec 耗时缺失时省略，不显示假的 0.0s', () => {
    // 真机事实：ToolCardResult 只有 {ok, summary, detail}，工具结果不携带耗时。
    // 之前写死 durationMs: number，导致只能传 0，报告出现误导性的 "0.0s"。
    const tracker = createTurnTracker({ now: () => 1 });
    tracker.startTurn('t');
    tracker.toolExec('shell_exec', undefined, true);
    tracker.toolExec('local_file_read', 2600, false);

    const events = tracker.snapshot().filter((e) => e.t === 'tool.exec');
    expect(events[0]).toEqual({ t: 'tool.exec', turnId: 't#1', timestamp: 1, name: 'shell_exec', ok: true });
    expect('durationMs' in events[0]).toBe(false);

    const report = renderTraceReport(tracker.snapshot());
    expect(report).toContain('tool.exec       shell_exec  ok');
    expect(report).toContain('tool.exec       local_file_read  2.6s  FAIL');
    expect(report).not.toContain('shell_exec  0.0s');
  });

  it('turn.end 幂等：重复收尾不会产生两条', () => {
    const tracker = createTurnTracker({ now: () => 1 });
    tracker.startTurn('t');
    tracker.endTurn('end_turn', false);
    tracker.endTurn('end_turn', true);
    expect(tracker.snapshot().filter((e) => e.t === 'turn.end')).toHaveLength(1);
  });

  it('requestSent 产生 request.sent 事件（P0-2 第 2.1 项）', () => {
    const tracker = createTurnTracker({ now: () => 42 });
    tracker.startTurn('t');
    tracker.requestSent(4096, 180);

    const sent = tracker.snapshot().filter((e) => e.t === 'request.sent');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      t: 'request.sent',
      turnId: 't#1',
      timestamp: 42,
      bytes: 4096,
      powMs: 180,
    });
  });

  it('requestSent 可省略 powMs（official-api 无 PoW）', () => {
    const tracker = createTurnTracker({ now: () => 1 });
    tracker.startTurn('t');
    tracker.requestSent(2048);

    const sent = tracker.snapshot().find((e) => e.t === 'request.sent');
    expect(sent).toMatchObject({ bytes: 2048 });
    expect(sent && 'powMs' in sent).toBe(false);
  });

  it('跨轮重置首帧标记：每轮第一帧都立即 flush', () => {
    const tracker = createTurnTracker({ now: () => 1 });
    tracker.startTurn('a');
    tracker.sseFrame('text');
    tracker.endTurn('step_advanced', false);
    tracker.startTurn('b');
    tracker.sseFrame('think');

    const sseEvents = tracker.snapshot().filter((e) => e.t === 'sse.frame');
    expect(sseEvents).toHaveLength(2);
    expect(sseEvents[0]).toMatchObject({ count: 1, kind: 'text' });
    expect(sseEvents[1]).toMatchObject({ count: 1, kind: 'think' });
  });

  it('事件超过上限时丢弃最旧的，并如实记录丢弃数', () => {
    const tracker = createTurnTracker({ now: () => 1, limit: 3 });
    tracker.startTurn('t');
    tracker.toolParsed('a', 'OK');
    tracker.toolExec('a', 1, true);
    tracker.continuationDecision('model_requested', true);

    expect(tracker.snapshot()).toHaveLength(3);
    expect(tracker.dropped).toBe(1);
    // 只保留队列末尾的三条：tool.parsed 是最旧的，已被丢弃
    expect(tracker.snapshot()[0]).toMatchObject({ t: 'tool.parsed' });
  });
});

describe('W29 turn tracker × renderTraceReport · 两个 bug 的形态', () => {
  it('完整闭环渲染为 DONE，且续轮判定可见', () => {
    const tracker = createTurnTracker({ now: (() => {
      let t = 0;
      return () => (t += 100);
    })() });
    tracker.startTurn('loop:0');
    tracker.sseFrame('text', 12);
    tracker.flushSse();
    tracker.toolParsed('shell_exec', 'OK');
    tracker.toolExec('shell_exec', 2600, true);
    tracker.continuationDecision('model_requested', true);
    tracker.endTurn('end_turn', true);

    const report = renderTraceReport(tracker.snapshot());
    expect(report).toContain('DONE');
    expect(report).toContain('tool.exec');
    expect(report).toContain('continuation.decision: model_requested → triggered=true');
    expect(report).toContain('turn.end stopReason=end_turn finished=true');
    expect(report).not.toContain('OPEN');
  });

  it('Bug B 形态：没有 turn.end 就渲染成 OPEN（这一轮从来没结束）', () => {
    const tracker = createTurnTracker({ now: (() => {
      let t = 0;
      return () => (t += 100);
    })() });
    tracker.startTurn('loop:1');
    tracker.sseFrame('tool', 1);
    tracker.flushSse();
    tracker.toolParsed('shell_exec', 'OK');
    tracker.toolExec('shell_exec', 152_000, true);
    // 关键：没有 continuation.decision，也没有 turn.end

    const report = renderTraceReport(tracker.snapshot());
    expect(report).toContain('OPEN');
    expect(report).toContain('tool.exec');
    expect(report).not.toContain('turn.end');
  });

  it('Bug A 形态：续轮判定为 false 时可从报告读出一整条判断链', () => {
    const tracker = createTurnTracker({ now: (() => {
      let t = 0;
      return () => (t += 100);
    })() });
    tracker.startTurn('loop:2');
    tracker.sseFrame('text', 3);
    tracker.flushSse();
    tracker.toolParsed('shell_exec', 'FAIL');
    tracker.toolExec('shell_exec', 120_000, false);
    tracker.continuationDecision('model_requested', false);
    tracker.endTurn('error', false);

    const report = renderTraceReport(tracker.snapshot());
    // finished=false 时渲染器判为 TRUNCATED 并标注断点，这是报告的核心语义。
    expect(report).toContain('TRUNCATED');
    expect(report).toContain('tool.exec       shell_exec  120.0s  FAIL');
    expect(report).toContain('continuation.decision: model_requested → triggered=false');
    expect(report).toContain('turn.end stopReason=error finished=false');
  });
});
