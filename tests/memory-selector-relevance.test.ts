import { describe, expect, it } from 'vitest';
import { selectMemories } from '../core/memory/selector';
import type { Memory } from '../core/types';

describe('memory selector relevance threshold', () => {
  it('rejects unrelated global memory when keyword score is zero', () => {
    const globalMemory = makeMemory({
      id: 1,
      scope: 'global',
      name: 'deepseek-pp 审计进度',
      content: '完整审计计划 22 轮，分轮目录 A1-A3、B1-B3',
      tags: ['deepseek-pp', '审计进度'],
      accessCount: 24,
    });

    // Prompt about air conditioner — zero keyword overlap with audit memory
    const selected = selectMemories('查询卧室空调使用时长', [globalMemory]);
    expect(selected).toHaveLength(0);
  });

  it('accepts global memory when keyword score meets threshold (>=5)', () => {
    const globalMemory = makeMemory({
      id: 1,
      scope: 'global',
      name: '空调使用习惯',
      content: '卧室空调通常在晚上 8 点开启，早上 7 点关闭',
      tags: ['空调', '卧室', '使用时长'],
      accessCount: 5,
    });

    const selected = selectMemories('查询卧室空调使用时长', [globalMemory]);
    expect(selected).toHaveLength(1);
    expect(selected[0].id).toBe(1);
  });

  it('project memory has lower threshold (>=1 keyword hit)', () => {
    const projectMemory = makeMemory({
      id: 1,
      scope: 'project',
      projectId: 'proj-1',
      name: '项目笔记',
      content: '这个项目需要关注空调使用时长的统计',
      tags: ['项目'],
      accessCount: 1,
    });

    // "空调" appears in content → contentHits >= 1 → passes project threshold
    const selected = selectMemories('查询卧室空调使用时长', [projectMemory]);
    expect(selected).toHaveLength(1);
  });

  it('pinned memory bypasses relevance threshold', () => {
    const pinnedMemory = makeMemory({
      id: 1,
      scope: 'global',
      name: '完全不相关的置顶记忆',
      content: '这是一条用户手动置顶的记忆，内容与查询无关',
      tags: ['其他'],
      pinned: true,
      accessCount: 0,
    });

    const selected = selectMemories('查询卧室空调使用时长', [pinnedMemory]);
    expect(selected).toHaveLength(1);
    expect(selected[0].id).toBe(1);
  });

  it('returns empty when all memories fail relevance threshold', () => {
    const memories = [
      makeMemory({ id: 1, scope: 'global', name: '审计', content: '审计内容', tags: ['审计'], accessCount: 10 }),
      makeMemory({ id: 2, scope: 'global', name: '编程', content: '代码审查', tags: ['代码'], accessCount: 5 }),
    ];

    const selected = selectMemories('今天天气怎么样', memories);
    expect(selected).toHaveLength(0);
  });

  it('ranks relevant memories above barely-relevant ones', () => {
    const highlyRelevant = makeMemory({
      id: 1,
      scope: 'global',
      name: '卧室空调使用记录',
      content: '卧室空调每晚 8 点到早 7 点运行，日均 11 小时',
      tags: ['卧室', '空调', '使用时长'],
      accessCount: 3,
    });
    const barelyRelevant = makeMemory({
      id: 2,
      scope: 'global',
      name: '客厅设备清单',
      content: '客厅有空调、电视、沙发',
      tags: ['客厅', '空调'],
      accessCount: 1,
    });

    const selected = selectMemories('查询卧室空调使用时长', [barelyRelevant, highlyRelevant]);
    expect(selected).toHaveLength(2);
    expect(selected[0].id).toBe(1); // highly relevant first
  });
});

function makeMemory(overrides: Partial<Memory> & { id: number }): Memory {
  return {
    syncId: `sync-${overrides.id}`,
    scope: 'global',
    type: 'reference',
    name: 'memory',
    content: 'content',
    description: '',
    tags: [],
    pinned: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    accessCount: 0,
    lastAccessedAt: Date.now(),
    ...overrides,
  };
}
