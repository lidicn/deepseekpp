import type { Memory, MemoryType, NewMemory } from '../types';
import { DEFAULT_LOCALE, translate, type SupportedLocale } from '../i18n/background';
import type {
  JsonValue,
  ToolCall,
  ToolDescriptor,
  ToolProviderIdentity,
  ToolResult,
} from './types';

const MEMORY_TYPES: MemoryType[] = ['user', 'feedback', 'topic', 'reference'];

export const MEMORY_TOOL_PROVIDER: ToolProviderIdentity = {
  kind: 'local',
  id: 'memory',
  displayName: translate(DEFAULT_LOCALE, 'tool.memory.providerName'),
  transport: 'in_process',
};

export const MEMORY_TOOL_NAMES = ['memory_save', 'memory_update', 'memory_delete', 'memory_archive', 'memory_unarchive', 'memory_search'] as const;

export type MemoryToolName = typeof MEMORY_TOOL_NAMES[number];

export interface MemoryToolSaveConfirmation {
  id: number;
}

export interface MemoryToolRuntime {
  saveMemory(input: NewMemory): Promise<MemoryToolSaveConfirmation | null>;
  getMemoryById(id: number): Promise<Memory | null>;
  updateMemory(memory: Memory): Promise<void>;
  deleteMemory(id: number): Promise<void>;
  archiveMemory(id: number): Promise<void>;
  unarchiveMemory(id: number): Promise<void>;
  getAllMemories(): Promise<Memory[]>;
}

export function createMemoryToolProviderIdentity(
  locale: SupportedLocale = DEFAULT_LOCALE,
): ToolProviderIdentity {
  return {
    ...MEMORY_TOOL_PROVIDER,
    displayName: translate(locale, 'tool.memory.providerName'),
  };
}

export function createMemoryToolDescriptors(
  locale: SupportedLocale = DEFAULT_LOCALE,
): ToolDescriptor[] {
  const provider = createMemoryToolProviderIdentity(locale);
  return [{
    id: 'local:memory:memory_save',
    provider,
    name: 'memory_save',
    invocationName: 'memory_save',
    title: translate(locale, 'tool.memory.saveTitle'),
    description: translate(locale, 'tool.memory.saveDescription'),
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: MEMORY_TYPES,
          description: translate(locale, 'tool.memory.typeDescription'),
        },
        name: { type: 'string', description: translate(locale, 'tool.memory.nameDescription') },
        content: { type: 'string', description: translate(locale, 'tool.memory.contentDescription') },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: translate(locale, 'tool.memory.tagsDescription'),
        },
      },
      required: ['type', 'name', 'content', 'tags'],
      additionalProperties: false,
    },
    execution: {
      mode: 'auto',
      enabled: true,
      risk: 'low',
    },
  },
  {
    id: 'local:memory:memory_update',
    provider,
    name: 'memory_update',
    invocationName: 'memory_update',
    title: translate(locale, 'tool.memory.updateTitle'),
    description: translate(locale, 'tool.memory.updateDescription'),
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: translate(locale, 'tool.memory.idDescription') },
        type: { type: 'string', enum: MEMORY_TYPES, description: translate(locale, 'tool.memory.typeDescription') },
        name: { type: 'string', description: translate(locale, 'tool.memory.updatedNameDescription') },
        content: { type: 'string', description: translate(locale, 'tool.memory.updatedContentDescription') },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: translate(locale, 'tool.memory.tagsDescription'),
        },
      },
      required: ['id', 'type', 'name', 'content', 'tags'],
      additionalProperties: false,
    },
    execution: {
      mode: 'auto',
      enabled: true,
      risk: 'medium',
    },
  },
  {
    id: 'local:memory:memory_delete',
    provider,
    name: 'memory_delete',
    invocationName: 'memory_delete',
    title: translate(locale, 'tool.memory.deleteTitle'),
    description: translate(locale, 'tool.memory.deleteDescription'),
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: translate(locale, 'tool.memory.idDescription') },
      },
      required: ['id'],
      additionalProperties: false,
    },
    execution: {
      mode: 'auto',
      enabled: true,
      risk: 'medium',
    },
  },
  {
    id: 'local:memory:memory_archive',
    provider,
    name: 'memory_archive',
    invocationName: 'memory_archive',
    title: '归档记忆',
    description: '归档一条记忆（软删除，不再注入但仍可检索）。适合旧的、不再常用但不想彻底删除的记忆。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: '要归档的记忆 ID' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    execution: {
      mode: 'auto',
      enabled: true,
      risk: 'low',
    },
  },
  {
    id: 'local:memory:memory_unarchive',
    provider,
    name: 'memory_unarchive',
    invocationName: 'memory_unarchive',
    title: '取消归档',
    description: '取消归档一条记忆，让它重新可以被注入和检索。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: '要取消归档的记忆 ID' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    execution: {
      mode: 'auto',
      enabled: true,
      risk: 'low',
    },
  },
  {
    id: 'local:memory:memory_search',
    provider,
    name: 'memory_search',
    invocationName: 'memory_search',
    title: translate(locale, 'tool.memory.searchTitle'),
    description: translate(locale, 'tool.memory.searchDescription'),
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '检索关键词（如"用户偏好"、"项目约束"、"上次决策"）' },
        topK: { type: 'integer', description: '返回前 K 条结果（默认 5）', default: 5 },
        includeArchived: { type: 'boolean', description: '是否包含已归档的记忆（默认 false，不包含）', default: false },
      },
      required: ['query'],
      additionalProperties: false,
    },
    execution: {
      mode: 'auto',
      enabled: true,
      risk: 'low',
    },
  },
  ];
}

