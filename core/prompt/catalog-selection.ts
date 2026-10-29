/**
 * 工具目录预算与选择（2026-10-30，`断流根因与修复方案` 的主改）。
 *
 * 事实：出资人请求 `prompt: 24660B`，其中 `catalog section: 24084B`（**97.6%**），
 * 42 个工具 ≈ 570B/工具。目录已经过一轮 R2 压缩（compact + shared region + 省略示例），
 * 继续瘦身描述收益 ≤30% ⇒ 必须靠**选择**：完整块只给 top-k，其余只给名字。
 *
 * 为什么这样安全：catalog 只是**说明书**，工具调用由解析器按名字解析。
 * 隐藏某个工具的完整参数**不会让它不可调用**，只会让模型少知道细节；
 * 名称索引保证它仍然知道自己有哪些工具。
 *
 * 回滚开关（无需改代码）：`localStorage.setItem('dpp:catalogBudget', '0')` ⇒ 全量（今日行为）。
 */

/** 默认预算：24,084B → ≤8,000B（约 -67%）。 */
export const DEFAULT_CATALOG_BUDGET_BYTES = 8_000;

/** 目录固定开销预留（共享区 + shell/python 提示 + 分隔符）。 */
// 真机实测：共享区 + shell/python 提示 + hiddenSummary ≈ 2.9KB。
// 预留按实测抬高，否则 catalog 会稳定超预算（实测 9,442B > 8,000B 目标）。
export const DEFAULT_CATALOG_RESERVE_BYTES = 3_200;

/** 名称索引里每个工具标题的最大字符数。 */
const INDEX_TITLE_MAX_CHARS = 40;

/** 名称索引段标题（与模板里 `### Available Tools` 同为英文，保持风格一致）。 */
export const CATALOG_NAME_INDEX_HEADER = '### Other tools (name only)';

/** 永远给完整块的工具（核心能力，缺了模型就干不成事）。 */
export const ALWAYS_FULL_TOOLS: readonly string[] = [
  'memory_save',
  'web_search',
  'web_fetch',
];

export interface CatalogToolLike {
  readonly name: string;
  readonly title: string;
  readonly description: string;
}

export interface CatalogSelectionResult<T> {
  /** 渲染完整参数块的工具。 */
  full: T[];
  /** 只渲染一行名字的工具（保证可发现性）。 */
  indexOnly: T[];
  bytes: { full: number; index: number; total: number };
  /** 命中预算、被判为"值得给完整块"的数量（便于观测）。 */
  selectedCount: number;
}

export interface CatalogSelectionInput<T extends CatalogToolLike> {
  tools: readonly T[];
  userText: string;
  /** 精确测量某工具完整块的字节数（由调用方注入，避免与模板重复实现）。 */
  measure: (tool: T) => number;
  alwaysInclude?: readonly string[];
  /** 0 或负数 ⇒ 关闭选择，全部给完整块（回滚用）。 */
  budgetBytes: number;
  /**
   * 预算里要**预留给目录固定开销**的字节数（共享区、shell/python 提示、分隔符）。
   * 不预留的话实测会超：完整块 8,000 + 共享区/索引 ≈ 1,800 ⇒ catalog 9,808B。
   */
  reserveBytes?: number;
}

function tokenize(text: string): string[] {
  const lower = text.toLowerCase();
  const tokens = lower.split(/[^a-z0-9_\u4e00-\u9fff]+/).filter((t) => t.length >= 2);
  return [...new Set(tokens)].slice(0, 200);
}

/** 打分：名字命中 > 描述命中；alwaysInclude 直接置顶。 */
export function scoreCatalogTool(
  tool: CatalogToolLike,
  tokens: readonly string[],
  alwaysInclude: readonly string[],
): number {
  if (alwaysInclude.includes(tool.name)) return 1_000;
  const name = tool.name.toLowerCase();
  const title = (tool.title ?? '').toLowerCase();
  const description = (tool.description ?? '').toLowerCase();
  let score = 0;
  for (const token of tokens) {
    if (name.includes(token)) score += 6;
    else if (title.includes(token)) score += 3;
    else if (description.includes(token)) score += 1;
  }
  return score;
}

