/**
 * t5-a / t5-b：聊天层「截断（无 FINISHED）」续轮决策 + 截断链放宽一格。
 *
 * 现场（t4 修后验收`验收-修后.md` §3）：
 * - B3 r4：正文 2,772 字 + `response/status=INCOMPLETE` + 有工具记录 ⇒ 旧判据被 `tools>0`
 *   挡住，agent 侧又静默不启动 ⇒ 无诊断无续轮（30.5s 零写入后中途停住）。
 * - B3 r10：截断后续了 1 次仍 INCOMPLETE，随后被 no-progress / meta-reasoning 挡住。
 *
 * 变异自证：
 *   - 把 `hadToolExecutions && !truncated` 放宽逻辑改成 `hadToolExecutions` 一律拦 ⇒
 *     「r4 形状续轮」用例红；
 *   - 去掉「截断链放宽一格」分支 ⇒ r10 形状用例红；
 *   - 放宽不看 `previousContinuationReason==='truncation'` ⇒ 正常轮反例用例红。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  decideChatCompletionContinuation,
  type ChatCompletionContinuationInput,
} from '../core/chat/truncation-continuation';

const CONTENT_SOURCE = readFileSync(
  join(__dirname, '..', 'entrypoints', 'content.ts'),
  'utf-8',
);

function input(
  overrides: Partial<ChatCompletionContinuationInput> = {},
): ChatCompletionContinuationInput {
  return {
    truncated: true,
    verdictEmpty: false,
    hadToolExecutions: true,
    blockedByServerError: false,
    blockedByNoProgress: false,
    blockedByMetaReasoning: false,
    userStopped: false,
    budgetExhausted: false,
    inlineAgentRunning: false,
    inlineAgentWillHandle: false,
    previousContinuationReason: null,
    truncationRelaxUsed: false,
    ...overrides,
  };
}

describe('decideChatCompletionContinuation · 截断续轮（t5-a）', () => {
  it('★★ B3 r4 形状：正文非空 + 截断 + 有工具记录 + agent 不接手 ⇒ 必须续轮（旧判据的盲区）', () => {
    const decision = decideChatCompletionContinuation(input());
    expect(decision.continue).toBe(true);
    expect(decision.reason).toBe('truncation');
    expect(decision.relaxed).toBe(false);
  });

  it('★★ 反例：正常结束（有 FINISHED 且正文非空）⇒ 一律不动', () => {
    const decision = decideChatCompletionContinuation(
      input({ truncated: false, verdictEmpty: false, hadToolExecutions: false }),
    );
    expect(decision.continue).toBe(false);
    expect(decision.blockedBy).toBe('normal_completion');
  });

  it('反例：非截断的工具轮（空回答 + 有工具）⇒ 不得续（保留旧语义，避免工具轮重复）', () => {
    const decision = decideChatCompletionContinuation(
      input({ truncated: false, verdictEmpty: true, hadToolExecutions: true }),
    );
    expect(decision.continue).toBe(false);
    expect(decision.blockedBy).toBe('tool_turn_without_truncation');
  });

  it('旧行为保留：非截断的空回答（无工具）⇒ 仍按 empty 续轮', () => {
    const decision = decideChatCompletionContinuation(
      input({ truncated: false, verdictEmpty: true, hadToolExecutions: false }),
    );
    expect(decision.continue).toBe(true);
    expect(decision.reason).toBe('empty');
  });

  it('agent 在跑 / agent 会接手 ⇒ 让给 agent（不得双续轮）', () => {
    expect(
      decideChatCompletionContinuation(input({ inlineAgentRunning: true })).blockedBy,
    ).toBe('inline_agent_running');
    expect(
      decideChatCompletionContinuation(input({ inlineAgentWillHandle: true })).blockedBy,
    ).toBe('inline_agent_will_handle');
  });

  it('停止 / 服务端故障 / 预算耗尽 ⇒ 不续（沿用它既有硬闸）', () => {
    expect(
      decideChatCompletionContinuation(input({ userStopped: true })).blockedBy,
    ).toBe('user_stopped');
    expect(
      decideChatCompletionContinuation(input({ blockedByServerError: true })).blockedBy,
    ).toBe('server_error');
    expect(
      decideChatCompletionContinuation(input({ budgetExhausted: true })).blockedBy,
    ).toBe('budget_exhausted');
  });
});

describe('decideChatCompletionContinuation · 截断链放宽一格（t5-b）', () => {
  it('★★ B3 r10 形状：上一轮也是截断续轮 + 本轮又截断 + no-progress 挡住 ⇒ 放宽续一次', () => {
    const decision = decideChatCompletionContinuation(
      input({
        blockedByNoProgress: true,
        previousContinuationReason: 'truncation',
      }),
    );
    expect(decision.continue).toBe(true);
    expect(decision.reason).toBe('truncation');
    expect(decision.relaxed).toBe(true);
  });

  it('★★ 放宽只给一次：已用过 ⇒ 再次被 no-progress 挡住', () => {
    const decision = decideChatCompletionContinuation(
      input({
        blockedByNoProgress: true,
        previousContinuationReason: 'truncation',
        truncationRelaxUsed: true,
      }),
    );
    expect(decision.continue).toBe(false);
    expect(decision.blockedBy).toBe('no_progress');
  });

  it('★★ 反例：正常轮（上一轮续轮不是截断原因）不得因此多跑', () => {
    for (const previousContinuationReason of [null, 'plan', 'empty'] as const) {
      const decision = decideChatCompletionContinuation(
        input({
          blockedByNoProgress: true,
          previousContinuationReason,
        }),
      );
      expect(decision.continue).toBe(false);
      expect(decision.blockedBy).toBe('no_progress');
    }
  });

  it('反例：非截断轮永远不吃放宽（即使 previous=truncation）', () => {
    const decision = decideChatCompletionContinuation(
      input({
        truncated: false,
        verdictEmpty: true,
        hadToolExecutions: false,
        blockedByMetaReasoning: true,
        previousContinuationReason: 'truncation',
      }),
    );
    expect(decision.continue).toBe(false);
    expect(decision.blockedBy).toBe('meta_reasoning');
  });
});

describe('content.ts 接线守卫（截断诊断 + 三选一续轮）', () => {
  it('★ 截断时必落 `chat/truncated_completion` 诊断（含决策读数）', () => {
    expect(CONTENT_SOURCE).toContain('message: "truncated_completion"');
    expect(CONTENT_SOURCE).toContain('agentWillHandle=');
    expect(CONTENT_SOURCE).toContain('blockedBy=');
  });

  it('★ 聊天层续轮收敛为三选一（plan / empty / truncation），且 agent 启动被它挡住', () => {
    expect(CONTENT_SOURCE).toContain('decideChatCompletionContinuation({');
    expect(CONTENT_SOURCE).toContain('"truncated_auto_continue"');
    expect(CONTENT_SOURCE).toContain('"empty_answer_auto_continue"');
    expect(CONTENT_SOURCE).toContain("recordAgentStartDecision(\n            'skipped:chat_continuation_issued',");
    // 旧的 tools===0 硬条件已被决策函数取代（防止回归到"工具轮不续"）。
    expect(CONTENT_SOURCE).not.toContain(
      '(emptyAnswerVerdict === "empty" || complete.truncated === true) && completedExecutions.length === 0',
    );
  });
});
