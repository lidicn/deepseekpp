import { describe, it, expect } from 'vitest';
// @ts-ignore - 宿主 .mjs 为纯 JS 实现，无类型声明文件
import { detectShellKind } from '../packages/shell-host/native/os-adapter.mjs';
// @ts-ignore - 宿主 .mjs 为纯 JS 实现，无类型声明文件
import { buildSessionEndMarkerLine, createPersistentShellArgs } from '../packages/shell-host/native/session-provider.mjs';

/**
 * E-1 fix: parameterized tests covering all 4 shellKind branches.
 * Previously only the platform-default shell was tested (1/4 coverage),
 * which allowed S2-8 (cmd shellKind marker mismatch) to slip through.
 *
 * Acceptance criterion (from E report): deleting the cmd branch of
 * buildSessionEndMarkerLine must cause these tests to fail.
 */

const ALL_SHELL_KINDS = ['powershell', 'wsl', 'cmd', 'posix'] as const;
type ShellKind = (typeof ALL_SHELL_KINDS)[number];

const SHELL_BIN_BY_KIND: Record<ShellKind, string> = {
  powershell: 'powershell.exe',
  wsl: 'wsl.exe',
  cmd: 'cmd.exe',
  posix: '/bin/bash',
};

describe('E-1: detectShellKind covers all 4 shell kinds', () => {
  for (const kind of ALL_SHELL_KINDS) {
    it(`classifies ${SHELL_BIN_BY_KIND[kind]} as ${kind}`, () => {
      expect(detectShellKind(SHELL_BIN_BY_KIND[kind])).toBe(kind);
    });
  }

  it('classifies pwsh as powershell', () => {
    expect(detectShellKind('pwsh')).toBe('powershell');
  });

  it('classifies cmd (without .exe) as cmd', () => {
    expect(detectShellKind('cmd')).toBe('cmd');
  });

  it('classifies /bin/sh as posix', () => {
    expect(detectShellKind('/bin/sh')).toBe('posix');
  });

  it('classifies /usr/bin/zsh as posix', () => {
    expect(detectShellKind('/usr/bin/zsh')).toBe('posix');
  });
});

describe('E-1: createPersistentShellArgs covers all 4 shell kinds', () => {
  for (const kind of ALL_SHELL_KINDS) {
    it(`${kind}: returns non-empty args array`, () => {
      const args = createPersistentShellArgs(SHELL_BIN_BY_KIND[kind]);
      expect(Array.isArray(args)).toBe(true);
      expect(args.length).toBeGreaterThan(0);
    });
  }

  it('powershell: uses -Command - for stdin reading', () => {
    const args = createPersistentShellArgs('powershell.exe');
    expect(args).toContain('-Command');
    expect(args).toContain('-');
    expect(args).toContain('-NonInteractive');
  });

  it('wsl: uses -e bash to launch bash inside WSL', () => {
    const args = createPersistentShellArgs('wsl.exe');
    expect(args).toContain('-e');
    expect(args).toContain('bash');
  });

  it('cmd: uses /q /k for echo-off + persistent session', () => {
    const args = createPersistentShellArgs('cmd.exe');
    expect(args).toContain('/q');
    expect(args).toContain('/k');
  });

  it('posix: uses -s for stdin reading', () => {
    const args = createPersistentShellArgs('/bin/bash');
    expect(args).toEqual(['-s']);
  });
});

describe('E-1: buildSessionEndMarkerLine covers all 4 shell kinds', () => {
  const TOKEN = 'test-token-1234';

  for (const kind of ALL_SHELL_KINDS) {
    it(`${kind}: returns a non-empty string containing the token`, () => {
      const line = buildSessionEndMarkerLine(TOKEN, kind);
      expect(typeof line).toBe('string');
      expect(line.length).toBeGreaterThan(0);
      expect(line).toContain(TOKEN);
    });
  }

  it('powershell: uses Write-Output and $LASTEXITCODE', () => {
    const line = buildSessionEndMarkerLine(TOKEN, 'powershell');
    expect(line).toContain('Write-Output');
    expect(line).toContain('$LASTEXITCODE');
  });

  it('cmd: uses echo and %ERRORLEVEL% (S2-8 regression guard)', () => {
    const line = buildSessionEndMarkerLine(TOKEN, 'cmd');
    expect(line).toContain('echo');
    expect(line).toContain('%ERRORLEVEL%');
    // S2-8: cmd must NOT use printf or $? (POSIX syntax that cmd.exe cannot parse)
    expect(line).not.toContain('printf');
    expect(line).not.toContain('$?');
  });

  it('posix: uses printf and $?', () => {
    const line = buildSessionEndMarkerLine(TOKEN, 'posix');
    expect(line).toContain('printf');
    expect(line).toContain('$?');
  });

  it('wsl: falls through to POSIX printf syntax', () => {
    const line = buildSessionEndMarkerLine(TOKEN, 'wsl');
    expect(line).toContain('printf');
    expect(line).toContain('$?');
  });
});

describe('E-1: cross-branch consistency — each shellKind produces distinct marker syntax', () => {
  const TOKEN = 'consistency-token';
  const lines = ALL_SHELL_KINDS.map((kind) => buildSessionEndMarkerLine(TOKEN, kind));

  it('powershell line is distinct from cmd line', () => {
    expect(lines[0]).not.toEqual(lines[2]);
  });

  it('cmd line is distinct from posix line', () => {
    expect(lines[2]).not.toEqual(lines[3]);
  });

  it('no two shell kinds produce identical marker lines', () => {
    const unique = new Set(lines);
    // wsl and posix intentionally share the POSIX syntax, so we expect 3 unique
    expect(unique.size).toBe(3);
  });
});
