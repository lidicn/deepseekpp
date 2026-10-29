/**
 * 收尾头部守卫（F2）：截断轮不得显示「已完成」。
 *
 * 变异（可判红）：
 *   - `interrupted` 分支删掉 ⇒ 用例 2 红（截断轮退回显示「已完成」）
 *   - `hadError` 优先级放后 ⇒ 用例 3 红
 */
import { describe, expect, it } from 'vitest';
import { resolveTerminalHeader } from '../core/inline-agent/terminal-header';

describe('resolveTerminalHeader', () => {
  it('★ 正常完成 ⇒ complete + 默认文案', () => {
    expect(resolveTerminalHeader({ interrupted: false, budgetPaused: false })).toEqual({
      phase: 'complete',
      labelKey: null,
    });
  });

  it('★★ 截断轮 ⇒ complete 但要覆盖成「响应被中断」标签（不能显示已完成）', () => {
    expect(resolveTerminalHeader({ interrupted: true, budgetPaused: false })).toEqual({
      phase: 'complete',
      labelKey: 'content.agent.interruptedLabel',
    });
  });

  it('★ 错误优先于截断与预算暂停', () => {
    expect(resolveTerminalHeader({ interrupted: true, budgetPaused: true, hadError: true })).toEqual({
      phase: 'error',
      labelKey: null,
    });
  });

  it('★ 预算暂停（未截断）⇒ paused + 默认文案', () => {
    expect(resolveTerminalHeader({ interrupted: false, budgetPaused: true })).toEqual({
      phase: 'paused',
      labelKey: null,
    });
  });
});
