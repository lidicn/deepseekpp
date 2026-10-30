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
  hasDeliverableEvidence,
  isSuspiciouslyShortAnswer,
  decideAutoContinueBudget,
  decideStallRecovery,
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

  it('★ 短文本单个计划语也算计划型（真机 127 字样本只命中 1 个）', () => {
    expect(looksLikePlanOnlyAnswer({ answerText: '接下来我会处理。' })).toBe(true);
  });

  it('★ 负控：短且无计划语、或带 file:line 的短答案 ⇒ 不算', () => {
    expect(looksLikePlanOnlyAnswer({ answerText: '好的。' })).toBe(false);
    expect(looksLikePlanOnlyAnswer({ answerText: '已完成，见 core/a.ts:12。' })).toBe(false);
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

describe('极短答案（真机 50 字 FINISHED 样本）', () => {
  it('★★ 50 字、无计划标记、无工具 ⇒ 判为可疑极短', () => {
    expect(isSuspiciouslyShortAnswer({ answerText: '好，我来审计一下这个仓库，先看看结构，然后找 bug。', hadToolExecutions: false })).toBe(true);
  });

  it('★ 186 字（真机 run1 样本，无交付证据）也算', () => {
    expect(isSuspiciouslyShortAnswer({ answerText: 'x'.repeat(186), hadToolExecutions: false })).toBe(true);
  });

  it('负控：有交付证据 / 有工具执行 / 长文 / 空文 ⇒ 不算', () => {
    expect(isSuspiciouslyShortAnswer({ answerText: '发现一个 bug：core/a.ts:12 拼写错误。', hadToolExecutions: false })).toBe(false);
    expect(isSuspiciouslyShortAnswer({ answerText: '好，我来审计。', hadToolExecutions: true })).toBe(false);
    expect(isSuspiciouslyShortAnswer({ answerText: 'x'.repeat(400), hadToolExecutions: false })).toBe(false);
    expect(isSuspiciouslyShortAnswer({ answerText: '', hadToolExecutions: false })).toBe(false);
  });

  it('★ hasDeliverableEvidence 认 file:line 与结论', () => {
    expect(hasDeliverableEvidence('见 core/a.ts:12')).toBe(true);
    expect(hasDeliverableEvidence('结论：没问题')).toBe(true);
    expect(hasDeliverableEvidence('我先看看')).toBe(false);
  });
});


describe('自动续轮预算（修 requestId 为空导致永不触发）', () => {
  it('★★ 首次允许，用满 2 次后不再允许', () => {
    let budget = { windowStart: 1000, count: 0 };
    const a = decideAutoContinueBudget({ budget, now: 2000 });
    expect(a.allow).toBe(true);
    budget = a.next;
    const b = decideAutoContinueBudget({ budget, now: 3000 });
    expect(b.allow).toBe(true);
    budget = b.next;
    const c = decideAutoContinueBudget({ budget, now: 4000 });
    expect(c.allow).toBe(false);
  });

  it('★ 超过时间窗 ⇒ 重置', () => {
    const budget = { windowStart: 0, count: 2 };
    const r = decideAutoContinueBudget({ budget, now: 5 * 60_000 + 1 });
    expect(r.allow).toBe(true);
    expect(r.next).toEqual({ windowStart: 5 * 60_000 + 1, count: 1 });
  });

  it('负控：窗口内未满 ⇒ 允许', () => {
    const r = decideAutoContinueBudget({ budget: { windowStart: 0, count: 1 }, now: 1000 });
    expect(r.allow).toBe(true);
  });
});


describe('页面侧看门狗（卡住即停止 + 续轮）', () => {
  it('★★ 生成中且 120s 无变化 ⇒ 该动手', () => {
    expect(decideStallRecovery({ now: 200_000, lastChangeAt: 0, generating: true })).toBe(true);
  });

  it('负控：未在生成 / 刚有变化 / 未到阈值 ⇒ 不动手', () => {
    expect(decideStallRecovery({ now: 200_000, lastChangeAt: 0, generating: false })).toBe(false);
    expect(decideStallRecovery({ now: 10_000, lastChangeAt: 0, generating: true })).toBe(false);
    expect(decideStallRecovery({ now: 200_000, lastChangeAt: 0, generating: true, thresholdMs: 300_000 })).toBe(false);
  });
});
