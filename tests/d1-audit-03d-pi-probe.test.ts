// @ts-nocheck
/**
 * D1-03d · 直接调用 runAgentLoop（真实 pi 引擎）+ loop-adapter 的 post，
 * 在 handleEvent 之外再包一层 trace，看 pi 事件流停在哪。
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

const { runAgentLoop } = await import('@earendil-works/pi-agent-core');
const { createDeepSeekWebProvider, deepSeekWebProviderToStreamFn } =
  await import('../core/inline-agent/pi/deepseek-web-provider');

const trace: string[] = [];

function createPayload() {
  return {
    loopId: 'loop-1',
    capabilityScopeRequestId: 'req-1',
    chatSessionId: 'chat-1',
    parentMessageId: 100,
    originalPrompt: 'do the thing',
    agentTaskPrompt: 'do the thing',
    toolExecutions: [],
    promptOptions: {
      modelType: null,
      searchEnabled: false,
      thinkingEnabled: false,
      refFileIds: [],
    },
    toolDescriptors: [],
    locale: 'en',
  } as never;
}

describe('D1-03d pi engine probe', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    trace.length = 0;
    adapterMocks.createPowHeaders.mockResolvedValue({ 'X-DS-PoW-Response': 'pow-1' });
  });
  afterEach(() => vi.useRealTimers());

  it('runs the real pi loop over the deepseek-web StreamFn and traces events', async () => {
    adapterMocks.submitPromptStreaming.mockImplementationOnce(async () => {
      trace.push('submit:returning');
      return {
        assistantText: '',
        responseMessageId: null,
        requestMessageId: 101,
        finished: true,
      };
    });

    const provider = createDeepSeekWebProvider({
      resolveAuthHeaders: () => ({ Authorization: 'Bearer t' }),
      submitTurn: (await import('../core/inline-agent/pi/deepseek-stream-fn')).createDeepSeekTurnSubmitter({}),
      session: {
        chatSessionId: 'chat-1',
        parentMessageId: 100,
        setParentMessageId: () => {},
      },
      serializePrompt: () => 'prompt',
      mapToolCall: (call: never, index: number) => ({ type: 'toolCall', id: `x:${index}`, name: (call as { name: string }).name, arguments: {} }),
      toolDescriptors: [],
      turnDefaults: { modelType: null, refFileIds: [], thinkingEnabled: false, searchEnabled: false },
    });
    const streamFn = deepSeekWebProviderToStreamFn(provider);
    const model = provider.getModels()[0];

    const config = {
      model,
      toolExecution: 'sequential',
      convertToLlm: (messages: unknown[]) => messages,
      shouldStopAfterTurn: ({ message }: { message: { content: unknown[] } }) => {
        trace.push(`shouldStopAfterTurn:content=${message.content.length}`);
        return true;
      },
      getSteeringMessages: async () => {
        trace.push('getSteeringMessages');
        return [];
      },
    };

    const emit = async (event: { type: string }) => {
      trace.push(`emit:${event.type}`);
    };

    let settled = false;
    const run = runAgentLoop(
      [{ role: 'user', content: 'p', timestamp: 0 }],
      { systemPrompt: '', messages: [], tools: [] },
      config as never,
      emit as never,
      new AbortController().signal,
      streamFn,
    ).then(() => { settled = true; trace.push('runAgentLoop:resolved'); });

    await new Promise((resolve) => setTimeout(resolve, 3500));
    // eslint-disable-next-line no-console
    console.log('[D1-03d] settled=', settled, '\nTRACE:\n' + trace.join('\n'));
    await run;
  }, 30000);
});
