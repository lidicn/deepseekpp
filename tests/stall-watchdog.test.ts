// @vitest-environment jsdom
/**
 * 看门狗 DOM 读取守卫（2026-10-30）。
 *
 * 变异（可判红）：
 *   - 改成读第一条消息 ⇒ 用例 1 红
 *   - 去掉 trim ⇒ 用例 3 红（纯空白应算 0）
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { readLastAnswerLength } from '../core/inline-agent/stall-watchdog';

function message(text: string | null): HTMLElement {
  const el = document.createElement('div');
  el.className = 'ds-message';
  if (text !== null) {
    const md = document.createElement('div');
    md.className = 'ds-markdown';
    md.textContent = text;
    el.appendChild(md);
  }
  document.body.appendChild(el);
  return el;
}

describe('readLastAnswerLength', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('★★ 必须读**最后一条**消息，而不是第一条', () => {
    message('用户的问题');
    message('第一条助手回答，长度比较长一点点');
    message('最终答案');
    expect(readLastAnswerLength(document)).toBe('最终答案'.length);
  });

  it('★ 变量分隔的兄弟节点不影响结果（第一版 :last-of-type 的坑）', () => {
    message('用户的问题');
    const other = document.createElement('div'); // 非 .ds-message 的兄弟
    document.body.appendChild(other);
    message('最终答案');
    other.className = 'some-toolbar';
    expect(readLastAnswerLength(document)).toBe('最终答案'.length);
  });

  it('★ 纯空白算 0（trim 生效）', () => {
    message('   \n  ');
    expect(readLastAnswerLength(document)).toBe(0);
  });

  it('负控：没有消息 / 最后一条没有 .ds-markdown ⇒ 0', () => {
    expect(readLastAnswerLength(document)).toBe(0);
    message('有正文');
    message(null);
    expect(readLastAnswerLength(document)).toBe(0);
  });
});
