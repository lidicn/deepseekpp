/**
 * 首轮窄化注入：只从**最终 prompt**里剥掉「记忆段」与「工具目录段」（含其广告尾段），
 * 其余注入（系统提示 / 技能激活 / preset / 项目上下文 / model_type / 工具描述符）全部保留。
 *
 * 背景（2026-11-01 收口）：
 * - 首轮全量注入 13,612B（base 576 + catalog 4,658 + memory 8,378）时，「服务器暂时不可用」3/6；
 *   整段不注入（43B）时 0/6 ⇒ 触发点是首轮 prompt 体积。
 * - 但「整段不注入」把首轮能力一起砍掉了（技能/preset/model_type/系统提示全丢）。
 *   ⇒ 折中：首轮只剥"记忆 + 工具广告"，把首轮压到 ≤2KB，其余能力保留。
 *
 * 剥离标记与 `core/debug/prompt-segments.ts` **同构**（同一对 marker / 同一个「段末 = 下一个
 * 行首 `## `」定义），保证「剥了什么」和「量到什么」是同一件事，不会出现"改了但量不出来"。
 *
 * 安全边界（必须保留）：
 * - 段末查找**绝不跨过**可见用户输入起点（`VISIBLE_USER_PROMPT_START`）与工具格式提醒标题；
 *   否则当记忆段是最后一段时会把用户原文一起删掉。
 * - 无 marker 时原样返回（幂等）；重复调用第二次不再改动。
 */

export const FIRST_TURN_CATALOG_MARKER = '### Available Tools';
export const FIRST_TURN_MEMORY_MARKER = /^## (?:\u5df2\u6709\u8bb0\u5fc6|Existing Memor(?:y|ies))/m;
/** 与 prompt-segments 一致：段末 = 下一个行首 `## `（不是 `###`）。 */
const SECTION_START = /^## /gm;
/** 可见用户输入起点：段末不得越过这里。 */
const VISIBLE_USER_PROMPT_START = '<!-- deepseek-pp-visible-user-prompt:start -->';
/** 可见用户输入的元数据行前缀（在 start 标记之前）：段末同样不得越过。 */
const VISIBLE_USER_PROMPT_METADATA_PREFIX = '<!-- deepseek-pp-visible-user-prompt:value=';
/** 工具格式提醒标题：段末不得越过这里。 */
const TOOL_REMINDER_HEADING = 'Tool call format reminder:';

export interface FirstTurnStripResult {
  prompt: string;
  strippedCatalog: boolean;
  strippedMemory: boolean;
  /**
   * 工具格式提醒尾段也被剥掉。
   *
   * 它是同一族「工具广告」：`Available tool tag names: <全部工具名+别名> …`。
   * 首轮不注入工具目录时保留它，会让首轮 prompt 随工具数量膨胀（默认描述符下 4.9KB，
   * 直接击穿 ≤2KB 判据），且与「首轮不广告工具」自相矛盾。
   * 工具描述符本身仍由 RequestContext 携带（解析/执行不受影响）。
   */
  strippedToolReminder: boolean;
}

/** 从 `from` 起找下一个行首 `## ` 的位置（找不到返回 text.length）。 */
function nextSectionStart(text: string, from: number): number {
  SECTION_START.lastIndex = Math.max(0, from);
  const match = SECTION_START.exec(text);
  return match ? match.index : text.length;
}

/**
 * 段末：下一个 `## `，但**不得**跨过用户输入 / 工具提醒这些安全边界。
 * 这是本模块唯一需要"防御"的地方 —— 少了它，最后一段被剥时会连用户原文一起吞掉。
 *
 * 注意：可见用户输入的**元数据行**（`value=...`）在 start 标记之前，必须单独算边界；
 * 少了它，记忆段是最后一段时会把元数据一起删掉，`extractVisibleUserPrompt` 就会退化成
 * "整段被包装过的可见文本"（技能指令会被当成用户原话）。
 */
function safeSectionEnd(text: string, from: number): number {
  let end = nextSectionStart(text, from);
  for (const boundary of [
    VISIBLE_USER_PROMPT_METADATA_PREFIX,
    VISIBLE_USER_PROMPT_START,
    TOOL_REMINDER_HEADING,
  ]) {
    const index = text.indexOf(boundary, from);
    if (index >= 0 && index < end) end = index;
  }
  return end;
}

/** 只收敛剥离产生的空行（3+ 连续换行 → 一个空行），不改动其它内容。 */
function collapseSeamBlankLines(text: string): string {
  return text.replace(/\n{3,}/g, '\n\n');
}

export function stripFirstTurnOptionalSections(prompt: string): FirstTurnStripResult {
  if (!prompt) {
    return {
      prompt,
      strippedCatalog: false,
      strippedMemory: false,
      strippedToolReminder: false,
    };
  }

  let text = prompt;
  let strippedCatalog = false;
  let strippedMemory = false;
  let strippedToolReminder = false;

  const catalogStart = text.indexOf(FIRST_TURN_CATALOG_MARKER);
  if (catalogStart >= 0) {
    const catalogEnd = safeSectionEnd(text, catalogStart + FIRST_TURN_CATALOG_MARKER.length);
    text = text.slice(0, catalogStart) + text.slice(catalogEnd);
    strippedCatalog = true;
  }

  const memoryMatch = FIRST_TURN_MEMORY_MARKER.exec(text);
  if (memoryMatch && typeof memoryMatch.index === 'number') {
    const memoryStart = memoryMatch.index;
    const memoryEnd = safeSectionEnd(text, memoryStart + 1);
    text = text.slice(0, memoryStart) + text.slice(memoryEnd);
    strippedMemory = true;
  }

  const reminderIndex = text.indexOf(TOOL_REMINDER_HEADING);
  if (reminderIndex >= 0) {
    // 模板里提醒以 `\n\n---\n` 开头：把分隔线一起剥掉，避免留下悬空的分隔符。
    const beforeReminder = text.slice(0, reminderIndex);
    const withoutSeparator = beforeReminder.replace(/\n+---\n+$/, '');
    const start = withoutSeparator === beforeReminder ? reminderIndex : withoutSeparator.length;
    text = text.slice(0, start);
    strippedToolReminder = true;
  }

  return {
    prompt: collapseSeamBlankLines(text).trimEnd(),
    strippedCatalog,
    strippedMemory,
    strippedToolReminder,
  };
}
