import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getActiveChatLoop,
  markChatLoopFinished,
  markChatLoopStarted,
  reconcileInterruptedChatLoop,
} from '../core/chat/active-loop';

const STORAGE_KEY = 'deepseek_pp_active_chat_loop';

function createSessionStorageStub() {
  const storage = new Map<string, unknown>();
  const sessionApi = {
    get: vi.fn(async (key: string) => ({ [key]: storage.get(key) })),
    set: vi.fn(async (value: Record<string, unknown>) => {
      for (const [key, storedValue] of Object.entries(value)) storage.set(key, storedValue);
    }),
    remove: vi.fn(async (key: string) => {
      storage.delete(key);
    }),
  };
  return {
    storage,
    chromeStub: { storage: { session: sessionApi } },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('active chat loop marker', () => {
  it('marks a loop as started and reads it back', async () => {
    const { chromeStub } = createSessionStorageStub();
    vi.stubGlobal('chrome', chromeStub);

    await markChatLoopStarted('web');

    const marker = await getActiveChatLoop();
    expect(marker).toEqual({
      active: true,
      startedAt: expect.any(Number),
      provider: 'web',
      executions: [],
      currentTool: null,
    });
  });

  it('clears the marker when the loop finishes', async () => {
    const { chromeStub } = createSessionStorageStub();
    vi.stubGlobal('chrome', chromeStub);

    await markChatLoopStarted('official-api');
    await markChatLoopFinished();

    expect(await getActiveChatLoop()).toBeNull();
  });

  it('ignores malformed stored markers', async () => {
    const { storage, chromeStub } = createSessionStorageStub();
    vi.stubGlobal('chrome', chromeStub);
    storage.set(STORAGE_KEY, { active: 'yes', startedAt: 'oops' });

    expect(await getActiveChatLoop()).toBeNull();
  });
});

describe('reconcileInterruptedChatLoop', () => {
  it('returns interrupted loop + clears marker — P0-6 fix: no stale threshold', async () => {
    const { storage, chromeStub } = createSessionStorageStub();
    vi.stubGlobal('chrome', chromeStub);
    // Simulate marker from 5s ago (would have been "fresh" under old 60s threshold)
    const startedAt = Date.now() - 5_000;
    storage.set(STORAGE_KEY, { active: true, startedAt, provider: 'web' });

    // P0-6: cold start → marker exists = interrupted (no fresh/stale distinction)
    const result = await reconcileInterruptedChatLoop();

    expect(result).not.toBeNull();
    expect(result!.provider).toBe('web');
    expect(result!.startedAt).toBe(startedAt);
    expect(result!.interruptedAt).toBeGreaterThanOrEqual(startedAt);
    expect(result!.executions).toEqual([]);
    expect(result!.currentTool).toBeNull();
    expect(storage.has(STORAGE_KEY)).toBe(false);  // marker cleared
  });

  it('returns interrupted loop with executions/currentTool populated — P0-3 enhanced marker', async () => {
    const { storage, chromeStub } = createSessionStorageStub();
    vi.stubGlobal('chrome', chromeStub);
    const startedAt = 1_000_000;
    const executions = [{ name: 'shell_exec', provider: 'native', descriptorId: 's1', result: { ok: true, summary: 'ok' } }];
    const currentTool = { name: 'python', startedAt: startedAt + 5000 };
    storage.set(STORAGE_KEY, {
      active: true, startedAt, provider: 'official-api',
      executions, currentTool,
    });

    const result = await reconcileInterruptedChatLoop();

    expect(result).toMatchObject({
      provider: 'official-api',
      startedAt,
      executions,
      currentTool,
    });
    expect(result!.interruptedAt).toBeGreaterThanOrEqual(startedAt);
    expect(storage.has(STORAGE_KEY)).toBe(false);
  });

  it('returns null when no marker exists', async () => {
    const { chromeStub } = createSessionStorageStub();
    vi.stubGlobal('chrome', chromeStub);

    // No marker → no interruption
    expect(await reconcileInterruptedChatLoop()).toBeNull();
  });
});
