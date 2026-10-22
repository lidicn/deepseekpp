// 2026-10-22 真机定位回归：工具执行块只按条数限 100、不按字节，
// 实测撑到 2797 KB。每次 upsert 都是「读全部 → 写全部」，即每次工具执行
// 做一次 ~2.8 MB 的 JSON 往返。真机上连续 3 次工具调用后渲染进程崩溃，
// Chrome 提示「页面崩溃可能与浏览器插件对页面内容的修改有关」。
//
// 本测试锁定契约：
//  1. 超过字节预算时丢弃最旧的块
//  2. 最新那块永远保留（trace-store 曾把裁剪方向写反，丢的是最新）
//  3. 预算内不裁剪
import { describe, expect, it } from 'vitest';
import {
  TOOL_EXECUTION_BLOCK_LIMIT,
  createToolExecutionBlockStore,
} from '../core/tool/execution-block-store';
import type { PersistedToolExecutionBlock } from '../core/tool/execution-block-codec';
import type { StorageSlotPort } from '../core/persistence/versioned-repository';

function buildBlock(id: string, createdAt: number, payloadBytes: number): PersistedToolExecutionBlock {
  return {
    id,
    source: 'storage',
    url: 'https://chat.deepseek.com/a/chat/s/test',
    createdAt,
    // 每块塞入指定大小的内容，用来撑爆字节预算
    content: 'x'.repeat(payloadBytes),
  } as PersistedToolExecutionBlock;
}

function createMemorySlot(): StorageSlotPort & { snapshot(): unknown } {
  let value: unknown = undefined;
  return {
    async read() {
      return value === undefined ? { present: false } : { present: true, value };
    },
    async write(next) { value = next; },
    async remove() { value = undefined; },
    snapshot() { return value; },
  };
}

describe('工具执行块的字节预算', () => {
  it('超过预算时丢弃最旧的块，并始终保留最新那块', async () => {
    const slot = createMemorySlot();
    const store = createToolExecutionBlockStore(slot);

    const now = Date.now();
    // 每块 300 KB：4 块 = 1.2 MB，预算 2.5 MB 内 → 全留
    for (let i = 0; i < 4; i += 1) {
      await store.upsert(buildBlock(`b${i}`, now + i, 300 * 1024), now + i);
    }
    let blocks = (slot.snapshot() as PersistedToolExecutionBlock[]);
    expect(blocks.map((b) => b.id)).toEqual(['b0', 'b1', 'b2', 'b3']);

    // 再加 6 块，共 10 块 × 300KB = 3 MB > 2.5 MB 预算 → 必须裁剪
    for (let i = 4; i < 10; i += 1) {
      await store.upsert(buildBlock(`b${i}`, now + i, 300 * 1024), now + i);
    }
    blocks = (slot.snapshot() as PersistedToolExecutionBlock[]);
    const serialized = JSON.stringify(blocks);
    const size = new Blob([serialized]).size;

    // 1) 落在预算内
    expect(size).toBeLessThanOrEqual(2_621_440); // 10MB * 0.25
    // 2) 最新的 b9 一定还在（裁剪方向不能反）
    expect(blocks[blocks.length - 1].id).toBe('b9');
    // 3) 确实裁掉了最旧的
    expect(blocks.length).toBeLessThan(10);
    expect(blocks.some((b) => b.id === 'b0')).toBe(false);
  }, 60_000);

  it('预算内不裁剪', async () => {
    const slot = createMemorySlot();
    const store = createToolExecutionBlockStore(slot);
    const now = Date.now();
    for (let i = 0; i < 3; i += 1) {
      await store.upsert(buildBlock(`s${i}`, now + i, 1024), now + i);
    }
    const blocks = (slot.snapshot() as PersistedToolExecutionBlock[]);
    expect(blocks.map((b) => b.id)).toEqual(['s0', 's1', 's2']);
  }, 30_000);

  it('条数上限仍然生效（不超过 100）', async () => {
    const slot = createMemorySlot();
    const store = createToolExecutionBlockStore(slot);
    const now = Date.now();
    for (let i = 0; i < TOOL_EXECUTION_BLOCK_LIMIT + 5; i += 1) {
      await store.upsert(buildBlock(`n${i}`, now + i, 16), now + i);
    }
    const blocks = (slot.snapshot() as PersistedToolExecutionBlock[]);
    expect(blocks.length).toBeLessThanOrEqual(TOOL_EXECUTION_BLOCK_LIMIT);
    expect(blocks[blocks.length - 1].id).toBe(`n${TOOL_EXECUTION_BLOCK_LIMIT + 4}`);
  }, 60_000);
});
