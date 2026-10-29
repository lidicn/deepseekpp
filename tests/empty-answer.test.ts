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
