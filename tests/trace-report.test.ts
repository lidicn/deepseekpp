import { describe, it, expect } from 'vitest';
import {
  renderTraceReport,
  type TraceEvent,
} from '../core/trace/report';

describe('renderTraceReport (W29)', () => {
  it('正常完成流渲染为 DONE 并列出请求/帧/工具/续轮', () => {
    const events: TraceEvent[] = [
      { t: 'turn.start', turnId: 't1', timestamp: 0 },
      { t: 'request.sent', turnId: 't1', timestamp: 10, bytes: 4296, powMs: 180 },
      { t: 'sse.frame', turnId: 't1', timestamp: 50, kind: 'text', count: 42 },
      { t: 'sse.frame', turnId: 't1', timestamp: 60, kind: 'think', count: 18 },
      { t: 'sse.frame', turnId: 't1', timestamp: 70, kind: 'tool', count: 1 },
      { t: 'tool.parsed', turnId: 't1', timestamp: 80, name: 'artifact_create', status: 'OK' },
      { t: 'tool.exec', turnId: 't1', timestamp: 90, name: 'artifact_create', durationMs: 1800, ok: true },
      { t: 'continuation.decision', turnId: 't1', timestamp: 1900, reason: 'model_requested', triggered: true },
      { t: 'turn.end', turnId: 't1', timestamp: 2300, stopReason: 'finished', finished: true },
    ];

    const report = renderTraceReport(events);
    expect(report).toContain('turn 1 (2.3s)  DONE');
    expect(report).toContain('4.2KB');
    expect(report).toContain('pow=180ms');
    expect(report).toContain('text×42 think×18 tool×1');
    expect(report).toContain('tool.parsed     artifact_create  OK');
    expect(report).toContain('tool.exec       artifact_create  1.8s  ok');
    expect(report).toContain('continuation.decision: model_requested → triggered=true');
    expect(report).not.toContain('断在这里');
  });

  it('finished=false 的 turn.end 渲染为 TRUNCATED 并标注断点', () => {
    const events: TraceEvent[] = [
      { t: 'turn.start', turnId: 't2', timestamp: 0 },
      { t: 'request.sent', turnId: 't2', timestamp: 20, bytes: 4915 },
      { t: 'sse.frame', turnId: 't2', timestamp: 40, kind: 'text', count: 12 },
      { t: 'turn.end', turnId: 't2', timestamp: 800, stopReason: 'length', finished: false },
    ];

    const report = renderTraceReport(events);
    expect(report).toContain('TRUNCATED  ← 断在这里');
    expect(report).toContain('stopReason=length finished=false');
    expect(report).not.toContain('DONE');
  });

  it('多轮按出现顺序编号，独立渲染各自状态', () => {
    const events: TraceEvent[] = [
      { t: 'turn.start', turnId: 'a', timestamp: 0 },
      { t: 'turn.end', turnId: 'a', timestamp: 300, stopReason: 'finished', finished: true },
      { t: 'turn.start', turnId: 'b', timestamp: 400 },
      // b 无 turn.end → OPEN
    ];

    const report = renderTraceReport(events);
    expect(report).toContain('turn 1 (0.3s)  DONE');
    expect(report).toContain('turn 2 (0.0s)  OPEN');
    // 两轮标题都在
    expect(report.indexOf('turn 1')).toBeLessThan(report.indexOf('turn 2'));
  });

  it('空输入返回空字符串，不输出占位标题', () => {
    expect(renderTraceReport([])).toBe('');
  });
});
