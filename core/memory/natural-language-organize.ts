/**
 * 自然语言 → 记忆整理 draft（v1.0 · P3）。
 *
 * 管线：instruction → Prompt 构造 →（LLM | 本地规则）→ 严格解码 → draft。
 * 本模块永不执行：`organizeMemoriesFromNaturalLanguage` 只产出 draft；
 * 执行必须由上层拿到用户确认后走 `applyMemoryOrganizeDraft`。
 */

import { translate, type LocaleMessageKey, type MessageParams } from '../i18n';

/** 本模块用于把用户可见的 summary/issue 文案翻译到当前 locale。 */
type OrganizeT = (key: LocaleMessageKey, params?: MessageParams) => string;
/** 测试与未注入 translator 的调用方默认走 zh-CN，保持既有行为。 */
const defaultOrganizeT: OrganizeT = (key, params) => translate('zh-CN', key, params);

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
  /**
   * 展示用：被操作记忆的名称/类型/scope 摘要。
   *
   * 修复「不可辨识的确认界面」：预览面板原来对破坏性操作只显示 `ID: 13`，
   * 用户没有能力判断即将被删的到底是哪一条。由生成 draft 的一侧填入真实值，
   * 预览直接展示，不影响执行逻辑（执行仍按 memoryId）。
   */
  memoryLabel?: string;
  memoryLabels?: string[];
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

/**
 * 按「用户可见顺序」重排记忆快照，让「第 N 条」的编号基准唯一。
 *
 * 修复越权删除：记忆整理里用户说的「第 N 条」，指的是**他在记忆页当前筛选下看到的**
 * 第 N 条。但后端原本直接拿 `getAllMemories()` 的存储顺序做下标，且 UI 还隐藏
 * `project` scope，两者偏差可能导致：
 *
 *   用户看着「第 1 条：项目约束」点确认 → 实际删掉的是「用户职业」。
 *
 * 前端把自己的 filtered 列表 ID 按显示顺序传上来，这里据此重排 ⇒ 基准唯一。
 *
 * @param allSnapshots 全量快照（存储顺序）
 * @param visibleMemoryIds 用户可见的 ID 序列（显示顺序）；为空/未传则回退全量顺序
 *
 * 注意：传入的 id 若已不存在（并发删除），**跳过而不占位** —— 否则下标会整体偏移，
 * 又变回「删错」。跳过是 fail-safe：少一条可选，不会错删。
 */
export function orderSnapshotsByVisibleIds<T extends { id: number }>(
  allSnapshots: readonly T[],
  visibleMemoryIds: readonly number[] | undefined,
): T[] {
  if (!visibleMemoryIds || visibleMemoryIds.length === 0) return [...allSnapshots];
  const byId = new Map(allSnapshots.map((snapshot) => [snapshot.id, snapshot]));
  const ordered: T[] = [];
  for (const id of visibleMemoryIds) {
    const snapshot = byId.get(id);
    if (snapshot !== undefined) ordered.push(snapshot);
  }
  return ordered;
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
  t: OrganizeT = defaultOrganizeT,
): MemoryOrganizeDraft {
  const issues: { code: string; severity: 'info' | 'warning' | 'error'; message: string }[] = [];
  const operations: MemoryOrganizeOperation[] = [];

  const text = instruction.trim();
  if (!text) {
    return {
      operations: [],
      summary: t('sidepanel.memoryOrganize.summaryEmpty'),
      ready: false,
      baseTime: Date.now(),
      issues: [{ code: 'instruction_empty', severity: 'error', message: t('sidepanel.memoryOrganize.issueInstructionEmpty') }],
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
    issues.push({ code: 'unknown_instruction', severity: 'warning', message: t('sidepanel.memoryOrganize.issueUnknown') });
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
        message: t('sidepanel.memoryOrganize.issueCrossScope', { scopes: Array.from(scopes).join(' / ') }),
      });
      break;
    }
  }

  return {
    operations,
    summary: operations.length === 0
      ? t('sidepanel.memoryOrganize.summaryNoOperation')
      : t('sidepanel.memoryOrganize.summaryCount', { count: operations.length }),
    ready: !issues.some((i) => i.severity === 'error'),
    baseTime: Date.now(),
    issues,
  };
}

/**
 * 解析 LLM 输出的 JSON，验证合法性。
 * 验证失败返回 null，调用方应回退到本地规则。
 */
export const KNOWN_OPERATION_TYPES = new Set<string>([
  'list_all', 'delete', 'archive', 'pin', 'unpin',
  'merge', 'retitle', 'retag', 'compress', 'clean_stale',
]);

/**
 * 校验 LLM 输出的 operation 是否可信。
 *
 * 修复越权删除的加固项：原来只判 `typeof op.type === 'string'` 就 push，
 * 于是任意字符串都能通过；LLM 又从不产 `cross_scope_operation` issue，
 * 导致 applyMemoryOrganizeDraft 里的 scope 守卫在 LLM 路径上是死代码。
 *
 * 现在：类型必须在 10 个合法枚举内；引用的 memoryId/memoryIds 必须落在
 * 本次传上去的快照集合内（防止 LLM 编造 id 删到用户没看到的记忆）；
 * merge 必须有非空 mergedContent。
 */
