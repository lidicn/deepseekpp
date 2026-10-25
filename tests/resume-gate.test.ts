// resume-gate 分支回归：伪造 v1 web marker + feature flag，验证
// enabled+合法 marker 走 runner，其余（flag 关 / marker 缺 / runner 失败）回退 legacy。
import { describe, it, expect, vi } from 'vitest';
import { createResumeGate, normalizeFlags } from '../core/chat/resume-gate';
import type { ActiveChatLoop } from '../core/chat/active-loop';
import type { ResumeToolLoopResult } from '../core/chat/resume-tool-loop';

const validMarker: ActiveChatLoop = {
  active: true,
  startedAt: Date.now() - 1000,
  provider: 'web',
  executions: [],
  currentTool: null,
  schemaVersion: 1,
  revision: 1,
  turnId: 'test-turn',
  jobId: 'test-job',
  jobState: 'running',
  calls: [{ name: 'search', payload: {}, raw: '{}' }],
  position: { callIndex: 0, depth: 0 },
  parentMessageId: 12345,
  chatSessionId: 'test-session',
  attempt: 0,
  lastUpsertAt: Date.now() - 1000,
  resumeDeadline: Date.now() + 600_000,
};

function makeDeps(overrides: { flags?: unknown; marker?: ActiveChatLoop | null }) {
  const legacyReconcile = vi.fn(async () => ({
    provider: 'web' as const,
    startedAt: 1,
    interruptedAt: 2,
    executions: [],
    currentTool: null,
  }));
  const reportError = vi.fn();
  const runnerRun = vi.fn(async (): Promise<ResumeToolLoopResult> => ({
    ok: true,
    terminalEmitted: true,
  }));
  return {
    legacyReconcile,
    reportError,
    runner: { run: runnerRun },
    readFlags: async () => normalizeFlags(overrides.flags),
    readMarker: async () => (overrides.marker === undefined ? validMarker : overrides.marker),
    runnerRun,
  };
}

describe('resume-gate 分支（伪造 marker）', () => {
  it('enabled=true + 合法 v1 web marker → 走 runner，legacy 不调用，返回 null', async () => {
    const d = makeDeps({ flags: { enabled: true } });
    const gate = await createResumeGate({
      readFlags: d.readFlags,
      readMarker: d.readMarker,
      legacyReconcile: d.legacyReconcile,
      reportError: d.reportError,
      runner: d.runner,
    });
    const result = await gate();
    expect(d.runnerRun).toHaveBeenCalledTimes(1);
    expect(d.legacyReconcile).not.toHaveBeenCalled();
    expect(d.reportError).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it('enabled=false（默认）→ 走 legacy，runner 不调用', async () => {
    const d = makeDeps({ flags: undefined });
    const gate = await createResumeGate({
      readFlags: d.readFlags,
      readMarker: d.readMarker,
      legacyReconcile: d.legacyReconcile,
      reportError: d.reportError,
      runner: d.runner,
    });
    const result = await gate();
    expect(d.runnerRun).not.toHaveBeenCalled();
    expect(d.legacyReconcile).toHaveBeenCalledTimes(1);
    expect(result).not.toBeNull();
  });

  it('runner 失败 → reportError 后回退 legacy', async () => {
    const d = makeDeps({ flags: { enabled: true } });
    d.runnerRun.mockResolvedValueOnce({ ok: false, reason: 'aborted' });
    const gate = await createResumeGate({
      readFlags: d.readFlags,
      readMarker: d.readMarker,
      legacyReconcile: d.legacyReconcile,
      reportError: d.reportError,
      runner: d.runner,
    });
    await gate();
    expect(d.runnerRun).toHaveBeenCalledTimes(1);
    expect(d.reportError).toHaveBeenCalledWith('resume_runner_failed', expect.any(Error));
    expect(d.legacyReconcile).toHaveBeenCalledTimes(1);
  });

  it('marker 缺失（readMarker=null）→ 走 legacy，runner 不调用', async () => {
    const d = makeDeps({ flags: { enabled: true }, marker: null });
    const gate = await createResumeGate({
      readFlags: d.readFlags,
      readMarker: d.readMarker,
      legacyReconcile: d.legacyReconcile,
      reportError: d.reportError,
      runner: d.runner,
    });
    await gate();
    expect(d.runnerRun).not.toHaveBeenCalled();
    expect(d.legacyReconcile).toHaveBeenCalledTimes(1);
  });
});

// 审计 #11（2026-10-24 报告 P1）：resume-gate 在不传 abortController 时会**本地新建**
// 一个传给 runner，但从不 abort —— runner 挂在 signal 上的监听器就永久泄漏。
// 修法：退出时 abort **自己创建的那个**；调用方传进来的绝不碰。
describe('审计 #11：resume-gate 的 controller 生命周期', () => {
  it('未传 abortController ⇒ 退出后本地 controller 被 abort', async () => {
    const d = makeDeps({ flags: { enabled: true } });
    let captured: AbortSignal | undefined;
    d.runnerRun.mockImplementation((async (_plan: unknown, signal: AbortSignal) => {
      captured = signal;
      return { ok: true, terminalEmitted: true };
    }) as never);
    const gate = await createResumeGate({
      readFlags: d.readFlags,
      readMarker: d.readMarker,
      legacyReconcile: d.legacyReconcile,
      reportError: d.reportError,
      runner: d.runner,
    });
    await gate();
    expect(captured).toBeDefined();
    expect(captured?.aborted).toBe(true);
  });

  it('调用方传入 abortController ⇒ 退出后**不得**被 abort（负控）', async () => {
    const d = makeDeps({ flags: { enabled: true } });
    let captured: AbortSignal | undefined;
    d.runnerRun.mockImplementation((async (_plan: unknown, signal: AbortSignal) => {
      captured = signal;
      return { ok: true, terminalEmitted: true };
    }) as never);
    const callerController = new AbortController();
    const gate = await createResumeGate({
      readFlags: d.readFlags,
      readMarker: d.readMarker,
      legacyReconcile: d.legacyReconcile,
      reportError: d.reportError,
      runner: d.runner,
      abortController: callerController,
    });
    await gate();
    expect(captured).toBe(callerController.signal);
    expect(callerController.signal.aborted).toBe(false);
  });
});
