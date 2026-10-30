/**
 * 「最终答案唯一」的不变量测试 + 渲染安全护栏。
 *
 * 三次教训（按时间）：
 *   ① 原实现 `if (!hasNativeTurn)` 只"跳过再画"，收不回已流式画在屏上的那份 ⇒ 双份。
 *   ② 我第一版改成 `clear`（`updateStepStreamText(step,'')`）⇒ **整个 step 被删**，
 *      连带删掉工具记录。恢复侧那个 `toolExecutions.length === 0` 其实是渲染护栏，
 *      不是判定 bug。
 *   ③ 因此本模块把「答案归谁」与「这个 step 能不能动」分开：
 *      owns + 装答案 + 有工具记录 ⇒ `clear-text`（只清正文）
 *      owns + 装答案 + 无工具记录 ⇒ `clear-step`
 *      owns + 不装答案 ⇒ `none`（**不许删工具记录**）
 *
 * 变异（可判红）：
 *   - `lastStepHasToolEntries ? 'clear-text' : 'clear-step'` 改成恒 `'clear-step'` ⇒ 用例 2 红
 *   - `stepHoldsAnswer` 判断删掉（恒 true）⇒ 用例 3 红
 *   - 给 `traceOwnsFinalTurn` 加回 `toolExecutions` 条件 ⇒ 用例 6 红
 */
import { describe, expect, it } from 'vitest';
import {
  decideRestoreStepAction,
  routeFinalAnswer,
  traceOwnsFinalTurn,
  type FinalAnswerAction,
} from '../core/inline-agent/final-answer-routing';
import type { InlineAgentTraceRecord } from '../core/inline-agent/types';

const ANSWER = '最终答案：这部片值得看，因为它在克制里蓄力。';
const PARTIAL = '最终答案：这部片值得看';

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

const base = {
  finalText: ANSWER,
  resolvedAnswer: { answer: ANSWER, fromStep: false },
  lastStepText: ANSWER,
  lastStepHasToolEntries: false,
  isFinalStepText,
};

describe('routeFinalAnswer · 原生拥有（去重）', () => {
  it('★ 装答案 + 无工具记录 ⇒ clear-step（整块移除，这是纯答案步）', () => {
    expect(routeFinalAnswer({ ...base, ownsFinalTurn: true })).toEqual({ kind: 'clear-step' });
  });

  it('★★ 装答案 + **有工具记录** ⇒ clear-text（只清正文，工具记录必须留下）', () => {
    const action = routeFinalAnswer({
      ...base,
      ownsFinalTurn: true,
      lastStepHasToolEntries: true,
    });
    expect(action).toEqual({ kind: 'clear-text' });
  });

  it('★★ 该 step 不装答案 ⇒ none（原生拥有不等于可以删工具记录）', () => {
    const action = routeFinalAnswer({
      ...base,
      ownsFinalTurn: true,
      lastStepText: '我先调了个工具，结果如下',
      lastStepHasToolEntries: true,
    });
    expect(action).toEqual({ kind: 'none' });
  });

  it('负控：正文为空 + 原生拥有 ⇒ none（没有证据说这一步装着答案）', () => {
    const action = routeFinalAnswer({
      ...base,
      ownsFinalTurn: true,
      finalText: '',
      resolvedAnswer: { answer: '', fromStep: false },
      lastStepText: '残留文本',
      lastStepHasToolEntries: true,
    });
    expect(action).toEqual({ kind: 'none' });
  });

  it('边界：fromStep=true 时即使没有前缀关系也认作装答案', () => {
    const action = routeFinalAnswer({
      ...base,
      ownsFinalTurn: true,
      resolvedAnswer: { answer: ANSWER, fromStep: true },
      lastStepText: '完全不同的文本',
    });
    expect(action.kind).toBe('clear-step');
  });
});

describe('routeFinalAnswer · 扩展拥有（正常渲染）', () => {
  it('★ 最后一步就是答案 ⇒ replace', () => {
    expect(routeFinalAnswer({ ...base, ownsFinalTurn: false })).toEqual({
      kind: 'replace',
      text: ANSWER,
    });
  });

  it('★ 前缀关系 ⇒ 仍 replace（不追加）', () => {
    const action = routeFinalAnswer({
      ...base,
      ownsFinalTurn: false,
      lastStepText: PARTIAL,
    });
    expect(action.kind).toBe('replace');
  });

  it('★ 不构成前缀 ⇒ append（§2.2 step↔narration 的来源，靠 owner 兜）', () => {
    const action: FinalAnswerAction = routeFinalAnswer({
      ...base,
      ownsFinalTurn: false,
      lastStepText: '我先说点别的，然后再说结论。',
    });
    expect(action).toEqual({ kind: 'append', text: ANSWER });
  });

  it('负控：没有正文 ⇒ none', () => {
    expect(
      routeFinalAnswer({
        ...base,
        ownsFinalTurn: false,
        finalText: '',
        resolvedAnswer: { answer: '', fromStep: false },
      }),
    ).toEqual({ kind: 'none' });
  });
});

