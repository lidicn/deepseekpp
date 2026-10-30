/**
 * 「计划型短答案」判定（2026-10-30 真机，目标第 5 轮发现）。
 *
 * 现象：模型正常收尾（FINISHED、无截断、答案只有 1 份），但正文是**它打算怎么做**：
 *   "先检索记忆了解项目背景…先探索项目结构…让我开始。"
 * 用户看到的就是"什么都没做"。这不是断流、不是重复渲染，是**内容未完成**。
 *
 * 判据要保守：宁可漏报（交给用户），也不要误报（把真正的短答案判成未完成）。
 * 只有「短 + 多个计划语 + 无交付证据」同时成立才算。
 *
 * 注：所有中文标记一律用 unicode 转义书写 —— `verify:i18n` 不允许源码出现中文字面量。
 */

const PLAN_MARKERS: readonly RegExp[] = [
  /\u8ba9\u6211(\u5148|\u6765|\u5f00\u59cb)/, // 让我(先|来|开始)
  /\u6211\u5148/, // 我先
  /\u5148(\u770b|\u67e5|\u68c0\u7d22|\u63a2\u7d22|\u8bfb|\u5217|\u786e\u8ba4)/, // 先(看|查|检索|探索|读|列|确认)
  /\u63a5\u4e0b\u6765/, // 接下来
  /\u9996\u5148/, // 首先
  /(\u9700\u8981|\u5e94\u8be5)(\u5148|\u53bb|\u67e5\u770b|\u8bfb)/, // (需要|应该)(先|去|查看|读)
  /\u8ba1\u5212/, // 计划
  /\u5f00\u59cb(\u63a2\u7d22|\u5ba1\u8ba1|\u68c0\u67e5|\u770b)/, // 开始(探索|审计|检查|看)
  // 英文计划语（2026-10-30 真机：模型用英文写计划后直接 FINISHED）
  /\bLet me\b/i,
  /\bLet's\b/i,
  /\bI'll\b/i,
  /\bI will\b/i,
  /\bFirst,?\s/i,
  /\bNext,?\s/i,
  /\bThen I\b/i,
  /\bPlan:/i,
  /\bStep \d/i,
];

