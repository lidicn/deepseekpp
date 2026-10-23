import type { Memory } from '../types';
import { MEMORY_TOKEN_BUDGET, STOP_WORDS } from '../constants';
import { DEFAULT_LOCALE, translate, type SupportedLocale } from '../i18n/background';
import { estimateTokens } from '../token/estimator';
import { wrapUntrustedMemoryContent } from './untrusted-content';

export { estimateTokens } from '../token/estimator';

// 相关性门控阈值（供 digest.ts / augmentation.ts 等**注入侧**复用）
//
// 2026-10-23 复核结论：这两个阈值原先都是 1（`e99d64e` 把 global 从 5 降到 1，
// 注释写「方案甲：门控只做 0 分剔除」）。但 `keywordScore` 里 content 命中
// 一次就是 5 分，所以 `>= 1` 实际等价于「有任何一点点词重叠就放行」——
// 真机实测 114 条记忆里有 24 条通过门控，门控形同虚设。
//
// 更关键的是**语境差异**：注入侧（L2 digest / prompt augmentation）是模型
// 自己决定塞进系统提示的，塞错就是噪音 + 烧 token，应当**严格**；
// 而显式检索（`memory_search`，用户主动提问）宽松才对——
// 用户问了就该给结果，不该被门控拦空。
//
// 所以这里恢复 global 的严格阈值，并新增 `minKeywordScore` 覆盖项，
// 供 `memory_search` 显式放宽（见 `core/tool/memory.ts`）。
//
// 阈值取 10 的语义（对应 keywordScore 的权重：tag 20 / name 15 / content 5/词）：
//   · 一个标签命中 (20)     → 通过
//   · 一个名字命中 (15)     → 通过
//   · 一个内容词命中 (5)    → **不通过**（太弱，纯噪音）
//   · 两个内容词命中 (10)   → 通过
// 注意不能取 5：那正好等于单次内容命中的权重，`>= 5` 会让一次弱命中就放行，
// 等于没门控（本次实测发现，已用测试锁住）。
export const MIN_KEYWORD_SCORE_PROJECT = 1;
export const MIN_KEYWORD_SCORE_GLOBAL = 10;

/**
 * 内容命中的长度归一基准（分词后的词数）。
 *
 * 问题：`contentHits` 统计「记忆内容里有多少个**不同词**命中了 prompt」。
 * 长记忆词更多，命中机会天然更多——不归一化会让长记忆系统性压过
 * 精确但简短的记忆。实测（`memory_search` 真机数据）：#84（1646 token，
 * 长内容）排在 #113（351 token，精确匹配）之上。
 *
 * 做法：词数在基准以内不压制；超出后按 `sqrt` 比例压制。
 * 用 sqrt 而不是全比例，是为了不把「内容全面且确实相关」的长记忆压死。
 */
const CONTENT_LENGTH_NORM_BASE_WORDS = 16;

/** 词数在基准内返回 1；超出后按 sqrt 次线性衰减。 */
function lengthFactor(wordCount: number): number {
  if (wordCount <= CONTENT_LENGTH_NORM_BASE_WORDS) return 1;
  return Math.sqrt(CONTENT_LENGTH_NORM_BASE_WORDS / wordCount);
}

const segmenter =
  typeof Intl !== 'undefined' && Intl.Segmenter
    ? new Intl.Segmenter('zh-Hans', { granularity: 'word' })
    : null;

const SEGMENT_CACHE_LIMIT = 1000;
const segmentCache = new Map<string, string[]>();

export function segmentText(text: string): string[] {
  const cached = segmentCache.get(text);
  if (cached) return cached;

  const words = segmenter
    ? [...segmenter.segment(text)]
      .filter((s) => s.isWordLike)
      .map((s) => s.segment.toLowerCase())
      .filter((w) => w.length > 1 && !STOP_WORDS.has(w))
    : text
      .toLowerCase()
      .split(/[\s,，。！？；：、\-_/]+/)
      .filter((w) => w.length > 1 && !STOP_WORDS.has(w));

  if (segmentCache.size >= SEGMENT_CACHE_LIMIT) {
    const firstKey = segmentCache.keys().next().value;
    if (firstKey !== undefined) segmentCache.delete(firstKey);
  }
  segmentCache.set(text, words);
  return words;
}

export function keywordScore(promptWords: string[], memory: Memory): number {
  const promptSet = new Set(promptWords);

  let tagHits = 0;
  for (const tag of memory.tags) {
    const tagLower = tag.toLowerCase();
    if (tagLower.length > 1 && promptSet.has(tagLower)) tagHits++;
    for (const pw of promptWords) {
      if (pw.length > 2 && tagLower.includes(pw) && tagLower !== pw) tagHits += 0.5;
    }
  }

  const nameWords = segmentText(memory.name);
  let nameHits = 0;
  for (const w of nameWords) {
    if (promptSet.has(w)) nameHits++;
  }

  const contentWords = segmentText(memory.content);
  let contentHits = 0;
  for (const w of contentWords) {
    if (promptSet.has(w)) contentHits++;
  }

  // 内容分做长度归一：长内容词多、命中机会多，不归一会系统性压过简短精确的记忆。
  // tag / name 不归一 —— 标签数量有限、名字本身就短，没有这个问题。
  const contentScore = contentHits * 5 * lengthFactor(contentWords.length);

  return tagHits * 20 + nameHits * 15 + contentScore;
}

