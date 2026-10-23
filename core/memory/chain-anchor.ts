/**
 * Session Chain Anchor Store — Phase 1
 *
 * 统一管理会话链锚点（rootMessageId / lastMessageId / mode / consecutiveAttachFailures）。
 * 决定 L2 注入时机、续跑 parent 取值、以及何时降级到 full 模式。
 *
 * 设计参考：doc/设计/memory-system-v2-mimo-design.md §L1 链锚点
 *
 * R10-01 修复（2026-10-23）：三个「读-改-写」函数此前只包了一层**按 sessionId 的
 * 内存锁**（`withSessionLock`）。该锁有两个缺口：
 *   1. 它只在一个 JS 上下文内串行；SW / sidepanel / content 各自持有独立实例，
 *      它们对同一个 IndexedDB 的并发读-改-写**互不可见**，仍会静默丢更新；
 *   2. 它绕过了 `withSyncLocalStateLock` 的前置恢复钩子
 *      （`recoverRequiredLocalStateAlreadyLocked()`），与其他 memory 写入不同步。
 *
 * 现改为与本仓其他持久化写入一致的双重保护：
 *   `withSyncLocalStateLock(() => memoryDb.transaction('rw', anchors, ...))`
 * —— 全局串行队列 + 真实 IDB 读写事务（读与写在同一事务内完成，不再有中间窗口）。
 */

import { memoryDb } from './store';
import { ANCHOR_TABLE_NAME } from './schema';
import { withSyncLocalStateLock } from '../persistence/local-state-lock';

export type ChainMode = 'chained' | 'full';

export interface SessionChainAnchor {
  sessionId: string;
  /** 记忆根消息 id（L2 注入那条），首条用户消息以它为 parent */
  rootMessageId: string | null;
  /** 下一轮请求的 parent_message_id */
  lastMessageId: string | null;
  mode: ChainMode;
  turnCount: number;
  /** 已注入的 digest hash，避免同会话重复注入 */
  injectedDigestHash: string | null;
  lastInjectedAt: number | null;
  /** 连续挂接失败计数，达阈值切 full 模式 */
  consecutiveAttachFailures: number;
  updatedAt: number;
}

const anchors = memoryDb.table(ANCHOR_TABLE_NAME);

/**
 * 在一个读写事务内完成「读 → 可变修改 → 写」，并持有全局本地状态锁。
 *
 * 事务回调内只 await 通过 `tx.table(...)` 取到的 wrapper 操作，
 * 不 await 任何外部 promise —— 否则 IDB 事务会被提前提交
 * （见 `core/persistence/indexeddb.ts` 的 transaction liveness 注释）。
 *
 * @param mutate 就地修改 anchor；返回的新对象由本函数负责补 `updatedAt` 并落库
 * @returns 落库后的 anchor；不存在则返回 null
 */
async function mutateAnchor(
  sessionId: string,
  mutate: (anchor: SessionChainAnchor) => void,
): Promise<SessionChainAnchor | null> {
  return withSyncLocalStateLock(() => memoryDb.transaction('rw', anchors, async (tx) => {
    const table = tx.table(ANCHOR_TABLE_NAME);
    const row = await table.get(sessionId);
    if (!row) return null;

    const anchor = row as unknown as SessionChainAnchor;
    mutate(anchor);
    const next: SessionChainAnchor = { ...anchor, updatedAt: Date.now() };
    await table.put(next);
    return next;
  }));
}

/**
 * 获取会话链锚点；不存在则返回 null。
 */
export async function getChainAnchor(sessionId: string): Promise<SessionChainAnchor | null> {
  const row = await anchors.get(sessionId);
  if (!row) return null;
  return row as unknown as SessionChainAnchor;
}

/**
 * 保存/更新会话链锚点（整体覆盖，非读-改-写）。
 */
export async function saveChainAnchor(anchor: SessionChainAnchor): Promise<void> {
  await withSyncLocalStateLock(() => anchors.put({ ...anchor, updatedAt: Date.now() }));
}

/**
 * 删除会话链锚点（会话结束/切换时调用）。
 */
export async function deleteChainAnchor(sessionId: string): Promise<void> {
  await withSyncLocalStateLock(() => anchors.delete(sessionId));
}

/**
 * 新会话初始化链锚点。
 *
 * 注意：走 `mutateAnchor` 之外的独立路径，因为它需要「不存在时创建」的语义；
 * 仍然经 `withSyncLocalStateLock` 串行，避免与同会话的更新交错。
 * @returns 新建的 anchor
 */
export async function initChainAnchor(sessionId: string): Promise<SessionChainAnchor> {
  const anchor: SessionChainAnchor = {
    sessionId,
    rootMessageId: null,
    lastMessageId: null,
    mode: 'chained',
    turnCount: 0,
    injectedDigestHash: null,
    lastInjectedAt: null,
    consecutiveAttachFailures: 0,
    updatedAt: Date.now(),
  };
  await saveChainAnchor(anchor);
  return anchor;
}

/**
 * 续跑后更新 lastMessageId（每轮 assistant 响应后调用）。
 */
export async function updateLastMessageId(
  sessionId: string,
  lastMessageId: string,
): Promise<SessionChainAnchor | null> {
  return mutateAnchor(sessionId, (anchor) => {
    anchor.lastMessageId = lastMessageId;
    anchor.turnCount += 1;
  });
}

/**
 * 记录挂接失败；连续失败达阈值时切换到 full 模式。
 * @param failThreshold 连续失败多少次后切 full（默认 3）
 */
export async function recordAttachFailure(
  sessionId: string,
  failThreshold = 3,
): Promise<SessionChainAnchor | null> {
  return mutateAnchor(sessionId, (anchor) => {
    anchor.consecutiveAttachFailures += 1;
    if (anchor.consecutiveAttachFailures >= failThreshold && anchor.mode === 'chained') {
      anchor.mode = 'full';
    }
  });
}

/**
 * 挂接成功时重置失败计数。
 */
export async function resetAttachFailures(sessionId: string): Promise<SessionChainAnchor | null> {
  return mutateAnchor(sessionId, (anchor) => {
    anchor.consecutiveAttachFailures = 0;
  });
}
