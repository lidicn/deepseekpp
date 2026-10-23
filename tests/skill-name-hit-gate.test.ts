// 2026-10-23 X-68 回归：`nameHits` 的 `score += 100` 必须在覆盖率门**内**。
//
// 背景：2026-10-22 那次误激活修复（`90be38a`）只把 `descHits` 罩进门内，
// `nameHits` 留在门外。而 `ACTIVATION_THRESHOLD = 100` ——
// 长提示词的任意一个 2-gram 落进 Skill 名就**恰好抵达激活阈值**，
// 其余候选被门压到 0，`MIN_LEAD_GAP` 自动满足 ⇒ 无关 Skill 被激活。
//
// 现 `termScoringAllowed` 同时罩住 nameHits 与 descHits，并新增
// **名称覆盖率**（`nameCoverage >= MIN_NAME_HIT_RATIO`）作为解除条件，
// 以兼容 X-44（门太严把「名字 + 包装词」的查询误杀）。
import { describe, expect, it } from 'vitest';
import { scoreLocalSkill } from '../core/skill/local-skill-scorer';
import { normalizeSearchText } from '../core/mcp/capability-projection';
import { tokenizeFlexible } from '../core/skill/local-skill-scorer';
import type { LocalSkillIndex } from '../core/skill/local-skill-scorer';

function index(name: string, description: string): LocalSkillIndex {
  return { name, description, skillDir: `/skills/${name}` } as LocalSkillIndex;
}

function score(name: string, description: string, query: string): number {
  const queryNorm = normalizeSearchText(query);
  return scoreLocalSkill(index(name, description), queryNorm, tokenizeFlexible(queryNorm));
}

describe('X-68: nameHits 受覆盖率门约束', () => {
  it('长提示词里偶然命中名字一个词，不足以激活（旧实现恰好 =100）', () => {
    // 构造：Skill 名含一个常见词「报告」，描述与查询毫无关系；
    // 长提示词里出现「报告」一次。旧实现：nameHits=1 → score=100 = 阈值 → 激活。
    const longPrompt = [
      '你现在作为验收执行员，把下面八个环节从头到尾跑一遍，全部在同一个目录里完成，',
      '严禁用文字假装执行，每一步都必须真的调用工具并把原始返回贴出来。',
      '先确认平台架构，再建好工作目录，之后按顺序写文件、跑程序、存一条记忆、搜一次、',
      '改一次、删一次，最后输出一张表格。这段文字里只出现过一次「报告」这个词。',
    ].join('');

    const s = score('季度报告生成器', '与查询完全无关的描述文本', longPrompt);
    // 门内计分被拦 ⇒ 远低于激活阈值 100
    expect(s).toBeLessThan(100);
  });

  it('名称被查询覆盖过半时仍正常计分（X-44 兼容）', () => {
    // 「名字 + 包装词」的查询：查询的每个词并不都在名字里，
    // 但名字自身的 3 个 token 全在查询里 ⇒ nameCoverage = 1 ≥ 0.5 ⇒ 放行。
    const s = score('dcd-decision-support', '', '用一下 dcd-decision-support');
    expect(s).toBeGreaterThanOrEqual(100);
  });

  it('短查询真意图匹配不受影响（原有不变量）', () => {
    // 查询词全部落进描述 ⇒ descHitRatio = 1 ⇒ 门放行，名称逐词照样计分。
    expect(score('weekly-report', 'Generate weekly report and summary', 'weekly report'))
      .toBe(100 + 100 + 400 + 40 + 40);
  });

  it('名字只被偶然覆盖一小部分时不放行', () => {
    // 名字 3 个 token，查询只覆盖 1 个 ⇒ nameCoverage ≈ 0.33 < 0.5
    const longPrompt = '完全无关的一段很长的文字，只在末尾提了一句 support 而已。';
    const s = score('dcd-decision-support', '', longPrompt);
    // 不应靠 nameHits 冲到阈值
    expect(s).toBeLessThan(100);
  });
});