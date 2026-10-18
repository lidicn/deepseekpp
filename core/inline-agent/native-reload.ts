/**
 * P0-1: 惰性原生历史刷新状态机（纯逻辑，IO 经 deps 注入，便于单测）。
 *
 * 旧实现（#38 无感刷新）在页面可见时挂 visibilitychange + 30s 兜底硬刷新，
 * 会打断用户阅读/输入。新方案：任务完成后只写一个 pending 标记；页面可见时
 * 绝不主动刷新，把刷新推迟到「下一次用户发消息前」或「页面切到后台立即消费」。
 *
 * - requestNativeHistoryReload：写 pending 标记；若此刻已在后台则立即 consume。
 * - consumeNativeHistoryReload：清标记并执行 reload；无标记时返回 false。
 * - hasPendingNativeReload：发消息入口最前判定是否有待刷新。
 */

export const PENDING_NATIVE_RELOAD_KEY = "dpp:pending-native-reload";

export interface NativeReloadDeps {
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  isHidden: () => boolean;
  reload: () => void;
}

/** 写 pending 标记；页面已在后台则立即消费刷新（用户看不到）。可见时只登记、不刷新。 */
export function requestNativeHistoryReload(
  deps: NativeReloadDeps,
  meta: Record<string, unknown> = {},
): void {
  try {
    deps.storage.setItem(
      PENDING_NATIVE_RELOAD_KEY,
      JSON.stringify({ requestedAt: Date.now(), ...meta }),
    );
  } catch {
    // sessionStorage 不可用时退化为不刷新，仍优于误刷新。
  }
  if (deps.isHidden()) consumeNativeHistoryReload(deps);
}

/** 消费 pending 标记并刷新；无待刷新则返回 false（不 reload）。 */
export function consumeNativeHistoryReload(deps: NativeReloadDeps): boolean {
  try {
    if (!deps.storage.getItem(PENDING_NATIVE_RELOAD_KEY)) return false;
    deps.storage.removeItem(PENDING_NATIVE_RELOAD_KEY);
  } catch {
    return false;
  }
  deps.reload();
  return true;
}

/** 发消息入口最前判定：是否存在待消费的原生历史刷新。 */
export function hasPendingNativeReload(
  storage: Pick<Storage, "getItem">,
): boolean {
  try {
    return Boolean(storage.getItem(PENDING_NATIVE_RELOAD_KEY));
  } catch {
    return false;
  }
}
