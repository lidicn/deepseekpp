/**
 * 「最终答案唯一」的不变量测试（先让它红，再谈修）。
 *
 * 覆盖三件事：
 *   ① **路由**：ownsFinalTurn 时必须 clear（不是跳过）—— 这是原实现的漏洞
 *   ② **判据唯一**：live 与 restore 必须同解；额外条件（toolExecutions.length===0）不得回归
 *   ③ **不变量**：一次 run 结束后，页面里"可见的出现次数"必须 == 1
 *
 * 变异（可判红）：
 *   - 把 `if (input.ownsFinalTurn) return { kind: 'clear' }` 改成 `return { kind: 'none' }`
 *     ⇒ 用例 1 红（这正是"不新增但老那份还在"的旧行为）
 *   - 给 `traceOwnsFinalTurn` 加回额外条件 ⇒ 用例 5 红
 */
import { describe, expect, it } from 'vitest';
import {
  routeFinalAnswer,
  traceOwnsFinalTurn,
  type FinalAnswerAction,
} from '../core/inline-agent/final-answer-routing';
import type { InlineAgentTraceRecord } from '../core/inline-agent/types';

const ANSWER = '最终答案：这部片值得看，因为它在克制里蓄力。';

/** 造一个"已提交到原生历史"的 trace 最小形状（只带被判据读到的字段）。 */
function makeTrace(overrides: Partial<InlineAgentTraceRecord> = {}): InlineAgentTraceRecord {
  return {
    id: 'trace-1',
    loopId: 'loop-1',
    chatSessionId: 'chat-1',
    url: 'https://chat.deepseek.com/a/chat/s/x',
    originalPrompt: '推荐几部高分电影',
    agentTaskPrompt: '推荐几部高分电影',
    status: 'complete',
    // 判据真实要求：complete + 有 step + 最后一步带正整数 responseMessageId
    steps: [{ index: 0, status: 'complete', text: 'done', toolExecutions: [], collapsed: false, responseMessageId: 4242 } as never],
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  } as InlineAgentTraceRecord;
}

const isFinalStepText = (stepText: string, finalText: string) =>
  stepText === finalText || finalText.startsWith(stepText);

describe('routeFinalAnswer · 路由', () => {
  it('★ 原生拥有 ⇒ clear（即使正文为空也必须清空屏上那份）', () => {
    const action = routeFinalAnswer({
      ownsFinalTurn: true,
      finalText: ANSWER,
      resolvedAnswer: { answer: ANSWER, fromStep: false },
      lastStepText: ANSWER, // 流式期已经画在屏上的那份
      isFinalStepText,
    });
    expect(action).toEqual({ kind: 'clear' });

    // 边界：没有任何正文时也要 clear（屏上可能有上一轮残留）
    const empty = routeFinalAnswer({
      ownsFinalTurn: true,
      finalText: '',
      resolvedAnswer: { answer: '', fromStep: false },
      lastStepText: '残留',
      isFinalStepText,
    });
    expect(empty).toEqual({ kind: 'clear' });
  });

  it('★ 扩展拥有 + 最后一步就是答案 ⇒ replace', () => {
    const action = routeFinalAnswer({
      ownsFinalTurn: false,
      finalText: ANSWER,
      resolvedAnswer: { answer: ANSWER, fromStep: false },
      lastStepText: '最终答案：这部片值得看，因为它在克制里蓄力。',
      isFinalStepText,
    });
    expect(action).toEqual({ kind: 'replace', text: ANSWER });
  });

  it('★ 扩展拥有 + 前缀关系 ⇒ 仍 replace（不追加）', () => {
    const action = routeFinalAnswer({
      ownsFinalTurn: false,
      finalText: ANSWER,
      resolvedAnswer: { answer: ANSWER, fromStep: false },
      lastStepText: '最终答案：这部片值得看',
      isFinalStepText,
    });
    expect(action.kind).toBe('replace');
  });

  it('★ 扩展拥有 + 不构成前缀 ⇒ append（这是 §2.2 的 step↔narration 双份来源，靠 clear/唯一所有者兜）', () => {
    const action: FinalAnswerAction = routeFinalAnswer({
      ownsFinalTurn: false,
      finalText: ANSWER,
      resolvedAnswer: { answer: ANSWER, fromStep: false },
      lastStepText: '我先说点别的，然后再说结论。',
      isFinalStepText,
    });
    expect(action).toEqual({ kind: 'append', text: ANSWER });
  });

  it('负控：没有正文、扩展拥有 ⇒ none（不画空 narration）', () => {
    expect(
      routeFinalAnswer({
        ownsFinalTurn: false,
        finalText: '',
        resolvedAnswer: { answer: '', fromStep: false },
        lastStepText: 'x',
        isFinalStepText,
      }),
    ).toEqual({ kind: 'none' });
  });
});

