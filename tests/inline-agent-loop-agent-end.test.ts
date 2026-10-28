/**
 * 审计 #83：agent_end 终态必须 await 最后一轮后台图片物化。
 *
 * 问题：pi `agent_end` 是循环的最后一个事件。正常流式对话里，`pacedStreamFn`
 * 会在下一次 LLM 请求前 await `pendingImageMaterialization` 汇合；但
 * `agent_end` 意味着循环结束、不会再有下一次请求 —— 不等就丢弃最后一个 step
 * 的图片上传。
 *
 * 本测试 mock `@earendil-works/pi-agent-core` 的 `runAgentLoop`，手动 emit
 * 事件驱动 loop-adapter 的 handleEvent；uploadImage 返回永不 resolve 的 Promise
 * 精确控制时序，在 agent_end await 它之前断言 finalize 未被调用。
 *
 * 变异自证（MUST revert 前跑红）：
 *   loop-adapter.ts `case 'agent_end'` 块里去掉
 *     `if (pendingImageMaterialization) { await pendingImageMaterialization; ... }`
 *   → runPromise 会在 resolveUpload 之前就 settle，断言 A 失败（preResolveComplete > 0）
 *     或断言 C 失败（resolveUpload 之前 runPromise 已 settle）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const piAgentCoreMocks = vi.hoisted(() => ({
  runAgentLoop: vi.fn(),
}));

vi.mock('@earendil-works/pi-agent-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@earendil-works/pi-agent-core')>();
  return {
    ...actual,
    runAgentLoop: piAgentCoreMocks.runAgentLoop,
  };
});

const { runInlineAgentLoop } = await import('../core/inline-agent/loop');

function createPayload() {
  return {
    loopId: 'loop-1',
    chatSessionId: 'chat-1',
    parentMessageId: 100,
    originalPrompt: 'Use the tool and summarize the result.',
    agentTaskPrompt: 'Use the tool and summarize the result.',
    toolExecutions: [],
    promptOptions: {
      modelType: null,
      searchEnabled: false,
      thinkingEnabled: false,
      refFileIds: [],
    },
    toolDescriptors: [],
    locale: 'en' as const,
  };
}

describe('审计 #83：agent_end 终态 await 最后一轮图片物化', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('最后一轮 tool_execution_end → turn_end 排队物化 → agent_end await 后再 finalize', async () => {
    // uploadImage 返回**永不 resolve**的 Promise — 模拟后台图片物化卡住
    // 我们手动 resolve，精确控制时序
    let resolveUpload!: () => void;
    const uploadImage = vi.fn(({ url }: { url: string; name: string }) => {
      return new Promise<string>((resolve) => {
        resolveUpload = () => resolve('file_id_' + url.slice(-8));
      });
    });

    piAgentCoreMocks.runAgentLoop.mockImplementation(
      async (_prompts, _context, _config, emit) => {
        // 按 pi 引擎事件顺序 emit —— handleEvent 有状态机依赖
        await emit({ type: 'agent_start' });
        await emit({ type: 'turn_start' });
        // tool_execution_end → executedInStep 入列 → turn_end 的 hasTools 分支
        // 会排队 pendingImageMaterialization（不 await，后台跑）
        // details.ok 分支让 piToolResultToExecutionRecord 保留 output 数组
        await emit({
          type: 'tool_execution_end',
          toolCallId: 'tc-1',
          toolName: 'web_search',
          result: {
            content: [{ type: 'text', text: 'Search completed' }],
            details: {
              ok: true,
              summary: 'Found chart',
              output: [{ title: 'Chart', url: 'https://example.com/chart.png' }],
            },
          },
        });
        // turn_end 带 toolCall block → hasTools → pendingImageMaterialization 排队
        await emit({
          type: 'turn_end',
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: 'Here is the result...' },
              { type: 'toolCall', toolCallId: 'tc-1', toolName: 'web_search' },
            ],
          },
          toolResults: [],
        });
        // agent_end — 此时 pendingImageMaterialization 已排队，uploadImage 还没 resolve
        // loop-adapter 必须 await 它再 finalize → post('AGENT_LOOP_COMPLETE')
        await emit({ type: 'agent_end', messages: [] });
        return [];
      },
    );

    const post = vi.fn();
    const runPromise = runInlineAgentLoop(
      { ...createPayload(), modelBackend: 'official-api' },
      {
        post,
        executeTool: vi.fn(),
        uploadImage,
        signal: new AbortController().signal,
      },
    );

    // 等 microtask + 一轮 macrotask —— materializeAndUploadToolResultImages
    // 内部有 `await import('../../multimodal/media')` 动态 import，需要足够的
    // 调度轮次才能让 uploadImage 真正被调用
    await new Promise((r) => setTimeout(r, 50));
    await Promise.resolve();
    await Promise.resolve();

    // 断言 A：resolve 前不应有 AGENT_LOOP_COMPLETE（agent_end 必须 await pendingImageMaterialization）
    const preResolveComplete = post.mock.calls.filter((c) => c[0] === 'AGENT_LOOP_COMPLETE').length;
    expect(preResolveComplete).toBe(0);

    // 手动 resolve uploadImage → pendingImageMaterialization resolve → finalize → post
    resolveUpload();

    // 断言 B：runPromise 现在必须 settle（不会因 finalize 之前就 settle 导致漏 upload）
    await runPromise;

    // 断言 C：uploadImage 被调用过（materializeAndUploadToolResultImages 扫描到了图片 URL）
    expect(uploadImage).toHaveBeenCalledTimes(1);

    // 断言 D：post('AGENT_LOOP_COMPLETE') 最终被发出
    const completeCalls = post.mock.calls.filter((c) => c[0] === 'AGENT_LOOP_COMPLETE');
    expect(completeCalls.length).toBeGreaterThan(0);
  }, 30_000);
});