export function renderCatalogNameIndex(tools: readonly CatalogToolLike[]): string {
  if (tools.length === 0) return '';
  const lines = tools.map((tool) => {
    const title = (tool.title ?? '').replace(/\s+/g, ' ').trim();
    const short = title.length > INDEX_TITLE_MAX_CHARS
      ? `${title.slice(0, INDEX_TITLE_MAX_CHARS)}…`
      : title;
    return `- ${tool.name}: ${short}`;
  });
  return [CATALOG_NAME_INDEX_HEADER, ...lines].join('\n');
}

function indexBytes(tools: readonly CatalogToolLike[]): number {
  const text = renderCatalogNameIndex(tools);
  return text ? new TextEncoder().encode(text).byteLength : 0;
}

/**
 * 选择（纯函数，除缓存外无副作用）。
 * 保证：`full.length + indexOnly.length === tools.length` —— 一个都不丢。
 */
export function selectCatalogTools<T extends CatalogToolLike>(
  input: CatalogSelectionInput<T>,
): CatalogSelectionResult<T> {
  const tools = input.tools;
  if (tools.length === 0) {
    return { full: [], indexOnly: [], bytes: { full: 0, index: 0, total: 0 }, selectedCount: 0 };
  }

  // 关闭：全部完整块（回滚路径，必须与今日字节级一致）
  if (!(input.budgetBytes > 0)) {
    const fullBytes = tools.reduce((sum, tool) => sum + input.measure(tool), 0);
    return {
      full: [...tools],
      indexOnly: [],
      bytes: { full: fullBytes, index: 0, total: fullBytes },
      selectedCount: tools.length,
    };
  }

  const alwaysInclude = input.alwaysInclude ?? ALWAYS_FULL_TOOLS;
  const tokens = tokenize(input.userText);

  // 稳定排序：分数降序，同分保持原始顺序（确定性）
  const ranked = tools
    .map((tool, index) => ({
      tool,
      index,
      score: scoreCatalogTool(tool, tokens, alwaysInclude),
    }))
    .sort((a, b) => (b.score - a.score) || (a.index - b.index));

  const full: T[] = [];
  const indexOnly: T[] = [];
  let fullBytes = 0;

  for (const entry of ranked) {
    const cost = input.measure(entry.tool);
    const isAlways = alwaysInclude.includes(entry.tool.name);
    if (isAlways || fullBytes + cost <= input.budgetBytes) {
      full.push(entry.tool);
      fullBytes += cost;
    } else {
      indexOnly.push(entry.tool);
    }
  }

  // 索引回填：名称索引本身也占字节，若 full + index 超出 (预算 - 预留)，
  // 就把**分数最低的非必留工具**降级成"只给名字"，直到装得下。
  const reserve = input.reserveBytes ?? DEFAULT_CATALOG_RESERVE_BYTES;
  const limit = input.budgetBytes - reserve;
  while (full.length > 0) {
    const indexSize = indexBytes(indexOnly);
    if (fullBytes + indexSize <= limit) break;
    // 从尾部（分数最低、非 alwaysInclude）开始降级
    let demoteAt = -1;
    for (let i = full.length - 1; i >= 0; i -= 1) {
      if (!alwaysInclude.includes(full[i]!.name)) {
        demoteAt = i;
        break;
      }
    }
    if (demoteAt < 0) break; // 全是必留工具：装不下也只能这样
    const [demoted] = full.splice(demoteAt, 1);
    fullBytes -= input.measure(demoted!);
    indexOnly.push(demoted!);
  }

  // 恢复原始顺序渲染（与今日目录排序逻辑解耦，由调用方再排序）
  const order = new Map(tools.map((tool, i) => [tool, i] as const));
  full.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
  indexOnly.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));

  const indexSize = indexBytes(indexOnly);
  return {
    full,
    indexOnly,
    bytes: { full: fullBytes, index: indexSize, total: fullBytes + indexSize },
    selectedCount: full.length,
  };
}

/**
 * 读取预算（同步）。优先级：localStorage 覆盖 > 默认值。
 * 控制台回滚：`localStorage.setItem('dpp:catalogBudget', '0')`，再发一次请求即生效。
 */
export function resolveCatalogBudgetBytes(): number {
  try {
    const raw = globalThis.localStorage?.getItem('dpp:catalogBudget');
    if (typeof raw === 'string' && raw.trim().length > 0) {
      const parsed = Number(raw);
      if (Number.isFinite(parsed) && parsed >= 0) return parsed;
    }
  } catch {
    // 读不到就用默认值
  }
  return DEFAULT_CATALOG_BUDGET_BYTES;
}
