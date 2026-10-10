/**
 * Memory Extractor Hook — Phase 2
 *
 * 在每轮对话结束后自动提取记忆候选并保存。
 * 与 agent loop 集成的入口点。
 *
 * 设计参考：doc/设计/memory-system-v2-mimo-design.md §提取集成
 */

import { saveMemory } from './store';
import {
  extractSignals,
  evaluateGate,
  buildCandidate,
  DEFAULT_GATE_CONFIG,
  type ExtractionGateConfig,
  type ExtractionCandidate,
} from './extractor';
import { getChainAnchor, updateLastMessageId } from './chain-anchor';

/**
 * 提取结果统计。
 */
export interface ExtractionHookResult {
  /** 是否触发了提取 */
  triggered: boolean;
  /** 触发原因 */
  reason: string;
  /** 保存的记忆数 */
  savedCount: number;
  /** 跳过的候选数 */
  skippedCount: number;
}

/**
 * 每轮对话结束后的提取 hook。
 *
 * 在 assistant 响应完成后调用，从用户消息中提取记忆候选。
 *
 * @param sessionId 会话 ID
 * @param userMessage 用户本轮消息
 * @param assistantMessage assistant 本轮响应（可选，用于上下文）
 * @param turnCount 当前轮数
 * @param lastExtractionTurn 上次提取的轮数（用于冷却判断）
 * @param config 门控配置（可选）
 * @returns 提取结果统计
 */
export async function runExtractionHook(
  sessionId: string,
  userMessage: string,
  assistantMessage: string | null,
  turnCount: number,
  lastExtractionTurn: number | null,
  config: ExtractionGateConfig = DEFAULT_GATE_CONFIG,
): Promise<ExtractionHookResult> {
  // 1. 从用户消息提取信号
  const signals = extractSignals(userMessage);

  // 2. 门控判断
  const gate = evaluateGate(turnCount, lastExtractionTurn, signals, config);
  if (!gate.trigger) {
    return {
      triggered: false,
      reason: gate.reason,
      savedCount: 0,
      skippedCount: 0,
    };
  }

  // 3. 生成候选
  const candidate = buildCandidate(userMessage, signals);
  if (!candidate) {
    return {
      triggered: false,
      reason: 'noise_only',
      savedCount: 0,
      skippedCount: 0,
    };
  }

  // 4. 保存到 memories 表
  try {
    await saveMemory({
      syncId: crypto.randomUUID(),
      scope: 'global',
      type: candidate.kind,
      name: candidate.content.slice(0, 30) || '自动提取',
      content: candidate.content,
      description: `自动提取（${candidate.tags.join(', ')}）`,
      tags: candidate.tags,
      pinned: false,
    });

    return {
      triggered: true,
      reason: gate.reason,
      savedCount: 1,
      skippedCount: 0,
    };
  } catch (err) {
    return {
      triggered: true,
      reason: `save_failed: ${String(err)}`,
      savedCount: 0,
      skippedCount: 1,
    };
  }
}

/**
 * 便捷函数：更新链锚点的 lastMessageId（每轮 assistant 响应后调用）。
 *
 * @param sessionId 会话 ID
 * @param lastMessageId assistant 消息 id
 */
export async function updateChainAfterTurn(
  sessionId: string,
  lastMessageId: string,
): Promise<void> {
  await updateLastMessageId(sessionId, lastMessageId);
}
