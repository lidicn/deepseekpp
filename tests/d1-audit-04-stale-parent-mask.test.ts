// @ts-nocheck
/**
 * D1-04 [P1] · inline-agent「无 continuable message id」fail-closed 被陈旧
 *             parentMessageId 掩盖 —— 空响应不终止，反而多打一次模型请求。
 *
 * 根因链（实证）：
 *  1. `runPiInlineAgentLoop` 用 `payload.parentMessageId` 初始化
 *     `session.parentMessageId`（loop-adapter.ts:90）。
 *  2. `createDeepSeekStreamFn` 仅在 `result.responseMessageId !== null` 时才
 *     写回 session（deepseek-stream-fn.ts:298-300）。当本 turn 的响应
 *     **没有** responseMessageId 时，session 里残留的是**上一轮/初始**的 id。
 *  3. `shouldStopAfterTurn` 的 fail-closed 分支判定 `hasContinuableChain()`
 *     （loop-adapter.ts:102-105 = `session.parentMessageId !== null`），
 *     于是读到陈旧 id → 判定"有链" → 不抛错。
 *  4. 空文本 + 有链 ⇒ 进入 nudge 续轮：额外一次 `createPowHeaders`
 *     （实测 +3.8s）+ `waitBetweenDeepSeekRequests`（2.5–6.5s），
 *     然后第二次 submit 才报错。实测总延迟 9.0s。
 *
 * 后果：
 *  - 设计意图（tests/inline-agent-loop.test.ts:227「fails visibly when the
 *    response is empty and omits a continuable message id」）被违背：
 *    应立即 fail-closed，实际先多发一次请求。
 *  - 真实场景：服务端在首个 SSE 帧后就断流（未吐出 response_message_id），
 *    扩展会**再发一次 completion 请求**才报错 → 用户侧多等 ~5-10s，
 *    且第二次请求的 parent_message_id 指向一个**从未被服务端确认**的消息，
 *    可能造成对话链分叉。
 *  - 5 条既有测试因此超时（5s < 9s）。
 *
 * 判定：用例失败 ⇒ 复现缺陷。
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

const { runInlineAgentLoop } = await import('../core/inline-agent/loop');

function createPayload() {
  return {
    loopId: 'loop-1',
    capabilityScopeRequestId: 'req-1',
    chatSessionId: 'chat-1',
    parentMessageId: 100,
    originalPrompt: 'do the thing',
    agentTaskPrompt: 'do the thing',
    toolExecutions: [],
    promptOptions: { modelType: null, searchEnabled: false, thinkingEnabled: false, refFileIds: [] },
    toolDescriptors: [],
    locale: 'en',
  } as never;
}

describe('D1-04 stale parentMessageId masks the no-continuable-id fail-closed', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    adapterMocks.createPowHeaders.mockResolvedValue({ 'X-DS-PoW-Response': 'pow-1' });
  });
  afterEach(() => vi.useRealTimers());

  it('an empty turn that reports responseMessageId=null must fail closed WITHOUT a second model request', async () => {
    adapterMocks.submitPromptStreaming.mockImplementationOnce(async () => ({
      assistantText: '',
      responseMessageId: null,
      requestMessageId: 101,
      finished: true,
    }));

    const post = vi.fn();
    const executeTool = vi.fn();

    await runInlineAgentLoop(createPayload(), {
      post,
      executeTool: executeTool as never,
      signal: new AbortController().signal,
    });

    // The turn produced no content and no continuable response message id:
    // exactly ONE model request must be issued, then a visible error.
    expect(adapterMocks.submitPromptStreaming).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith('AGENT_LOOP_ERROR', expect.objectContaining({
      error: expect.stringContaining('empty agent continuation'),
    }));
  });

  it('a tool call without a continuable id must not be executed and must not trigger a retry', async () => {
    adapterMocks.submitPromptStreaming.mockImplementationOnce(async (_input, handlers) => {
      handlers.onTextChunk('<artifact_create>{"filename":"a.txt","content":"ok"}</artifact_create>');
      return {
        assistantText: '',
        responseMessageId: null,
        requestMessageId: 101,
        finished: true,
      };
    });

    const post = vi.fn();
    const executeTool = vi.fn();

    const { createArtifactToolDescriptors } = await import('../core/artifact');
    await runInlineAgentLoop({
      ...createPayload(),
      toolDescriptors: createArtifactToolDescriptors('en'),
    } as never, {
      post,
      executeTool: executeTool as never,
      signal: new AbortController().signal,
    });

    expect(executeTool).not.toHaveBeenCalled();
    expect(adapterMocks.submitPromptStreaming).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith('AGENT_LOOP_ERROR', expect.objectContaining({
      error: expect.stringContaining('without a continuable response message'),
    }));
  });
});