/** 出现这些说明**已经交付了东西**，不该判成"只给了计划"。 */
const DELIVERABLE_MARKERS: readonly RegExp[] = [
  /\u7ed3\u8bba/, // 结论
  /\u53d1\u73b0/, // 发现
  /\u8bc1\u636e/, // 证据
  /\u6839\u56e0/, // 根因
  /\u4fee\u590d/, // 修复
  /\b[\w./-]+\.(ts|tsx|js|mjs|json|md):\d+/, // file:line
  /```/,
  /\|.*\|/, // 表格
  /(\u5efa\u8bae|\u65b9\u6848|\u6b65\u9aa4)\s*[:：]/, // (建议|方案|步骤):
  // 英文交付证据
  /\b(the bug|root cause|I found|found that|the issue is)\b/i,
];

export interface PlanOnlyAnswerInput {
  answerText: string;
  /** 本轮是否执行过工具（执行过就说明真的动了手，不算只给计划）。 */
  hadToolExecutions?: boolean;
}

export const PLAN_ONLY_MAX_CHARS = 1500;
/** 极短答案阈值：低于它且无交付证据，视为"这一轮没做完"。 */
export const SHORT_ANSWER_MAX_CHARS = 300;

/** 是否出现了"交付证据"（结论/证据/file:line/代码块/表格/建议）。 */
export function hasDeliverableEvidence(text: string): boolean {
  const value = (text ?? '').trim();
  if (!value) return false;
  return DELIVERABLE_MARKERS.some((re) => re.test(value));
}

/**
 * 极短答案判定（2026-10-30 真机新增）。
 * 真机样本：正文 50 字、`cls=clean / FINISHED`、无任何计划标记、无工具执行 ——
 * 既不是"空"也不是"计划型"，但用户看到的就是"刚开头就停"。
 */
export function isSuspiciouslyShortAnswer(input: {
  answerText: string;
  hadToolExecutions?: boolean;
}): boolean {
  const value = (input.answerText ?? '').trim();
  if (value.length === 0) return false;
  if (value.length >= SHORT_ANSWER_MAX_CHARS) return false;
  if (input.hadToolExecutions) return false;
  return !hasDeliverableEvidence(value);
}

/** 短文本阈值：低于它时，命中 1 个计划语即判计划型。 */
export const SHORT_PLAN_ONLY_CHARS = 200;

export function looksLikePlanOnlyAnswer(input: PlanOnlyAnswerInput): boolean {
  const text = (input.answerText ?? '').trim();
  if (text.length === 0) return false;
  if (text.length > PLAN_ONLY_MAX_CHARS) return false;
  if (input.hadToolExecutions) return false;
  if (DELIVERABLE_MARKERS.some((re) => re.test(text))) return false;
  const hits = PLAN_MARKERS.filter((re) => re.test(text)).length;
  // 真机（2026-10-30）：127 字的中文计划只命中 1 个标记（"先看…"），阈值 ≥2 会漏。
  // 短文本单独放宽到 ≥1：短 + 带计划语 + 无交付证据，几乎一定是"打算怎么做"。
  if (hits >= 2) return true;
  return hits >= 1 && text.length <= SHORT_PLAN_ONLY_CHARS;
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
/**
 * 聊天层决策（2026-10-30 真机）：**第一轮**模型只给计划、且没调用任何工具时，
 * 自动把"继续"发出去一次。
 *
 * 为什么必须在聊天层：此时 agent loop 根本没启动（没有工具调用），
 * `loop-adapter` 里的计划型守卫永远不会被走到 —— 用户看到的就是"第一步就停"。
 */
export function decideChatLayerContinuation(input: {
  answerText: string;
  hadToolExecutions: boolean;
  alreadyContinued: boolean;
  enabled: boolean;
}): boolean {
  if (!input.enabled) return false;
  if (input.alreadyContinued) return false;
  if (input.hadToolExecutions) return false;
  return looksLikePlanOnlyAnswer({ answerText: input.answerText });
}
/** 自动续轮预算：时间窗内最多 N 次。 */
export interface AutoContinueBudget {
  windowStart: number;
  count: number;
}

export const AUTO_CONTINUE_WINDOW_MS = 5 * 60_000;
export const AUTO_CONTINUE_MAX = 3;

/**
 * 是否允许再自动续一次。
 *
 * 为什么不用 requestId 做闸：真机上 `complete.requestId` 可能为空，
 * 而 `"" === ""` 会让"是否已续过"恒为 true ⇒ 续轮从第一次就被自己挡住（实测 plan=0）。
 */
export function decideAutoContinueBudget(input: {
  budget: AutoContinueBudget;
  now: number;
  max?: number;
  windowMs?: number;
}): { allow: boolean; next: AutoContinueBudget } {
  const max = input.max ?? AUTO_CONTINUE_MAX;
  const windowMs = input.windowMs ?? AUTO_CONTINUE_WINDOW_MS;
  const expired = input.now - input.budget.windowStart > windowMs;
  const base = expired ? { windowStart: input.now, count: 0 } : input.budget;
  if (base.count >= max) return { allow: false, next: base };
  return { allow: true, next: { windowStart: base.windowStart, count: base.count + 1 } };
}

/** 页面侧看门狗：答案文字多久没变就算"卡住"。 */
export const STALL_RECOVER_MS = 180_000;

/**
 * 是否该对"卡住的生成"动手（点停止 + 自动续）。
 *
 * 真机（2026-10-30）：审计类提示词下页面 `stop=true` 持续 4 分钟以上、正文不再增长，
 * 因为流根本没结束 ⇒ `RESPONSE_COMPLETE` 永不触发 ⇒ 续轮逻辑永远等不到。
 * 这类"挂死"只能由页面侧看门狗处理。
 */
export function decideStallRecovery(input: {
  now: number;
  lastChangeAt: number;
  generating: boolean;
  thresholdMs?: number;
}): boolean {
  if (!input.generating) return false;
  const threshold = input.thresholdMs ?? STALL_RECOVER_MS;
  return input.now - input.lastChangeAt >= threshold;
}
