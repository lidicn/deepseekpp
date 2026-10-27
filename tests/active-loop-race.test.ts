/**
 * 审计 #5：appendToolExecution / setCurrentTool / clearCurrentTool / updateMarker
 * 的 read-modify-write 串行化。用可手动 resolve 的假 chrome.storage.session 制造交错。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  appendToolExecution,
  clearCurrentTool,
  markChatLoopFinished,
  markChatLoopStarted,
  setCurrentTool,
  updateMarker,
} from '../core/chat/active-loop';

const KEY = 'deepseek_pp_active_chat_loop';

function makeFakeSession() {
  let store: Record<string, unknown> = {};
  // 控制 get 的 resolve 时机，制造交错窗口
  let getGate: Promise<void> | null = null;
  // 控制 set 的 resolve 时机（用于构造竞争场景）
  let setGate: Promise<void> | null = null;
  // setGate 只挂前 N 次 set 调用，之后的 set 立即执行
  let setGateCount = 0;
  return {
    get: vi.fn(async (_k: string) => {
      if (getGate) await getGate;
      return structuredClone(store);
    }),
    set: vi.fn(async (v: Record<string, unknown>) => {
      if (setGate && setGateCount > 0) {
        setGateCount--;
        await setGate;
      }
      store = { ...store, ...v };
    }),
    remove: vi.fn(async (_k: string) => { delete store[_k as string]; }),
    setGate: (p: Promise<void> | null) => { getGate = p; },
    // setCount: 挂住接下来 N 次 set 调用
    setSetGate: (p: Promise<void> | null, count = 1) => { setGate = p; setGateCount = p ? count : 0; },
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

  // 审计 #5：markChatLoopFinished 虽非 R-M-W（是 remove），但和 R-M-W 函数并发
  // 会导致 R-M-W 在 remove 之后 set 回去，留孤儿 marker。也纳进链。

  it('markChatLoopFinished 与 appendToolExecution 交错 ⇒ 不留孤儿 marker', async () => {
    const s = makeFakeSession();
    vi.stubGlobal('chrome', {
      storage: { session: { get: s.get, set: s.set, remove: s.remove } },
      alarms: { onAlarm: { addListener: vi.fn() } },
    });
    await markChatLoopStarted('web');
    await appendToolExecution({ name: 'existing' } as never);

    // 关键竞争：让 append 的 set（read 拿到快照后 push 再 set）被挂住，
    // 期间 markChatLoopFinished 的 remove 先执行。
    // 不纳链时：remove 删了 key，但 append 的 set 在之后写入快照 → 留孤儿 marker
    // 纳链时：remove 排在 append 的 set 之后 → 最终 key 被删干净
    let releaseSet!: () => void;
    const setGate = new Promise<void>((r) => { releaseSet = r; });
    s.setSetGate(setGate);
    // 发起 append —— readMarker 正常拿到快照（get 不挂），但 set 被 setGate 挂住
    const p1 = appendToolExecution({ name: 'orphan?' } as never);
    // 立即发起 markChatLoopFinished → remove 先执行（不挂）
    const p2 = markChatLoopFinished();
    await Promise.resolve(); // 让出微任务，确保 remove 已执行
    // 此时如果不纳链：store[KEY] 应已被 remove 删除
    // 放行 setGate → append 的 set 执行
    releaseSet();
    s.setSetGate(null);
    await Promise.all([p1, p2]);
    // 纳链后：remove 排在 set 之后 → 最终 store[KEY] 被删干净
    // 不纳链时：set 在 remove 之后写回 → store[KEY] 存在（孤儿）
    expect(s.getData()[KEY]).toBeUndefined();
  });
});
