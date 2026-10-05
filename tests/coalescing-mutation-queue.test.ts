import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BurstSupersededError,
  createCoalescingMutationQueue,
} from '../core/persistence/coalescing-mutation-queue';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('coalescing mutation queue', () => {
  it('flushes adjacent mutations once and resolves results in FIFO order', async () => {
    const flush = vi.fn(async (inputs: readonly number[]) => inputs.map((input) => input * 10));
    const queue = createCoalescingMutationQueue(flush);

    await expect(Promise.all([
      queue.mutate(1),
      queue.mutate(2),
      queue.mutate(3),
    ])).resolves.toEqual([10, 20, 30]);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledWith([1, 2, 3]);
  });

  it('seals an open batch at a read or clear barrier', async () => {
    const events: string[] = [];
    const queue = createCoalescingMutationQueue<number, number>(async (inputs) => {
      events.push(`flush:${inputs.join(',')}`);
      return inputs;
    });

    const first = queue.mutate(1);
    const second = queue.mutate(2);
    const barrier = queue.barrier(async () => {
      events.push('barrier');
      return 'observed';
    });
    const third = queue.mutate(3);

    await expect(Promise.all([first, second, barrier, third]))
      .resolves.toEqual([1, 2, 'observed', 3]);
    expect(events).toEqual(['flush:1,2', 'barrier', 'flush:3']);
  });

  it('starts a new batch for mutations that arrive after a physical flush begins', async () => {
    let releaseFirstFlush!: () => void;
    const firstFlushGate = new Promise<void>((resolve) => {
      releaseFirstFlush = resolve;
    });
    let markFirstFlushStarted!: () => void;
    const firstFlushStarted = new Promise<void>((resolve) => {
      markFirstFlushStarted = resolve;
    });
    const flush = vi.fn(async (inputs: readonly number[]) => {
      if (inputs[0] === 1) {
        markFirstFlushStarted();
        await firstFlushGate;
      }
      return inputs;
    });
    const queue = createCoalescingMutationQueue(flush);

    const first = queue.mutate(1);
    await firstFlushStarted;
    const second = queue.mutate(2);
    releaseFirstFlush();

    await expect(Promise.all([first, second])).resolves.toEqual([1, 2]);
    expect(flush.mock.calls.map(([inputs]) => inputs)).toEqual([[1], [2]]);
  });

  it('rejects every member of a failed batch and accepts later work', async () => {
    const failure = new Error('physical write failed');
    const flush = vi.fn()
      .mockRejectedValueOnce(failure)
      .mockImplementation(async (inputs: readonly number[]) => inputs);
    const queue = createCoalescingMutationQueue<number, number>(flush);

    const failed = await Promise.allSettled([queue.mutate(1), queue.mutate(2)]);
    expect(failed).toEqual([
      { status: 'rejected', reason: failure },
      { status: 'rejected', reason: failure },
    ]);
    await expect(queue.mutate(3)).resolves.toBe(3);
    expect(flush).toHaveBeenCalledTimes(2);
  });

  it('rejects a length-mismatched flush result instead of fabricating empty outputs', async () => {
    const flush = vi.fn(async (inputs: readonly number[]) => inputs.slice(0, 1));
    const queue = createCoalescingMutationQueue<number, number>(flush);

    const settled = await Promise.allSettled([queue.mutate(1), queue.mutate(2)]);
    expect(settled.map((outcome) => outcome.status)).toEqual(['rejected', 'rejected']);
    const reason = (settled[0] as PromiseRejectedResult).reason as Error;
    expect(reason).toBeInstanceOf(Error);
    expect(reason).not.toBeInstanceOf(BurstSupersededError);
    expect(reason.message).toContain('1 outputs for 2 pending mutations');
    await expect(queue.mutate(3)).resolves.toBe(3);
  });

  it('surfaces a superseded burst as a typed burst_superseded rejection for every member', async () => {
    const flush = vi.fn(async (inputs: readonly number[]) => {
      throw new BurstSupersededError('burst superseded by clear');
    });
    const queue = createCoalescingMutationQueue<number, number>(flush);

    const settled = await Promise.allSettled([queue.mutate(1), queue.mutate(2)]);
    expect(settled.map((outcome) => outcome.status)).toEqual(['rejected', 'rejected']);
    const reason = (settled[0] as PromiseRejectedResult).reason as BurstSupersededError;
    expect(reason).toBeInstanceOf(BurstSupersededError);
    expect(reason.code).toBe('burst_superseded');
  });

  it('drops a superseded tool-history burst with a typed rejection and never resurrects the cleared key', async () => {
    vi.stubGlobal('crypto', { randomUUID: () => '00000000-0000-4000-8000-000000000001' });
    const values = new Map<string, unknown>();
    values.set('deepseek_pp_tool_history', []);
    let getCalls = 0;
    let writeBackPerformed = false;
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          QUOTA_BYTES: 10_485_760,
          get: vi.fn(async (key: string) => {
            getCalls += 1;
            // The third get is the flusher's post-read clear check: a clear ran
            // after the burst read, so the key is gone before write-back.
            if (getCalls === 3) values.delete(key);
            return values.has(key) ? { [key]: values.get(key) } : {};
          }),
          set: vi.fn(async (next: Record<string, unknown>) => {
            writeBackPerformed = true;
            for (const [key, value] of Object.entries(next)) values.set(key, value);
          }),
          remove: vi.fn(async (key: string) => {
            values.delete(key);
          }),
        },
      },
    });

    const { BurstSupersededError: LiveBurstSupersededError } = await import('../core/persistence/coalescing-mutation-queue');
    const history = await import('../core/tool/history');
    await expect(history.appendToolCallHistory(
      { name: 'tool_race', payload: {}, raw: '<tool_race/>' },
      { ok: true, summary: 's', detail: 'd' },
      'manual_chat',
    )).rejects.toBeInstanceOf(LiveBurstSupersededError);
    expect(writeBackPerformed).toBe(false);
    expect(values.has('deepseek_pp_tool_history')).toBe(false);
    values.clear();
  });
});
