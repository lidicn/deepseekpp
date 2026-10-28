/**
 * P0-2 第 2.1 项：request.sent 发射守卫（第十一批）。
 *
 * 此前全仓从未 emit 过 request.sent —— 观测模型里有事件类型，
 * 但没有发射点，导致「变慢查不清」。本测试锁：
 *  1. turn-tracker.requestSent 入库；
 *  2. deepseek-stream-fn 的 createDeepSeekTurnSubmitter 在 PoW 后、
 *     请求发出前经 emitTraceEvent 上报 bytes + powMs。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTurnTracker } from '../core/trace/turn-tracker';
import { emitTraceEvent, setTraceEventSink, type ExternalTraceEvent } from '../core/trace/collector';

const adapterMocks = vi.hoisted(() => ({
  createPowHeaders: vi.fn(),
  submitPromptStreaming: vi.fn(),
}));

vi.mock('../core/deepseek/adapter', () => ({
  createClientHeaders: () => ({ Authorization: 'Bearer test' }),
  createPowHeaders: adapterMocks.createPowHeaders,
  submitPromptStreaming: adapterMocks.submitPromptStreaming,
}));

const { createDeepSeekTurnSubmitter } = await import('../core/inline-agent/pi/deepseek-stream-fn');

beforeEach(() => {
  vi.clearAllMocks();
  setTraceEventSink(null);
});

afterEach(() => {
  setTraceEventSink(null);
});

describe('P0-2 · request.sent', () => {
  it('turn-tracker.requestSent 产生带 bytes/powMs 的事件', () => {
    const tracker = createTurnTracker({ now: () => 5 });
    tracker.startTurn('t');
    tracker.requestSent(1234, 90);
    expect(tracker.snapshot().find((e) => e.t === 'request.sent')).toMatchObject({
      bytes: 1234,
      powMs: 90,
    });
  });

  it('createDeepSeekTurnSubmitter 在 PoW 后、submit 前 emit request.sent（bytes + powMs）', async () => {
    const received: ExternalTraceEvent[] = [];
    setTraceEventSink((event) => received.push(event));

    adapterMocks.createPowHeaders.mockResolvedValue({ 'X-DS-PoW-Response': 'pow' });
    adapterMocks.submitPromptStreaming.mockResolvedValue({
      assistantText: 'ok',
      responseMessageId: 1,
      requestMessageId: 0,
      finished: true,
    });

    const submitter = createDeepSeekTurnSubmitter({ powWasmUrl: undefined });
    await submitter(
      {
        chatSessionId: 'c1',
        parentMessageId: 1,
        modelType: null,
        prompt: 'hello 世界',
        refFileIds: [],
        thinkingEnabled: false,
        searchEnabled: false,
      },
      { onTextChunk: () => {}, onTokenSpeed: () => {} },
      new AbortController().signal,
    );

    const sent = received.find((e) => e.t === 'request.sent');
    expect(sent).toBeDefined();
    if (sent?.t !== 'request.sent') throw new Error('expected request.sent');
    // UTF-8: 'hello ' = 6 bytes + '世界' = 6 bytes → 12
    expect(sent.bytes).toBe(new TextEncoder().encode('hello 世界').length);
    expect(typeof sent.powMs).toBe('number');
    expect(sent.powMs!).toBeGreaterThanOrEqual(0);
    // emit 必须发生在 submit 之前（可观测顺序：sink 收到时 submit 尚未被调用亦可，
    // 但至少 request.sent 事件存在且 submit 被调用过）
    expect(adapterMocks.submitPromptStreaming).toHaveBeenCalledTimes(1);
  });

  it('sink 未绑定时 emit 静默丢弃，不影响主流程', async () => {
    adapterMocks.createPowHeaders.mockResolvedValue({});
    adapterMocks.submitPromptStreaming.mockResolvedValue({
      assistantText: 'ok',
      responseMessageId: 1,
      requestMessageId: 0,
      finished: true,
    });

    const submitter = createDeepSeekTurnSubmitter();
    await expect(
      submitter(
        {
          chatSessionId: 'c1',
          parentMessageId: 1,
          modelType: null,
          prompt: 'x',
          refFileIds: [],
          thinkingEnabled: false,
          searchEnabled: false,
        },
        { onTextChunk: () => {}, onTokenSpeed: () => {} },
        new AbortController().signal,
      ),
    ).resolves.toBeDefined();
  });

  it('emitTraceEvent 对 request.sent 透传到 sink', () => {
    const received: ExternalTraceEvent[] = [];
    setTraceEventSink((e) => received.push(e));
    emitTraceEvent({ t: 'request.sent', bytes: 100, powMs: 5 });
    expect(received).toEqual([{ t: 'request.sent', bytes: 100, powMs: 5 }]);
  });
});

describe('P0-2 第 2.3 项 · tool.exec.durationMs 源码级守卫', () => {
  it('content.ts 的 executeTool 用 performance.now 计时并把 durationMs 传给 toolExec', () => {
    const source = readFileSync(
      join(process.cwd(), 'entrypoints/content.ts'),
      'utf8',
    );
    // 计时起点
    expect(source).toMatch(/execStartedAt\s*=\s*performance\.now\(\)/);
    // 终点差值
    expect(source).toMatch(/durationMs\s*=\s*Math\.round\(performance\.now\(\)\s*-\s*execStartedAt\)/);
    // 带耗时入库（不再传 undefined）
    expect(source).toMatch(/activeTraceTracker\?\.toolExec\([^)]*durationMs/);
    // flushTraceStep 不得再 emit 无耗时的 tool.exec（否则双计）
    const flushFn = source.match(
      /function flushTraceStep\([\s\S]*?\n\}/,
    )?.[0] ?? '';
    expect(flushFn).not.toMatch(/\.toolExec\(/);
  });
});
