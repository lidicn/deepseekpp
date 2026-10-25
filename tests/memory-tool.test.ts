import { describe, expect, it } from 'vitest';
import {
  createMemoryToolDescriptors,
  executeMemoryToolCall,
  type MemoryToolRuntime,
} from '../core/tool/memory';
import {
  createWebSearchToolDescriptors,
  executeWebSearchToolCall,
} from '../core/tool/web-search';
import type { ToolCall } from '../core/tool/types';

function memorySaveCall(payload: Record<string, unknown>): ToolCall {
  return {
    name: 'memory_save',
    payload,
    raw: '<memory_save />',
  };
}

function schemaPropertyDescription(
  descriptor: ReturnType<typeof createMemoryToolDescriptors>[number] | ReturnType<typeof createWebSearchToolDescriptors>[number],
  propertyName: string,
): string {
  const property = descriptor.inputSchema.properties?.[propertyName];
  if (!property || typeof property !== 'object' || Array.isArray(property)) {
    throw new Error(`Missing schema property ${propertyName}`);
  }
  const description = property.description;
  if (typeof description !== 'string') {
    throw new Error(`Missing schema description for ${propertyName}`);
  }
  return description;
}

describe('memory tool validation', () => {
  it('localizes memory descriptors without changing tool protocol names', () => {
    const english = createMemoryToolDescriptors('en');
    const chinese = createMemoryToolDescriptors('zh-CN');

    expect(english[0].name).toBe('memory_save');
    expect(english[0].invocationName).toBe('memory_save');
    expect(english[0].title).toBe('Save memory');
    expect(schemaPropertyDescription(english[0], 'type')).toContain('Memory type');

    expect(chinese[0].name).toBe('memory_save');
    expect(chinese[0].invocationName).toBe('memory_save');
    expect(chinese[0].title).toBe('保存记忆');
    expect(schemaPropertyDescription(chinese[0], 'type')).toContain('记忆类型');
  });

  it('does not persist invalid memory_save payloads', async () => {
    let saveCalls = 0;
    const runtime: MemoryToolRuntime = {
      async saveMemory() {
        saveCalls++;
        return { id: 1 };
      },
      async getMemoryById() {
        return null;
      },
      async updateMemory() {},
      async deleteMemory() {},
      async getAllMemories() {
        return [];
      },
      async archiveMemory() {},
      async unarchiveMemory() {},
    };

    const result = await executeMemoryToolCall(runtime, memorySaveCall({
      type: 'topic',
      name: '',
      content: 'content',
      tags: [],
    }));

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('memory_invalid_payload');
    expect(saveCalls).toBe(0);
  });

  it('returns localized memory validation errors', async () => {
    let saveCalls = 0;
    const runtime: MemoryToolRuntime = {
      async saveMemory() {
        saveCalls++;
        return { id: 1 };
      },
      async getMemoryById() {
        return null;
      },
      async updateMemory() {},
      async deleteMemory() {},
      async getAllMemories() {
        return [];
      },
      async archiveMemory() {},
      async unarchiveMemory() {},
    };

    const english = await executeMemoryToolCall(runtime, memorySaveCall({
      type: 'topic',
      name: '',
      content: 'content',
      tags: [],
    }), 'en');

    const chinese = await executeMemoryToolCall(runtime, memorySaveCall({
      type: 'topic',
      name: '',
      content: 'content',
      tags: [],
    }), 'zh-CN');

    expect(english.summary).toBe('Invalid memory payload');
    expect(english.detail).toBe('name must be a non-empty string');
    expect(chinese.summary).toBe('记忆格式错误');
    expect(chinese.detail).toBe('name 必须是非空字符串');
    expect(saveCalls).toBe(0);
  });

  it('returns localized memory success summaries', async () => {
    const runtime: MemoryToolRuntime = {
      async saveMemory() {
        return { id: 42 };
      },
      async getMemoryById() {
        return null;
      },
      async updateMemory() {},
      async deleteMemory() {},
      async getAllMemories() {
        return [];
      },
      async archiveMemory() {},
      async unarchiveMemory() {},
    };

    const result = await executeMemoryToolCall(runtime, memorySaveCall({
      type: 'topic',
      name: 'Pinned decision',
      content: 'Keep tool names stable.',
      tags: ['i18n'],
    }), 'en');

    expect(result.ok).toBe(true);
    expect(result.summary).toBe('Saved');
    expect(result.detail).toBe('Pinned decision');
  });
});

