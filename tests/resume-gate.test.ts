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
