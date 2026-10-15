/**
 * 自然语言 → 记忆整理 draft（v1.0 · P3）。
 *
 * 管线：instruction → Prompt 构造 →（LLM | 本地规则）→ 严格解码 → draft。
 * 本模块永不执行：`organizeMemoriesFromNaturalLanguage` 只产出 draft；
 * 执行必须由上层拿到用户确认后走 `applyMemoryOrganizeDraft`。
 */

export type MemoryOrganizeOperationType =
  | 'list_all'
  | 'delete'
  | 'archive'
  | 'pin'
  | 'unpin'
  | 'merge'
  | 'retitle'
  | 'retag'
  | 'compress'
  | 'clean_stale';

export interface MemoryOrganizeOperation {
  type: MemoryOrganizeOperationType;
  memoryId?: number;
  memoryIds?: number[];
  newTitle?: string;
  newTags?: string[];
  mergedContent?: string;
  compressedContent?: string;
  tags?: string[];
  reason?: string;
}

export interface MemoryOrganizeDraft {
  operations: MemoryOrganizeOperation[];
  summary: string;
  ready: boolean;
  baseTime: number;
  issues: readonly { code: string; severity: 'info' | 'warning' | 'error'; message: string }[];
}

export interface MemorySnapshot {
  id: number;
  name: string;
  content: string;
  tags: string[];
  scope: string;
  type: string;
  updatedAt: number;
  accessCount: number;
  pinned: boolean;
  archived: boolean;
}

/* ------------------------------------------------------------------ *
 * ① 记忆快照构造
 * ------------------------------------------------------------------ */

export function readMemoryText(memory: { content?: string; text?: string; summary?: string; body?: string }): string {
  return memory.content ?? memory.text ?? memory.summary ?? memory.body ?? '';
}

