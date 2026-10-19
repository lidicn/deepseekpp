import { describe, expect, it } from 'vitest';
import {
  formatMemoriesBlock,
  formatMemoryLine,
  getMemoryBudget,
  keywordScore,
  segmentText,
  selectMemories,
} from '../core/memory/selector';
import { MEMORY_TOKEN_BUDGET } from '../core/constants';
import type { Memory } from '../core/types';

// T45: memory 剩余纯函数。
// chain-anchor.ts 全部走 memoryDb（IndexedDB）IO，无独立纯 chain 计算函数，
// 按总规格备选方案「全 IO 依赖则标注跳过」，本文件不测它；这里只覆盖 selector.ts 的纯函数。

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

describe('getMemoryBudget · 预算随 prompt 长度递减且有下限', () => {
  it('returns the full budget when prompt tokens are at or below 3000', () => {
    expect(getMemoryBudget(0)).toBe(MEMORY_TOKEN_BUDGET);
    expect(getMemoryBudget(3000)).toBe(MEMORY_TOKEN_BUDGET);
  });

  it('shrinks linearly above 3000 and never drops below 800', () => {
    expect(getMemoryBudget(4000)).toBe(MEMORY_TOKEN_BUDGET - Math.floor((4000 - 3000) * 0.2));
    expect(getMemoryBudget(100_000)).toBeGreaterThanOrEqual(800);
  });
});

describe('segmentText · 小写化并剔除停用词', () => {
  it('drops stop words and lowercases tokens', () => {
    const words = segmentText('the CAT the Dog');
    expect(words).not.toContain('the');
    expect(words).toContain('cat');
    expect(words).toContain('dog');
  });
});

describe('keywordScore · tag 命中权重高于 name/content', () => {
  it('a tag exact hit scores more than a bare content hit', () => {
    const tagged = makeMemory({ id: 1, name: 'x', content: 'x', tags: ['空调'] });
    const inContent = makeMemory({ id: 2, name: 'x', content: '空调', tags: [] });
    expect(keywordScore(['空调'], tagged)).toBeGreaterThan(keywordScore(['空调'], inContent));
  });
});

describe('formatMemoryLine / formatMemoriesBlock', () => {
  it('prefixes id and project scope, and normalizes DSML separator', () => {
    const m = makeMemory({ id: 7, scope: 'project', name: '偏好', content: '用｜DSML｜分隔' });
    const line = formatMemoryLine(m);
    expect(line).toContain('#7');
    expect(line).toContain('project reference');
    expect(line).toContain('|DSML|');
    expect(line).not.toContain('｜DSML｜');
  });

  it('empty block returns a non-empty empty-state string; non-empty block joins lines', () => {
    expect(formatMemoriesBlock([]).length).toBeGreaterThan(0);
    const block = formatMemoriesBlock([makeMemory({ id: 1, name: '笔记', content: '内容' })]);
    expect(block).toContain('笔记');
  });
});

describe('selectMemories · archived / identityOnly 过滤分支', () => {
  it('drops archived memories by default but keeps them when includeArchived', () => {
    const archived = makeMemory({ id: 1, name: '空调习惯', content: '卧室空调晚上开', tags: ['空调'], archived: true });
    expect(selectMemories('空调', [archived])).toHaveLength(0);
    expect(selectMemories('空调', [archived], { includeArchived: true })).toHaveLength(1);
  });

  it('identityOnly keeps only user/feedback/pinned memories', () => {
    const user = makeMemory({ id: 1, type: 'user', name: '用户画像', content: '用户喜欢咖啡', tags: ['咖啡'] });
    const reference = makeMemory({ id: 2, type: 'reference', name: '参考', content: '咖啡知识', tags: ['咖啡'] });
    const selected = selectMemories('咖啡', [user, reference], { identityOnly: true });
    expect(selected.map((m) => m.id)).toEqual([1]);
  });
});