function isTrustedOperation(
  op: unknown,
  allowedIds: ReadonlySet<number>,
): op is MemoryOrganizeOperation {
  if (!op || typeof op !== 'object') return false;
  const candidate = op as Record<string, unknown>;
  const type = candidate.type;
  if (typeof type !== 'string' || !KNOWN_OPERATION_TYPES.has(type)) return false;

  // 单条 id 引用必须真实存在于本次快照集合
  if (candidate.memoryId !== undefined) {
    if (typeof candidate.memoryId !== 'number' || !allowedIds.has(candidate.memoryId)) return false;
  }
  if (candidate.memoryIds !== undefined) {
    if (!Array.isArray(candidate.memoryIds) || candidate.memoryIds.length === 0) return false;
    if (!candidate.memoryIds.every((id) => typeof id === 'number' && allowedIds.has(id))) return false;
  }

  // 破坏性/改写类操作必须带有效载荷
  if (type === 'merge' && (typeof candidate.mergedContent !== 'string' || !candidate.mergedContent.trim())) {
    return false;
  }
  if (type === 'retitle' && (typeof candidate.newTitle !== 'string' || !candidate.newTitle.trim())) {
    return false;
  }
  if (type === 'retag' && !Array.isArray(candidate.newTags)) return false;
  if (type === 'compress' && typeof candidate.compressedContent !== 'string') return false;

  return true;
}

function parseLlmOutputAsDraft(llmOutput: string, allowedIds: ReadonlySet<number>, t: OrganizeT = defaultOrganizeT): MemoryOrganizeDraft | null {
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

    // 验证每条 operation：类型白名单 + id 必须落在本次快照集合内。
    // 越界的 op 直接丢弃并记 issue，不静默通过（原实现只判 typeof op.type === 'string'）。
    const validOps: MemoryOrganizeOperation[] = [];
    const rejectedIssues: { code: string; severity: 'warning'; message: string }[] = [];
    for (const op of parsed.operations) {
      if (isTrustedOperation(op, allowedIds)) {
        validOps.push(op);
      } else {
        rejectedIssues.push({
          code: 'llm_operation_rejected',
          severity: 'warning',
          message: t('sidepanel.memoryOrganize.issueLlmOperationRejected'),
        });
      }
    }

    return {
      operations: validOps,
      summary: parsed.summary,
      ready: parsed.ready !== false,
      baseTime: Date.now(),
      issues: [...(Array.isArray(parsed.issues) ? parsed.issues : []), ...rejectedIssues],
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
  t: OrganizeT = defaultOrganizeT,
): MemoryOrganizeDraft {
  // 传入本次快照的 id 集合：LLM 只能引用用户真实看到的记忆，防止编造 id 删到不可见记忆。
  const allowedIds = new Set(
    memories.map((m) => m.id).filter((id): id is number => typeof id === 'number'),
  );
  const llmDraft = parseLlmOutputAsDraft(llmOutput, allowedIds, t);
  if (llmDraft) {
    return llmDraft;
  }
  // 回退到本地规则
  const localDraft = planMemoryOrganizeLocally(instruction, memories, t);
  return {
    ...localDraft,
    issues: [
      {
        code: 'llm_output_invalid',
        severity: 'warning',
        message: t('sidepanel.memoryOrganize.issueLlmOutputInvalid'),
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

/**
 * 给 draft 里每个操作回填「这条记忆叫什么」的展示标签。
 *
 * 修复「不可辨识的确认界面」：预览面板原来对破坏性操作只显示 `ID: 13`，
 * 用户看到「第 1 条：项目约束」点确认，实际删的可能是另一条，事后连追溯线索都不完整。
 *
 * 只影响展示，**不改变执行语义**（执行仍严格按 memoryId / memoryIds）。
 * 找不到对应快照时留空，预览会退化成只显示 ID（不伪造信息）。
 */
export function attachOperationLabels(
  draft: MemoryOrganizeDraft,
  snapshots: readonly MemorySnapshot[],
): MemoryOrganizeDraft {
  if (draft.operations.length === 0) return draft;
  const byId = new Map(snapshots.map((snapshot) => [snapshot.id, snapshot]));
  const labelOf = (id: number): string | undefined => {
    const snapshot = byId.get(id);
    if (!snapshot) return undefined;
    const name = (snapshot.name || readMemoryText(snapshot)).trim().slice(0, 40);
    const parts = [name, snapshot.type, snapshot.scope].filter((part) => part && part.trim());
    return parts.length > 0 ? parts.join(' · ') : undefined;
  };
  return {
    ...draft,
    operations: draft.operations.map((op) => {
      const next: MemoryOrganizeOperation = { ...op };
      if (typeof op.memoryId === 'number') {
        const label = labelOf(op.memoryId);
        if (label) next.memoryLabel = label;
      }
      if (Array.isArray(op.memoryIds)) {
        const labels = op.memoryIds.map((id) => labelOf(id)).filter((l): l is string => !!l);
        if (labels.length > 0) next.memoryLabels = labels;
      }
      return next;
    }),
  };
}

export function organizeMemoriesFromNaturalLanguage(
  request: NaturalLanguageOrganizeRequest,
  t?: OrganizeT,
): OrganizeMemoriesDraftResult {
  // 回填展示标签：让用户能在预览里认出「即将被删的是哪一条」，而不只是看到一个 ID。
  return attachOperationLabels(planMemoryOrganizeLocally(request.instruction, request.memories, t), request.memories);
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
          default: {
            // 非法 op.type 原来静默跳过、不产 outcome，用户与调用方都看不出「这条没执行」。
            // 现在记为失败项，与其它失败一样进 outcomes。
            const unknownType: never = op.type;
            outcomes.push({
              type: op.type,
              memoryId: op.memoryId,
              memoryIds: op.memoryIds,
              ok: false,
              error: `Unknown operation type: ${String(unknownType)}`,
            });
            break;
          }
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
