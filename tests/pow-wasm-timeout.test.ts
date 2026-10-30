/**
 * PoW WASM 冷加载超时守卫（审计 P2-3）。
 *
 * 审计实证：`pow.ts` 的原生 fetch **完全没有超时**，实测挂起 28s 仍未结束。
 * 这里用 fake timers 把"永不 resolve 的 fetch"钉住：
 *
 * 变异（可判红）：
 *   - 去掉 race/timeoutGuard ⇒ 用例 1 会一直挂住（超时失败）
 *   - 把超时设成 Infinity ⇒ 同上
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  POW_WASM_LOAD_TIMEOUT_MS,
  solvePowChallengeLocally,
  type PowChallenge,
} from '../core/deepseek/pow';

function challenge(): PowChallenge {
  return {
    algorithm: 'DeepSeekHashV1',
    challenge: 'a'.repeat(64),
    salt: 'salt',
    difficulty: 1,
    signature: 'sig',
    expireAt: Date.now() + 60_000,
  };
}

describe('PoW WASM 冷加载超时', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('★★ fetch 永不 resolve ⇒ 到达上限必须失败（不能永久挂起）', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<never>(() => {})));

    const pending = solvePowChallengeLocally(challenge(), 'wasm-url', new AbortController().signal);
    const assertion = expect(pending).rejects.toThrow(/pow_wasm_load_timeout|timed out/i);

    await vi.advanceTimersByTimeAsync(POW_WASM_LOAD_TIMEOUT_MS + 10);
    await assertion;
  });

  it('负控：fetch 返回 not ok ⇒ 立刻报错，不必等到超时', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 404, statusText: 'Not Found' })),
    );

    await expect(
      solvePowChallengeLocally(challenge(), 'wasm-url', new AbortController().signal),
    ).rejects.toThrow(/Failed to load DeepSeek PoW WASM: 404/);
  });

  it('负控：已取消的 signal ⇒ 立刻抛 AbortError（不进入加载）', async () => {
    const controller = new AbortController();
    controller.abort(new DOMException('stop', 'AbortError'));
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await expect(
      solvePowChallengeLocally(challenge(), 'wasm-url', controller.signal),
    ).rejects.toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('上限值必须有限且合理（防止被改成 Infinity）', () => {
    expect(Number.isFinite(POW_WASM_LOAD_TIMEOUT_MS)).toBe(true);
    expect(POW_WASM_LOAD_TIMEOUT_MS).toBeGreaterThan(1_000);
    expect(POW_WASM_LOAD_TIMEOUT_MS).toBeLessThanOrEqual(60_000);
  });
});
