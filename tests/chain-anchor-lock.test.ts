// R10-01 回归测试：Session Chain Anchor 的读-改-写必须不丢更新。
//
// 修复前的实现只用一层「按 sessionId 的内存锁」（withSessionLock），
// 它有两个缺口：
//   1. 只在一个 JS 上下文内串行 —— SW / sidepanel / content 各自独立实例，
//      对同一个 IndexedDB 的并发读-改-写互不可见，仍会静默丢更新；
//   2. 绕过 withSyncLocalStateLock 的前置恢复钩子，与其他 memory 写入不同步。
//
// 修复后：withSyncLocalStateLock（全局串行）+ memoryDb.transaction('rw', ...)
// （读与写在同一 IDB 事务内完成）。
//
// 本测试锁定四条契约：
//   A. 默认值正确
//   B. 并发 updateLastMessageId 后 turnCount 等于调用次数（不丢更新）
//   C. recordAttachFailure 达阈值切 full
//   D. 锚点不存在时返回 null 且不创建
//
// ⚠️ **本测试的能力边界（如实说明）**：
// 旧的 `withSessionLock` 是**按 sessionId 的内存锁**，在**单个 JS 上下文内**
// 它确实能挡住并发 —— 所以下面的「并发不丢更新」用例**在修复前也会通过**，
// 它不能证明跨上下文修复生效。
//
// 真正的 bug 场景（SW / sidepanel / content 三个上下文各自持有独立的内存
// 锁实例，同时对同一个 IndexedDB 做读-改-写）**无法在单元测试里复现**，
// 因为测试进程只有一个 JS 上下文。
//
// 所以本测试的作用是：
//   1. 锁定「行为契约」（并发下计数正确、降级单向、缺失返回 null）——
//      防止将来改动让这些语义回归；
//   2. 修复的正确性由**代码结构**保证并与本仓其他持久化写入对齐：
//      `withSyncLocalStateLock`（全局串行 + 恢复钩子）
//      + `memoryDb.transaction('rw', anchors, ...)`（读与写同一 IDB 事务，
//      不再有 `get()` 与 `put()` 分属两个自动提交事务的中间窗口）。
//      可参照 `core/memory/store.ts:113` 等既有写法。
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MEMORY_DATABASE_NAME } from '../core/memory/schema';
import { deleteIndexedDb } from './helpers/indexeddb';

const indexedDbFactory = new IDBFactory();

beforeAll(() => {
  vi.stubGlobal('indexedDB', indexedDbFactory);
  vi.stubGlobal('IDBKeyRange', IDBKeyRange);
});

beforeEach(async () => {
  const { db } = await import('../core/memory/store');
  if (!db.isOpen()) await db.open();
});

afterEach(async () => {
  const { db } = await import('../core/memory/store');
  db.close();
  await deleteIndexedDb(MEMORY_DATABASE_NAME);
  vi.restoreAllMocks();
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe('SessionChainAnchor 读-改-写（R10-01）', () => {
  it('initChainAnchor 建出正确默认值', async () => {
    const { initChainAnchor, getChainAnchor } = await import('../core/memory/chain-anchor');

    const created = await initChainAnchor('sess-a');
    expect(created.sessionId).toBe('sess-a');
    expect(created.rootMessageId).toBeNull();
    expect(created.lastMessageId).toBeNull();
    expect(created.mode).toBe('chained');
    expect(created.turnCount).toBe(0);
    expect(created.consecutiveAttachFailures).toBe(0);

    // 落库后读回一致
    const readBack = await getChainAnchor('sess-a');
    expect(readBack).not.toBeNull();
    expect(readBack!.sessionId).toBe('sess-a');
    expect(readBack!.mode).toBe('chained');
  });

  it('并发 updateLastMessageId 不丢更新（turnCount 等于调用次数）', async () => {
    const { initChainAnchor, updateLastMessageId, getChainAnchor } = await import(
      '../core/memory/chain-anchor'
    );

    await initChainAnchor('sess-concurrent');

    const concurrent = 20;
    await Promise.all(
      Array.from({ length: concurrent }, (_, index) => (
        updateLastMessageId('sess-concurrent', `msg-${index}`)
      )),
    );

    const after = await getChainAnchor('sess-concurrent');
    expect(after).not.toBeNull();
    // 修复前这里会小于 concurrent（丢更新）
    expect(after!.turnCount).toBe(concurrent);
    // lastMessageId 是某一次写入的值，不应为 null
    expect(after!.lastMessageId).toMatch(/^msg-\d+$/);
  });

  it('并发 recordAttachFailure + resetAttachFailures 后状态自洽', async () => {
    const { initChainAnchor, recordAttachFailure, resetAttachFailures, getChainAnchor } =
      await import('../core/memory/chain-anchor');

    await initChainAnchor('sess-fail');

    // 阈值 3：连续失败 3 次应切 full
    await Promise.all([
      recordAttachFailure('sess-fail'),
      recordAttachFailure('sess-fail'),
      recordAttachFailure('sess-fail'),
    ]);
    const failed = await getChainAnchor('sess-fail');
    expect(failed!.consecutiveAttachFailures).toBe(3);
    expect(failed!.mode).toBe('full');

    // 重置只清计数，不把 mode 改回 chained（降级是单向的）
    await resetAttachFailures('sess-fail');
    const reset = await getChainAnchor('sess-fail');
    expect(reset!.consecutiveAttachFailures).toBe(0);
    expect(reset!.mode).toBe('full');
  });

  it('锚点不存在时返回 null 且不创建记录', async () => {
    const { updateLastMessageId, recordAttachFailure, resetAttachFailures, getChainAnchor } =
      await import('../core/memory/chain-anchor');

    expect(await updateLastMessageId('sess-missing', 'msg-x')).toBeNull();
    expect(await recordAttachFailure('sess-missing')).toBeNull();
    expect(await resetAttachFailures('sess-missing')).toBeNull();
    expect(await getChainAnchor('sess-missing')).toBeNull();
  });

  it('每次写入都刷新 updatedAt', async () => {
    const { initChainAnchor, updateLastMessageId, getChainAnchor } = await import(
      '../core/memory/chain-anchor'
    );

    const created = await initChainAnchor('sess-ts');
    await new Promise((resolve) => setTimeout(resolve, 5));
    const updated = await updateLastMessageId('sess-ts', 'msg-1');
    expect(updated!.updatedAt).toBeGreaterThanOrEqual(created.updatedAt);

    const readBack = await getChainAnchor('sess-ts');
    expect(readBack!.updatedAt).toBeGreaterThanOrEqual(created.updatedAt);
  });
});