describe('traceOwnsFinalTurn · 判据唯一', () => {
  it('★ 原生历史回溯的 trace ⇒ true', () => {
    expect(traceOwnsFinalTurn(makeTrace(), { budgetPaused: false })).toBe(true);
  });

  it('★ 预算暂停 ⇒ false（哪怕 trace 看起来像原生回溯）', () => {
    expect(traceOwnsFinalTurn(makeTrace(), { budgetPaused: true })).toBe(false);
  });

  it('负控：没有 trace ⇒ false', () => {
    expect(traceOwnsFinalTurn(null, { budgetPaused: false })).toBe(false);
    expect(traceOwnsFinalTurn(undefined, { budgetPaused: false })).toBe(false);
  });

  it('★ 关键回归守卫：判据不接受"最后一步有无工具执行"这类额外条件', () => {
    // 同一个 trace、同样的 budgetPaused，无论 steps 里塞了什么，判定必须一致。
    // 旧实现 restore 侧多加了 `lastStepRecord?.toolExecutions.length === 0`，
    // 导致同一轮"收尾判原生拥有、刷新后判扩展拥有"。
    const withTools = makeTrace({
      steps: [
        {
          index: 0,
          status: 'complete',
          text: ANSWER,
          toolExecutions: [{ id: 'x', name: 'web_search', status: 'success' } as never],
          collapsed: false,
          responseMessageId: 4242,
        } as never,
      ],
    });
    const withoutTools = makeTrace({
      steps: [
        {
          index: 0,
          status: 'complete',
          text: ANSWER,
          toolExecutions: [],
          collapsed: false,
          responseMessageId: 4242,
        } as never,
      ],
    });

    // 先证明两条 fixture 都是「原生拥有」，否则相等断言只是双双 false 的假绿
    expect(traceOwnsFinalTurn(withTools, { budgetPaused: false })).toBe(true);
    expect(traceOwnsFinalTurn(withoutTools, { budgetPaused: false })).toBe(true);
    expect(traceOwnsFinalTurn(withTools, { budgetPaused: false })).toBe(
      traceOwnsFinalTurn(withoutTools, { budgetPaused: false }),
    );
  });
});

describe('不变量：一次 run 结束后最终答案只出现一次', () => {
  /**
   * DOM 级不变量：用假 DOM 模拟"扩展 console + 原生消息"两个世界，
   * 按路由动作执行后统计**可见**出现次数。
   */
  function visibleOccurrences(root: HTMLElement, needle: string): number {
    let count = 0;
    for (const el of [root, ...Array.from(root.querySelectorAll<HTMLElement>('*'))]) {
      // 只统计"叶子文本块"：自身不含子元素，且不隐藏在 none/hidden 子树里
      if (el.children.length > 0) continue;
      if (el.closest('[hidden]')) continue;
      if (el.style?.display === 'none') continue;
      if ((el.textContent ?? '').includes(needle)) count += 1;
    }
    return count;
  }

  function applyAction(container: HTMLElement, nativeHasAnswer: boolean, action: FinalAnswerAction) {
    const step = container.querySelector<HTMLElement>('.dpp-agent-step-body');
    if (nativeHasAnswer) {
      const native = document.createElement('div');
      native.className = 'ds-message';
      native.textContent = ANSWER;
      document.body.appendChild(native);
    }
    switch (action.kind) {
      case 'clear':
        step?.parentElement?.remove();   // 与 updateStepStreamText(step, '') 等价：整个 step 移除
        break;
      case 'replace':
        if (step) step.textContent = action.text;
        break;
      case 'append': {
        const narration = document.createElement('div');
        narration.className = 'dpp-agent-step-body';
        narration.textContent = action.text;
        container.appendChild(narration);
        break;
      }
      case 'none':
        break;
    }
  }

  it('★ live：原生拥有时，屏上不得残留扩展那份（旧实现 skip ⇒ 两份 ⇒ 红）', () => {
    document.body.innerHTML = '';
    const consoleRoot = document.createElement('div');
    consoleRoot.className = 'dpp-agent-container';
    consoleRoot.innerHTML = `<div class="dpp-agent-step"><div class="dpp-agent-step-body">${ANSWER}</div></div>`;
    document.body.appendChild(consoleRoot);

    const action = routeFinalAnswer({
      ownsFinalTurn: true,
      finalText: ANSWER,
      resolvedAnswer: { answer: ANSWER, fromStep: false },
      lastStepText: ANSWER,
      isFinalStepText,
    });
    applyAction(consoleRoot, true, action);

    expect(visibleOccurrences(document.body, ANSWER)).toBe(1);
  });

  it('★ 扩展拥有时：屏上只有扩展那份', () => {
    document.body.innerHTML = '';
    const consoleRoot = document.createElement('div');
    consoleRoot.className = 'dpp-agent-container';
    consoleRoot.innerHTML = `<div class="dpp-agent-step"><div class="dpp-agent-step-body">我先说点别的</div></div>`;
    document.body.appendChild(consoleRoot);

    const action = routeFinalAnswer({
      ownsFinalTurn: false,
      finalText: ANSWER,
      resolvedAnswer: { answer: ANSWER, fromStep: false },
      lastStepText: '我先说点别的',
      isFinalStepText,
    });
    applyAction(consoleRoot, false, action);

    expect(visibleOccurrences(document.body, ANSWER)).toBe(1);
  });
});
