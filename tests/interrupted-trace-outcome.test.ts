/**
 * t3-B（观测口径）：中断轮不得在 trace 里记成完成。
 *
 * 真实事故形态：服务端 EOF 无 FINISHED ⇒ partial/'length' ⇒ 结算层把 finalText 换成
 * 「响应被中断」提示 ⇒ 旧口径 `stopReason==='finalized' && hasFinalText` 把这一轮记成
 * finished=true，报告/验收永远读不出红灯。
 *
 * 变异自证：
 *   - `resolveTraceStopReason` 去掉 `interrupted` 分支 ⇒ 用例 1/2 红；
 *   - `isTraceRunFinished` 去掉 `stopReason==='finalized'` ⇒ 用例 3 红；
 *   - content.ts 的 AGENT_LOOP_COMPLETE 不再把 msg.interrupted 传下去 ⇒ 接线守卫红。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  TRACE_INTERRUPTED_STOP_REASON,
  isTraceRunFinished,
  resolveTraceStopReason,
} from '../core/trace/trace-outcome';

const CONTENT_SOURCE = readFileSync(
  join(__dirname, '..', 'entrypoints', 'content.ts'),
  'utf-8',
);

describe('resolveTraceStopReason / isTraceRunFinished', () => {
  it('★ 中断轮的 finalized 改写为 interrupted', () => {
    expect(resolveTraceStopReason('finalized', true)).toBe(TRACE_INTERRUPTED_STOP_REASON);
  });

  it('非中断轮保持原 stopReason（aborted / turn_error / loop_threw 不受影响）', () => {
    expect(resolveTraceStopReason('finalized', false)).toBe('finalized');
    expect(resolveTraceStopReason('aborted', true)).toBe('aborted');
    expect(resolveTraceStopReason('turn_error', true)).toBe('turn_error');
    expect(resolveTraceStopReason('loop_threw', true)).toBe('loop_threw');
  });

  it('★★ 中断轮即使有可读提示文案也不得记 finished=true', () => {
    const stopReason = resolveTraceStopReason('finalized', true);
    // 中断提示文案非空，但这不是"用户拿到东西了"。
    expect(isTraceRunFinished(stopReason, true)).toBe(false);
    // 对照：真正完成仍然是 finished=true。
    expect(isTraceRunFinished('finalized', true)).toBe(true);
    expect(isTraceRunFinished('finalized', false)).toBe(false);
  });
});

describe('content.ts 接线守卫（中断标记必须传进 trace 口径）', () => {
  it('★ AGENT_LOOP_COMPLETE 把 msg.interrupted 传给 finishTraceRun', () => {
    expect(CONTENT_SOURCE).toContain(
      'finishTraceRun(msg.stopReason ?? "finalized", msg.finalText.trim().length > 0, msg.interrupted === true);',
    );
  });

  it('fade: finishTraceRun 走统一口径（不得自己再写一套判断）', () => {
    const fnStart = CONTENT_SOURCE.indexOf('function finishTraceRun(');
    expect(fnStart).toBeGreaterThan(0);
    const fnBody = CONTENT_SOURCE.slice(fnStart, fnStart + 700);
    expect(fnBody).toContain('resolveTraceStopReason(');
    expect(fnBody).toContain('isTraceRunFinished(');
  });
});
