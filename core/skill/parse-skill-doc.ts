// Shared SKILL.md parser (DCD 20261005 DPP-06 附带项).
//
// `github-importer` and `local-importer` each carried their own copy of this parser and its YAML helper
// family. The divergence that mattered was never the format - it was that a hardening pass could land on one
// copy and leave the other bypassable. Both importers now bind `parseSkillDoc` below through a profile, so
// the remaining provider differences are declared in one place instead of hidden in two forks.

import { sanitizeImportedDescription } from './imported-description';

export interface ParsedSkillDoc {
  name: string;
  description: string;
  body: string;
  version?: string;
  lastUpdated?: string;
}

export interface SkillDocParseProfile {
  /** Provider label used by the last-resort description fallback. */
  readonly descriptionLabel: string;
  /** Only the local pipeline names an unnamed skill after its H1 title. */
  readonly h1TitleFallback: boolean;
  /** Pattern removed from the path when nothing else yields a name. */
  readonly skillDocPathPattern: RegExp;
}

export const GITHUB_SKILL_DOC_PROFILE: SkillDocParseProfile = Object.freeze({
  descriptionLabel: 'GitHub',
  h1TitleFallback: false,
  skillDocPathPattern: /\/?SKILL\.md$/,
});

export const LOCAL_SKILL_DOC_PROFILE: SkillDocParseProfile = Object.freeze({
  descriptionLabel: 'local',
  h1TitleFallback: true,
  skillDocPathPattern: /\/?SKILL\.md$/i,
});

/**
 * Parses one SKILL.md document (agentskills.io / pi-ecosystem format) under a provider profile. A leading
 * byte-order mark is stripped before the `^---` frontmatter fence is matched, so a BOM-saved document keeps
 * its `name:` (issue #296).
 */
export function parseSkillDoc(raw: string, path: string, profile: SkillDocParseProfile): ParsedSkillDoc {
  const bomStripped = raw.replace(/^\uFEFF/, '');
  const frontmatter = bomStripped.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  const meta = frontmatter ? parseYamlSubset(frontmatter[1]) : {};
  const body = frontmatter ? bomStripped.slice(frontmatter[0].length).trim() : bomStripped.trim();
  const name = normalizeSkillName(
    readString(meta, 'name')
    ?? (profile.h1TitleFallback ? extractH1Title(body) : undefined)
    ?? parentDirectory(path).split('/').pop()
    ?? path.replace(profile.skillDocPathPattern, ''),
  );
  const rawDescription = readString(meta, 'description')
    ?? firstParagraph(body)
    ?? `Imported ${profile.descriptionLabel} Skill from ${path}`;
  const description = sanitizeImportedDescription(rawDescription);
  const metadata = readObject(meta, 'metadata');
  const version = readString(metadata, 'version') ?? readString(meta, 'version');
  const lastUpdated = readString(metadata, 'last_updated') ?? readString(metadata, 'lastUpdated') ?? readString(meta, 'last_updated');

  return { name, description, body, version, lastUpdated };
}

export function createSkillDocParser(
  profile: SkillDocParseProfile,
): (raw: string, path: string) => ParsedSkillDoc {
  return (raw, path) => parseSkillDoc(raw, path, profile);
}

function extractH1Title(body: string): string | undefined {
  const match = body.match(/^\s*#\s+(.+?)\s*$/m);
  return match ? match[1] : undefined;
}

function parseYamlSubset(raw: string): Record<string, unknown> {
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  const result: Record<string, unknown> = {};
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const match = line.match(/^([A-Za-z0-9_-]+):(?:\s*(.*))?$/);
    if (!match) continue;
    const key = match[1];
    const value = match[2] ?? '';
    if (value === '|' || value === '|-' || value === '>' || value === '>-') {
      const block: string[] = [];
      while (i + 1 < lines.length && /^(\s+|$)/.test(lines[i + 1])) {
        i += 1;
        block.push(lines[i].replace(/^\s{2,}/, ''));
      }
      result[key] = value.startsWith('>') ? block.join(' ').replace(/\s+/g, ' ').trim() : block.join('\n').trim();
      continue;
    }
    if (value === '') {
      const nested: Record<string, string> = {};
      while (i + 1 < lines.length && /^\s+/.test(lines[i + 1])) {
        i += 1;
        const nestedMatch = lines[i].match(/^\s+([A-Za-z0-9_-]+):\s*(.*)$/);
        if (nestedMatch) nested[nestedMatch[1]] = cleanYamlScalar(nestedMatch[2]);
      }
      result[key] = nested;
      continue;
    }
    result[key] = cleanYamlScalar(value);
  }
  return result;
}

function cleanYamlScalar(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function readString(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readObject(record: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = record[key];
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function firstParagraph(body: string): string | undefined {
  const paragraph = body
    .replace(/^# .+$/m, '')
    .split(/\n\s*\n/)
    .map((part) => part.replace(/\s+/g, ' ').trim())
    .find((part) => part.length > 0 && !part.startsWith('```'));
  return paragraph ? paragraph.slice(0, 240) : undefined;
}

export function parentDirectory(path: string): string {
  // Windows backslashes are normalized so D:\foo\bar\SKILL.md resolves the same way a POSIX path does.
  const normalized = path.replace(/\\/g, '/');
  const parts = normalized.split('/');
  parts.pop();
  return parts.join('/');
}

export function normalizeSkillName(name: string): string {
  const normalized = name.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  // A non-ASCII title slugifies to nothing (issue #296). A stable hash-derived slug keeps the import
  // succeeding instead of throwing; the user can rename the skill afterwards.
  if (!normalized) return `skill-${shortHash(name || 'unnamed')}`;
  return normalized;
}

export function shortHash(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash << 5) - hash + input.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(36).slice(0, 8).padStart(2, '0');
}
