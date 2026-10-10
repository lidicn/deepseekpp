/**
 * L2 Memory Injector — Phase 2
 *
 * 在新会话根消息（parent=null）时注入 L2 记忆摘要。
 * 避免每轮都注入，只在会话首次启动时注入一次。
 *
 * 设计参考：doc/设计/memory-system-v2-mimo-design.md §L2 注入
 */

import type { Memory } from '../types';
import { getAllMemories } from './store';
import { buildDigest, type MemoryDigest } from './digest';
import {
  getChainAnchor,
  saveChainAnchor,
  initChainAnchor,
} from './chain-anchor';

/**
 * L2 注入结果。
 */
export interface L2InjectionResult {
  /** 是否实际注入了（false = 已注入过 / 无记忆 / 会话非根） */
  injected: boolean;
  /** 注入的摘要文本（如果注入了） */
  digestText: string;
  /** 摘要 hash */
  digestHash: string;
  /** 注入原因 */
  reason: 'new_session' | 'already_injected' | 'no_memories' | 'not_root';
}

/**
 * 注入前缀模板（中文）。
 */
const INJECT_PREFIX_ZH = '【记忆系统摘要】\n以下是用户的长期记忆，请在后续对话中参考：\n\n';
const INJECT_SUFFIX_ZH = '\n\n---\n\n';

/**
 * 判断当前是否为会话根消息（parent_message_id = null）。
 */
function isRootMessage(parentMessageId: number | null): boolean {
  return parentMessageId === null;
}

/**
 * 构建注入后的 prompt。
 */
function buildInjectedPrompt(originalPrompt: string, digestText: string): string {
  return INJECT_PREFIX_ZH + digestText + INJECT_SUFFIX_ZH + originalPrompt;
}

/**
 * L2 注入主入口。
 *
 * 在发送请求前调用：如果是新会话根消息且未注入过 digest，则注入。
 *
 * @param sessionId 会话 ID
 * @param originalPrompt 原始 prompt
 * @param parentMessageId 当前 parent_message_id（null = 根消息）
 * @param maxTokens 摘要最大 token 数（默认 500）
 * @returns 注入后的 prompt + 注入结果
 */
export async function injectL2Digest(
  sessionId: string,
  originalPrompt: string,
  parentMessageId: number | null,
  maxTokens = 500,
): Promise<{ prompt: string; result: L2InjectionResult }> {
  // 非根消息：不注入
  if (!isRootMessage(parentMessageId)) {
    return {
      prompt: originalPrompt,
      result: {
        injected: false,
        digestText: '',
        digestHash: '',
        reason: 'not_root',
      },
    };
  }

  // 获取或初始化链锚点
  let anchor = await getChainAnchor(sessionId);
  if (!anchor) {
    anchor = await initChainAnchor(sessionId);
  }

  // 已注入过 digest：不重复注入
  if (anchor.injectedDigestHash !== null) {
    return {
      prompt: originalPrompt,
      result: {
        injected: false,
        digestText: '',
        digestHash: anchor.injectedDigestHash,
        reason: 'already_injected',
      },
    };
  }

  // 拉取所有记忆并构建摘要
  const memories: Memory[] = await getAllMemories();
  if (memories.length === 0) {
    // 无记忆：记录已注入（空摘要），避免重复查询
    anchor.injectedDigestHash = 'empty';
    anchor.lastInjectedAt = Date.now();
    await saveChainAnchor(anchor);
    return {
      prompt: originalPrompt,
      result: {
        injected: false,
        digestText: '',
        digestHash: 'empty',
        reason: 'no_memories',
      },
    };
  }

  const digest: MemoryDigest = buildDigest(memories, maxTokens);
  if (digest.estimatedTokens === 0) {
    anchor.injectedDigestHash = 'empty';
    anchor.lastInjectedAt = Date.now();
    await saveChainAnchor(anchor);
    return {
      prompt: originalPrompt,
      result: {
        injected: false,
        digestText: '',
        digestHash: 'empty',
        reason: 'no_memories',
      },
    };
  }

  // 注入：把摘要拼到 prompt 前面
  const injectedPrompt = buildInjectedPrompt(originalPrompt, digest.text);

  // 更新链锚点：记录已注入
  anchor.injectedDigestHash = digest.hash;
  anchor.lastInjectedAt = Date.now();
  await saveChainAnchor(anchor);

  return {
    prompt: injectedPrompt,
    result: {
      injected: true,
      digestText: digest.text,
      digestHash: digest.hash,
      reason: 'new_session',
    },
  };
}
