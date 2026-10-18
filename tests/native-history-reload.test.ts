import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  consumeNativeHistoryReload,
  hasPendingNativeReload,
  PENDING_NATIVE_RELOAD_KEY,
  requestNativeHistoryReload,
  type NativeReloadDeps,
} from '../core/inline-agent/native-reload';

// P0-1：可见时只写 pending、120s 内绝不硬刷新；切后台立即消费刷新；
// 发消息入口可判定/消费 pending 标记。
function makeDeps(hidden: boolean) {
  const store = new Map<string, string>();
  const reload = vi.fn();
  const deps: NativeReloadDeps = {
    storage: {
      getItem: (k) => (store.has(k) ? store.get(k)! : null),
      setItem: (k, v) => void store.set(k, v),
      removeItem: (k) => void store.delete(k),
    },
    isHidden: () => hidden,
    reload,
  };
  return { deps, reload, store };
}

describe('native-reload（P0-1 惰性刷新）', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('页面可见：request 后只写 pending 标记，快进 120s 也不刷新', () => {
    const { deps, reload, store } = makeDeps(false);

    requestNativeHistoryReload(deps, { scrollTop: 120, composer: 'draft' });

    expect(store.has(PENDING_NATIVE_RELOAD_KEY)).toBe(true);
    expect(hasPendingNativeReload(deps.storage)).toBe(true);
    expect(reload).not.toHaveBeenCalled();

    vi.advanceTimersByTime(120_000);
    expect(reload).not.toHaveBeenCalled();
  });

  it('页面已在后台：request 立即消费并刷新一次，pending 标记被清', () => {
    const { deps, reload, store } = makeDeps(true);

    requestNativeHistoryReload(deps);

    expect(reload).toHaveBeenCalledTimes(1);
    expect(store.has(PENDING_NATIVE_RELOAD_KEY)).toBe(false);
    expect(hasPendingNativeReload(deps.storage)).toBe(false);
  });

  it('consume：无标记返回 false 不刷新；有标记返回 true、刷新并清标记', () => {
    const { deps, reload, store } = makeDeps(false);

    expect(consumeNativeHistoryReload(deps)).toBe(false);
    expect(reload).not.toHaveBeenCalled();

    store.set(PENDING_NATIVE_RELOAD_KEY, JSON.stringify({ requestedAt: 1 }));
    expect(consumeNativeHistoryReload(deps)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(store.has(PENDING_NATIVE_RELOAD_KEY)).toBe(false);
  });
});
