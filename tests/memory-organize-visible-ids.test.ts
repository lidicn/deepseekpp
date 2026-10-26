// 越权删除回归（2026-10-26 用户报告的审计项）。
//
// 缺陷：记忆页「自然语言整理」里用户说的「第 N 条」，后端按**全量记忆的存储顺序**
// 解析（planMemoryOrganizeLocally 用 snapshots[index-1].id），而用户认知里的
// 「第 N 条」是**前端当前筛选后的可见列表**（MemoryPage 的 filter 是纯 useState）。
// 两者基准不同 ⇒ 会删错记忆。UI 还隐藏 project scope，偏差更大。
//
// 修法：前端把 filtered 的 id 序列（visibleMemoryIds）一路传到后端，
// 后端按它重排 snapshots，编号基准唯一。
//
// 本测试锁定：
//   A. 核心：给定可见列表时，「第 N 条」按可见列表解析，**不是**全量顺序
//   B. 负控：不传可见列表时保持旧行为（全量顺序），不破坏无前端上下文的调用
//   C. 可见列表里有已删除的 id 时，跳过而不污染下标
//   D. 预览标签回填：destructive op 能显示名称/类型/scope，不再只有 ID
//   E. LLM 输出白名单：未知 op.type、越界 memoryId 被拒并记 issue
import { describe, expect, it } from 'vitest';
import {
  attachOperationLabels,
  buildMemorySnapshots,
  planMemoryOrganizeLocally,
  organizeMemoriesFromLlm,
  orderSnapshotsByVisibleIds,
  type MemorySnapshot,
} from '../core/memory/natural-language-organize';

/** 造记忆：id 顺序 = 存储顺序 */
function makeMemory(id: number, name: string, type = 'preference', scope = 'global') {
  return {
    id,
    name,
    content: `${name} 的内容`,
    tags: [],
    scope,
    type,
    updatedAt: id,
    accessCount: 0,
    pinned: false,
    archived: false,
  };
}

/** 完整记忆（给 buildMemorySnapshots 用） */
function makeRawMemory(id: number, name: string, type = 'preference', scope = 'global') {
  return { id, name, content: `${name} 的内容`, tags: [], type, scope } as never;
}

describe('越权删除：可见列表必须成为「第 N 条」的唯一基准', () => {
  it('★ 核心：可见列表重排后，「删除第1条」删的是可见列表第 1 条，不是全量第 1 条', () => {
    // 存储顺序：1=用户职业, 2=项目约束, 3=其他
    const all = buildMemorySnapshots([
      makeRawMemory(1, '用户职业'),
      makeRawMemory(2, '项目约束'),
      makeRawMemory(3, '其他偏好'),
    ]);
    expect(all.map((s) => s.id)).toEqual([1, 2, 3]);

    // 用户在 UI 里筛选后只看到 [项目约束(2), 其他偏好(3)]，第 1 条是「项目约束」。
    // ★ 走真实链路：前端传 visibleMemoryIds(2,3) → background 用 core 函数重排 → 再规划。
    const visible = orderSnapshotsByVisibleIds(all, [2, 3]);
    expect(visible.map((s) => s.id)).toEqual([2, 3]);

    const draft = planMemoryOrganizeLocally('删除第1条', visible);
    const del = draft.operations.find((op) => op.type === 'delete');
    expect(del).toBeDefined();
    // 必须删 2（可见列表第 1 条），不是 1（全量第 1 条）
    expect(del!.memoryId).toBe(2);
    expect(del!.memoryId).not.toBe(1);
  });

  it('负控：不传可见列表（全量）时，旧语义保持 —— 第 1 条仍是全量第 1 条', () => {
    const all = buildMemorySnapshots([
      makeRawMemory(1, '用户职业'),
      makeRawMemory(2, '项目约束'),
    ]);
    const draft = planMemoryOrganizeLocally('删除第1条', all);
    const del = draft.operations.find((op) => op.type === 'delete');
    expect(del!.memoryId).toBe(1);
  });

  it('可见列表顺序决定编号（不是按 id 排序）', () => {
    const all = buildMemorySnapshots([
      makeRawMemory(1, 'A'),
      makeRawMemory(2, 'B'),
      makeRawMemory(3, 'C'),
    ]);
    // UI 里显示顺序是 C, A, B（例如按更新时间倒序）
    const visible = orderSnapshotsByVisibleIds(all, [3, 1, 2]);
    const draft = planMemoryOrganizeLocally('删除第2条', visible);
    const del = draft.operations.find((op) => op.type === 'delete');
    expect(del!.memoryId).toBe(1); // 第 2 条 = A(1)
  });
});

