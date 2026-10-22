// 2026-10-22 真机定位回归：memory_search 的 budget 会饿死后面的结果。
//
// 现场（DPP 八环节验收暴露）：调 memory_search 要 topK=5，只拿到 1 条，
// 且返回的是 #84「dpp 与 studio 的关系」而不是刚存的 #112。
//
// 根因：selectMemories 的 budget 循环「装不下就 break」，而调用方传的
// budget = topK * 200（假设每条约 200 token）。真机实测单条记忆可达 1646 token：
//
//   budget = 5 * 200 = 1000
//   #84 = 1646 token   ← 单条就超过整个 budget
//   #92 = 1525 / #86 = 644 / #114 = 566 / #113 = 351
//   通过关键词阈值的共 24 条，最终只返回 1 条
//
// 循环细节：第 1 条 1000-1646 = -646，但 selected 为空所以仍 push；
// 第 2 条 -646-351 < 0 且已有 1 条 → break。
//
// 修法：把「选哪些」与「显示多少」解耦 —— selectMemories 用宽松上限拿到完整
// 排序结果，再 slice(0, topK)，显示时对单条内容截断。
import { describe, expect, it } from 'vitest';
import { executeMemoryToolCall, type MemoryToolRuntime } from '../core/tool/memory';
import type { Memory } from '../core/types';
import type { ToolCall } from '../core/tool/types';

const NOW = Date.now();

function makeMemory(overrides: Partial<Memory> & { id: number }): Memory {
  return {
    id: overrides.id,
    type: overrides.type ?? 'topic',
    name: overrides.name ?? `记忆${overrides.id}`,
    content: overrides.content ?? `内容${overrides.id}`,
    description: '',
    tags: overrides.tags ?? [],
    pinned: overrides.pinned ?? false,
    archived: overrides.archived ?? false,
    scope: overrides.scope ?? 'global',
    createdAt: NOW - 1000,
    updatedAt: NOW - 1000,
    lastAccessedAt: NOW - 1000,
    accessCount: overrides.accessCount ?? 0,
  } as Memory;
}

/** 一条超长记忆（模拟真机 #84 的 1646 token）。 */
function longMemory(id: number): Memory {
  return makeMemory({
    id,
    name: 'dpp 与 studio 的关系、漂移量化与投入建议',
    content: 'dpp 与 studio 的关系说明。'.repeat(300) + ' dpp accept mark 2026',
    tags: ['dpp'],
    accessCount: 7,
  });
}

function searchRuntime(memories: Memory[]): MemoryToolRuntime {
  return {
    async saveMemory() { return { id: 1 }; },
    async getMemoryById() { return null; },
    async updateMemory() {},
    async deleteMemory() {},
    async getAllMemories() { return memories; },
    async archiveMemory() {},
    async unarchiveMemory() {},
  };
}

function searchCall(payload: Record<string, unknown>): ToolCall {
  return { name: 'memory_search', payload, raw: '<memory_search />' };
}

describe('memory_search 的预算不再饿死结果', () => {
  it('长记忆排第一时，仍返回 topK 条（真机 bug 回归）', async () => {
    // 1 条超长 + 5 条短，全部含检索词
    const memories = [
      longMemory(84),
      makeMemory({ id: 113, name: 'DPP验收标记', content: 'DPP-ACCEPT-MARK-2026 正文' }),
      makeMemory({ id: 92, name: 'DPP 对比', content: 'DPP-ACCEPT-MARK 相关' }),
      makeMemory({ id: 86, name: 'DPP 纪律', content: 'DPP ACCEPT 相关' }),
      makeMemory({ id: 114, name: 'DPP 越界', content: 'DPP MARK 相关' }),
      makeMemory({ id: 115, name: 'DPP 备注', content: 'DPP 2026 相关' }),
    ];

    const result = await executeMemoryToolCall(
      searchRuntime(memories),
      searchCall({ query: 'DPP-ACCEPT-MARK-2026', topK: 5 }),
      'zh-CN',
    );

    expect(result.ok).toBe(true);
    const detail = result as unknown as { output?: { count?: number; matched?: number } };
    // 关键断言：修复前 count=1（被长记忆吃光预算）
    expect(detail.output?.count).toBe(5);
    // matched 是「通过阈值的总数」，应 >= 返回条数
    expect(detail.output?.matched).toBeGreaterThanOrEqual(5);
  });

  it('单条超长记忆在显示时被截断并标注', async () => {
    const memories = [longMemory(84)];
    const result = await executeMemoryToolCall(
      searchRuntime(memories),
      searchCall({ query: 'dpp', topK: 1 }),
      'zh-CN',
    );

    expect(result.ok).toBe(true);
    // header + body 走的是 summary（success 的第三个参数）
    const text = String(result.summary ?? '');
    expect(text).toContain('截断，省略');
  });

  it('零命中时 count 与 matched 都是 0', async () => {
    const memories = [makeMemory({ id: 1, name: '无关', content: '完全无关内容' })];
    const result = await executeMemoryToolCall(
      searchRuntime(memories),
      searchCall({ query: 'DPP-ACCEPT-MARK-2026', topK: 5 }),
      'zh-CN',
    );

    expect(result.ok).toBe(true);
    const detail = result as unknown as { output?: { count?: number; matched?: number } };
    expect(detail.output?.count).toBe(0);
    expect(detail.output?.matched).toBe(0);
  });
});
