// Injected memory content boundary (2026-10-20).
//
// Why this exists
// ---------------
// Memory is extracted automatically from past conversations and re-injected into every prompt. That makes it
// DATA, not an instruction — but it lands in the same system prompt as the app's own rules, and a `reference`
// memory literally stores an external resource link. Observed failure: the model saw a URL inside memory and
// called `browser_navigate` on its own, so every memory-bearing turn opened an extra tab.
//
// Skills already had this protection (`core/skill/untrusted-content.ts`); memory did not. A memory body is at
// least as untrusted as an imported SKILL.md, so it gets the same treatment: a marker pair plus a localized
// notice that forbids acting on links/commands/blocks found inside it, and marker neutralization so a memory
// cannot close its own block early.

import { translate, type SupportedLocale } from '../i18n';

export const UNTRUSTED_MEMORY_OPEN = '[[DEEPSEEK_PP_UNTRUSTED_MEMORY_CONTENT]]';
export const UNTRUSTED_MEMORY_CLOSE = '[[/DEEPSEEK_PP_UNTRUSTED_MEMORY_CONTENT]]';
const REDACTED_MARKER = '[[redacted-memory-content-marker]]';

export function neutralizeUntrustedMemoryMarkers(content: string): string {
  return content.split(UNTRUSTED_MEMORY_OPEN).join(REDACTED_MARKER)
    .split(UNTRUSTED_MEMORY_CLOSE).join(REDACTED_MARKER);
}

export function containsUntrustedMemoryBoundary(content: string): boolean {
  return content.includes(UNTRUSTED_MEMORY_OPEN);
}

/**
 * Wrap one untrusted memory payload.
 *
 * Unlike the Skill wrapper this does NOT short-circuit on a pre-existing boundary marker: a memory body is
 * attacker-influenced text, so containing the open marker must not be a way to skip the envelope. We neutralize
 * both markers first and then always wrap exactly once (there is a single call site: `formatMemoriesBlock`).
 */
export function wrapUntrustedMemoryContent(content: string, locale: SupportedLocale): string {
  const notice = translate(locale, 'prompt.memoryUntrustedNotice');
  return [
    UNTRUSTED_MEMORY_OPEN,
    notice,
    '',
    neutralizeUntrustedMemoryMarkers(content),
    UNTRUSTED_MEMORY_CLOSE,
  ].join('\n');
}
