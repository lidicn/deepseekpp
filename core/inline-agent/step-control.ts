/**
 * Shared step-level control helpers for the inline agent.
 *
 * Extracted from the original self-built loop (loop.ts) so the DS-web
 * StreamFn adapter (Issue A1) can reuse the exact same timeout/abort and
 * request-throttling semantics without duplicating them. Behavior is
 * byte-identical to the previous private implementations; the original
 * loop is replaced by the pi engine in Issue A3, which consumes this
 * module as well.
 */
import {
  INLINE_AGENT_REQUEST_DELAY_MAX_MS,
  INLINE_AGENT_REQUEST_DELAY_MIN_MS,
  INLINE_AGENT_STEP_TIMEOUT_MS,
} from './types';

export interface StepSignal {
  signal: AbortSignal;
  clear: () => void;
  timedOut: () => boolean;
}

/**
 * Creates an abort signal that fires either when the parent signal aborts or
 * when the step timeout elapses (INLINE_AGENT_STEP_TIMEOUT_MS, currently 300s —
 * not 120s; the earlier comment drifted from the constant). Mirrors the
 * original loop semantics: the timeout reason is a `TimeoutError` DOMException
 * and `timedOut()` reports whether the timeout (not a parent abort) fired.
 */
export function createStepSignal(parentSignal: AbortSignal): StepSignal {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException('Agent step timed out.', 'TimeoutError'));
  }, INLINE_AGENT_STEP_TIMEOUT_MS);
  const onParentAbort = () => controller.abort();
  if (parentSignal.aborted) {
    onParentAbort();
  } else {
    parentSignal.addEventListener('abort', onParentAbort, { once: true });
  }
  const clear = () => {
    clearTimeout(timeout);
    parentSignal.removeEventListener('abort', onParentAbort);
  };
  return { signal: controller.signal, clear, timedOut: () => timedOut };
}

/** Resolves after a random 2.5–6.5s delay, or immediately when aborted. */
export function waitBetweenDeepSeekRequests(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  const delay = randomInt(INLINE_AGENT_REQUEST_DELAY_MIN_MS, INLINE_AGENT_REQUEST_DELAY_MAX_MS);
  return new Promise((resolve) => {
    const timeout = setTimeout(cleanup, delay);
    const onAbort = () => cleanup();

    function cleanup() {
      clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
      resolve();
    }

    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * P1-5（审计 §8.2）：同一步内的节流去重令牌。
 *
 * 审计实证：唤醒续跑路径曾同时经过 `resume-tool-loop` 步内与
 * `chat-runtime-service.submitContinuation` 两道 `waitBetweenDeepSeekRequests`，
 * 每步 5–13s。O1 删掉了重复调用点；本令牌是结构防复发——
 * **同一 stepKey 第二次调用立即返回**，新增调用点不会再叠加真实等待。
 *
 * 失败重试退避（`deepseek-stream-fn.ts`）**不传 stepKey**，保持独立等待语义。
 * abort 语义不变：已发起的等待仍可被 abort 立即放行。
 */
const pacedStepKeys = new Set<string>();

/** 清空全部已节流步标记（每个 agent run / resume run 开始时调用）。 */
export function resetPacedStepKeys(): void {
  pacedStepKeys.clear();
}

/**
 * 带步级去重的节流。stepKey 建议用 `${loopId}:${stepIndex}` 或
 * `${jobId}:${depth}:${step}`——必须在同一 run 内唯一、跨 run 可区分。
 * 省略 stepKey 时行为与裸 `waitBetweenDeepSeekRequests` 完全一致（不记令牌）。
 */
export function waitBetweenDeepSeekRequestsKeyed(
  signal: AbortSignal,
  stepKey?: string,
): Promise<void> {
  if (stepKey !== undefined) {
    if (pacedStepKeys.has(stepKey)) {
      return Promise.resolve();
    }
    pacedStepKeys.add(stepKey);
  }
  return waitBetweenDeepSeekRequests(signal);
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
