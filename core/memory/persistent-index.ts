/**
 * Persistent Memory Index — Phase 4
 *
 * 把中文 bigram 倒排索引持久化到 IndexedDB，避免刷新丢失。
 * 启动时从 DB 加载，记忆保存时自动更新索引。
 *
 * 表结构：memory_index { id++, term, memoryId }
 *
 * 注意：现有 IndexedDb 封装不支持 where().equals().toArray() 查询，
 * 所以查询时全量加载到内存再过滤。
 */

import { memoryDb } from './store';
import { INDEX_TABLE_NAME } from './schema';
import { tokenizeBigram } from './index';

interface IndexRow {
  id?: number;
  term: string;
  memoryId: number;
}

const indexTable = memoryDb.table(INDEX_TABLE_NAME);

/**
 * 从 IndexedDB 加载所有索引行到内存。
 */
export async function loadIndexFromDb(): Promise<Map<string, Set<number>>> {
  const rows = (await indexTable.toArray()) as unknown as IndexRow[];
  const index: Map<string, Set<number>> = new Map();
  for (const row of rows) {
    if (!index.has(row.term)) {
      index.set(row.term, new Set());
    }
    index.get(row.term)!.add(row.memoryId);
  }
  return index;
}

/**
 * 为一条记忆建索引（持久化版）。
 * 先删除旧索引，再写入新索引。
 */
export async function indexMemoryPersistent(
  memoryId: number,
  name: string,
  content: string,
  tags: string[] = [],
): Promise<void> {
  // 1. 删除旧索引（先全量加载，再在内存里过滤，再逐条删除）
  const allRows = (await indexTable.toArray()) as unknown as IndexRow[];
  const oldRows = allRows.filter((r) => r.memoryId === memoryId);
  for (const row of oldRows) {
    if (row.id !== undefined) {
      await indexTable.delete(row.id);
    }
  }

  // 2. 生成 tokens
  const allText = [name, content, ...tags].join(' ');
  const tokens = new Set(tokenizeBigram(allText));

  // 3. 批量写入新索引
  const rows: IndexRow[] = Array.from(tokens).map((term) => ({ term, memoryId }));
  if (rows.length > 0) {
    await indexTable.bulkAdd(rows as any);
  }
}

/**
 * 删除一条记忆的所有索引。
 */
export async function deleteIndexForMemory(memoryId: number): Promise<void> {
  const allRows = (await indexTable.toArray()) as unknown as IndexRow[];
  const oldRows = allRows.filter((r) => r.memoryId === memoryId);
  for (const row of oldRows) {
    if (row.id !== undefined) {
      await indexTable.delete(row.id);
    }
  }
}

/**
 * 清空整个索引表。
 */
export async function clearIndex(): Promise<void> {
  await indexTable.clear();
}

/**
 * 从索引表检索：返回包含任一 query token 的 memoryId 列表。
 */
export async function searchIndexPersistent(
  query: string,
): Promise<Array<{ memoryId: number; score: number }>> {
  const queryTokens = new Set(tokenizeBigram(query));
  if (queryTokens.size === 0) return [];

  // 全量加载到内存，然后过滤
  const allRows = (await indexTable.toArray()) as unknown as IndexRow[];
  const hitCount = new Map<number, number>();

  for (const row of allRows) {
    if (queryTokens.has(row.term)) {
      hitCount.set(row.memoryId, (hitCount.get(row.memoryId) || 0) + 1);
    }
  }

  return Array.from(hitCount.entries())
    .map(([memoryId, score]) => ({ memoryId, score }))
    .sort((a, b) => b.score - a.score);
}

/**
 * 索引统计。
 */
export async function indexStats(): Promise<{ rows: number }> {
  const count = await indexTable.count();
  return { rows: count };
}