function decayScore(memory: Memory): number {
  const daysSinceAccess = (Date.now() - memory.lastAccessedAt) / 86_400_000;
  const freshness = Math.max(0, 10 - daysSinceAccess * 0.1);
  return Math.min(memory.accessCount, 20) + freshness;
}

export interface SelectOptions {
  budget?: number;
  identityOnly?: boolean;
  /** 是否包含归档的记忆（默认 false，不包含） */
  includeArchived?: boolean;
  /**
   * 覆盖默认门控阈值。
   *
   * - **不传**：注入侧语义 —— global 用 `MIN_KEYWORD_SCORE_GLOBAL`(5)，
   *   project 用 `MIN_KEYWORD_SCORE_PROJECT`(1)。宁缺勿滥。
   * - **显式检索传 1 或 0**：`memory_search` 这类用户主动发起的查询应宽松，
   *   用户问了就该给结果，不该被门控拦空。
   */
  minKeywordScore?: number;
}

export function getMemoryBudget(promptTokens: number): number {
  if (promptTokens > 3000) {
    return Math.max(800, MEMORY_TOKEN_BUDGET - Math.floor((promptTokens - 3000) * 0.2));
  }
  return MEMORY_TOKEN_BUDGET;
}

export function selectMemories(
  prompt: string,
  allMemories: Memory[],
  options?: SelectOptions,
): Memory[] {
  if (allMemories.length === 0) return [];

  const {
    budget = MEMORY_TOKEN_BUDGET,
    identityOnly = false,
    includeArchived = false,
    minKeywordScore,
  } = options ?? {};

  // 先过滤 archived 的记忆（除非 includeArchived 为 true）
  const activeMemories = includeArchived
    ? allMemories
    : allMemories.filter((m) => !m.archived);
  if (activeMemories.length === 0) return [];

  const candidates = identityOnly
    ? activeMemories.filter((m) => m.type === 'user' || m.type === 'feedback' || m.pinned)
    : activeMemories;

  if (candidates.length === 0) return [];

  const promptWords = segmentText(prompt);

  const scored = candidates
    .map((m) => {
      const kwScore = keywordScore(promptWords, m);
      const isGlobal = m.scope === undefined || m.scope === 'global';
      // 显式检索可用 minKeywordScore 覆盖注入侧的严格阈值（见 SelectOptions 注释）
      const minScore = minKeywordScore
        ?? (isGlobal ? MIN_KEYWORD_SCORE_GLOBAL : MIN_KEYWORD_SCORE_PROJECT);
      // Pinned memories bypass the relevance threshold (user explicitly pinned them)
      // Archived memories need stricter threshold (archived = weakened, should be harder to recall)
      const effectiveMin = m.archived ? minScore * 3 : minScore;
      const passesThreshold = m.pinned || kwScore >= effectiveMin;
      return {
        memory: m,
        passesThreshold,
        score:
          (m.pinned ? 1000 : 0) +
          kwScore +
          decayScore(m) +
          (Date.now() - m.lastAccessedAt < 3600_000 ? 5 : 0),
      };
    })
    .filter((item) => item.passesThreshold);

  if (scored.length === 0) return [];

  scored.sort((a, b) => b.score - a.score);

  const selected: Memory[] = [];
  let remaining = budget;

  for (const { memory } of scored) {
    const cost = estimateTokens(formatMemoryLine(memory));
    if (remaining - cost < 0 && selected.length > 0) break;
    selected.push(memory);
    remaining -= cost;
  }

  return selected;
}

function sanitizeContent(text: string): string {
  return text.replace(/｜DSML｜/g, '|DSML|');
}

export function formatMemoryLine(m: Memory): string {
  const idPrefix = m.id != null ? `#${m.id} ` : '';
  const scopePrefix = m.scope === 'project' ? 'project ' : '';
  return `- ${idPrefix}[${scopePrefix}${m.type}] ${sanitizeContent(m.name)}: ${sanitizeContent(m.content)}`;
}

export function formatMemoriesBlock(
  memories: Memory[],
  locale: SupportedLocale = DEFAULT_LOCALE,
): string {
  if (memories.length === 0) return translate(locale, 'prompt.memoryEmpty');
  const body = memories.map(formatMemoryLine).join('\n');
  // 2026-10-20：记忆是自动抽取的历史内容，按不可信数据处理。
  // 详见 core/memory/untrusted-content.ts —— 修复「记忆里的链接导致 agent 自行导航、每次多开 tab」。
  return wrapUntrustedMemoryContent(body, locale);
}
