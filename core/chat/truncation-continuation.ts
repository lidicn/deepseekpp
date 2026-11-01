/**
 * 聊天层「截断/空回答」续轮决策（t5-a / t5-b，2026-11-01）。
 *
 * 现场（t4 修后验收，`验收-修后.md` §3）：
 * - 带注入 + 工具密集的第二轮：注入轮 6/10 没有 FINISHED。
 * - **B3 r4 完全静默**：`response/status=INCOMPLETE`（无 FINISHED、无 error 帧）、
 *   1498 帧、零写入 30,517ms、屏上 2,772 字半截答案、**无诊断、无续轮**。
 *   成因：旧判据把「续轮」绑在 `emptyAnswerVerdict==='empty' || truncated` 且
 *   `completedExecutions.length===0` 上；工具密集轮有工具记录 ⇒ 被 `tools>0` 挡住；
 *   而 agent 侧又因缺 assistantMessageId/授权静默不启动 ⇒ 两头都不动。
 * - **B3 r10**：截断续了 1 次仍无 FINISHED，随后被 `auto_continue_no_progress` /
 *   `auto_continue_skipped_meta_reasoning` 挡住（2/6 未救回之一）。
 *
 * 本模块只做纯决策，副作用（预算、诊断、提交 composer）留在 content.ts：
 * 1. **截断（无 FINISHED）本身就是续轮理由**，不再要求「正文为空 / 没有工具」；
 * 2. 但 agent 侧会接手时必须让给 agent（`inlineAgentRunning/WillHandle`），不得双续；
 * 3. **截断链放宽一格**：若上一轮续轮也是因截断触发，本轮再次截断时允许
 *    越过 no-progress / meta-reasoning 闸一次（只一次，靠 `truncationRelaxUsed` 记账）。
 */

/** 聊天层续轮原因（仅用于观测与截断链记账；plan 不参与截断放宽）。 */
export type ChatContinuationReason = 'plan' | 'empty' | 'truncation';

/** 本模块会产出的续轮原因（plan 由既有的计划型闸门产出，这里只记账）。 */
export type ChatTruncationContinuationReason = 'empty' | 'truncation';

export interface ChatCompletionContinuationInput {
  /** 本轮流是否没有 FINISHED 结束（含 `response/status=INCOMPLETE` / generation_err / abort）。 */
  truncated: boolean;
  /** 正文分类是否为「空回答」。 */
  verdictEmpty: boolean;
  /** 本轮是否有工具执行记录（含被截断轮补齐的 incomplete 记录）。 */
  hadToolExecutions: boolean;
  blockedByServerError: boolean;
  blockedByNoProgress: boolean;
  blockedByMetaReasoning: boolean;
  userStopped: boolean;
  /** 自动续轮预算是否已耗尽（`autoContinueBudgetDecision.allow === false`）。 */
  budgetExhausted: boolean;
  /** 当前是否已有 inline agent 在跑。 */
  inlineAgentRunning: boolean;
  /** inline agent 本轮是否会接手续轮（会话/消息 id/授权/可续工具都满足）。 */
  inlineAgentWillHandle: boolean;
  /** 上一次聊天层续轮的原因（null = 没有在链条里）。 */
  previousContinuationReason: ChatContinuationReason | null;
  /** 本次预算窗口内是否已用过「截断放宽」。 */
  truncationRelaxUsed: boolean;
}

export interface ChatCompletionContinuationDecision {
  continue: boolean;
  reason: ChatTruncationContinuationReason | null;
  /** 是否因「截断链放宽一格」而续（观测用）。 */
  relaxed: boolean;
  /** 不续的原因码（观测用；续时为 null）。 */
  blockedBy: string | null;
}

const NO_CONTINUATION = (
  blockedBy: string,
): ChatCompletionContinuationDecision => ({
  continue: false,
  reason: null,
  relaxed: false,
  blockedBy,
});

export function decideChatCompletionContinuation(
  input: ChatCompletionContinuationInput,
): ChatCompletionContinuationDecision {
  if (input.userStopped) return NO_CONTINUATION('user_stopped');
  if (input.blockedByServerError) return NO_CONTINUATION('server_error');
  if (input.budgetExhausted) return NO_CONTINUATION('budget_exhausted');
  // 既不是空回答、也不是截断 ⇒ 正常结束，一律不动（反例：正常轮不得多跑）。
  if (!input.truncated && !input.verdictEmpty) return NO_CONTINUATION('normal_completion');
  // 旧语义保留：非截断的空回答仍只允许在「没有工具执行」时续（避免工具轮重复）。
  if (input.hadToolExecutions && !input.truncated) {
    return NO_CONTINUATION('tool_turn_without_truncation');
  }
  // agent 侧会接手（或已在跑）⇒ 让给 agent，聊天层不得再发一条 completion。
  if (input.inlineAgentRunning) return NO_CONTINUATION('inline_agent_running');
  if (input.inlineAgentWillHandle) return NO_CONTINUATION('inline_agent_will_handle');

  const reason: ChatTruncationContinuationReason = input.verdictEmpty ? 'empty' : 'truncation';
  const gateBlocked = input.blockedByNoProgress || input.blockedByMetaReasoning;
  if (!gateBlocked) return { continue: true, reason, relaxed: false, blockedBy: null };

  // t5-b：截断链放宽一格 —— 只对「上一轮也是因截断而续」的再次截断放开一次。
  // 正常轮（previousContinuationReason !== 'truncation'）永远不会走到这里。
  if (
    input.truncated &&
    input.previousContinuationReason === 'truncation' &&
    !input.truncationRelaxUsed
  ) {
    return { continue: true, reason, relaxed: true, blockedBy: null };
  }

  return NO_CONTINUATION(
    input.blockedByNoProgress ? 'no_progress' : 'meta_reasoning',
  );
}
