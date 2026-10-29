/**
 * 第十二批 P0-2 · background 网页聊天路径 W29 埋点。
 *
 * 变异：去掉 chat-runtime-service 里的 webTrace.request.sent 调用 ⇒ 源码守卫红。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBackgroundWebChatTrace, utf8ByteLength } from '../core/trace/background-web-chat-trace';
import { renderTraceReport, type TraceEvent } from '../core/trace/report';

interface InlineAgentTraceRecordLike {
  chatSessionId: string;
  totalTools: number;
  status: string;
  events: TraceEvent[];
}

const storeMocks = vi.hoisted(() => ({
  upsertPersistedInlineAgentTrace: vi.fn(async () => {}),
}));

vi.mock('../core/inline-agent/trace-store', () => ({
  upsertPersistedInlineAgentTrace: storeMocks.upsertPersistedInlineAgentTrace,
}));

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createBackgroundWebChatTrace', () => {
  it('records request.sent / first-frame sse / tool.exec.durationMs and persists into the shared slot', async () => {
    let clock = 1_000;
    const trace = createBackgroundWebChatTrace({ now: () => clock });

    trace.beginTurn('web-chat:0');
    const turnStart = clock;
    clock += 120;
    const sentAt = clock;
    trace.requestSent(utf8ByteLength('hello 世界'), 180);
    clock += 40;
    const firstFrameAt = clock;
    trace.sseFrame('text');
    clock += 2_600;
    trace.toolExec('shell_exec', 2_600, true);
    clock += 50;
    trace.endTurn('finalized', true);

    await trace.persist({
      chatSessionId: 'sess-1',
      originalPrompt: 'list top movies',
      finalText: 'done',
      totalTools: 1,
      status: 'complete',
    });

    expect(storeMocks.upsertPersistedInlineAgentTrace).toHaveBeenCalledTimes(1);
    const record = (storeMocks.upsertPersistedInlineAgentTrace.mock as unknown as {
      calls: Array<[InlineAgentTraceRecordLike]>;
    }).calls[0][0];
    expect(record.chatSessionId).toBe('sess-1');
    expect(record.totalTools).toBe(1);
    expect(record.status).toBe('complete');

    const sent = record.events.find((e) => e.t === 'request.sent');
    expect(sent).toBeDefined();
    expect(sent!.bytes).toBe(utf8ByteLength('hello 世界'));
    expect(sent!.powMs).toBe(180);
    expect(sent!.timestamp).toBe(sentAt);

    const firstSse = record.events.find((e) => e.t === 'sse.frame');
    expect(firstSse).toBeDefined();
    expect(firstSse!.timestamp).toBe(firstFrameAt);

    const tool = record.events.find((e) => e.t === 'tool.exec');
    expect(tool).toMatchObject({ name: 'shell_exec', durationMs: 2_600, ok: true });

    // Δ 可从事件时间戳算出
    const start = record.events.find((e) => e.t === 'turn.start')!;
    expect(sent!.timestamp - start.timestamp).toBe(sentAt - turnStart);
    expect(firstSse!.timestamp - sent!.timestamp).toBeGreaterThan(0);

    const report = renderTraceReport(record.events as never);
    expect(report).toContain('request.sent');
    expect(report).toContain('pow=180ms');
    expect(report).toContain('tool.exec       shell_exec  2.6s  ok');
  });

  it('first sse frame flushes immediately (TTFT not delayed to frame 20)', () => {
    const trace = createBackgroundWebChatTrace({ now: () => 1 });
    trace.beginTurn('t');
    trace.sseFrame('text');
    const sse = trace.snapshot().filter((e) => e.t === 'sse.frame');
    expect(sse).toHaveLength(1);
    expect(sse[0]).toMatchObject({ count: 1, kind: 'text' });
  });

  it('does not invent durationMs=0 when tool timing is missing', () => {
    const trace = createBackgroundWebChatTrace({ now: () => 1 });
    trace.beginTurn('t');
    trace.toolExec('shell_exec', undefined, true);
    const tool = trace.snapshot().find((e) => e.t === 'tool.exec')!;
    expect('durationMs' in tool).toBe(false);
  });
});

describe('P0-2 · chat-runtime-service 网页路径埋点源码守卫', () => {
  const source = readFileSync(
    join(process.cwd(), 'entrypoints/background/chat-runtime-service.ts'),
    'utf8',
  );

  it('runWebToolLoop emits request.sent / sse.frame / toolExec via webTrace', () => {
    expect(source).toMatch(/webTrace\.requestSent\(/);
    expect(source).toMatch(/webTrace\.sseFrame\(/);
    expect(source).toMatch(/webTrace\?\.toolExec\(/);
    expect(source).toMatch(/createBackgroundWebChatTrace\(/);
  });

  it('tool duration uses real elapsed ms (Date.now diff), not a hardcoded 0', () => {
    expect(source).toMatch(/durationMs\s*=\s*Date\.now\(\)\s*-\s*startedAt/);
  });
});
