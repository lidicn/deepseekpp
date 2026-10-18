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
      name: m.name ?? (readMemoryText(m).slice(0, 50) || `记忆 ${index + 1}`),
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
  const issues: { code: string; severity: 'info' | 'warning' | 'error'; message: string }[] = [];
  const operations: MemoryOrganizeOperation[] = [];

  const text = instruction.trim();
  if (!text) {
    return {
      operations: [],
      summary: '请输入整理指令',
      ready: false,
      baseTime: Date.now(),
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
    issues.push({ code: 'unknown_instruction', severity: 'warning', message: '未识别到具体操作，请描述你想怎么整理记忆' });
  }

  // Scope 保护：检查跨 scope 的破坏性操作
  const scopeById = new Map(snapshots.map((s) => [s.id, s.scope]));
  const destructiveOps = operations.filter((op) =>
    ['delete', 'merge', 'clean_stale'].includes(op.type),
  );
  for (const op of destructiveOps) {
    const ids = op.memoryIds ?? (op.memoryId !== undefined ? [op.memoryId] : []);
    const scopes = new Set(ids.map((id) => scopeById.get(id)).filter(Boolean));
    if (scopes.size > 1) {
      issues.push({
        code: 'cross_scope_operation',
        severity: 'warning',
        message: `检测到跨 scope 操作（${Array.from(scopes).join(' / ')}），请确认`,
      });
      break;
    }
  }

  return {
    operations,
    summary: operations.length === 0 ? '未识别到具体操作' : `共 ${operations.length} 个操作`,
    ready: !issues.some((i) => i.severity === 'error'),
    baseTime: Date.now(),
    issues,
  };
}

/**
 * 解析 LLM 输出的 JSON，验证合法性。
 * 验证失败返回 null，调用方应回退到本地规则。
 */
export function parseLlmOutputAsDraft(llmOutput: string): MemoryOrganizeDraft | null {
  try {
    // 去掉可能的 markdown 代码块包裹
    let jsonStr = llmOutput.trim();
    if (jsonStr.startsWith('```json')) {
      jsonStr = jsonStr.slice(7);
    }
    if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.slice(3);
    }
    if (jsonStr.endsWith('```')) {
      jsonStr = jsonStr.slice(0, -3);
    }
    jsonStr = jsonStr.trim();

    const parsed = JSON.parse(jsonStr);

    // 验证基本结构
    if (!parsed || typeof parsed !== 'object') return null;
    if (!Array.isArray(parsed.operations)) return null;
    if (typeof parsed.summary !== 'string') return null;

    // 验证每条 operation
    const validOps: MemoryOrganizeOperation[] = [];
    for (const op of parsed.operations) {
      if (!op || typeof op !== 'object') continue;
      if (typeof op.type !== 'string') continue;
      validOps.push(op as MemoryOrganizeOperation);
    }

    return {
      operations: validOps,
      summary: parsed.summary,
      ready: parsed.ready !== false,
      baseTime: Date.now(),
      issues: Array.isArray(parsed.issues) ? parsed.issues : [],
    };
  } catch {
    return null;
  }
}

/**
 * 从 LLM 输出生成 draft，失败时回退到本地规则。
 */
