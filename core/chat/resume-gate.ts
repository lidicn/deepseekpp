// M1-2c: resume-gate — feature flag + reconcile 接入点
// 原则：flag 默认关；任何不确定都委托 legacy reconcile

import type { ActiveChatLoop, InterruptedChatLoop } from './active-loop';
import type { ResumeToolLoopPlan, ResumeToolLoopResult } from './resume-tool-loop';
import { rebuildJobFromMarker, resolveResumeIndex } from './resume-runner';

export const RESUME_FLAGS_STORAGE_KEY = 'deepseek_pp_resume_flags';

export interface ResumeFlags {
  enabled: boolean;
  forkCheck: boolean;
  forkRecheckBeforeSubmit: boolean;
  inFlightPolicy: 'abort' | 'synthesize' | 'replay';
  forkProbeTimeoutMs: number;
  resumeTtlFallbackMs: number;
  strictForkRecheck: boolean;
}

export const DEFAULT_RESUME_FLAGS: ResumeFlags = {
  enabled: false,
  forkCheck: true,
  forkRecheckBeforeSubmit: true,
  inFlightPolicy: 'synthesize',
  forkProbeTimeoutMs: 5000,
  resumeTtlFallbackMs: 600_000,
  strictForkRecheck: true,
};

export function normalizeFlags(raw: unknown): ResumeFlags {
  if (!raw || typeof raw !== 'object') return DEFAULT_RESUME_FLAGS;
  const r = raw as Record<string, unknown>;
  return {
    enabled: r.enabled === true,
    forkCheck: r.forkCheck !== false,
    forkRecheckBeforeSubmit: r.forkRecheckBeforeSubmit !== false,
    inFlightPolicy: r.inFlightPolicy === 'abort' || r.inFlightPolicy === 'replay' ? r.inFlightPolicy : 'synthesize',
    forkProbeTimeoutMs: typeof r.forkProbeTimeoutMs === 'number' ? Math.min(30000, Math.max(1000, r.forkProbeTimeoutMs)) : DEFAULT_RESUME_FLAGS.forkProbeTimeoutMs,
    resumeTtlFallbackMs: typeof r.resumeTtlFallbackMs === 'number' ? Math.min(3_600_000, Math.max(60_000, r.resumeTtlFallbackMs)) : DEFAULT_RESUME_FLAGS.resumeTtlFallbackMs,
    strictForkRecheck: r.strictForkRecheck !== false,
  };
}

export interface ResumeGateDeps {
  readFlags(): Promise<ResumeFlags>;
  readMarker(): Promise<ActiveChatLoop | null>;
  legacyReconcile(): Promise<InterruptedChatLoop | null>;
  reportError(code: string, error: unknown): void;
  // runner 由组合根注入
  runner: {
    run(plan: ResumeToolLoopPlan, signal: AbortSignal): Promise<ResumeToolLoopResult>;
  } | null;
  // 取消信号
  abortController?: AbortController;
}

export async function createResumeGate(deps: ResumeGateDeps): Promise<() => Promise<InterruptedChatLoop | null>> {
  const cancelled = { value: false };

  return async function resumeGate(): Promise<InterruptedChatLoop | null> {
    // A 保守：窗口期内被 submitPrompt 取消 → 走 legacy
    if (cancelled.value) {
      deps.reportError('resume_superseded_by_user', new Error('superseded_by_user'));
      return deps.legacyReconcile();
    }

    let flags: ResumeFlags;
    try {
      flags = await deps.readFlags();
    } catch (error) {
      deps.reportError('resume_flags_read_failed', error);
      return deps.legacyReconcile();
    }

    if (!flags.enabled) {
      return deps.legacyReconcile();
    }

    const snapshot = await deps.readMarker();
    if (!snapshot) {
      return deps.legacyReconcile();
    }

    // 可续跑判定（简化版：完整判定在 resume-runner.plan()）
    if (snapshot.schemaVersion !== 1 || snapshot.provider !== 'web') {
      return deps.legacyReconcile();
    }

    if (!deps.runner) {
      return deps.legacyReconcile();
    }

    // 重建 Job + 解析游标
    const rebuildResult = rebuildJobFromMarker(snapshot, Date.now());
    if (!rebuildResult.ok) {
      deps.reportError('resume_rebuild_failed', new Error(rebuildResult.reason));
      return deps.legacyReconcile();
    }

    const cursorResult = resolveResumeIndex(rebuildResult.job, snapshot);
    if (!cursorResult.ok) {
      deps.reportError('resume_cursor_failed', new Error(cursorResult.reason));
      return deps.legacyReconcile();
    }

    // 组装 plan
    const plan: ResumeToolLoopPlan = {
      job: rebuildResult.job,
      snapshot: rebuildResult.snapshot,
      resumeIndex: cursorResult.cursor.resumeIndex,
      depth: cursorResult.cursor.depth,
      synthesized: cursorResult.cursor.synthesized,
    };

    // 跑 runner
    // 审计 #11（2026-10-24 报告 P1）：调用方不传 abortController 时这里会**本地新建**
    // 一个，但从不 abort。runner 内部若把 listener 挂在 signal 上、而 signal 永不触发，
    // 那些监听器就永久泄漏（SW 反复唤醒后越积越多）。
    // 注意：只有「本函数自己创建」时才 abort —— 调用方传进来的 controller 属于调用方
    // 的作用域，擅自 abort 会取消它的后续工作。
    const ownsController = deps.abortController === undefined;
    const controller = deps.abortController ?? new AbortController();
    try {
      const result = await deps.runner.run(plan, controller.signal);
      if (result.ok) {
        return null; // 续跑成功，不需要 legacy
      }
      deps.reportError('resume_runner_failed', new Error(result.reason));
    } catch (error) {
      deps.reportError('resume_runner_threw', error);
    } finally {
      if (ownsController && !controller.signal.aborted) {
        controller.abort(new DOMException('Resume gate finished.', 'AbortError'));
      }
    }

    return deps.legacyReconcile();
  };
}