export const MEMORY_TOOL_DESCRIPTORS: ToolDescriptor[] = createMemoryToolDescriptors(DEFAULT_LOCALE);

export function isMemoryToolName(name: string): name is MemoryToolName {
  return (MEMORY_TOOL_NAMES as readonly string[]).includes(name);
}

export async function executeMemoryToolCall(
  runtime: MemoryToolRuntime,
  call: ToolCall,
  locale: SupportedLocale = DEFAULT_LOCALE,
): Promise<ToolResult> {
  if (call.name === 'memory_save') {
    return saveMemory(runtime, call, locale);
  }

  if (call.name === 'memory_update') {
    return updateExistingMemory(runtime, call, locale);
  }

  if (call.name === 'memory_delete') {
    return deleteExistingMemory(runtime, call, locale);
  }

  if (call.name === 'memory_archive') {
    return archiveExistingMemory(runtime, call, locale);
  }

  if (call.name === 'memory_unarchive') {
    return unarchiveExistingMemory(runtime, call, locale);
  }

  if (call.name === 'memory_search') {
    return searchMemory(runtime, call, locale);
  }

  return {
    ok: false,
    name: call.name,
    summary: translate(locale, 'tool.memory.unsupported'),
    error: {
      code: 'memory_tool_unsupported',
      message: `Unsupported memory tool: ${call.name}`,
      retryable: false,
    },
  };
}

async function saveMemory(
  runtime: MemoryToolRuntime,
  call: ToolCall,
  locale: SupportedLocale,
): Promise<ToolResult> {
  const parsed = parseMemorySavePayload(call, locale);
  if (!parsed.ok) return parsed.result;

  const saved = await runtime.saveMemory({
    type: parsed.memory.type,
    name: parsed.memory.name,
    content: parsed.memory.content,
    description: parsed.memory.name,
    tags: parsed.memory.tags,
    pinned: false,
  });

  if (!saved?.id) {
    return failure(
      call,
      'memory_save_failed',
      translate(locale, 'tool.memory.saveFailed'),
      translate(locale, 'tool.memory.saveMissingConfirmation'),
      true,
    );
  }

  return success(call, locale, translate(locale, 'tool.memory.saved'), parsed.memory.name, { id: saved.id });
}

