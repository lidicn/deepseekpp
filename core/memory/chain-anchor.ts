/**
 * Session Chain Anchor Store — Phase 1
 *
 * 统一管理会话链锚点（rootMessageId / lastMessageId / mode / consecutiveAttachFailures）。
 * 决定 L2 注入时机、续跑 parent 取值、以及何时降级到 full 模式。
 *
 * 设计参考：doc/设计/memory-system-v2-mimo-design.md §L1 链锚点
 */

import { memoryDb } from './store';
import { ANCHOR_TABLE_NAME } from './schema';

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
 * 获取会话链锚点；不存在则返回 null。
 */
export async function getChainAnchor(sessionId: string): Promise<SessionChainAnchor | null> {
  const row = await anchors.get(sessionId);
  if (!row) return null;
  return row as unknown as SessionChainAnchor;
}

/**
 * 保存/更新会话链锚点。
 */
export async function saveChainAnchor(anchor: SessionChainAnchor): Promise<void> {
  await anchors.put({ ...anchor, updatedAt: Date.now() });
}

/**
 * 删除会话链锚点（会话结束/切换时调用）。
 */
export async function deleteChainAnchor(sessionId: string): Promise<void> {
  await anchors.delete(sessionId);
}

/**
 * 新会话初始化链锚点。
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
  const anchor = await getChainAnchor(sessionId);
  if (!anchor) return null;
  anchor.lastMessageId = lastMessageId;
  anchor.turnCount += 1;
  await saveChainAnchor(anchor);
  return anchor;
}

/**
 * 记录挂接失败；连续失败达阈值时切换到 full 模式。
 * @param failThreshold 连续失败多少次后切 full（默认 3）
 */
export async function recordAttachFailure(
  sessionId: string,
  failThreshold = 3,
): Promise<SessionChainAnchor | null> {
  const anchor = await getChainAnchor(sessionId);
  if (!anchor) return null;
  anchor.consecutiveAttachFailures += 1;
  if (anchor.consecutiveAttachFailures >= failThreshold && anchor.mode === 'chained') {
    anchor.mode = 'full';
  }
  await saveChainAnchor(anchor);
  return anchor;
}

/**
 * 挂接成功时重置失败计数。
 */
export async function resetAttachFailures(sessionId: string): Promise<SessionChainAnchor | null> {
  const anchor = await getChainAnchor(sessionId);
  if (!anchor) return null;
  anchor.consecutiveAttachFailures = 0;
  await saveChainAnchor(anchor);
  return anchor;
}
