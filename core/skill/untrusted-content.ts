// Imported Skill content boundary (DCD 20261005 DPP-06 ruling A).
//
// A third-party SKILL.md body is data, but it is written in the imperative mood and lands in the same prompt
// as the app's own instructions, so "ignore every previous rule" lines get read as commands. `sanitizeImportedDescription`
// already neutralizes the description field; the body was the remaining opening. This module wraps that body
// in a pair of markers plus a localized notice, and neutralizes any marker the body carries itself so a document
// cannot close its own block early.

import { translate, type SupportedLocale } from '../i18n';

export const UNTRUSTED_SKILL_OPEN = '[[DEEPSEEK_PP_UNTRUSTED_SKILL_CONTENT]]';
export const UNTRUSTED_SKILL_CLOSE = '[[/DEEPSEEK_PP_UNTRUSTED_SKILL_CONTENT]]';
const REDACTED_MARKER = '[[redacted-skill-content-marker]]';

export function neutralizeUntrustedSkillMarkers(content: string): string {
  return content.split(UNTRUSTED_SKILL_OPEN).join(REDACTED_MARKER)
    .split(UNTRUSTED_SKILL_CLOSE).join(REDACTED_MARKER);
}

export function containsUntrustedSkillBoundary(content: string): boolean {
  return content.includes(UNTRUSTED_SKILL_OPEN);
}

/**
 * 判断内容是否**已经是一个完整信封**（首尾都是标记）。
 *
 * 2026-10-23 安全修复：原实现用 `containsUntrustedSkillBoundary(content)`
 * （即「任何位置出现 OPEN 标记」）作为短路条件，于是恶意 SKILL.md 只要在正文里
 * 写一行 `[[DEEPSEEK_PP_UNTRUSTED_SKILL_CONTENT]]`，整段内容就被原样返回 ——
 * 既没有 notice，也没有做标记中和，敌意内容以"看似已包裹"的形式进入 prompt。
 * 这就是审计总汇总第三轮记录的 P1，但当时落地的提交不在本仓，
 * 漏洞在本仓依然存在（实测：90 字符敌意输入 → 90 字符原样输出、notice=false）。
 *
 * 现在改为只看「**结构上是否完整**」：必须**以 OPEN 开头且以 CLOSE 结尾**。
 * 仅在中途带上标记不再短路，因此会被正常包裹 + 中和。
 */
export function isWrappedUntrustedSkillContent(content: string): boolean {
  const trimmed = content.trim();
  return trimmed.startsWith(UNTRUSTED_SKILL_OPEN) && trimmed.endsWith(UNTRUSTED_SKILL_CLOSE);
}

/** Wrap one untrusted Skill payload. A already-complete envelope is returned untouched, so composing twice cannot nest a second block. */
export function wrapUntrustedSkillContent(content: string, locale: SupportedLocale): string {
  if (isWrappedUntrustedSkillContent(content)) return content;
  const notice = translate(locale, 'prompt.skillUntrustedContentNotice');
  return [
    UNTRUSTED_SKILL_OPEN,
    notice,
    '',
    neutralizeUntrustedSkillMarkers(content),
    UNTRUSTED_SKILL_CLOSE,
  ].join('\n');
}
