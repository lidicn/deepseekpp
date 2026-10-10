/**
 * Memory Index — Phase 2
 *
 * 中文 bigram 倒排索引，加速记忆检索。
 * Phase 2 先用内存索引，Phase 3 再考虑持久化到 IndexedDB。
 *
 * 设计参考：doc/设计/memory-system-v2-mimo-design.md §MemoryIndex
 */

/**
 * 中文 bigram 分词。
 * "你好世界" → ["你好", "好世", "世界"]
 * "hello world" → ["he", "el", "ll", "lo", "wo", "or", "rl", "ld"]
 */
export function tokenizeBigram(text: string): string[] {
  const tokens: string[] = [];
  const normalized = text.toLowerCase().trim();

  // 提取中文连续片段和英文单词
  const segments = normalized.match(/[\u4e00-\u9fa5]+|[a-z0-9]+/g) || [];

  for (const segment of segments) {
    if (segment.length < 2) {
      tokens.push(segment);
      continue;
    }
    // bigram
    for (let i = 0; i < segment.length - 1; i++) {
      tokens.push(segment.slice(i, i + 2));
    }
  }

  return tokens;
}

/**
 * 倒排索引：term → memoryId 集合。
 */
type InvertedIndex = Map<string, Set<number>>;

/**
 * MemoryIndex 类。
 */
export class MemoryIndex {
  private index: InvertedIndex = new Map();
  /** memoryId → tokens（用于删除时清理） */
  private memoryTokens: Map<number, Set<string>> = new Map();

  /**
   * 为一条记忆建索引。
   * @param memoryId 记忆 id
   * @param name 记忆名称
   * @param content 记忆内容
   * @param tags 记忆标签
   */
  indexMemory(memoryId: number, name: string, content: string, tags: string[] = []): void {
    // 先清理旧索引
    this.removeMemory(memoryId);

    // 合并所有文本
    const allText = [name, content, ...tags].join(' ');
    const tokens = tokenizeBigram(allText);

    // 去重
    const uniqueTokens = new Set(tokens);
    this.memoryTokens.set(memoryId, uniqueTokens);

    // 建倒排
    for (const token of uniqueTokens) {
      if (!this.index.has(token)) {
        this.index.set(token, new Set());
      }
      this.index.get(token)!.add(memoryId);
    }
  }

  /**
   * 删除一条记忆的索引。
   */
  removeMemory(memoryId: number): void {
    const tokens = this.memoryTokens.get(memoryId);
    if (!tokens) return;

    for (const token of tokens) {
      const ids = this.index.get(token);
      if (ids) {
        ids.delete(memoryId);
        if (ids.size === 0) {
          this.index.delete(token);
        }
      }
    }

    this.memoryTokens.delete(memoryId);
  }

  /**
   * 查询：返回包含任一 query token 的 memoryId 列表。
   * @param query 查询文本
   * @returns memoryId 数组（按命中 token 数排序）
   */
  search(query: string): Array<{ memoryId: number; score: number }> {
    const queryTokens = new Set(tokenizeBigram(query));
    if (queryTokens.size === 0) return [];

    // 统计每个 memoryId 命中了多少个 token
    const hitCount = new Map<number, number>();

    for (const token of queryTokens) {
      const ids = this.index.get(token);
      if (ids) {
        for (const id of ids) {
          hitCount.set(id, (hitCount.get(id) || 0) + 1);
        }
      }
    }

    // 按命中数排序
    return Array.from(hitCount.entries())
      .map(([memoryId, score]) => ({ memoryId, score }))
      .sort((a, b) => b.score - a.score);
  }

  /**
   * 清空索引。
   */
  clear(): void {
    this.index.clear();
    this.memoryTokens.clear();
  }

  /**
   * 索引统计（调试用）。
   */
  stats(): { terms: number; memories: number } {
    return {
      terms: this.index.size,
      memories: this.memoryTokens.size,
    };
  }
}

/** 全局单例 */
let globalIndex: MemoryIndex | null = null;

export function getMemoryIndex(): MemoryIndex {
  if (!globalIndex) {
    globalIndex = new MemoryIndex();
  }
  return globalIndex;
}
