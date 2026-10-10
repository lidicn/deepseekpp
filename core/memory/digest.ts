/**
 * Memory Digest Builder — Phase 1
 *
 * 把 top-N 记忆压缩成 ≤500 token 的摘要，作为 L2 根消息注入内容。
 * 六槽位：identity / preferences / constraints / projects / procedures / goals
 *
 * 设计参考：doc/设计/memory-system-v2-mimo-design.md §L2 摘要
 */

import type { Memory } from '../types';

/** L2 槽位类型 */
export type L2Slot =
  | 'identity'
  | 'preferences'
  | 'constraints'
  | 'projects'
  | 'procedures'
  | 'goals';

/** 单条 L2 行 */
export interface L2Line {
  slot: L2Slot;
  content: string;
  pinned?: boolean;
}

/** L2 块（一个槽位的所有行） */
export interface L2Block {
  slot: L2Slot;
  lines: L2Line[];
}

/** 摘要结果 */
export interface MemoryDigest {
  /** 完整摘要文本（注入用） */
  text: string;
  /** token 估算 */
  estimatedTokens: number;
  /** 被省略的记忆数 */
  omitted: number;
  /** 摘要 hash（用于去重） */
  hash: string;
}

/**
 * 槽位映射：根据记忆类型和 tag 决定归入哪个槽位。
 */
function mapSlot(memory: Memory): L2Slot {
  // 优先按 tag 判断
  if (memory.tags.includes('preference')) return 'preferences';
  if (memory.tags.includes('constraint')) return 'constraints';
  if (memory.tags.includes('procedure')) return 'procedures';
  if (memory.tags.includes('goal')) return 'goals';
  if (memory.tags.includes('decision')) return 'projects';

  // 按 type 兜底
  switch (memory.type) {
    case 'user':
      return 'identity';
    case 'feedback':
      return 'constraints';
    case 'topic':
      return 'projects';
    case 'reference':
      return 'procedures';
    default:
      return 'identity';
  }
}

/**
 * 估算 token 数（粗略：中文按字符数/1.5）。
 */
function estimateTokens(text: string): number {
  const chineseChars = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
  const englishWords = (text.match(/[a-zA-Z]+/g) || []).length;
  return Math.ceil(chineseChars / 1.5 + englishWords);
}

/**
 * 计算 hash（简单的字符串哈希）。
 */
function simpleHash(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // 转 32 位整数
  }
  return Math.abs(hash).toString(36);
}

/**
 * 槽位的显示名（中文）。
 */
const SLOT_LABELS: Record<L2Slot, string> = {
  identity: '用户画像',
  preferences: '偏好',
  constraints: '约束',
  projects: '项目',
  procedures: '流程',
  goals: '目标',
};

/**
 * 构建记忆摘要。
 *
 * @param memories 所有记忆
 * @param maxTokens 最大 token 数（默认 500）
 * @returns MemoryDigest
 */
export function buildDigest(
  memories: Memory[],
  maxTokens = 500,
): MemoryDigest {
  if (memories.length === 0) {
    return {
      text: '',
      estimatedTokens: 0,
      omitted: 0,
      hash: simpleHash('empty'),
    };
  }

  // 1. 按重要度排序（pinned > importance > accessCount > 新鲜度）
  const sorted = [...memories].sort((a, b) => {
    if (a.pinned && !b.pinned) return -1;
    if (!a.pinned && b.pinned) return 1;
    const aScore = (a.accessCount || 0) + (Date.now() - a.lastAccessedAt < 7 * 86400_000 ? 5 : 0);
    const bScore = (b.accessCount || 0) + (Date.now() - b.lastAccessedAt < 7 * 86400_000 ? 5 : 0);
    return bScore - aScore;
  });

  // 2. 按槽位分组
  const slotGroups = new Map<L2Slot, Memory[]>();
  for (const mem of sorted) {
    const slot = mapSlot(mem);
    if (!slotGroups.has(slot)) {
      slotGroups.set(slot, []);
    }
    slotGroups.get(slot)!.push(mem);
  }

  // 3. 逐槽位渲染，直到达到 token 上限
  const lines: string[] = [];
  let currentTokens = 0;
  let omitted = 0;
  const SLOTS: L2Slot[] = ['identity', 'preferences', 'constraints', 'projects', 'procedures', 'goals'];

  for (const slot of SLOTS) {
    const group = slotGroups.get(slot);
    if (!group || group.length === 0) continue;

    const slotLabel = SLOT_LABELS[slot];
    lines.push(`【${slotLabel}】`);
    currentTokens += estimateTokens(`【${slotLabel}】`);

    for (const mem of group) {
      const line = `- ${mem.name}: ${mem.content}`;
      const lineTokens = estimateTokens(line);

      if (currentTokens + lineTokens > maxTokens) {
        omitted += group.length - group.indexOf(mem);
        break;
      }

      lines.push(line);
      currentTokens += lineTokens;
    }
  }

  const text = lines.join('\n');

  return {
    text,
    estimatedTokens: currentTokens,
    omitted,
    hash: simpleHash(text),
  };
}
