/**
 * 记忆整理 LLM 的系统 Prompt 构造。
 */

import type { MemorySnapshot } from './natural-language-organize';

export function buildOrganizeSystemPrompt(): string {
  return `你是一个记忆整理助手。用户会用自然语言描述如何整理记忆。
你需要输出一个 JSON draft，包含以下字段：
- operations: 操作列表（数组）
- summary: 一句话摘要（字符串）
- ready: 是否准备好执行（布尔值）
- issues: 问题列表（数组，每项包含 code / severity / message）

记忆列表中每条记忆的字段：
- id: 记忆 ID（数字，操作时需要用到）
- name: 记忆标题
- content: 记忆内容
- tags: 标签数组（合法取值：preference | constraint | procedure | goal | decision）
- type: 记忆类型（user | feedback | topic | reference）
- scope: 作用域（global | project）

支持的操作类型：
- delete: 删除指定记忆（需要 memoryId）
- archive: 归档指定记忆（需要 memoryId）
- pin / unpin: 置顶 / 取消置顶（需要 memoryId）
- merge: 合并多个记忆（需要 memoryIds + mergedContent）
- retitle: 重命名记忆（需要 memoryId + newTitle）
- retag: 重新打 tag（需要 memoryId + newTags）
- compress: 缩短内容（需要 memoryId + compressedContent）
- clean_stale: 清理过期记忆（需要 memoryIds）

筛选记忆的规则：
- 「偏好类记忆」→ 筛选 type=user 或 tags 里包含 preference 的记忆
- 「约束类记忆」→ 筛选 tags 里包含 constraint 的记忆
- 「目标类记忆」→ 筛选 tags 里包含 goal 的记忆
- 「过期记忆」→ 筛选 updatedAt 较早或 accessCount 较低的记忆
- 「相似记忆」→ 筛选 name 或 content 语义相近的记忆

打 tag 规则：
- retag 操作的 newTags 是完整的新 tags 列表，会覆盖原有 tags
- 如果只是想加一个 tag，要先把原有 tags 列出来，再加上新 tag

只输出 JSON，不要额外解释。不要用 markdown 代码块包裹。`;
}

export function buildOrganizeUserPrompt(
  instruction: string,
  memories: MemorySnapshot[],
): string {
  const memoriesJson = JSON.stringify(
    memories.map((m) => ({
      id: m.id,
      name: m.name,
      content: m.content.slice(0, 500), // 截断，避免 prompt 太长
      tags: m.tags,
      type: m.type,
      scope: m.scope,
      updatedAt: m.updatedAt,
      pinned: m.pinned,
      archived: m.archived,
    })),
    null,
    2,
  );

  return `记忆列表：
${memoriesJson}

用户输入：
${instruction}

请输出 JSON draft。`;
}
