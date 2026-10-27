/**
 * 带超时的 reconcile 等待。
 *
 * 2026-10-22：原实现是 `await reconcileInterruptedOnWake()`，没有超时。
 * reconcile 内部会等 storage / 网络，一旦挂住（残留 marker、storage 异常、
 * 原生宿主无响应），background 侧那个**模块级共享**的 wakeReconcileOperation
 * promise 就永远不 settle；之后每次 submitPrompt 都复用同一个挂起的 promise，
 * 于是整个侧边栏对话永久不可用，UI 只显示「...」且零诊断。
 *
 * 真机复现过：写入一个残留的 active-loop marker 后即触发此状，
 * 只能清 storage + 重载扩展才恢复。
 *
 * 语义：
 * - reconcile 正常结束 → 立即返回，不引入额外延迟。
 * - reconcile 挂住 → 到上限后放行，**不抛错**（reconcile 是尽力而为的恢复
 *   动作，失败不该堵死用户发言），并回调 onTimeout 让调用方记一条诊断。
 * - reconcile 自己抛错 → 原样抛出，由调用方按原有路径处理。
 */
export interface WaitForWakeReconcileOptions {
  readonly reconcile: () => Promise<void>;
  readonly timeoutMs: number;
  readonly scheduleTimeout: (callback: () => void, delayMs: number) => unknown;
  readonly clearScheduledTimeout: (timer: unknown) => void;
  readonly onTimeout?: () => void;
}

export async function waitForWakeReconcile(
  options: WaitForWakeReconcileOptions,
): Promise<void> {
  if (options.timeoutMs <= 0) {
    await options.reconcile();
    return;
  }

  let timer: unknown = null;
  let settled = false;
  let timeoutWon = false;
  let reconcilePromise: Promise<void> | null = null;
  try {
    await Promise.race([
      (reconcilePromise = options.reconcile()),
      new Promise<void>((resolve) => {
        timer = options.scheduleTimeout(() => {
          if (settled) return;
          settled = true;
          timeoutWon = true;
          options.onTimeout?.();
          resolve();
        }, options.timeoutMs);
      }),
    ]);
  } finally {
    settled = true;
    if (timer !== null) options.clearScheduledTimeout(timer);
    // #32: 超时胜出后，后台 reconcile 可能还在跑并最终 reject —— 吞掉它的 rejection
    // 避免 unhandled promise rejection。reconcile 自己先 reject 的情况由 Promise.race
    // 直接向上抛出（符合"失败不堵死用户发言"的语义），不走到这里。
    if (timeoutWon && reconcilePromise) {
      reconcilePromise.catch(() => undefined);
    }
  }
}
