/**
 * ChatPage mount 时把 active-transcript 的 pendingChunks 合并到 messages 的纯函数。
 *
 * 为什么单独抽：
 * - 可在 CI 直接测（不依赖 React / chrome.storage）
 * - ChatPage 里原来那段 30 行是 effect 闭包里的手写逻辑，改起来容易漏
 * - 这是恢复续传的核心路径，必须守卫
 *
 * 语义：
 * 1. 空 messages + 有 chunks → 生成一条 assistant（无已有 assistant 可追加）
 * 2. 最后一条是 assistant → 追加到它的 text/reasoningText（不新起一条）
 * 3. chunks 乱序 → 按 seq 排序
 * 4. 重复 seq → 去重（background + ChatPage 双写会产生重复）
 * 5. chunks 只追加 text / reasoningText，不影响 role 或其他字段
 */
import type { ChatMessage } from './types';
import type { ActiveTranscriptChunk } from './chat/active-transcript';

export interface MergeRestoredResult {
  /** 合并后的消息数组（新数组，不突变输入） */
  messages: ChatMessage[];
  /** 实际追加的 assistant 消息索引（在返回数组里）；-1 表示没有 assistant 消息 */
  assistantIndex: number;
  /** 本次合并后 assistant 的累计文本长度（便于 UI 判断是否有实际增量） */
  assistantTextLength: number;
}

/**
 * 恢复场景下把 pendingChunks 合并到 messages。
 *
 * @param messages 已持久化的消息数组（来自 transcript.messages）
 * @param chunks   pendingChunks 数组（可能乱序、可能有重复 seq）
 * @returns 合并结果（新数组，不突变输入）
 */
export function mergeRestoredTranscript(
  messages: ChatMessage[],
  chunks: ActiveTranscriptChunk[],
): MergeRestoredResult {
  // 去重 + 按 seq 排序
  const seen = new Set<number>();
  const dedupedSorted = [...chunks]
    .filter((c) => {
      if (seen.has(c.seq)) return false;
      seen.add(c.seq);
      return true;
    })
    .sort((a, b) => a.seq - b.seq);

  if (dedupedSorted.length === 0) {
    // 无 chunk — 直接返回原数组（浅拷贝避免外部误以为稳定）
    return {
      messages: [...messages],
      assistantIndex: -1,
      assistantTextLength: messages.length > 0 && messages[messages.length - 1]!.role === 'assistant'
        ? (messages[messages.length - 1]!.text ?? '').length
        : 0,
    };
  }

  // 找最后一条 assistant
  let lastAssistantIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === 'assistant') {
      lastAssistantIdx = i;
      break;
    }
  }

  let lastAssistantText = '';
  let lastAssistantReasoning = '';

  // 先已有内容（如果有）
  if (lastAssistantIdx >= 0) {
    lastAssistantText = messages[lastAssistantIdx]!.text ?? '';
    lastAssistantReasoning = messages[lastAssistantIdx]!.reasoningText ?? '';
  }

  // 追加 chunk
  for (const c of dedupedSorted) {
    if (c.text) lastAssistantText += c.text;
    if (c.reasoningText) lastAssistantReasoning += c.reasoningText;
  }

  // 构建返回数组
  const result = [...messages];
  if (lastAssistantIdx >= 0) {
    result[lastAssistantIdx] = {
      ...result[lastAssistantIdx]!,
      text: lastAssistantText,
      reasoningText: lastAssistantReasoning || undefined,
    };
  } else {
    result.push({
      role: 'assistant',
      text: lastAssistantText,
      reasoningText: lastAssistantReasoning || undefined,
    });
    lastAssistantIdx = result.length - 1;
  }

  return {
    messages: result,
    assistantIndex: lastAssistantIdx,
    assistantTextLength: lastAssistantText.length,
  };
}
