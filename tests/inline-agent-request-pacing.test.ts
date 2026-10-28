/**
 * E2 · 请求节流量化实验（第十批派工 · 性能）。
 *
 * 目标：用确定性假时钟回答「一个步进里 waitBetweenDeepSeekRequests
 * 被调用几次、累计假时间多少」，不依赖浏览器与真实模型。
 *
 * 覆盖两条真实链路：
 *  1. 正常 pi loop（official-api 后端驱动 runAgentLoop 真实链路）
 *     —— 节流点只有 pacedStreamFn（loop-adapter.ts:315-328）；
 *  2. 唤醒续跑 resume-tool-loop（chat-runtime-service.ts:894 的
 *     submitContinuation 会再等一次 —— 与 resume-tool-loop.ts:126 叠加）。
 *
 * 断言（也是未来的回归守卫）：
 *  - 正常路径：perStepWaits === 1；每次等待 ∈ [2500, 6500]
 *  - 续跑路径：若仍双重节流，测试记录并断言当前行为（O1 修复后改为 1）
 *
 * 变异自证（写红用，改完必须还原）：
 *  - 在 pacedStreamFn 里连续 await 两次 waitBetweenDeepSeekRequests
 *    → 「normal pi loop」用例红（waitsPerNonFirstRequest 变成 2）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryToolDescriptors } from '../core/tool/memory';
import type { InlineAgentStartPayload } from '../core/inline-agent/types';
import type { ToolExecutionRecord } from '../core/types';

// ---------------------------------------------------------------- mocks
const officialApiMocks = vi.hoisted(() => ({
  submitOfficialDeepSeekStreaming: vi.fn(),
}));

const pacing = vi.hoisted(() => ({
  /** 每次真实节流消耗的假时间（ms） */
  waitedMs: [] as number[],
  calls: 0,
}));

vi.mock('../core/deepseek/official-api', async (importOriginal) => {
  const original = await importOriginal<typeof import('../core/deepseek/official-api')>();
  return {
    ...original,
    submitOfficialDeepSeekStreaming: officialApiMocks.submitOfficialDeepSeekStreaming,
  };
});

vi.mock('../core/chat/api-key', () => ({
  getDeepSeekApiKey: vi.fn(async () => 'sk-test'),
}));

vi.mock('../core/chat/official-api-config', () => ({
  getOfficialApiChatConfig: vi.fn(async () => ({
    model: 'deepseek-v4-flash',
    thinking: 'disabled',
    reasoningEffort: 'high',
  })),
}));

// 间谍：包装真实实现，记录调用次数与假时间增量，不改变语义。
vi.mock('../core/inline-agent/step-control', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/inline-agent/step-control')>();
  return {
    ...actual,
    waitBetweenDeepSeekRequests: (signal: AbortSignal) => {
      pacing.calls += 1;
      const start = Date.now();
      return actual.waitBetweenDeepSeekRequests(signal).then(() => {
        pacing.waitedMs.push(Date.now() - start);
      });
    },
  };
});

const { runInlineAgentLoop } = await import('../core/inline-agent/loop');
const { runResumeToolLoop } = await import('../core/chat/resume-tool-loop');
const stepControl = await import('../core/inline-agent/step-control');

// chrome stub（official-api 分支的存储读取）
(globalThis as Record<string, unknown>).chrome = {
  storage: {
    local: {
      QUOTA_BYTES: 10_485_760,
      get: vi.fn(async () => ({})),
      set: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
    },
    session: {
      get: vi.fn(async () => ({})),
      set: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
    },
  },
  runtime: {
    getURL: (path: string) => `chrome-extension://mock/${path}`,
    lastError: undefined,
  },
};

const TOOL_CALL_TEXT =
  '<memory_save>{"type":"topic","name":"e2","content":"step payload","tags":["e2"]}</memory_save>';
const FINAL_TEXT = '<task_complete>{"summary":"E2 pacing experiment finished."}</task_complete>';

