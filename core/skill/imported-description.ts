export const MAX_IMPORT_DESCRIPTION_CHARS = 512;

// Neutralize untrusted Skill description text before it becomes Skill context:
// strip C0/C1 control characters (including newlines/tabs, so the value cannot
// forge structure or span multiple lines) and collapse the remaining whitespace to
// single spaces. A well-formed single-line description is returned byte-for-byte
// unchanged; an oversized one is truncated with a visible marker (never silent).
// Shared by every importer on purpose: sanitizing only the remote path leaves the
// same SKILL.md reaching the prompt through a local import.
export function sanitizeImportedDescription(value: string): string {
  const cleaned = value
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length <= MAX_IMPORT_DESCRIPTION_CHARS) return cleaned;
  return `${cleaned.slice(0, MAX_IMPORT_DESCRIPTION_CHARS).trimEnd()}…[truncated]`;
}