function parseMemorySavePayload(
  call: ToolCall,
  locale: SupportedLocale,
): { ok: true; memory: Pick<NewMemory, 'type' | 'name' | 'content' | 'tags'> } | { ok: false; result: ToolResult } {
  const payload = call.payload;
  const type = memoryTypeValue(payload.type);
  if (!type) {
    return {
      ok: false,
      result: failure(
        call,
        'memory_invalid_payload',
        translate(locale, 'tool.memory.invalidPayload'),
        translate(locale, 'tool.memory.invalidType'),
        false,
      ),
    };
  }

  const name = requiredStringValue(payload.name);
  if (!name) {
    return {
      ok: false,
      result: failure(
        call,
        'memory_invalid_payload',
        translate(locale, 'tool.memory.invalidPayload'),
        translate(locale, 'tool.memory.invalidName'),
        false,
      ),
    };
  }

  const content = requiredStringValue(payload.content);
  if (!content) {
    return {
      ok: false,
      result: failure(
        call,
        'memory_invalid_payload',
        translate(locale, 'tool.memory.invalidPayload'),
        translate(locale, 'tool.memory.invalidContent'),
        false,
      ),
    };
  }

  if (!Array.isArray(payload.tags) || !payload.tags.every((item) => typeof item === 'string')) {
    return {
      ok: false,
      result: failure(
        call,
        'memory_invalid_payload',
        translate(locale, 'tool.memory.invalidPayload'),
        translate(locale, 'tool.memory.invalidTags'),
        false,
      ),
    };
  }

  return {
    ok: true,
    memory: {
      type,
      name,
      content,
      tags: [...payload.tags],
    },
  };
}

async function updateExistingMemory(
  runtime: MemoryToolRuntime,
  call: ToolCall,
  locale: SupportedLocale,
): Promise<ToolResult> {
  const payload = call.payload;
  const id = numberValue(payload.id);
  if (!id) return failure(call, 'memory_invalid_id', translate(locale, 'tool.memory.invalidId'), undefined, false);

  const existing = await runtime.getMemoryById(id);
  if (!existing) {
    return failure(
      call,
      'memory_not_found',
      translate(locale, 'tool.memory.notFound'),
      translate(locale, 'tool.memory.notFoundDetail', { id }),
      false,
    );
  }

  const name = stringValue(payload.name) || existing.name;
  await runtime.updateMemory({
    ...existing,
    type: memoryTypeValue(payload.type) || existing.type,
    name,
    content: stringValue(payload.content) || existing.content,
    description: name || existing.description,
    tags: Array.isArray(payload.tags) ? stringArrayValue(payload.tags) : existing.tags,
  });

  return success(call, locale, translate(locale, 'tool.memory.updated'), name);
}

async function deleteExistingMemory(
  runtime: MemoryToolRuntime,
  call: ToolCall,
  locale: SupportedLocale,
): Promise<ToolResult> {
  const id = numberValue(call.payload.id);
  if (!id) return failure(call, 'memory_invalid_id', translate(locale, 'tool.memory.invalidId'), undefined, false);

  await runtime.deleteMemory(id);
  return success(call, locale, translate(locale, 'tool.memory.deleted'), `#${id}`);
}

async function archiveExistingMemory(
  runtime: MemoryToolRuntime,
  call: ToolCall,
  locale: SupportedLocale,
): Promise<ToolResult> {
  const id = numberValue(call.payload.id);
  if (!id) return failure(call, 'memory_invalid_id', translate(locale, 'tool.memory.invalidId'), undefined, false);

  await runtime.archiveMemory(id);
  return success(call, locale, `已归档 #${id}`, `#${id}`);
}

async function unarchiveExistingMemory(
  runtime: MemoryToolRuntime,
  call: ToolCall,
  locale: SupportedLocale,
): Promise<ToolResult> {
  const id = numberValue(call.payload.id);
  if (!id) return failure(call, 'memory_invalid_id', translate(locale, 'tool.memory.invalidId'), undefined, false);

  await runtime.unarchiveMemory(id);
  return success(call, locale, `已取消归档 #${id}`, `#${id}`);
}

