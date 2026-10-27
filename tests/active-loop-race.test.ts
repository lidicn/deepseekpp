/**
 * 审计 #5：appendToolExecution / setCurrentTool / clearCurrentTool / updateMarker
 * 的 read-modify-write 串行化。用可手动 resolve 的假 chrome.storage.session 制造交错。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  appendToolExecution,
  clearCurrentTool,
  markChatLoopStarted,
  setCurrentTool,
  updateMarker,
} from '../core/chat/active-loop';

const KEY = 'deepseek_pp_active_chat_loop';

function makeFakeSession() {
  let store: Record<string, unknown> = {};
  // 控制 get 的 resolve 时机，制造交错窗口
  let getGate: Promise<void> | null = null;
  return {
    get: vi.fn(async (_k: string) => {
      if (getGate) await getGate;
      return store;
    }),
    set: vi.fn(async (v: Record<string, unknown>) => { store = { ...store, ...v }; }),
    remove: vi.fn(async (_k: string) => { delete store[_k as string]; }),
    setGate: (p: Promise<void> | null) => { getGate = p; },
    getData: () => store,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('active-loop R-M-W 串行化', () => {
  it('交错 appendToolExecution + setCurrentTool 不丢修改', async () => {
    const s = makeFakeSession();
    vi.stubGlobal('chrome', {
      storage: { session: { get: s.get, set: s.set, remove: s.remove } },
      alarms: { onAlarm: { addListener: vi.fn() } },
    });
    await markChatLoopStarted('web');
    // gate 第一次 get 挂起，期间发起第二个写
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    s.setGate(gate);
    const p1 = appendToolExecution({ name: 't1' } as never);
    // 让 p1 的 readMarker 挂在 gate 上；此时发起 p2
    const p2 = setCurrentTool('search');
    // 放行
    release();
    s.setGate(null);
    await Promise.all([p1, p2]);
    const final = s.getData()[KEY] as { executions: unknown[]; currentTool: unknown };
    expect(final.executions).toHaveLength(1);
    expect(final.currentTool).toEqual({ name: 'search', startedAt: expect.any(Number) });
  });

  it('交错 updateMarker + appendToolExecution 不丢', async () => {
    const s = makeFakeSession();
    vi.stubGlobal('chrome', {
      storage: { session: { get: s.get, set: s.set, remove: s.remove } },
      alarms: { onAlarm: { addListener: vi.fn() } },
    });
    await markChatLoopStarted('web');
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    s.setGate(gate);
    const p1 = updateMarker({ jobState: 'running' });
    const p2 = appendToolExecution({ name: 't2' } as never);
    release();
    s.setGate(null);
    await Promise.all([p1, p2]);
    const final = s.getData()[KEY] as { executions: unknown[]; jobState: string };
    expect(final.executions).toHaveLength(1);
    expect(final.jobState).toBe('running');
  });
});
