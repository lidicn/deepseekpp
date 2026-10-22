// 2026-10-22 真机定位回归：content script 的诊断写入是无锁 read-modify-write，
// 并发时互相吞条。
//
// 实证：两阶段锚点等待上线后，探针能证明延长窗跑了
// （anchor_find_probe 里 waitMs 从 15000 变成 120000），但配套的
// anchor_extended_wait 条目从未落盘 —— 被并发的 anchor_find_probe 覆盖了。
//
// 本测试用「模拟 storage + 并发 append」复现丢条，再验证串行队列能保住全部。
import { describe, expect, it } from 'vitest';
import { createSerializedQueue } from '../core/persistence/serialized-queue';

interface Entry { id: number; message: string }

function createFakeStorage(initial: Entry[] = []) {
  let value = initial;
  // 人为放大读-改-写间隙，确保不加锁时必然丢条
  const tick = () => new Promise<void>((r) => setTimeout(r, 1));
  return {
    async read(): Promise<Entry[]> {
      await tick();
      return value;
    },
    async write(next: Entry[]): Promise<void> {
      await tick();
      value = next;
    },
    snapshot(): Entry[] { return value; },
  };
}

describe('createSerializedQueue', () => {
  it('不加串行化时并发 append 会丢条（复现原 bug）', async () => {
    const storage = createFakeStorage();
    const append = async (id: number) => {
      const prev = await storage.read();
      await storage.write([...prev, { id, message: `m${id}` }]);
    };

    await Promise.all([1, 2, 3, 4, 5].map(append));

    // 竞态下只有最后写的那条幸存（远少于 5 条）
    expect(storage.snapshot().length).toBeLessThan(5);
  });

  it('串行队列保证并发 append 全部落盘且保序', async () => {
    const storage = createFakeStorage();
    const queue = createSerializedQueue();
    const append = (id: number) => queue(async () => {
      const prev = await storage.read();
      await storage.write([...prev, { id, message: `m${id}` }]);
    });

    await Promise.all([1, 2, 3, 4, 5].map(append));

    const result = storage.snapshot();
    expect(result).toHaveLength(5);
    expect(result.map((e) => e.id)).toEqual([1, 2, 3, 4, 5]);
  });

  it('单个任务抛错不会卡死队列', async () => {
    const queue = createSerializedQueue();
    const order: string[] = [];

    const results = await Promise.all([
      queue(async () => { order.push('a'); return 'a'; }),
      queue(async () => { order.push('b'); throw new Error('boom'); }),
      queue(async () => { order.push('c'); return 'c'; }),
    ]);

    // 3 个都跑到了
    expect(order).toEqual(['a', 'b', 'c']);
    // 失败的那个返回 undefined，其余拿到返回值
    expect(results[0]).toBe('a');
    expect(results[1]).toBeUndefined();
    expect(results[2]).toBe('c');
  });

  it('任务严格串行：后一个在前一个 settle 之后才开始', async () => {
    const queue = createSerializedQueue();
    const events: string[] = [];

    const first = queue(async () => {
      events.push('first:start');
      await new Promise((r) => setTimeout(r, 20));
      events.push('first:end');
    });
    const second = queue(async () => {
      events.push('second:start');
    });

    await Promise.all([first, second]);
    expect(events).toEqual(['first:start', 'first:end', 'second:start']);
  });
});
