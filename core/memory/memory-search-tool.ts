/**
 * Memory Search Tool — Phase 3
 *
 * L3 冷检索工具：Agent 可主动调用检索历史记忆。
 *
 * 设计参考：doc/设计/memory-system-v2-mimo-design.md §L3 检索
 */

import type { Memory } from '../types';
import { getAllMemories } from './store';
import { getMemoryIndex } from './index';
import { selectMemories, formatMemoriesBlock } from './selector';

/**
 * 检索结果。
 */
export interface MemorySearchResult {
  /** 是否成功 */
  ok: boolean;
  /** 匹配的记忆数 */
  count: number;
  /** 格式化的结果文本（直接给 Agent 看） */
  text: string;
  /** 原始记忆列表（调试用） */
  memories?: Memory[];
}

/**
 * memory_search 工具主入口。
 *
 * @param query 检索关键词
 * @param topK 返回前 K 条（默认 5）
 * @returns 检索结果
 */
export async function memorySearch(
  query: string,
  topK = 5,
): Promise<MemorySearchResult> {
  if (!query || query.trim().length < 2) {
    return {
      ok: false,
      count: 0,
      text: '检索关键词太短，请输入至少 2 个字符。',
    };
  }

  // 1. 拉取所有记忆
  const allMemories = await getAllMemories();
  if (allMemories.length === 0) {
    return {
      ok: true,
      count: 0,
      text: '当前没有任何记忆。',
    };
  }

  // 2. 用 selector 检索（现有逻辑）
  const selected = selectMemories(query, allMemories, {
    budget: topK * 200, // 每条记忆约 200 token
  });

  if (selected.length === 0) {
    return {
      ok: true,
      count: 0,
      text: `没有找到与"${query}"相关的记忆。`,
    };
  }

  // 3. 截取 top-K
  const topResults = selected.slice(0, topK);

  // 4. 格式化输出
  const header = `找到 ${topResults.length} 条与"${query}"相关的记忆：\n`;
  const body = formatMemoriesBlock(topResults);

  return {
    ok: true,
    count: topResults.length,
    text: header + body,
    memories: topResults,
  };
}

/**
 * memory_search 工具描述（用于工具注册）。
 */
export const MEMORY_SEARCH_TOOL_DESCRIPTOR = {
  name: 'memory_search',
  description: '检索长期记忆。当你需要回忆用户偏好、项目约束、历史决策等信息时调用。',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: '检索关键词（如"用户偏好"、"项目约束"、"上次决策"）',
      },
      topK: {
        type: 'number',
        description: '返回前 K 条结果（默认 5）',
        default: 5,
      },
    },
    required: ['query'],
  },
} as const;