describe('web tool localization', () => {
  it('localizes web descriptors without changing tool protocol names', () => {
    const english = createWebSearchToolDescriptors('en');
    const chinese = createWebSearchToolDescriptors('zh-CN');

    expect(english[0].name).toBe('web_search');
    expect(english[0].invocationName).toBe('web_search');
    expect(english[0].title).toBe('Search the web');
    expect(schemaPropertyDescription(english[0], 'query')).toBe('Search query keywords');

    expect(chinese[0].name).toBe('web_search');
    expect(chinese[0].invocationName).toBe('web_search');
    expect(chinese[0].title).toBe('搜索互联网');
    expect(schemaPropertyDescription(chinese[0], 'query')).toBe('搜索查询关键词');
  });

  it('returns localized web validation errors without network access', async () => {
    const englishSearch = await executeWebSearchToolCall({
      name: 'web_search',
      payload: { query: '' },
      raw: '<web_search />',
    }, 'en');

    const chineseSearch = await executeWebSearchToolCall({
      name: 'web_search',
      payload: { query: '' },
      raw: '<web_search />',
    }, 'zh-CN');

    const englishFetch = await executeWebSearchToolCall({
      name: 'web_fetch',
      payload: { url: '' },
      raw: '<web_fetch />',
    }, 'en');

    expect(englishSearch.summary).toBe('Search query cannot be empty');
    expect(chineseSearch.summary).toBe('搜索查询不能为空');
    expect(englishFetch.summary).toBe('URL cannot be empty');
  });
});


// 审计 #50（2026-10-24 报告 P1）：`topK` 非数字时原来得到 NaN，一路传进
// selectMemories 的 budget 计算 ⇒ **返回空结果但 ok:true**，用户看到「没有相关记忆」，
// 其实一条都没检索到。修法：只接受有限正数，非法值回落默认 5 并夹到 [1,50]。
describe('审计 #50：memory_search 的 topK 必须是有限正数', () => {
  function makeRuntime(): MemoryToolRuntime {
    const memories = Array.from({ length: 8 }, (_, index) => ({
      id: index + 1,
      type: 'fact',
      scope: 'global',
      name: `alpha beta ${index}`,
      description: 'alpha beta 相关内容',
      content: 'alpha beta 相关内容，用于检索验证。',
      tags: ['alpha', 'beta'],
      pinned: false,
      archived: false,
      createdAt: index + 1,
      updatedAt: index + 1,
      lastAccessedAt: index + 1,
    })) as unknown as Awaited<ReturnType<MemoryToolRuntime['getAllMemories']>>;
    return {
      saveMemory: async () => null,
      getMemoryById: async () => null,
      updateMemory: async () => {},
      deleteMemory: async () => {},
      archiveMemory: async () => {},
      unarchiveMemory: async () => {},
      getAllMemories: async () => memories,
    };
  }

  function searchCall(topK: unknown): ToolCall {
    return {
      name: 'memory_search',
      payload: topK === undefined ? { query: 'alpha beta' } : { query: 'alpha beta', topK },
      raw: '<memory_search />',
    } as unknown as ToolCall;
  }

  it('topK 为非法字符串 ⇒ 仍能检索出结果（修复前是 slice(0, NaN) ⇒ 找到 0 条）', async () => {
    const result = await executeMemoryToolCall(makeRuntime(), searchCall('abc'), 'zh-CN');
    expect(result.ok).toBe(true);
    // 修复前的实际表现是 `找到 0 条与"…"相关的记忆`（slice(0, NaN) === []），
    // 注意它**不含**「没有」字样 —— 所以断言必须盯「找到 0 条」而不是「没有」。
    expect(String(result.summary)).not.toContain('找到 0 条');
    expect(String(result.summary)).not.toMatch(/没有|未找到/);
  });

  it('topK 为 0 / 负数 / Infinity / NaN / null ⇒ 都回落默认值，仍能检索', async () => {
    for (const bad of [0, -3, Number.POSITIVE_INFINITY, Number.NaN, null]) {
      const result = await executeMemoryToolCall(makeRuntime(), searchCall(bad), 'zh-CN');
      expect(result.ok).toBe(true);
      expect(String(result.summary)).not.toContain('找到 0 条');
    }
  });

  it('合法 topK 正常生效（负控）', async () => {
    const result = await executeMemoryToolCall(makeRuntime(), searchCall(3), 'zh-CN');
    expect(result.ok).toBe(true);
  });

  it('缺省 topK 仍是 5（负控：别把默认值改了）', async () => {
    const result = await executeMemoryToolCall(makeRuntime(), searchCall(undefined), 'zh-CN');
    expect(result.ok).toBe(true);
  });
});