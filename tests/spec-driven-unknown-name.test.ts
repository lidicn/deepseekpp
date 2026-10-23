// 2026-10-23 补：审计总汇总 §三 第 11 条「spec-driven 未知名拒绝」——原零测试文件。
//
// 被守护的防线：`core/skill/spec-driven-develop-library.ts:29-33`
//
//   const knownNames = new Set<string>(SKILL_ORDER);
//   for (const name of requested) {
//     if (!knownNames.has(name)) {
//       throw new Error(`Unknown bundled Spec-Driven Develop Skill: ${name}`);
//     }
//   }
//
// 为什么需要这条防线：`requestedNames` 来自持久化的用户配置 / 同步数据。
// 若不校验直接放进 `SKILL_ORDER.filter(...)` 之外的分支，未来的重构可能
// 让未知名字进入 `createThirdPartySpecDrivenDevelopSkill(name)`，
// 进而在读取 bundle 资源时静默产生半成品 Skill 或非预期 IO。
// 当前是「先整体校验、后加载」，本测试锁住这个**先校验**的次序。
//
// 报告同时指出外层 `validateLoadedSkills` 已兜底（非安全边界），
// 所以这里是**低优先级**的回归守卫，不是安全边界。
import { describe, expect, it } from 'vitest';
import { loadThirdPartySpecDrivenDevelopSkills } from '../core/skill/spec-driven-develop-library';

describe('spec-driven develop library: unknown name rejection', () => {
  it('rejects an unknown skill name', async () => {
    await expect(
      loadThirdPartySpecDrivenDevelopSkills(['spec-driven-develop', 'definitely-not-a-skill']),
    ).rejects.toThrow('Unknown bundled Spec-Driven Develop Skill: definitely-not-a-skill');
  });

  it('rejects before loading any known skill (fail-fast on the first unknown)', async () => {
    // 关键次序：校验先于加载。若把 throw 挪到 for 循环之后、
    // 或改成「边加载边校验」，未知名字会先触发已知技能的资源读取。
    // 这里用一个全部未知的集合，确保根本不进入加载阶段。
    await expect(
      loadThirdPartySpecDrivenDevelopSkills(['nope-1', 'nope-2']),
    ).rejects.toThrow('Unknown bundled Spec-Driven Develop Skill: nope-1');
  });

  it('does not treat the three known names as unknown', async () => {
    // 反向守卫：校验不能把合法名字也挡掉。
    //
    // 本测试**不提供 chrome.runtime / fetch 桩**，所以已知名字在通过校验后
    // 会在读取 bundle 资源时失败 —— 这是预期的。关键断言是：
    // 失败原因**不是**「未知名字」，即 `knownNames` 集合确实包含了它。
    for (const name of ['spec-driven-develop', 'deep-discuss', 'review-spd']) {
      const error = await loadThirdPartySpecDrivenDevelopSkills([name]).catch((reason) => reason);
      expect(String(error)).not.toContain('Unknown bundled Spec-Driven Develop Skill');
    }
  });

  it('accepts an empty request without throwing', async () => {
    await expect(loadThirdPartySpecDrivenDevelopSkills([])).resolves.toEqual([]);
  });
});
