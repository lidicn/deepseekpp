import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-ignore - Shell Host runtime modules are executable .mjs files.
import { resolveUnderRoot } from '../packages/shell-host/native/file-provider.mjs';

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('shell host resolveUnderRoot confinement', () => {
  it('accepts a real path nested inside the root', () => {
    const root = mkdtempSync(join(tmpdir(), 'dpp-root-'));
    tempRoots.push(root);
    mkdirSync(join(root, 'skills'), { recursive: true });
    writeFileSync(join(root, 'skills', 'SKILL.md'), 'body');

    const resolved = resolveUnderRoot(root, 'skills/SKILL.md');
    expect(resolved).toBe(join(root, 'skills', 'SKILL.md'));
  });

  it('rejects a lexical .. escape', () => {
    const root = mkdtempSync(join(tmpdir(), 'dpp-root-'));
    tempRoots.push(root);

    expect(() => resolveUnderRoot(root, '../outside.txt')).toThrow('Path escapes local Skill root');
  });

  it('rejects a symlink inside the root that resolves to a path outside it', () => {
    const root = mkdtempSync(join(tmpdir(), 'dpp-root-'));
    const outside = mkdtempSync(join(tmpdir(), 'dpp-outside-'));
    tempRoots.push(root, outside);

    writeFileSync(join(outside, 'evil.txt'), 'outside secret');
    // On Windows, a directory junction is creatable without developer mode or
    // admin privileges; a file symlink requires them. On POSIX a plain dir
    // symlink is used. Both make realpath() resolve the link to `outside`.
    const linkType = process.platform === 'win32' ? 'junction' : 'dir';
    symlinkSync(outside, join(root, 'escape'), linkType);

    expect(() => resolveUnderRoot(root, join('escape', 'evil.txt'))).toThrow('Path escapes local Skill root');
  });
});
