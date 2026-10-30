/**
 * 「计划型短答案」判定（2026-10-30 真机，目标第 5 轮发现）。
 *
 * 现象：模型正常收尾（FINISHED、无截断、答案只有 1 份），但正文是**它打算怎么做**：
 *   "先检索记忆了解项目背景…先探索项目结构…让我开始。"
 * 用户看到的就是"什么都没做"。这不是断流、不是重复渲染，是**内容未完成**。
 *
 * 判据要保守：宁可漏报（交给用户），也不要误报（把真正的短答案判成未完成）。
 * 只有「短 + 多个计划语 + 无交付证据」同时成立才算。
 */

const PLAN_MARKERS: readonly RegExp[] = [
  /让我(先|来|开始)/,
  /我先/,
  /先(看|查|检索|探索|读|列|确认)/,
  /接下来/,
  /首先/,
  /(需要|应该)(先|去|查看|读)/,
  /计划/,
  /开始(探索|审计|检查|看)/,
];

/** 出现这些说明**已经交付了东西**，不该判成"只给了计划"。 */
const DELIVERABLE_MARKERS: readonly RegExp[] = [
  /结论/,
  /发现/,
  /证据/,
  /根因/,
  /修复/,
  /\b[\w./-]+\.(ts|tsx|js|mjs|json|md):\d+/, // file:line
  /```/,
  /\|.*\|/, // 表格
  /(建议|方案|步骤)\s*[:：]/,
];

export interface PlanOnlyAnswerInput {
  answerText: string;
  /** 本轮是否执行过工具（执行过就说明真的动了手，不算只给计划）。 */
  hadToolExecutions?: boolean;
}

export const PLAN_ONLY_MAX_CHARS = 400;

export function looksLikePlanOnlyAnswer(input: PlanOnlyAnswerInput): boolean {
  const text = (input.answerText ?? '').trim();
  if (text.length === 0) return false;
  if (text.length > PLAN_ONLY_MAX_CHARS) return false;
  if (input.hadToolExecutions) return false;
  if (DELIVERABLE_MARKERS.some((re) => re.test(text))) return false;
  const hits = PLAN_MARKERS.filter((re) => re.test(text)).length;
  return hits >= 2;
}

export type PlanOnlySettlement = 'continue' | 'settle';

/**
 * 计划型答案该「续一轮」还是「就此收尾」。
 * 最多续 1 次（`continuedAlready`），避免又把空转放大。
 */
export function decidePlanOnlySettlement(input: {
  planOnly: boolean;
  continuable: boolean;
  continuedAlready: boolean;
}): PlanOnlySettlement {
  if (!input.planOnly) return 'settle';
  if (!input.continuable) return 'settle';
  if (input.continuedAlready) return 'settle';
  return 'continue';
}
