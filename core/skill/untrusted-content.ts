// Imported Skill content boundary (DCD 20261005 DPP-06 ruling A).
//
// A third-party SKILL.md body is data, but it is written in the imperative mood and lands in the same prompt
// as the app's own instructions, so "ignore every previous rule" lines get read as commands. `sanitizeImportedDescription`
// already neutralizes the description field; the body was the remaining opening. This module wraps that body
// in a pair of markers plus a localized notice, and neutralizes any marker the body carries itself so a document
// cannot close its own block early.
//
// 2026-10-23 安全修复（审计 X-65 / 本仓 P1）：
//
// 原实现有一条短路 —— `if (containsUntrustedSkillBoundary(content)) return content;`
// 即「正文任何位置出现 OPEN 标记就原样返回」。后果是恶意 SKILL.md 只要自带一枚
// `[[DEEPSEEK_PP_UNTRUSTED_SKILL_CONTENT]]`，整段内容既不包裹也不中和就进入 prompt，
// 攻击者于是可以自己造出「真」边界对，让 CLOSE 之后的文本落在块外、与第一方指令同层级。
// 这正是本模块头注声称要防的事（"so a document cannot close its own block early"），
// 而实现只防了 CLOSE 一侧、没防 OPEN 一侧。
//
// 第一版修法把短路条件收紧为「结构完整的信封」（首 OPEN 尾 CLOSE）才跳过。但审计 R18
// 指出这仍留一条缝：攻击者写一对**完整**的 OPEN…CLOSE 依然能拿到「无 notice 的合法信封」
// —— 边界在、告示不在，模型可能因此把它当第一方文本读。
//
// 最终修法（采纳审计建议）：**取消短路，无条件包裹**，并把 `neutralize` 放在最前。
// 幂等性不再靠早退，而由标记中和自然保证 —— 二次包裹时内层的 OPEN/CLOSE 已变成
// `[[redacted-skill-content-marker]]`，因此不会出现第二对功能边界，只是多一份告示。
// 调用面唯一（`request-augmentation.ts:440`，每请求一次），重复包裹在实践中不会发生。

import { translate, type SupportedLocale } from '../i18n';

export const UNTRUSTED_SKILL_OPEN = '[[DEEPSEEK_PP_UNTRUSTED_SKILL_CONTENT]]';
export const UNTRUSTED_SKILL_CLOSE = '[[/DEEPSEEK_PP_UNTRUSTED_SKILL_CONTENT]]';
const REDACTED_MARKER = '[[redacted-skill-content-marker]]';

export function neutralizeUntrustedSkillMarkers(content: string): string {
  return content.split(UNTRUSTED_SKILL_OPEN).join(REDACTED_MARKER)
    .split(UNTRUSTED_SKILL_CLOSE).join(REDACTED_MARKER);
}

/**
 * 无条件包裹一份不可信 Skill 正文。
 *
 * 没有「已包裹就跳过」的分支：任何早退都可能被攻击者用来跳过告示与中和。
 * 重复调用只会多一份告示，不会产生第二对功能边界（内层标记已先被中和）。
 */
export function wrapUntrustedSkillContent(content: string, locale: SupportedLocale): string {
  const notice = translate(locale, 'prompt.skillUntrustedContentNotice');
  return [
    UNTRUSTED_SKILL_OPEN,
    notice,
    '',
    neutralizeUntrustedSkillMarkers(content),
    UNTRUSTED_SKILL_CLOSE,
  ].join('\n');
}
