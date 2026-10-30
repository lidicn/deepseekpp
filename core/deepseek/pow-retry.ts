/**
 * PoW 计算的重试（审计 P2-4 / P3-5）。
 *
 * 审计实证：
 *   - 工具流：`createPowHeaders` **3 次** + backoff（`deepseek-stream-fn.ts`）
 *   - 对话流：**1 次**，失败直透用户（`chat-runtime-service.ts` 的 createPowHeaders 调用）
 *   - P3-5：abort 曾被错误分类成"PoW 失败"并重试（应当立刻放弃）
 *
 * 本模块把"何时可以重试"抽成可测函数，并把 sleep/attempts 做成可注入，
 * 便于单测在不碰真实计时器的情况下钉住行为。
 */

export const POW_RETRY_MAX_ATTEMPTS = 3;
export const POW_RETRY_BACKOFF_MS: readonly number[] = [300, 600, 900];

export interface PowRetryDecisionInput {
  /** 刚失败的这一次是第几次（从 1 开始）。 */
  attempt: number;
  maxAttempts?: number;
  /** 上层是否已取消。 */
  aborted: boolean;
  /** 抛出的错误（用来识别 AbortError）。 */
  error?: unknown;
}

export type PowRetryDecision = { retry: false; reason: 'aborted' | 'abort-error' | 'exhausted' } | { retry: true; reason: 'retryable' };

function isAbortLike(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const name = (error as { name?: unknown }).name;
  if (name === 'AbortError' || name === 'TimeoutError') return true;
  const code = (error as { code?: unknown }).code;
  return code === 'ABORT_ERR' || code === 20; // DOMException.ABORT_ERR
}

export function decidePowRetry(input: PowRetryDecisionInput): PowRetryDecision {
  const maxAttempts = input.maxAttempts ?? POW_RETRY_MAX_ATTEMPTS;
  if (input.aborted) return { retry: false, reason: 'aborted' };
  // P3-5：取消不是 PoW 失败，重试只会拖住用户。
  if (isAbortLike(input.error)) return { retry: false, reason: 'abort-error' };
  if (input.attempt >= maxAttempts) return { retry: false, reason: 'exhausted' };
  return { retry: true, reason: 'retryable' };
}

export interface WithPowRetryOptions {
  signal?: AbortSignal;
  maxAttempts?: number;
  backoffMs?: readonly number[];
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** 每次决定重试时回调（用于诊断）。 */
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
}

export function defaultPowRetrySleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });
}

/**
 * 跑 `run`，失败时按 `decidePowRetry` 决定是否重试。
 * 用尽后抛出**最后一次**的错误（保留原始信息，便于上层分类）。
 */
export async function withPowRetry<T>(run: () => Promise<T>, options: WithPowRetryOptions = {}): Promise<T> {
  const maxAttempts = options.maxAttempts ?? POW_RETRY_MAX_ATTEMPTS;
  const backoff = options.backoffMs ?? POW_RETRY_BACKOFF_MS;
  const sleep = options.sleep ?? defaultPowRetrySleep;

  let lastError: unknown = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      lastError = error;
      const decision = decidePowRetry({
        attempt,
        maxAttempts,
        aborted: options.signal?.aborted === true,
        error,
      });
      if (!decision.retry) throw error;
      const delayMs = backoff[attempt - 1] ?? backoff[backoff.length - 1] ?? 900;
      options.onRetry?.({ attempt, delayMs, error });
      await sleep(delayMs, options.signal);
    }
  }
  throw lastError ?? new Error('pow retry exhausted');
}