export function normalizeMemoryText(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function memoryTextSimilarity(a: string, b: string): number {
  const normalizedA = normalizeMemoryText(a);
  const normalizedB = normalizeMemoryText(b);
  if (!normalizedA || !normalizedB) return 0;

  const bigramsA = new Set<string>();
  for (let i = 0; i < normalizedA.length - 1; i++) {
    bigramsA.add(normalizedA.slice(i, i + 2));
  }
  const bigramsB = new Set<string>();
  for (let i = 0; i < normalizedB.length - 1; i++) {
    bigramsB.add(normalizedB.slice(i, i + 2));
  }

  let intersection = 0;
  for (const bigram of bigramsA) {
    if (bigramsB.has(bigram)) intersection++;
  }
  const union = bigramsA.size + bigramsB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export function buildMemorySnapshots(
  memories: Array<{
    id?: number;
    name?: string;
    content?: string;
    text?: string;
    summary?: string;
    body?: string;
    tags?: string[];
    scope?: string;
    type?: string;
    updatedAt?: number;
    accessCount?: number;
    pinned?: boolean;
    archived?: boolean;
  }>,
): MemorySnapshot[] {
  return memories
    .filter((m) => m.id !== undefined)
    .map((m, index) => ({
      id: m.id!,
      name: m.name ?? readMemoryText(m).slice(0, 50) || `记忆 ${index + 1}`,
      content: readMemoryText(m),
      tags: m.tags ?? [],
      scope: m.scope ?? 'global',
      type: m.type ?? 'unknown',
      updatedAt: m.updatedAt ?? Date.now(),
      accessCount: m.accessCount ?? 0,
      pinned: m.pinned ?? false,
      archived: m.archived ?? false,
    }));
}

/* ------------------------------------------------------------------ *
 * ④ 本地规则兜底
 * ------------------------------------------------------------------ */

export function groupNearDuplicateMemories(
  snapshots: MemorySnapshot[],
  options?: { threshold?: number },
): MemorySnapshot[][] {
  const threshold = options?.threshold ?? 0.8;
  const groups: MemorySnapshot[][] = [];
  const visited = new Set<number>();

  for (let i = 0; i < snapshots.length; i++) {
    if (visited.has(i)) continue;
    const group = [snapshots[i]];
    visited.add(i);
    for (let j = i + 1; j < snapshots.length; j++) {
      if (visited.has(j)) continue;
      const similarity = memoryTextSimilarity(snapshots[i].content, snapshots[j].content);
      if (similarity >= threshold) {
        group.push(snapshots[j]);
        visited.add(j);
      }
    }
    if (group.length > 1) {
      groups.push(group);
    }
  }

  return groups;
}

export function selectStaleMemorySnapshots(
  snapshots: MemorySnapshot[],
  now: number = Date.now(),
): MemorySnapshot[] {
  const ninetyDaysAgo = now - 90 * 24 * 60 * 60 * 1000;
  return snapshots.filter((m) => !m.pinned && m.updatedAt < ninetyDaysAgo && m.accessCount < 3);
}

/* ------------------------------------------------------------------ *
 * ① 本地规划
 * ------------------------------------------------------------------ */

export function planMemoryOrganizeLocally(
  instruction: string,
  snapshots: MemorySnapshot[],
): MemoryOrganizeDraft {
  const issues: MemoryOrganizeDraft['issues'] = [];
  const operations: MemoryOrganizeOperation[] = [];

  const text = instruction.trim();
  if (!text) {
    return {
      operations: [],
      summary: '请输入整理指令',
      ready: false,
      issues: [{ code: 'instruction_empty', severity: 'error', message: 'Instruction is empty.' }],
    };
  }

  // 罗列全部记忆
  if (/罗列|全部|列出|清单/.test(text)) {
    operations.push({ type: 'list_all', reason: '罗列全部记忆' });
  }

  // 删除指定记忆
  const deleteMatch = /删[除了]?\s*第?\s*(\d+)\s*条/g;
  let match;
  while ((match = deleteMatch.exec(text)) !== null) {
    const index = parseInt(match[1], 10) - 1;
    if (index >= 0 && index < snapshots.length) {
      operations.push({ type: 'delete', memoryId: snapshots[index].id, reason: '用户指定删除' });
    }
  }

  // 归档指定记忆
  const archiveMatch = /归档\s*第?\s*(\d+)\s*条/g;
  while ((match = archiveMatch.exec(text)) !== null) {
    const index = parseInt(match[1], 10) - 1;
    if (index >= 0 && index < snapshots.length) {
      operations.push({ type: 'archive', memoryId: snapshots[index].id, reason: '用户指定归档' });
    }
  }

  // 清理过期记忆
  if (/清理|过期|无用|旧记忆/.test(text)) {
    const stale = selectStaleMemorySnapshots(snapshots);
    operations.push({
      type: 'clean_stale',
      memoryIds: stale.map((m) => m.id),
      reason: `清理 ${stale.length} 条过期记忆（90天未访问）`,
    });
  }

  // 合并重复记忆
  if (/合并|重复|去重/.test(text)) {
    const groups = groupNearDuplicateMemories(snapshots);
    for (const group of groups) {
      operations.push({
        type: 'merge',
        memoryIds: group.map((m) => m.id),
        reason: `合并 ${group.length} 条相似记忆`,
      });
    }
  }

  if (operations.length === 0) {
    operations.push({ type: 'list_all', reason: '未识别到具体操作，罗列全部记忆供查看' });
    issues.push({ code: 'unknown_instruction', severity: 'warning', message: '未识别到具体操作，默认罗列全部记忆' });
  }

  return {
    operations,
    summary: `共 ${operations.length} 个操作`,
    ready: !issues.some((i) => i.severity === 'error'),
    baseTime: Date.now(),
    issues,
  };
}

/* ------------------------------------------------------------------ *
 * ①-⑥ 编排
 * ------------------------------------------------------------------ */

export interface NaturalLanguageOrganizeRequest {
  instruction: string;
  memories: MemorySnapshot[];
}

export type OrganizeMemoriesDraftResult = MemoryOrganizeDraft;

export function organizeMemoriesFromNaturalLanguage(
  request: NaturalLanguageOrganizeRequest,
): OrganizeMemoriesDraftResult {
  return planMemoryOrganizeLocally(request.instruction, request.memories);
}

/* ------------------------------------------------------------------ *
 * 确认后执行
 * ------------------------------------------------------------------ */

export interface ApplyMemoryOrganizeDraftOptions {
  confirmed: boolean;
  destructiveConfirmed?: boolean;
  executor: {
    listAll?: () => Promise<void>;
    delete?: (id: number) => Promise<void>;
    archive?: (id: number) => Promise<void>;
    pin?: (id: number) => Promise<void>;
    unpin?: (id: number) => Promise<void>;
    merge?: (ids: number[], mergedContent: string, tags?: string[]) => Promise<void>;
    retitle?: (id: number, newTitle: string) => Promise<void>;
    retag?: (id: number, newTags: string[]) => Promise<void>;
    compress?: (id: number, compressedContent: string) => Promise<void>;
    cleanStale?: (ids: number[]) => Promise<void>;
  };
}

export type ApplyMemoryOrganizeDraftResult =
  | { ok: true; executed: number }
  | { ok: false; error: string };

export async function applyMemoryOrganizeDraft(
  draft: MemoryOrganizeDraft,
  options: ApplyMemoryOrganizeDraftOptions,
): Promise<ApplyMemoryOrganizeDraftResult> {
  if (!options.confirmed) {
    return { ok: false, error: 'Draft must be confirmed before applying.' };
  }

  // 并发守卫：draft 过期校验（5 分钟内有效）
  const now = Date.now();
  const maxAgeMs = 5 * 60 * 1000;
  if (draft.baseTime && now - draft.baseTime > maxAgeMs) {
    return { ok: false, error: 'Draft expired. Please regenerate and confirm again.' };
  }

  const hasDestructiveOps = draft.operations.some((op) => op.type === 'delete' || op.type === 'clean_stale' || op.type === 'merge');
  if (hasDestructiveOps && !options.destructiveConfirmed) {
    return { ok: false, error: 'Destructive operations require second confirmation.' };
  }

  let executed = 0;
  try {
    for (const op of draft.operations) {
      switch (op.type) {
        case 'list_all':
          if (options.executor.listAll) await options.executor.listAll();
          executed++;
          break;
        case 'delete':
          if (op.memoryId !== undefined && options.executor.delete) {
            await options.executor.delete(op.memoryId);
            executed++;
          }
          break;
        case 'archive':
          if (op.memoryId !== undefined && options.executor.archive) {
            await options.executor.archive(op.memoryId);
            executed++;
          }
          break;
        case 'pin':
          if (op.memoryId !== undefined && options.executor.pin) {
            await options.executor.pin(op.memoryId);
            executed++;
          }
          break;
        case 'unpin':
          if (op.memoryId !== undefined && options.executor.unpin) {
            await options.executor.unpin(op.memoryId);
            executed++;
          }
          break;
        case 'merge':
          if (op.memoryIds && op.mergedContent && options.executor.merge) {
            await options.executor.merge(op.memoryIds, op.mergedContent, op.tags);
            executed++;
          }
          break;
        case 'retitle':
          if (op.memoryId !== undefined && op.newTitle && options.executor.retitle) {
            await options.executor.retitle(op.memoryId, op.newTitle);
            executed++;
          }
          break;
        case 'retag':
          if (op.memoryId !== undefined && op.newTags && options.executor.retag) {
            await options.executor.retag(op.memoryId, op.newTags);
            executed++;
          }
          break;
        case 'compress':
          if (op.memoryId !== undefined && op.compressedContent && options.executor.compress) {
            await options.executor.compress(op.memoryId, op.compressedContent);
            executed++;
          }
          break;
        case 'clean_stale':
          if (op.memoryIds && options.executor.cleanStale) {
            await options.executor.cleanStale(op.memoryIds);
            executed++;
          }
          break;
      }
    }
    return { ok: true, executed };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
