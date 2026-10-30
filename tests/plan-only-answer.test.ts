/**
 * 「计划型短答案」守卫（目标第 5 轮真机发现）。
 *
 * 变异（可判红）：
 *   - 去掉 `hits >= 2`（改成 >= 1）⇒ 用例 3 红（正常短答案被误判）
 *   - 去掉 DELIVERABLE 判据 ⇒ 用例 4 红（有 file:line 的答案被误判）
 *   - `continuedAlready` 失效 ⇒ 用例 5 红（无限续轮）
 */
import { describe, expect, it } from 'vitest';
import {
  decidePlanOnlySettlement,
  decideChatLayerContinuation,
  looksLikePlanOnlyAnswer,
} from '../core/inline-agent/plan-only-answer';

const REAL_PLAN = '先检索记忆了解项目背景。已有记忆 #107、#108 是之前的审计。'
  + '应该做新的审计，找不同的 bug。先探索项目结构，让我开始。';

describe('looksLikePlanOnlyAnswer', () => {
  it('★★ 真机样本（计划语 + 无交付 + 短）⇒ true', () => {
    expect(looksLikePlanOnlyAnswer({ answerText: REAL_PLAN })).toBe(true);
  });

  it('★ 有工具执行 ⇒ 不算（真的动了手）', () => {
    expect(looksLikePlanOnlyAnswer({ answerText: REAL_PLAN, hadToolExecutions: true })).toBe(false);
  });

  it('★ 只有单个计划语 ⇒ 不算（保守，避免误判正常短答案）', () => {
    expect(looksLikePlanOnlyAnswer({ answerText: '接下来我会处理。' })).toBe(false);
  });

  it('★ 含交付证据（file:line / 结论）⇒ 不算', () => {
    expect(
      looksLikePlanOnlyAnswer({
        answerText: '我先看了 core/a.ts:12，结论：这里有空指针风险。',
      }),
    ).toBe(false);
    expect(
      looksLikePlanOnlyAnswer({ answerText: '首先我确认了配置，发现一处拼写错误。' }),
    ).toBe(false);
  });

  it('负控：长文（>1500 字）不算计划型', () => {
    const long = `${REAL_PLAN}${'补充说明。'.repeat(400)}`;
    expect(long.length).toBeGreaterThan(1500);
    expect(looksLikePlanOnlyAnswer({ answerText: long })).toBe(false);
  });

  it('负控：空文本不算', () => {
    expect(looksLikePlanOnlyAnswer({ answerText: '   ' })).toBe(false);
  });
});

describe('decidePlanOnlySettlement', () => {
  it('★ 计划型 + 可续 + 未续过 ⇒ continue', () => {
    expect(
      decidePlanOnlySettlement({ planOnly: true, continuable: true, continuedAlready: false }),
    ).toBe('continue');
  });

  it('★ 已续过一次 ⇒ settle（最多续 1 次）', () => {
    expect(
      decidePlanOnlySettlement({ planOnly: true, continuable: true, continuedAlready: true }),
    ).toBe('settle');
  });

  it('负控：链不可续 / 非计划型 ⇒ settle', () => {
    expect(
      decidePlanOnlySettlement({ planOnly: true, continuable: false, continuedAlready: false }),
    ).toBe('settle');
    expect(
      decidePlanOnlySettlement({ planOnly: false, continuable: true, continuedAlready: false }),
    ).toBe('settle');
  });
});
describe('decideChatLayerContinuation（聊天层自动续一次）', () => {
  it('★★ 计划型 + 无工具 + 未续过 ⇒ 自动续（这就是"第一步就停"的修法）', () => {
    expect(
      decideChatLayerContinuation({ answerText: REAL_PLAN, hadToolExecutions: false, alreadyContinued: false, enabled: true }),
    ).toBe(true);
  });

  it('★ 已续过 ⇒ 不再续（封顶 1 次，避免自激）', () => {
    expect(
      decideChatLayerContinuation({ answerText: REAL_PLAN, hadToolExecutions: false, alreadyContinued: true, enabled: true }),
    ).toBe(false);
  });

  it('负控：有工具执行 / 开关关闭 / 非计划型 ⇒ 不续', () => {
    expect(decideChatLayerContinuation({ answerText: REAL_PLAN, hadToolExecutions: true, alreadyContinued: false, enabled: true })).toBe(false);
    expect(decideChatLayerContinuation({ answerText: REAL_PLAN, hadToolExecutions: false, alreadyContinued: false, enabled: false })).toBe(false);
    expect(decideChatLayerContinuation({ answerText: '答案：这里有一处 bug，证据 core/a.ts:12。', hadToolExecutions: false, alreadyContinued: false, enabled: true })).toBe(false);
  });
});
describe('英文计划型（真机 2026-10-30：990 字，FINISHED 但明显没做完）', () => {
  const EN_PLAN = [
    'Let me plan:',
    '',
    'memory_search for "deepseek-pp audit" to recall what is already found.',
    '',
    'shell_exec: check repo, git log, file listing (break, indexOf, dedupe keys, Date.now() etc.',
    '',
    'Then I dig into code areas not yet covered.',
    '',
    'Start.',
  ].join('\n');

  it('★★ 英文计划 + 无工具 + 无交付证据 ⇒ 判为计划型（中文标记时代这条会漏）', () => {
    expect(looksLikePlanOnlyAnswer({ answerText: EN_PLAN })).toBe(true);
  });

  it('★ 同样长度但含 file:line ⇒ 不算', () => {
    expect(
      looksLikePlanOnlyAnswer({ answerText: `${EN_PLAN}\n\nevidence: core/tool/runtime.ts:733` }),
    ).toBe(false);
  });

  it('★ 聊天层也会因此自动续一次', () => {
    expect(
      decideChatLayerContinuation({
        answerText: EN_PLAN,
        hadToolExecutions: false,
        alreadyContinued: false,
        enabled: true,
      }),
    ).toBe(true);
  });
});