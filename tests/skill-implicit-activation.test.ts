// 2026-10-22 真机定位回归：长提示词会误激活无关 Skill。
//
// 现场：用户发一段 914 字的验收提示词（文件读写 + 命令执行 + 记忆增删改查），
// 扩展却自动激活了 `dcd-decision-support`（关键决策部/DCD/不可逆操作），
// 并注入**强制措辞**：
//   「已自动激活本地 Skill「X」。在动手前，你**必须**先完成以下前置步骤，
//     否则禁止开始执行任务…在此之前，不得调用任何业务工具」
// 模型被迫先读 SKILL.md 才允许干活 → 用户看到「DPP 在执行跟任务不相关的事情」。
//
// 根因：分数是「提示词每个 2-gram 命中描述就 +40」的原始累加，**不按查询长度
// 归一化**。914 字提示词有 306 个 queryTerms，只要 5 个巧合命中就 200 分，
// 超过阈值 100 且领先差 200 > 50 → 激活。
//
// 实证的 5 个命中：执行 / nas / 同一 / 用 / 表
//   · `用`、`表` 是单字 CJK（信息量极低）
//   · `nas` 来自路径 `E:\NAS\dpp-accept` 撞上描述里的 `E:\NAS\关键决策部`
//
// 修法：给「按词命中累加」加覆盖率门（MIN_DESC_HIT_RATIO=0.15）+
// 单字词不参与计分（MIN_MATCH_TERM_LENGTH=2）。精确名命中（+800）不受影响。
import { describe, expect, it } from 'vitest';
import {
  scoreLocalSkill,
  selectImplicitSkill,
} from '../core/skill/local-skill-scorer';
import { normalizeSearchText } from '../core/mcp/capability-projection';
import { tokenizeFlexible } from '../core/skill/local-skill-scorer';

/** 真机那段 914 字验收提示词（关键片段足够复现）。 */
const ACCEPT_PROMPT = `你现在作为 DPP 的验收执行员，用真实工具把下面八个环节从头到尾跑一遍，全部在同一个目录里完成，严禁用文字假装执行——每一步都必须真的调用工具并把工具的原始返回贴出来。先调用 shell_status 确认平台、架构和 shell 类型并记下结果；再用 shell_exec 执行 New-Item -ItemType Directory -Force -Path 'E:\\NAS\\dpp-accept' 建好工作目录，之后按顺序做：(1) 写文件 notes.txt，第一行写 DPP-ACCEPT-START、第二行写当前日期时间，写完用 Get-Content 读回来并把原文完整贴出；(2) 写一个 Python 程序 fib.py，功能是从命令行参数取整数 n 并打印斐波那契数列前 n 项，写完用 Get-Content 把源码原样贴出；(3) 先调 python_status 确认解释器可用，再执行 python fib.py 10，把 stdout 原文和 exitCode 都贴出来；(4) 执行一条故意失败的命令 python fib.py abc，确认 exitCode 非零；(5) 在 notes.txt 末尾追加一行 DPP-ACCEPT-END，再读一次确认两行都在；(6) 调 memory_save 存一条记忆，type 用 project、name 用「DPP验收标记」、content 里必须包含唯一字符串 DPP-ACCEPT-MARK-2026、tags 用 验收 dpp，把返回的记忆 id 记下来;(7) 调 memory_search 搜 DPP-ACCEPT-MARK-2026，确认能命中刚存的那条并贴出结果；(8) 用第 6 步的 id 调 memory_update 把 content 改成包含 DPP-ACCEPT-MARK-2026-UPDATED 的新内容，再 memory_search 一次确认已更新，最后用同一个 id 调 memory_delete 删掉它，再 memory_search 一次确认已经搜不到。全部做完后输出一张 Markdown 表。`;

const DCD_SKILL = {
  name: 'dcd-decision-support',
  description: '关键决策部（DCD）决策支援流程。当你要做不可逆操作、同一问题卡住超过半天、两个方案拿不定、要动跨仓接口，或需要向 E:\\NAS\\关键决策部 提交决策申请 / 写执行回执时使用。含活判例索引、申请表模板、回执模板与两个校验脚本。',
  skillDir: 'E:/NAS/关键决策部/skills/dcd-decision-support',
};

const OTHER_SKILLS = [
  { name: 'dcd-adjudication', description: '', skillDir: 'E:/a' },
  { name: 'auditkit', description: '', skillDir: 'E:/b' },
  {
    name: 'codebase-review',
    description: 'Comprehensive codebase audit, bug hunting, modularisation, and refactoring agent. Use this when the user wants a deep code review.',
    skillDir: 'E:/c',
  },
];

describe('Skill 隐式激活：长提示词不得误激活', () => {
  it('914 字验收提示词不再激活 dcd-decision-support（真机 bug 回归）', () => {
    const queryNorm = normalizeSearchText(ACCEPT_PROMPT);
    const queryTerms = tokenizeFlexible(queryNorm);
    const score = scoreLocalSkill(DCD_SKILL, queryNorm, queryTerms);

    // 修复前 = 200（5 个巧合命中 × 40），超过阈值 100
    expect(score).toBeLessThan(100);

    const picked = selectImplicitSkill(ACCEPT_PROMPT, [DCD_SKILL, ...OTHER_SKILLS]);
    expect(picked).toBeNull();
  });

  it('单字 CJK 词（用/表）不参与命中计分', () => {
    const queryNorm = normalizeSearchText('用 表 执行');
    const queryTerms = tokenizeFlexible(queryNorm);
    // 单字词命中不应贡献分数
    const score = scoreLocalSkill(DCD_SKILL, queryNorm, queryTerms);
    expect(score).toBeLessThan(100);
  });

  it('真实匹配仍然能激活（不可逆操作 / 跨仓接口 / 方案拿不定）', () => {
    const genuine = '我要做一个不可逆操作，需要改动跨仓接口，两个方案拿不定，卡住超过半天了，帮我走决策流程';
    const picked = selectImplicitSkill(genuine, [DCD_SKILL, ...OTHER_SKILLS]);
    expect(picked?.name).toBe('dcd-decision-support');
  });

  it('精确名命中（+800）不受覆盖率门影响', () => {
    const picked = selectImplicitSkill('用一下 dcd-decision-support', [DCD_SKILL, ...OTHER_SKILLS]);
    expect(picked?.name).toBe('dcd-decision-support');
  });
});
