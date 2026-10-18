// @ts-nocheck
/**
 * D1-03c · 在 deepseek-stream-fn 的 IIFE 尾部与 pi 消费侧插桩，
 * 精确定位"submitPromptStreaming 已返回但 turn_end 迟迟不来"的断点。
 * 手段：mock 掉 @earendil-works/pi-agent-core 的 runAgentLoop，
 * 手动驱动 streamFn 并迭代事件流。
 */
import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';

const adapterMocks = vi.hoisted(() => ({
  createPowHeaders: vi.fn(),
  submitPromptStreaming: vi.fn(),
}));

vi.mock('../core/deepseek/adapter', () => ({
  createClientHeaders: () => ({ Authorization: 'Bearer test-token' }),
  createPowHeaders: adapterMocks.createPowHeaders,
  submitPromptStreaming: adapterMocks.submitPromptStreaming,
}));

const { createDeepSeekStreamFn, createDeepSeekTurnSubmitter } =
  await import('../core/inline-agent/pi/deepseek-stream-fn');

const trace: string[] = [];

describe('D1-03c streamFn tail probe', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    trace.length = 0;
    adapterMocks.createPowHeaders.mockResolvedValue({ 'X-DS-PoW-Response': 'pow-1' });
  });
  afterEach(() => vi.useRealTimers());

  it('emits a done event after submitPromptStreaming resolves with an empty turn', async () => {
    adapterMocks.submitPromptStreaming.mockImplementationOnce(async () => {
      trace.push('submit:returning');
      return {
        assistantText: '',
        responseMessageId: null,
        requestMessageId: 101,
        finished: true,
      };
    });

    const submitTurn = createDeepSeekTurnSubmitter({ powWasmUrl: undefined });
    const session = {
      chatSessionId: 'chat-1',
      parentMessageId: 100,
      setParentMessageId: (id: number) => { session.parentMessageId = id; },
    };
    const streamFn = createDeepSeekStreamFn({
      submitTurn,
      session,
      serializePrompt: () => 'prompt',
      mapToolCall: (call, index) => ({ type: 'toolCall', id: `x:${index}`, name: call.name, arguments: call.payload }),
      toolDescriptors: [],
      turnDefaults: {
        modelType: null,
        refFileIds: [],
        thinkingEnabled: false,
        searchEnabled: false,
      },
    });

    const model = { id: 'deepseek-chat', name: 'm', api: 'deepseek-web', provider: 'deepseek-web', baseUrl: '', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 0, maxTokens: 0 };
    const context = { systemPrompt: '', messages: [{ role: 'user', content: 'p', timestamp: 0 }], tools: [] };

    trace.push('calling streamFn');
    const stream = streamFn(model as never, context as never, { signal: new AbortController().signal } as never);
    trace.push('streamFn returned');

    // Iterate the event stream the way pi does.
    const events: string[] = [];
    const iterator = stream[Symbol.asyncIterator]();
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; }, 3000);
    while (true) {
      const next = await Promise.race([
        iterator.next(),
        new Promise<'__timeout__'>((resolve) => setTimeout(() => resolve('__timeout__'), 3000)),
      ]);
      if (next === '__timeout__') break;
      if (next.done) { events.push('<done>'); break; }
      events.push(next.value.type);
      if (next.value.type === 'done' || next.value.type === 'error') break;
    }
    clearTimeout(timeout);

    // eslint-disable-next-line no-console
    console.log('[D1-03c] events=', JSON.stringify(events), 'timedOut=', timedOut, 'trace=', JSON.stringify(trace));
    expect(events.length).toBeGreaterThan(0);
  }, 30000);
});
