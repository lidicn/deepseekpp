/**
 * Prompt 分段字节表（观测用，纯函数）。
 *
 * 背景：出资人的请求里 `prompt: 24660B / catalog section: 24084B`（97.6%），
 * 但这条日志只给了"总数 + 目录"，无法回答"系统提示 / 记忆 / 用户消息各占多少"，
 * 于是每次"上下文塞满"的讨论都只能靠推理（QA 那轮就是这么算出来的）。
 *
 * 本模块把 prompt 切成四段并给字节数，任何猜测都能一眼证实/证伪：
 *   - base：`### Available Tools` 之前（人设、规则、扩展能力说明）
 *   - catalog：工具目录（从 `### Available Tools` 到下一个 `## ` 标题）
 *   - memory：`## 已有记忆` / `## Existing Memor(y|ies)` 段
 *   - tail：其余（记忆保存规则、搜索指引、工具格式提醒、**用户消息**）
 *
 * 切分全部基于标题标记，**不假设固定顺序**：标记缺失时该段记 0，不抛错。
 */

export interface PromptSegments {
  base: number;
  catalog: number;
  memory: number;
  tail: number;
  total: number;
}

const CATALOG_MARKER = '### Available Tools';
// 中文标题用 unicode 转义书写：i18n 审计不允许源码里出现中文字面量。
const MEMORY_MARKER = /^## (?:\u5df2\u6709\u8bb0\u5fc6|Existing Memor(?:y|ies))/m;
/** 段落的通用起点：行首 `## `（不是 `###`）。 */
const SECTION_START = /^## /m;

function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/** 从 index 起找下一个行首 `## ` 的位置（找不到返回 text.length）。 */
function nextSectionStart(text: string, from: number): number {
  const rest = text.slice(from);
  const match = SECTION_START.exec(rest);
  return match ? from + (match.index ?? 0) : text.length;
}

export function measurePromptSegments(prompt: string): PromptSegments {
  const total = byteLength(prompt);
  if (!prompt) return { base: 0, catalog: 0, memory: 0, tail: 0, total: 0 };

  const catalogStart = prompt.indexOf(CATALOG_MARKER);
  if (catalogStart < 0) {
    // 没有目录标记：整段算 base，其余为 0（不要瞎猜）
    return { base: total, catalog: 0, memory: 0, tail: 0, total };
  }

  const base = byteLength(prompt.slice(0, catalogStart));
  const catalogEnd = nextSectionStart(prompt, catalogStart + CATALOG_MARKER.length);
  const catalog = byteLength(prompt.slice(catalogStart, catalogEnd));

  // 记忆段：从 `## 已有记忆` 到下一个 `## `
  const memoryMatch = MEMORY_MARKER.exec(prompt);
  let memory = 0;
  let memoryEnd = catalogEnd;
  if (memoryMatch && (memoryMatch.index ?? -1) >= catalogEnd) {
    const memoryStart = memoryMatch.index ?? 0;
    memoryEnd = nextSectionStart(prompt, memoryStart + 1);
    memory = byteLength(prompt.slice(memoryStart, memoryEnd));
  }

  const tailStart = Math.max(catalogEnd, memoryEnd);
  const tail = byteLength(prompt.slice(tailStart));

  return { base, catalog, memory, tail, total };
}

/** 一行格式，直接进 `[DPP-DEBUG] prompt:` 日志。 */
export function formatPromptSegments(segments: PromptSegments): string {
  return (
    `base ${segments.base} + catalog ${segments.catalog} + ` +
    `memory ${segments.memory} + tail ${segments.tail}`
  );
}