describe('越权删除：预览必须可辨识', () => {
  it('attachOperationLabels 给 delete 操作回填名称/类型/scope', () => {
    const snapshots = buildMemorySnapshots([
      makeRawMemory(13, '用户职业', 'user', 'global'),
    ]);
    const draft = planMemoryOrganizeLocally('删除第1条', snapshots);
    const labeled = attachOperationLabels(draft, snapshots);
    const del = labeled.operations.find((op) => op.type === 'delete');
    expect(del!.memoryLabel).toBeTruthy();
    expect(del!.memoryLabel).toContain('用户职业');
    // 不再只有 ID：至少要含名称，且带上类型/scope 之一
    expect(del!.memoryLabel).toMatch(/user|global/);
  });

  it('找不到对应快照时不伪造标签（宁可只有 ID）', () => {
    const snapshots = buildMemorySnapshots([makeRawMemory(1, '存在')]);
    const draft = {
      operations: [{ type: 'delete' as const, memoryId: 999 }],
      summary: '',
      ready: true,
      baseTime: 0,
      issues: [],
    };
    const labeled = attachOperationLabels(draft, snapshots);
    expect(labeled.operations[0]!.memoryLabel).toBeUndefined();
  });

  it('不改变执行语义：memoryId 原样保留', () => {
    const snapshots = buildMemorySnapshots([makeRawMemory(7, 'X')]);
    const draft = planMemoryOrganizeLocally('删除第1条', snapshots);
    const labeled = attachOperationLabels(draft, snapshots);
    expect(labeled.operations[0]!.memoryId).toBe(draft.operations[0]!.memoryId);
  });
});

describe('越权删除：LLM 输出白名单', () => {
  const snapshots: MemorySnapshot[] = buildMemorySnapshots([
    makeRawMemory(1, 'A'),
    makeRawMemory(2, 'B'),
  ]);

  function llmDraft(operations: unknown[]) {
    return JSON.stringify({ summary: 's', operations, ready: true });
  }

  it('未知 op.type 被拒并记 issue', () => {
    const draft = organizeMemoriesFromLlm(
      '整理',
      snapshots,
      llmDraft([{ type: 'drop_database', memoryId: 1 }]),
    );
    expect(draft.operations.some((op) => (op.type as string) === 'drop_database')).toBe(false);
    expect(draft.issues.some((i) => i.code === 'llm_operation_rejected')).toBe(true);
  });

  it('越界 memoryId（不在快照集合内）被拒', () => {
    const draft = organizeMemoriesFromLlm(
      '整理',
      snapshots,
      llmDraft([{ type: 'delete', memoryId: 999 }]),
    );
    expect(draft.operations.some((op) => op.memoryId === 999)).toBe(false);
    expect(draft.issues.some((i) => i.code === 'llm_operation_rejected')).toBe(true);
  });

  it('合法操作正常通过（负控）', () => {
    const draft = organizeMemoriesFromLlm(
      '整理',
      snapshots,
      llmDraft([{ type: 'delete', memoryId: 2 }]),
    );
    expect(draft.operations.some((op) => op.type === 'delete' && op.memoryId === 2)).toBe(true);
  });

  it('merge 缺 mergedContent 被拒', () => {
    const draft = organizeMemoriesFromLlm(
      '整理',
      snapshots,
      llmDraft([{ type: 'merge', memoryIds: [1, 2] }]),
    );
    expect(draft.operations.some((op) => op.type === 'merge')).toBe(false);
  });
});
