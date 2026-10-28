import { describe, it, expect, vi } from 'vitest';

// 测试环境跳过生产风控节流（2.5–6.5s 随机），避免 Phase B 续轮循环超过 5s 用例超时；
// 生产节流逻辑（core/inline-agent/step-control）保持不变，不在此修改。
vi.mock('../core/inline-agent/step-control', () => ({
  waitBetweenDeepSeekRequests: vi.fn(async () => {}),
  waitBetweenDeepSeekRequestsKeyed: vi.fn(async () => {}),
  resetPacedStepKeys: vi.fn(),
}));

import { runResumeToolLoop } from '../core/chat/resume-tool-loop';
import type { ResumeToolLoopDeps } from '../core/chat/resume-tool-loop';
import type { ActiveChatLoop } from '../core/chat/active-loop';
import type { ToolJob } from '../core/tool/job';
import type { ToolCall } from '../core/tool/types';

function makeJob(overrides: Partial<ToolJob> = {}): ToolJob {
  return {
    id: 'test-job',
    turnId: 'test-turn',
    parentMessageId: 12345,
    calls: [{ name: 'memory_save', args: {} }],
    executions: [],
    position: { callIndex: 0, depth: 0 },
    state: 'interrupted',
    startedAt: Date.now(),
    ...overrides,
  } as ToolJob;
}

function makeSnapshot(overrides: Partial<ActiveChatLoop> = {}): ActiveChatLoop {
  return {
    schemaVersion: 1,
    provider: 'web',
    jobId: 'test-job',
    turnId: 'test-turn',
    parentMessageId: 12345,
    chatSessionId: 'test-session',
    calls: [{ name: 'memory_save', args: {} }],
    executions: [],
    position: { callIndex: 0, depth: 0 },
    attempt: 0,
    startedAt: Date.now(),
    ...overrides,
  } as ActiveChatLoop;
}

function makeDeps(overrides: Partial<ResumeToolLoopDeps> = {}): ResumeToolLoopDeps {
  return {
    executeToolCall: async () => ({
      name: 'memory_save',
      result: { ok: true, summary: 'saved' },
    }),
    submitContinuation: async (_input) => ({
      responseMessageId: '67890',
      assistantText: 'done',
      finished: true,
      toolCalls: [],
    }),
    broadcastChunk: () => {},
    finalize: async () => {},
    updateMarker: async () => {},
    ...overrides,
  };
}

describe('runResumeToolLoop', () => {
  it('Phase A: 执行剩余工具调用', async () => {
    const executed: string[] = [];
    const deps = makeDeps({
      executeToolCall: async (call) => {
        executed.push(call.name);
        return { name: call.name, result: { ok: true, summary: 'ok' } };
      },
    });

    const result = await runResumeToolLoop(
      {
        job: makeJob(),
        snapshot: makeSnapshot(),
        resumeIndex: 0,
        depth: 0,
      },
      deps,
      new AbortController().signal,
    );

    expect(result.ok).toBe(true);
    expect(executed).toEqual(['memory_save']);
  });

  it('H3: depth=19 → remainingSteps=0 → 直接完成', async () => {
    const submitContinuation = async (_input: unknown) => {
      throw new Error('should not be called');
    };

    const result = await runResumeToolLoop(
      {
        job: makeJob({ calls: [] }),
        snapshot: makeSnapshot(),
        resumeIndex: 0,
        depth: 19,
      },
      makeDeps({ submitContinuation }),
      new AbortController().signal,
    );

    expect(result.ok).toBe(true);
  });

  it('Phase B: 续轮后无工具调用 → 完成', async () => {
    const deps = makeDeps({
      submitContinuation: async (_input) => ({
        responseMessageId: '67890',
        assistantText: 'done',
        finished: true,
        toolCalls: [],
      }),
    });

    const result = await runResumeToolLoop(
      {
        job: makeJob({ calls: [] }),
        snapshot: makeSnapshot(),
        resumeIndex: 0,
        depth: 0,
      },
      deps,
      new AbortController().signal,
    );

    expect(result.ok).toBe(true);
  });

  it('abort: signal.aborted → 返回 aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await runResumeToolLoop(
      {
        job: makeJob(),
        snapshot: makeSnapshot(),
        resumeIndex: 0,
        depth: 0,
      },
      makeDeps(),
      controller.signal,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('aborted');
  });

  it('步数用完 → 强制完成', async () => {
    const submitContinuation = async (_input: { parentMessageId: number | null; toolResults: string; signal: AbortSignal }) => ({
      responseMessageId: '67890',
      assistantText: 'continue',
      finished: false,
      toolCalls: [{ name: 'memory_search', args: {} } as unknown as ToolCall],
    });

    const result = await runResumeToolLoop(
      {
        job: makeJob({ calls: [] }),
        snapshot: makeSnapshot(),
        resumeIndex: 0,
        depth: 0,
      },
      makeDeps({ submitContinuation }),
      new AbortController().signal,
    );

    expect(result.ok).toBe(true);
  });
});
