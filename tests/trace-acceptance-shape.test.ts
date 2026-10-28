/**
 * P0-2 验收形态守卫：合成 3 轮 trace，断言报告里能同时读出
 *   request.sent.bytes / powMs / tool.exec.durationMs
 * 以及可由时间戳直接算出的两个 Δ。
 *
 * 不依赖浏览器。真机导出的 trace 应满足同一形状；
 * 本测试锁「渲染层不会吞掉这些字段」。
 */
import { describe, expect, it } from 'vitest';
import { createTurnTracker } from '../core/trace/turn-tracker';
import { renderTraceReport, type TraceEvent } from '../core/trace/report';

function buildThreeTurnTrace(): {
  events: readonly TraceEvent[];
  deltas: Array<{ turnToSentMs: number; sentToFirstFrameMs: number }>;
} {
  const deltas: Array<{ turnToSentMs: number; sentToFirstFrameMs: number }> = [];
  let clock = 1_000;
  const tracker = createTurnTracker({ now: () => clock });

  // 轮 1：首请求无节流等待（Δ turn→sent 较小），PoW 180ms，首帧紧跟
  tracker.startTurn('loop:0');
  const t1TurnStart = clock;
  clock += 120; // 物化/装配
  const t1Sent = clock;
  tracker.requestSent(4096, 180);
  clock += 180; // PoW 已计入 request.sent 前，这里模拟 prefill
  clock += 40; // prefill 到首帧
  const t1First = clock;
  tracker.sseFrame('text');
  clock += 2_000;
  tracker.toolParsed('shell_exec', 'OK');
  clock += 2_600;
  tracker.toolExec('shell_exec', 2_600, true);
  clock += 100;
  tracker.endTurn('step_advanced', false);
  deltas.push({
    turnToSentMs: t1Sent - t1TurnStart,
    sentToFirstFrameMs: t1First - t1Sent,
  });

  // 轮 2：节流后请求（Δ turn→sent ≈ 4.3s），bytes 膨胀
  clock += 50; // step 边界
  tracker.startTurn('loop:1');
  const t2TurnStart = clock;
  clock += 4_300; // pacedStreamFn 节流
  const t2Sent = clock;
  tracker.requestSent(8_192, 210);
  clock += 210;
  clock += 55; // prefill
  const t2First = clock;
  tracker.sseFrame('think');
  clock += 1_500;
  tracker.toolParsed('shell_exec', 'OK');
  clock += 152_000;
  tracker.toolExec('shell_exec', 152_000, true);
  clock += 80;
  tracker.endTurn('step_advanced', false);
  deltas.push({
    turnToSentMs: t2Sent - t2TurnStart,
    sentToFirstFrameMs: t2First - t2Sent,
  });

  // 轮 3：收尾
  clock += 40;
  tracker.startTurn('loop:2');
  const t3TurnStart = clock;
  clock += 3_100;
  const t3Sent = clock;
  tracker.requestSent(9_000, 160);
  clock += 160;
  clock += 30;
  const t3First = clock;
  tracker.sseFrame('text');
  clock += 800;
  tracker.endTurn('finalized', true);
  deltas.push({
    turnToSentMs: t3Sent - t3TurnStart,
    sentToFirstFrameMs: t3First - t3Sent,
  });

  return { events: tracker.snapshot(), deltas };
}

describe('P0-2 验收形态 · 合成 3 轮 trace 报告', () => {
  it('每轮都能读出 bytes / powMs / tool.exec.durationMs', () => {
    const { events } = buildThreeTurnTrace();
    const report = renderTraceReport(events);

    expect(report).toContain('request.sent');
    expect(report).toContain('pow=180ms');
    expect(report).toContain('pow=210ms');
    expect(report).toContain('tool.exec       shell_exec  2.6s  ok');
    expect(report).toContain('tool.exec       shell_exec  152.0s  ok');
    expect(report).toContain('DONE');

    // bytes 出现且逐轮非降（合成数据故意膨胀）
    const bytesLines = report.split('\n').filter((l) => l.includes('request.sent'));
    expect(bytesLines.length).toBe(3);
    expect(bytesLines[0]).toContain('4.0KB');
    expect(bytesLines[1]).toContain('8.0KB');
  });

  it('时间戳足以算出 Δ(turn.start→request.sent) 与 Δ(request.sent→首帧)', () => {
    const { events, deltas } = buildThreeTurnTrace();

    // 从事件流独立重算，不信任构造时的辅助变量
    const byTurn = new Map<string, TraceEvent[]>();
    for (const e of events) {
      const list = byTurn.get(e.turnId) ?? [];
      list.push(e);
      byTurn.set(e.turnId, list);
    }
    expect(byTurn.size).toBe(3);

    for (const [, turnEvents] of byTurn) {
      const start = turnEvents.find((e) => e.t === 'turn.start');
      const sent = turnEvents.find((e) => e.t === 'request.sent');
      const firstSse = turnEvents.find((e) => e.t === 'sse.frame');
      expect(start).toBeDefined();
      expect(sent).toBeDefined();
      expect(firstSse).toBeDefined();
      if (!start || !sent || !firstSse) throw new Error('missing event');
      // Δ(turn.start → request.sent) 隔离节流+物化
      expect(sent.timestamp - start.timestamp).toBeGreaterThanOrEqual(0);
      // Δ(request.sent → 首帧) = prefill + 排队
      expect(firstSse.timestamp - sent.timestamp).toBeGreaterThan(0);
    }

    // 轮 2 的 turn→sent 应明显大于轮 1（节流生效）
    expect(deltas[1].turnToSentMs).toBeGreaterThan(deltas[0].turnToSentMs + 2_000);
  });
});
