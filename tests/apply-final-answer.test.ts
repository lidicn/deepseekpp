/**
 * live 消费点守卫（审计 P3-12 / Y2）。
 *
 * 变异（可判红）：
 *   - 'clear-text' 分支误写成 clearStep ⇒ 用例 2 红
 *   - 'append' 分支不走 appendText ⇒ 用例 4 红
 *   - 忽略 `step === null` ⇒ 用例 5 抛错
 *   - 接线消失（content.ts 不再调用本函数）⇒ 源码守卫用例 6 红
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { applyFinalAnswerAction } from '../core/inline-agent/apply-final-answer';

function makeDeps(step: HTMLElement | null = document.createElement('div')) {
  const container = document.createElement('div');
  return {
    deps: {
      step,
      container,
      loopId: 'loop-1',
      clearStep: vi.fn(),
      clearText: vi.fn(),
      replaceText: vi.fn(),
      appendText: vi.fn(),
      refreshCodeRunners: vi.fn(),
    },
    container,
  };
}

describe('applyFinalAnswerAction', () => {
  it('★ none ⇒ 什么都不做', () => {
    const { deps } = makeDeps();
    applyFinalAnswerAction({ kind: 'none' }, deps);
    expect(deps.clearStep).not.toHaveBeenCalled();
    expect(deps.clearText).not.toHaveBeenCalled();
    expect(deps.replaceText).not.toHaveBeenCalled();
    expect(deps.appendText).not.toHaveBeenCalled();
  });

  it('★★ clear-text ⇒ 只清正文，**不整步清空**（否则会丢工具记录）', () => {
    const { deps } = makeDeps();
    applyFinalAnswerAction({ kind: 'clear-text' }, deps);
    expect(deps.clearText).toHaveBeenCalledTimes(1);
    expect(deps.clearStep).not.toHaveBeenCalled();
  });

  it('★ clear-step ⇒ 整步清空', () => {
    const { deps } = makeDeps();
    applyFinalAnswerAction({ kind: 'clear-step' }, deps);
    expect(deps.clearStep).toHaveBeenCalledTimes(1);
    expect(deps.clearText).not.toHaveBeenCalled();
  });

  it('★ replace ⇒ 替换正文并刷新代码运行器', () => {
    const { deps } = makeDeps();
    applyFinalAnswerAction({ kind: 'replace', text: '答案' }, deps);
    expect(deps.replaceText).toHaveBeenCalledWith(deps.step, '答案');
    expect(deps.refreshCodeRunners).toHaveBeenCalledWith(deps.step);
  });

  it('★ append ⇒ 追加到容器（带 loopId）', () => {
    const { deps, container } = makeDeps();
    applyFinalAnswerAction({ kind: 'append', text: '续写' }, deps);
    expect(deps.appendText).toHaveBeenCalledWith(container, '续写', 'loop-1');
  });

  it('负控：step 为 null（尚未建 step）⇒ 不抛错、也不动作', () => {
    const { deps } = makeDeps(null);
    expect(() => applyFinalAnswerAction({ kind: 'clear-text' }, deps)).not.toThrow();
    expect(() => applyFinalAnswerAction({ kind: 'replace', text: 'x' }, deps)).not.toThrow();
    expect(deps.clearText).not.toHaveBeenCalled();
    expect(deps.replaceText).not.toHaveBeenCalled();
  });

  it('★★ 接线守卫：content.ts 必须调用 applyFinalAnswerAction（Y2 变异会让这条红）', () => {
    const source = readFileSync('entrypoints/content.ts', 'utf8');
    expect(source).toContain('applyFinalAnswerAction(');
    // 反证：不得再保留"整步跳过"的旧实现
    expect(source).not.toMatch(/if \(ownsFinalTurn\)\s*\{\s*return;/);
  });
});