function createPayload(): InlineAgentStartPayload {
  return {
    loopId: 'e2-loop',
    chatSessionId: 'e2-chat',
    parentMessageId: 100,
    originalPrompt: 'Run three tool steps then finish.',
    agentTaskPrompt: 'Run three tool steps then finish.',
    toolExecutions: [],
    promptOptions: {
      modelType: null,
      searchEnabled: false,
      thinkingEnabled: false,
      refFileIds: [],
    },
    toolDescriptors: [...createMemoryToolDescriptors('en')],
    modelBackend: 'official-api',
    locale: 'en',
  };
}

function createExecution(name = 'memory_save'): ToolExecutionRecord {
  return {
    name,
    provider: {
      kind: 'local',
      id: 'memory',
      displayName: 'Memory',
      transport: 'in_process',
    },
    result: { ok: true, summary: 'saved' },
  };
}

/** 把 waitedMs 切成「每次调用的时长」——本身就是逐调用记录。 */
function summarizeWaits(): {
  totalCalls: number;
  totalMs: number;
  minMs: number | null;
  maxMs: number | null;
  outOfRange: number[];
} {
  const waits = pacing.waitedMs;
  const outOfRange = waits.filter((ms) => ms < 2500 || ms > 6500);
  return {
    totalCalls: pacing.calls,
    totalMs: waits.reduce((a, b) => a + b, 0),
    minMs: waits.length ? Math.min(...waits) : null,
    maxMs: waits.length ? Math.max(...waits) : null,
    outOfRange,
  };
}

