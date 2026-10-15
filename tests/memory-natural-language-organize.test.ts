/**
 * 自然语言整理记忆（P3）测试
 */

import { describe, expect, it } from 'vitest';
import {
  applyMemoryOrganizeDraft,
  buildMemorySnapshots,
  groupNearDuplicateMemories,
  memoryTextSimilarity,
  normalizeMemoryText,
  organizeMemoriesFromNaturalLanguage,
  planMemoryOrganizeLocally,
  readMemoryText,
  selectStaleMemorySnapshots,
} from '../core/memory/natural-language-organize';

describe('readMemoryText', () => {
  it('读取 content', () => {
    expect(readMemoryText({ content: 'test' })).toBe('test');
  });

  it('读取 text', () => {
    expect(readMemoryText({ text: 'test' })).toBe('test');
  });

  it('读取空', () => {
    expect(readMemoryText({})).toBe('');
  });
});

describe('normalizeMemoryText', () => {
  it('规范化文本', () => {
    expect(normalizeMemoryText('  Hello, World!  ')).toBe('hello world');
  });
});

describe('memoryTextSimilarity', () => {
  it('相似文本', () => {
    expect(memoryTextSimilarity('hello world', 'hello world')).toBeGreaterThan(0.9);
  });

  it('不同文本', () => {
    expect(memoryTextSimilarity('hello world', 'foo bar')).toBeLessThan(0.5);
  });
});

describe('buildMemorySnapshots', () => {
  it('构造快照', () => {
    const snapshots = buildMemorySnapshots([
      { id: 1, content: 'test memory', updatedAt: Date.now(), accessCount: 5, pinned: false },
    ]);
    expect(snapshots.length).toBe(1);
    expect(snapshots[0].id).toBe(1);
    expect(snapshots[0].title).toBe('test memory');
  });
});

describe('groupNearDuplicateMemories', () => {
  it('分组相似记忆', () => {
    const snapshots = [
      { id: 1, title: 'a', content: 'hello world this is a test', updatedAt: Date.now(), accessCount: 1, pinned: false },
      { id: 2, title: 'b', content: 'hello world this is a test', updatedAt: Date.now(), accessCount: 1, pinned: false },
      { id: 3, title: 'c', content: 'completely different content here', updatedAt: Date.now(), accessCount: 1, pinned: false },
    ];
    const groups = groupNearDuplicateMemories(snapshots, { threshold: 0.8 });
    expect(groups.length).toBe(1);
    expect(groups[0].length).toBe(2);
  });
});

describe('selectStaleMemorySnapshots', () => {
  it('选择过期记忆', () => {
    const now = Date.now();
    const snapshots = [
      { id: 1, title: 'a', content: 'a', updatedAt: now - 100 * 24 * 60 * 60 * 1000, accessCount: 1, pinned: false },
      { id: 2, title: 'b', content: 'b', updatedAt: now, accessCount: 1, pinned: false },
      { id: 3, title: 'c', content: 'c', updatedAt: now - 100 * 24 * 60 * 60 * 1000, accessCount: 1, pinned: true },
    ];
    const stale = selectStaleMemorySnapshots(snapshots, now);
    expect(stale.length).toBe(1);
    expect(stale[0].id).toBe(1);
  });
});

describe('planMemoryOrganizeLocally', () => {
  it('罗列全部记忆', () => {
    const snapshots = [
      { id: 1, title: 'a', content: 'a', updatedAt: Date.now(), accessCount: 1, pinned: false },
    ];
    const draft = planMemoryOrganizeLocally('罗列全部记忆', snapshots);
    expect(draft.operations.length).toBeGreaterThan(0);
    expect(draft.operations[0].type).toBe('list_all');
  });

  it('删除第1条', () => {
    const snapshots = [
      { id: 1, title: 'a', content: 'a', updatedAt: Date.now(), accessCount: 1, pinned: false },
      { id: 2, title: 'b', content: 'b', updatedAt: Date.now(), accessCount: 1, pinned: false },
    ];
    const draft = planMemoryOrganizeLocally('删除第1条', snapshots);
    expect(draft.operations.some((op) => op.type === 'delete' && op.memoryId === 1)).toBe(true);
  });

  it('清理过期记忆', () => {
    const now = Date.now();
    const snapshots = [
      { id: 1, title: 'a', content: 'a', updatedAt: now - 100 * 24 * 60 * 60 * 1000, accessCount: 1, pinned: false },
    ];
    const draft = planMemoryOrganizeLocally('清理过期记忆', snapshots);
    expect(draft.operations.some((op) => op.type === 'clean_stale')).toBe(true);
  });
});

describe('organizeMemoriesFromNaturalLanguage', () => {
  it('整理记忆', () => {
    const snapshots = [
      { id: 1, title: 'a', content: 'a', updatedAt: Date.now(), accessCount: 1, pinned: false },
    ];
    const draft = organizeMemoriesFromNaturalLanguage({
      instruction: '罗列全部记忆',
      memories: snapshots,
    });
    expect(draft.ready).toBe(true);
  });
});

describe('applyMemoryOrganizeDraft', () => {
  it('未确认拒绝', async () => {
    const draft = {
      operations: [{ type: 'list_all' as const }],
      summary: 'test',
      ready: true,
      issues: [],
    };
    const result = await applyMemoryOrganizeDraft(draft, {
      confirmed: false,
      executor: {},
    });
    expect(result.ok).toBe(false);
  });

  it('确认后执行', async () => {
    let executed = 0;
    const draft = {
      operations: [{ type: 'list_all' as const }],
      summary: 'test',
      ready: true,
      issues: [],
    };
    const result = await applyMemoryOrganizeDraft(draft, {
      confirmed: true,
      executor: {
        listAll: async () => { executed++; },
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.executed).toBe(1);
    }
    expect(executed).toBe(1);
  });
});
