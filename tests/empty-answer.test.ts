/**
 * 空回答分类守卫（真机 2026-10-30）。
 *
 * 变异（可判红）：
 *   - `hasToolExecutions` 分支去掉 ⇒ 用例 3 红（工具轮会被误报成空回答）
 *   - `reasoningText` 分支去掉 ⇒ 用例 2 红（思考型空回答退化成普通空回答）
 */
import { describe, expect, it } from 'vitest';
import {
  classifyEmptyAnswer,
  hasAssistantMessage,
  readLastAssistantAnswerText,
  shouldWarnEmptyAnswer,
} from '../core/inline-agent/empty-answer';

describe('classifyEmptyAnswer', () => {
  it('★ 有正文 ⇒ ok', () => {
    expect(classifyEmptyAnswer({ answerText: '这是答案。' })).toBe('ok');
  });

  it('★★ 只有思考、无正文、无工具 ⇒ thinking-only（真机复现的形态）', () => {
    expect(
      classifyEmptyAnswer({
        answerText: '',
        reasoningText: '先检查环境，然后浏览项目结构。让我开始。',
      }),
    ).toBe('thinking-only');
  });

  it('★★ 无正文但有工具执行 ⇒ ok（工具轮正常，不误报）', () => {
    expect(
      classifyEmptyAnswer({ answerText: '', reasoningText: '我要调 shell', hasToolExecutions: true }),
    ).toBe('ok');
  });

  it('负控：纯空白也算空', () => {
    expect(classifyEmptyAnswer({ answerText: '   \n ' })).toBe('empty');
  });

  it('★ 只有空/思考型才提示', () => {
    expect(shouldWarnEmptyAnswer('ok')).toBe(false);
    expect(shouldWarnEmptyAnswer('thinking-only')).toBe(true);
    expect(shouldWarnEmptyAnswer('empty')).toBe(true);
  });
});
describe('DOM 级判定（真机：payload.text 带着思考，不能用它判）', () => {
  function dom(html: string): HTMLElement {
    const root = document.createElement('div');
    root.innerHTML = html;
    return root;
  }

  it('★★ 只有思考块、没有 .ds-markdown 正文 ⇒ 读出空串（而非把思考当正文）', () => {
    const root = dom(`
      <div class="ds-message"><div class="ds-think">已思考（用时 1 秒）…让我开始。</div></div>`);
    expect(hasAssistantMessage(root)).toBe(true);
    expect(readLastAssistantAnswerText(root)).toBe('');
  });

  it('★ 有正文 ⇒ 读出正文', () => {
    const root = dom(`
      <div class="ds-message"><div class="ds-think">思考</div><div class="ds-markdown">这是答案。</div></div>`);
    expect(readLastAssistantAnswerText(root)).toBe('这是答案。');
  });

  it('负控：没有 assistant 消息 ⇒ 空串（调用方回退用 payload）', () => {
    const root = dom('<div></div>');
    expect(hasAssistantMessage(root)).toBe(false);
    expect(readLastAssistantAnswerText(root)).toBe('');
  });

  it('★ 端到端：只有思考的 DOM ⇒ 必须提示；有正文 ⇒ 不提示', () => {
    const thinking = dom(`
      <div class="ds-message"><div class="ds-think">先看结构。让我开始。</div></div>`);
    const thinkingVerdict = classifyEmptyAnswer({
      answerText: readLastAssistantAnswerText(thinking),
      reasoningText: '先看结构。让我开始。',
    });
    expect(thinkingVerdict).toBe('thinking-only');
    expect(shouldWarnEmptyAnswer(thinkingVerdict)).toBe(true);

    const answered = dom(`
      <div class="ds-message"><div class="ds-think">思考</div><div class="ds-markdown">答案</div></div>`);
    const okVerdict = classifyEmptyAnswer({ answerText: readLastAssistantAnswerText(answered) });
    expect(okVerdict).toBe('ok');
    expect(shouldWarnEmptyAnswer(okVerdict)).toBe(false);
  });});