describe('traceOwnsFinalTurn · 判据唯一', () => {
  it('原生历史回溯的 trace ⇒ true', () => {
    expect(traceOwnsFinalTurn(makeTrace(), { budgetPaused: false })).toBe(true);
  });

  it('★ 预算暂停 ⇒ false', () => {
    expect(traceOwnsFinalTurn(makeTrace(), { budgetPaused: true })).toBe(false);
  });

  it('负控：null / undefined ⇒ false', () => {
    expect(traceOwnsFinalTurn(null, { budgetPaused: false })).toBe(false);
    expect(traceOwnsFinalTurn(undefined, { budgetPaused: false })).toBe(false);
  });

  it('★ 回归守卫：判据不接受"末步有无工具执行"这类额外条件', () => {
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

describe('DOM 不变量：答案只出现一次，且工具记录不丢', () => {
  function visibleOccurrences(root: HTMLElement, needle: string): number {
    let count = 0;
    for (const el of [root, ...Array.from(root.querySelectorAll<HTMLElement>('*'))]) {
      if (el.children.length > 0) continue;
      if (el.closest('[hidden]')) continue;
      if (el.style?.display === 'none') continue;
      if ((el.textContent ?? '').includes(needle)) count += 1;
    }
    return count;
  }

  function makeConsole(withTools: boolean): HTMLElement {
    const consoleRoot = document.createElement('div');
    consoleRoot.className = 'dpp-agent-container';
    consoleRoot.innerHTML = `
      <div class="dpp-agent-step">
        ${withTools ? '<div class="dpp-agent-tool-group"><span>shell_exec</span></div>' : ''}
        <div class="dpp-agent-step-body">${ANSWER}</div>
      </div>`;
    document.body.appendChild(consoleRoot);
    return consoleRoot;
  }

  function apply(consoleRoot: HTMLElement, action: FinalAnswerAction, nativeHasAnswer: boolean) {
    const step = consoleRoot.querySelector<HTMLElement>('.dpp-agent-step');
    const body = consoleRoot.querySelector<HTMLElement>('.dpp-agent-step-body');
    if (nativeHasAnswer) {
      const native = document.createElement('div');
      native.className = 'ds-message';
      native.textContent = ANSWER;
      document.body.appendChild(native);
    }
    switch (action.kind) {
      case 'clear-step':
        step?.remove();
        break;
      case 'clear-text':
        if (body) body.textContent = '';
        break;
      case 'replace':
        if (body) body.textContent = action.text;
        break;
      case 'append': {
        const narration = document.createElement('div');
        narration.className = 'dpp-agent-step-body';
        narration.textContent = action.text;
        consoleRoot.appendChild(narration);
        break;
      }
      case 'none':
        break;
    }
  }

  it('★ 原生拥有 + 有工具记录：答案只 1 份，工具组仍在', () => {
    document.body.innerHTML = '';
    const consoleRoot = makeConsole(true);
    apply(
      consoleRoot,
      routeFinalAnswer({ ...base, ownsFinalTurn: true, lastStepHasToolEntries: true }),
      true,
    );
    expect(visibleOccurrences(document.body, ANSWER)).toBe(1);
    expect(consoleRoot.querySelector('.dpp-agent-tool-group')).not.toBeNull();
  });

  it('★ 原生拥有 + 无工具记录：整个 step 移除，答案只 1 份', () => {
    document.body.innerHTML = '';
    const consoleRoot = makeConsole(false);
    apply(consoleRoot, routeFinalAnswer({ ...base, ownsFinalTurn: true }), true);
    expect(visibleOccurrences(document.body, ANSWER)).toBe(1);
    expect(consoleRoot.querySelector('.dpp-agent-step')).toBeNull();
  });

  it('★ 扩展拥有：屏上只有扩展那份', () => {
    document.body.innerHTML = '';
    const consoleRoot = makeConsole(false);
    apply(consoleRoot, routeFinalAnswer({ ...base, ownsFinalTurn: false }), false);
    expect(visibleOccurrences(document.body, ANSWER)).toBe(1);
  });
});
describe('restore 侧单步动作（2.4 对齐）', () => {
  it('★ 原生拥有 + 末步 + 无工具 ⇒ skip', () => {
    expect(decideRestoreStepAction({ ownsFinalTurn: true, isLastStep: true, hasToolEntries: false })).toBe('skip');
  });

  it('★★ 原生拥有 + 末步 + **有工具** ⇒ 只去答案、保留工具记录', () => {
    expect(decideRestoreStepAction({ ownsFinalTurn: true, isLastStep: true, hasToolEntries: true })).toBe('render-without-answer');
  });

  it('负控：非末步 / 扩展拥有 ⇒ 正常渲染', () => {
    expect(decideRestoreStepAction({ ownsFinalTurn: true, isLastStep: false, hasToolEntries: true })).toBe('render');
    expect(decideRestoreStepAction({ ownsFinalTurn: false, isLastStep: true, hasToolEntries: false })).toBe('render');
  });
});
describe('nudge 续轮不重述（2.4 第三项）', () => {
  it('★★ nudge 轮即使不构成前缀关系也合并进同一 step（否则同一次工作出现两份）', () => {
    const action = routeFinalAnswer({
      ...base,
      ownsFinalTurn: false,
      isNudgeTurn: true,
      lastStepText: '完全不同的上一轮文本，不构成前缀。',
    });
    expect(action).toEqual({ kind: 'replace', text: ANSWER });
  });

  it('负控：非 nudge 轮仍走 append（保持原行为）', () => {
    const action = routeFinalAnswer({
      ...base,
      ownsFinalTurn: false,
      isNudgeTurn: false,
      lastStepText: '完全不同的上一轮文本，不构成前缀。',
    });
    expect(action).toEqual({ kind: 'append', text: ANSWER });
  });
});