beforeEach(() => {
  pacing.calls = 0;
  pacing.waitedMs = [];
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('E2 · 正常 pi loop 每步节流次数（假时钟）', () => {
  it('3 次工具步 + 1 次收尾 ⇒ 恰好 3 次节流（首请求免等），每次 ∈ [2500,6500]', async () => {
    vi.useFakeTimers();
    officialApiMocks.submitOfficialDeepSeekStreaming
      .mockImplementationOnce(async (_input, callbacks) => {
        callbacks.onTextChunk?.(TOOL_CALL_TEXT);
        callbacks.onFinished?.();
        return { assistantText: TOOL_CALL_TEXT, reasoningText: '', finished: true };
      })
      .mockImplementationOnce(async (_input, callbacks) => {
        callbacks.onTextChunk?.(TOOL_CALL_TEXT);
        callbacks.onFinished?.();
        return { assistantText: TOOL_CALL_TEXT, reasoningText: '', finished: true };
      })
      .mockImplementationOnce(async (_input, callbacks) => {
        callbacks.onTextChunk?.(TOOL_CALL_TEXT);
        callbacks.onFinished?.();
        return { assistantText: TOOL_CALL_TEXT, reasoningText: '', finished: true };
      })
      .mockImplementationOnce(async (_input, callbacks) => {
        callbacks.onTextChunk?.(FINAL_TEXT);
        callbacks.onFinished?.();
        return { assistantText: FINAL_TEXT, reasoningText: '', finished: true };
      });

    const events: Array<{ type: string }> = [];
    const run = runInlineAgentLoop(createPayload(), {
      post: (type) => {
        events.push({ type });
      },
      executeTool: async (call) => createExecution(call.name),
      signal: new AbortController().signal,
    });

    // 4 个请求 × 最长 6.5s 节流 = 26s 上限；一次推进覆盖全部。
    await vi.advanceTimersByTimeAsync(30_000);
    await run;

    const requests = officialApiMocks.submitOfficialDeepSeekStreaming.mock.calls.length;
    expect(requests).toBe(4);

    // 回归守卫：每个非首请求恰好节流一次。
    // 若某处塞了第二道等待（如 submitContinuation 叠加），此处会红。
    const waitsPerNonFirstRequest = pacing.waitedMs.length / (requests - 1);
    expect(waitsPerNonFirstRequest).toBe(1);
    expect(pacing.calls).toBe(3);

    const summary = summarizeWaits();
    expect(summary.outOfRange).toEqual([]);
    expect(summary.minMs).not.toBeNull();
    expect(summary.maxMs).not.toBeNull();
    expect(summary.minMs!).toBeGreaterThanOrEqual(2500);
    expect(summary.maxMs!).toBeLessThanOrEqual(6500);

    expect(events.some((e) => e.type === 'AGENT_LOOP_COMPLETE')).toBe(true);
  });

  it('首请求不节流（requestCount=0 免等），第 2 个请求起每次一节流', async () => {
    vi.useFakeTimers();
    officialApiMocks.submitOfficialDeepSeekStreaming
      .mockImplementationOnce(async (_input, callbacks) => {
        callbacks.onTextChunk?.(TOOL_CALL_TEXT);
        callbacks.onFinished?.();
        return { assistantText: TOOL_CALL_TEXT, reasoningText: '', finished: true };
      })
      .mockImplementationOnce(async (_input, callbacks) => {
        callbacks.onTextChunk?.(FINAL_TEXT);
        callbacks.onFinished?.();
        return { assistantText: FINAL_TEXT, reasoningText: '', finished: true };
      });

    const run = runInlineAgentLoop(createPayload(), {
      post: () => {},
      executeTool: async (call) => createExecution(call.name),
      signal: new AbortController().signal,
    });

    // 推进 0ms：首请求应已发出（requestCount=0 不节流）。
    // 注意：此刻第 2 请求的 wait 可能已被**发起**（calls 会 +1）但假时钟未走完
    // （waitedMs 仍空）—— 所以中间只断言 submit 次数，不断言 pacing.calls。
    await vi.advanceTimersByTimeAsync(0);
    expect(officialApiMocks.submitOfficialDeepSeekStreaming.mock.calls.length).toBe(1);

    await vi.advanceTimersByTimeAsync(7_000);
    await run;

    // 2 个请求 ⇒ 恰好 1 次完成的节流（首请求免等由「3 步用例 4 请求 3 等」独立锁定）。
    expect(officialApiMocks.submitOfficialDeepSeekStreaming.mock.calls.length).toBe(2);
    expect(pacing.waitedMs).toHaveLength(1);
    expect(pacing.waitedMs[0]).toBeGreaterThanOrEqual(2500);
    expect(pacing.waitedMs[0]).toBeLessThanOrEqual(6500);
  });
});

describe('E2 · 唤醒续跑路径的节流叠加', () => {
  it('resume-tool-loop 步内 wait ×1 + submitContinuation 内 wait ×1 = 每步 2 次（chat-runtime-service 接线形状）', async () => {
    vi.useFakeTimers();

    // 按 chat-runtime-service.ts:892-894 的真实接线复刻：
    // submitContinuation 内部又 await waitBetweenDeepSeekRequests。
    const submitContinuation = vi.fn(async (input: { signal: AbortSignal }) => {
      await stepControl.waitBetweenDeepSeekRequests(input.signal);
      return {
        responseMessageId: 'r-1',
        assistantText: 'done',
        finished: true,
        toolCalls: [],
      };
    });

    const run = runResumeToolLoop(
      {
        job: {
          id: 'e2-job',
          turnId: 'e2-turn',
          parentMessageId: 123,
          calls: [],
          executions: [],
          position: { callIndex: 0, depth: 0 },
          state: 'interrupted',
          startedAt: 0,
        },
        snapshot: {
          schemaVersion: 1,
          provider: 'web',
          jobId: 'e2-job',
          turnId: 'e2-turn',
          parentMessageId: 123,
          chatSessionId: 'e2-session',
          calls: [],
          executions: [],
          position: { callIndex: 0, depth: 0 },
          attempt: 0,
          startedAt: 0,
        },
        resumeIndex: 0,
        depth: 0,
      },
      {
        executeToolCall: async () => createExecution(),
        submitContinuation: submitContinuation as never,
        broadcastChunk: () => {},
        finalize: async () => {},
        updateMarker: async () => {},
      },
      new AbortController().signal,
    );

    await vi.advanceTimersByTimeAsync(15_000);
    await run;

    expect(submitContinuation).toHaveBeenCalledTimes(1);
    // 实测结论：续跑路径每步 2 次节流（2.5–6.5s ×2 = 5–13s）。
    // O1 去重后此断言应改为 1。
    expect(pacing.calls).toBe(2);
    for (const ms of pacing.waitedMs) {
      expect(ms).toBeGreaterThanOrEqual(2500);
      expect(ms).toBeLessThanOrEqual(6500);
    }
  });
});
