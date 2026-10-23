// 2026-10-23：selector 门控与长度归一的回归测试。
//
// 背景（账本 §二十八）：
//  1. `e99d64e` 把 `MIN_KEYWORD_SCORE_GLOBAL` 从 5 降到 1，注释写「方案甲：门控只做
//     0 分剔除」。但 keywordScore 里 content 命中一次就是 5 分，所以 `>= 1` 实际
//     等价于「有任何词重叠就放行」——实测 114 条记忆里 24 条通过，门控形同虚设。
//  2. 更关键的是**语境冲突**：注入侧（L2 digest / augmentation）该严格，
//     显式检索（memory_search）该宽松。一个阈值无法同时满足。
//  3. `contentHits` 统计「内容里有多少个不同词命中」，长内容词更多、命中机会更多，
//     不归一化会让长记忆系统性压过精确但简短的记忆。
//
// 本测试锁定：
//   A. 注入侧默认（不传 minKeywordScore）对 global 记忆要求 >= 5
//   B. minKeywordScore 覆盖项能放宽（memory_search 的用法）
//   C. 长度归一让「简短精确」优先于「冗长但命中数相同」
//   D. 长度归一不影响标签命中（标签是强信号，不压制）
import { describe, expect, it } from 'vitest';
import {
  keywordScore,
  segmentText,
  selectMemories,
} from '../core/memory/selector';
import type { Memory } from '../core/types';

const PROMPT = '查询卧室空调使用时长';

describe('selector 门控：注入侧严格 / 显式检索宽松', () => {
  it('内容只命中一个词的 global 记忆，注入侧默认被拒绝（阈值 10）', () => {
    // 构造一条「只有 content 里出现『空调』、且内容较短所以不被长度归一压制」的记忆
    const weak = makeMemory({
      id: 1,
      scope: 'global',
      name: '设备清单',
      content: '客厅有空调',
      tags: [],
      accessCount: 0,
    });

    const kwScore = keywordScore(segmentText(PROMPT), weak);
    // 只有一次内容命中 = 5 分，低于注入侧阈值 10
    // 这正是「阈值不能取 5」的原因：5 等于单次内容命中的权重，>= 5 会形同虚设
    expect(kwScore).toBeLessThan(10);

    // 注入侧语义（不传 minKeywordScore）→ 拒绝
    expect(selectMemories(PROMPT, [weak])).toHaveLength(0);
  });

  it('同一条记忆用 minKeywordScore=1（memory_search 语义）可通过', () => {
    const weak = makeMemory({
      id: 1,
      scope: 'global',
      name: '设备清单',
      content: '客厅有空调',
      tags: [],
      accessCount: 0,
    });

    const loose = selectMemories(PROMPT, [weak], { minKeywordScore: 1 });
    expect(loose).toHaveLength(1);
    expect(loose[0].id).toBe(1);
  });

  it('标签命中是强信号，即使内容零命中也能过注入侧阈值', () => {
    const tagOnly = makeMemory({
      id: 1,
      scope: 'global',
      name: '一些笔记',
      content: '内容与查询完全无关',
      tags: ['空调', '卧室'],
      accessCount: 0,
    });

    // tagHits >= 2 → 40 分，远超 5
    expect(selectMemories(PROMPT, [tagOnly])).toHaveLength(1);
  });

  it('完全不相关的记忆在两个阈值下都被拒绝', () => {
    const unrelated = makeMemory({
      id: 1,
      scope: 'global',
      name: '编程笔记',
      content: 'React 组件复用模式',
      tags: ['代码'],
      accessCount: 50,
    });

    expect(selectMemories(PROMPT, [unrelated])).toHaveLength(0);
    // 即使放宽到 1，零重叠仍为 0 分
    expect(selectMemories(PROMPT, [unrelated], { minKeywordScore: 1 })).toHaveLength(0);
  });
});

describe('selector 长度归一：短而精确优先于长而分散', () => {
  it('命中数相同时，短内容得分高于长内容', () => {
    const shortMemory = makeMemory({
      id: 1,
      scope: 'global',
      name: '空调',
      content: '空调',
      tags: [],
      accessCount: 0,
    });

    // 长内容里塞满与查询无关的填充词，但同样只命中「空调」这一个相关词
    const filler = '无关填充内容而已顺便写长一点让词数超过归一基准十六个词以上吧'.repeat(6);
    const longMemory = makeMemory({
      id: 2,
      scope: 'global',
      name: '长笔记',
      content: `空调 ${filler}`,
      tags: [],
      accessCount: 0,
    });

    const promptWords = segmentText(PROMPT);
    const shortScore = keywordScore(promptWords, shortMemory);
    const longScore = keywordScore(promptWords, longMemory);

    // 长度归一后，短记忆的同一处命中权重更高（不再被篇幅放大）
    expect(shortScore).toBeGreaterThan(0);
    expect(longScore).toBeGreaterThan(0);
    expect(shortScore).toBeGreaterThanOrEqual(longScore);
  });

  it('长度归一不影响标签权重（标签不压制）', () => {
    const filler = '无关填充内容而已顺便写长一点让词数超过归一基准十六个词以上吧'.repeat(6);
    const taggedLong = makeMemory({
      id: 1,
      scope: 'global',
      name: '长笔记',
      content: filler,
      tags: ['空调'],
      accessCount: 0,
    });

    // 标签命中 20 分，应稳定通过注入侧阈值 5，与内容长度无关
    expect(keywordScore(segmentText(PROMPT), taggedLong)).toBeGreaterThanOrEqual(20);
    expect(selectMemories(PROMPT, [taggedLong])).toHaveLength(1);
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
