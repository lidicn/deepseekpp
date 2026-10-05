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

/** Wrap one untrusted Skill payload. Already-wrapped payloads are returned untouched, so composing twice cannot nest a second block. */
export function wrapUntrustedSkillContent(content: string, locale: SupportedLocale): string {
  if (containsUntrustedSkillBoundary(content)) return content;
  const notice = translate(locale, 'prompt.skillUntrustedContentNotice');
  return [
    UNTRUSTED_SKILL_OPEN,
    notice,
    '',
    neutralizeUntrustedSkillMarkers(content),
    UNTRUSTED_SKILL_CLOSE,
  ].join('\n');
}