export function organizeMemoriesFromLlm(
  instruction: string,
  memories: MemorySnapshot[],
  llmOutput: string,
): MemoryOrganizeDraft {
  const llmDraft = parseLlmOutputAsDraft(llmOutput);
  if (llmDraft) {
    return llmDraft;
  }
  // 回退到本地规则
  const localDraft = planMemoryOrganizeLocally(instruction, memories);
  return {
    ...localDraft,
    issues: [
      {
        code: 'llm_output_invalid',
        severity: 'warning',
        message: 'LLM 输出不合法，已回退到本地规则',
      },
      ...localDraft.issues,
    ],
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

export interface MemoryOrganizeActionOutcome {
  type: MemoryOrganizeOperationType;
  memoryId?: number;
  memoryIds?: number[];
  ok: boolean;
  error?: string;
}

export type ApplyMemoryOrganizeDraftResult =
  | { ok: true; outcomes: MemoryOrganizeActionOutcome[] }
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

  // Scope 保护：如果有跨 scope 操作且没有显式声明，拒绝执行
  const hasCrossScopeIssue = draft.issues.some((i) => i.code === 'cross_scope_operation');
  if (hasCrossScopeIssue && !options.destructiveConfirmed) {
    return { ok: false, error: 'Cross-scope operations require explicit confirmation.' };
  }

  const outcomes: MemoryOrganizeActionOutcome[] = [];
  try {
    for (const op of draft.operations) {
      try {
        switch (op.type) {
          case 'list_all':
            if (options.executor.listAll) await options.executor.listAll();
            outcomes.push({ type: op.type, memoryId: op.memoryId, memoryIds: op.memoryIds, ok: true });
            break;
          case 'delete':
            if (op.memoryId !== undefined && options.executor.delete) {
              await options.executor.delete(op.memoryId);
              outcomes.push({ type: op.type, memoryId: op.memoryId, ok: true });
            } else {
              outcomes.push({ type: op.type, memoryId: op.memoryId, ok: false, error: 'Missing executor.delete or memoryId' });
            }
            break;
          case 'archive':
            if (op.memoryId !== undefined && options.executor.archive) {
              await options.executor.archive(op.memoryId);
              outcomes.push({ type: op.type, memoryId: op.memoryId, ok: true });
            } else {
              outcomes.push({ type: op.type, memoryId: op.memoryId, ok: false, error: 'Missing executor.archive or memoryId' });
            }
            break;
          case 'pin':
            if (op.memoryId !== undefined && options.executor.pin) {
              await options.executor.pin(op.memoryId);
              outcomes.push({ type: op.type, memoryId: op.memoryId, ok: true });
            } else {
              outcomes.push({ type: op.type, memoryId: op.memoryId, ok: false, error: 'Missing executor.pin or memoryId' });
            }
            break;
          case 'unpin':
            if (op.memoryId !== undefined && options.executor.unpin) {
              await options.executor.unpin(op.memoryId);
              outcomes.push({ type: op.type, memoryId: op.memoryId, ok: true });
            } else {
              outcomes.push({ type: op.type, memoryId: op.memoryId, ok: false, error: 'Missing executor.unpin or memoryId' });
            }
            break;
          case 'merge':
            if (op.memoryIds && op.mergedContent && options.executor.merge) {
              await options.executor.merge(op.memoryIds, op.mergedContent, op.tags);
              outcomes.push({ type: op.type, memoryIds: op.memoryIds, ok: true });
            } else {
              outcomes.push({ type: op.type, memoryIds: op.memoryIds, ok: false, error: 'Missing executor.merge, memoryIds, or mergedContent' });
            }
            break;
          case 'retitle':
            if (op.memoryId !== undefined && op.newTitle && options.executor.retitle) {
              await options.executor.retitle(op.memoryId, op.newTitle);
              outcomes.push({ type: op.type, memoryId: op.memoryId, ok: true });
            } else {
              outcomes.push({ type: op.type, memoryId: op.memoryId, ok: false, error: 'Missing executor.retitle, memoryId, or newTitle' });
            }
            break;
          case 'retag':
            if (op.memoryId !== undefined && op.newTags && options.executor.retag) {
              await options.executor.retag(op.memoryId, op.newTags);
              outcomes.push({ type: op.type, memoryId: op.memoryId, ok: true });
            } else {
              outcomes.push({ type: op.type, memoryId: op.memoryId, ok: false, error: 'Missing executor.retag, memoryId, or newTags' });
            }
            break;
          case 'compress':
            if (op.memoryId !== undefined && op.compressedContent && options.executor.compress) {
              await options.executor.compress(op.memoryId, op.compressedContent);
              outcomes.push({ type: op.type, memoryId: op.memoryId, ok: true });
            } else {
              outcomes.push({ type: op.type, memoryId: op.memoryId, ok: false, error: 'Missing executor.compress, memoryId, or compressedContent' });
            }
            break;
          case 'clean_stale':
            if (op.memoryIds && options.executor.cleanStale) {
              await options.executor.cleanStale(op.memoryIds);
              outcomes.push({ type: op.type, memoryIds: op.memoryIds, ok: true });
            } else {
              outcomes.push({ type: op.type, memoryIds: op.memoryIds, ok: false, error: 'Missing executor.cleanStale or memoryIds' });
            }
            break;
        }
      } catch (error) {
        outcomes.push({
          type: op.type,
          memoryId: op.memoryId,
          memoryIds: op.memoryIds,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { ok: true, outcomes };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