async function searchMemory(
  runtime: MemoryToolRuntime,
  call: ToolCall,
  locale: SupportedLocale,
): Promise<ToolResult> {
  const query = stringValue(call.payload.query);
  if (!query) {
    return failure(call, 'memory_invalid_query', '检索关键词不能为空', undefined, false);
  }

  const topK = Number(call.payload.topK ?? 5);
  const includeArchived = Boolean(call.payload.includeArchived ?? false);

  // 1. 拉取所有记忆
  const allMemories = await runtime.getAllMemories();
  if (allMemories.length === 0) {
    return success(call, locale, '当前没有任何记忆。', undefined, { count: 0 });
  }

  // 2. 用 selector 检索（复用现有逻辑）
  const { selectMemories, formatMemoriesBlock } = await import('../memory/selector');
  // 2026-10-22 真机定位（DPP 八环节验收暴露）：
  //
  // 原实现 `budget: topK * 200`（假设每条约 200 token），而 selectMemories 的
  // budget 循环是「装不下就 break」。真机实测单条记忆可以远超 200 token：
  //
  //   budget = 5 * 200 = 1000
  //   #84 = 1646 token   ← 单条就超过整个 budget
  //   #92 = 1525 / #86 = 644 / #114 = 566 / #113 = 351
  //   通过关键词阈值的共 24 条，最终只返回 1 条
  //
  // 循环细节：第 1 条 1000-1646 = -646，但 selected 为空所以仍 push；
  // 第 2 条 -646-351 < 0 且已有 1 条 → break。**一条长记忆吃光预算，
  // 饿死后面 23 条（含精确匹配但较短的 #113）。**
  //
  // 表现：要 topK=5 条却只拿到 1 条，且 count=1 让人误判成「只匹配到 1 条」，
  // 而不是「匹配到 24 条但只显示了 1 条」。
  //
  // 修法：把「选哪些」与「显示多少」解耦 ——
  //   · selectMemories 用宽松上限，确保拿到完整排序结果；
  //   · slice(0, topK) 取前 K 条；
  //   · 显示时对单条内容截断，保证 topK 条都装得下。
  const selected = selectMemories(query, allMemories, {
    budget: MEMORY_SEARCH_SELECTION_BUDGET,
    includeArchived,
  });

  if (selected.length === 0) {
    return success(
      call,
      locale,
      `没有找到与"${query}"相关的记忆。`,
      undefined,
      { query, count: 0, matched: 0 },
    );
  }

  // 3. 截取 top-K 并格式化（单条内容截断，避免一条长记忆挤掉其余条目）
  const topResults = selected.slice(0, topK).map((memory) => ({
    ...memory,
    content: truncateMemoryContentForSearch(memory.content),
  }));
  const header = `找到 ${topResults.length} 条与"${query}"相关的记忆：\n`;
  const body = formatMemoriesBlock(topResults);

  return success(
    call,
    locale,
    header + body,
    undefined,
    // matched = 通过关键词阈值的总数；count = 本次实际返回条数。
    // 分开之后调用方才能区分「只匹配到 1 条」与「匹配很多但只给了 1 条」。
    { query, count: topResults.length, matched: selected.length },
  );
}

/**
 * selectMemories 的选择预算上限。
 *
 * 只作安全上限（防止把上万条记忆全排一遍），不参与「显示多少」的决策。
 * 设得足够大，确保按分数排好序的完整结果能拿到，再由调用方 slice(0, topK)。
 */
const MEMORY_SEARCH_SELECTION_BUDGET = 200_000;

/** 检索结果里单条记忆的最大字符数；超出部分截断并标注。 */
const MEMORY_SEARCH_CONTENT_MAX_CHARS = 600;

function truncateMemoryContentForSearch(content: string): string {
  const text = String(content ?? '');
  if (text.length <= MEMORY_SEARCH_CONTENT_MAX_CHARS) return text;
  const omitted = text.length - MEMORY_SEARCH_CONTENT_MAX_CHARS;
  return `${text.slice(0, MEMORY_SEARCH_CONTENT_MAX_CHARS)}…（截断，省略 ${omitted} 字）`;
}

function success(
  call: ToolCall,
  locale: SupportedLocale,
  summary: string,
  detail?: string,
  output?: JsonValue,
): ToolResult {
  return {
    ok: true,
    name: call.name,
    callId: call.id,
    descriptorId: call.descriptorId,
    provider: call.provider ?? createMemoryToolProviderIdentity(locale),
    summary,
    detail,
    output,
  };
}

function failure(
  call: ToolCall,
  code: string,
  summary: string,
  detail: string | undefined,
  retryable: boolean,
): ToolResult {
  return {
    ok: false,
    name: call.name,
    callId: call.id,
    descriptorId: call.descriptorId,
    provider: call.provider ?? MEMORY_TOOL_PROVIDER,
    summary,
    detail,
    error: {
      code,
      message: detail ?? summary,
      retryable,
    },
  };
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function requiredStringValue(value: unknown): string {
  return typeof value === 'string' && value.trim().length > 0 ? value : '';
}

function numberValue(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function memoryTypeValue(value: unknown): MemoryType | null {
  return typeof value === 'string' && MEMORY_TYPES.includes(value as MemoryType)
    ? value as MemoryType
    : null;
}

function stringArrayValue(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}
