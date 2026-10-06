import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isCiEnvironment } from '../scripts/ci-environment.mjs';
import {
  SKIP_ACTIONLINT_MESSAGE,
  decideWorkflowsGate,
  runWorkflowsGate,
  type GateSpawn,
  type GateSpawnResult,
} from '../scripts/verify-workflows.mjs';
import {
  AUDIT_NPM_ARGS,
  decideAuditGate,
  parseRegistryHost,
  runAuditGate,
} from '../scripts/audit-prod.mjs';

// ci:quality local runnability — DCD 2026-10-06 ruling A.
//
// `verify:workflows` and `audit:prod` were bare CLI invocations, so on this machine they
// failed for environment reasons unrelated to the code under review (no actionlint binary,
// registry mirror without an audit endpoint). Ruling A: on a local host those two probes
// SKIP with rc=0, while in CI the same gates must never SKIP — actionlint missing in CI is
// a hard rc=1, and npm audit keeps running exactly as before.

function missingActionlint(): GateSpawnResult {
  return { error: new Error('spawnSync actionlint ENOENT') };
}

describe('ci-quality skip gates (DCD 2026-10-06 ruling A)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('isCiEnvironment', () => {
    it('treats CI=true (GitHub Actions default) as CI and the absence or false-y values as local', () => {
      expect(isCiEnvironment({})).toBe(false);
      expect(isCiEnvironment({ CI: undefined })).toBe(false);
      expect(isCiEnvironment({ CI: '' })).toBe(false);
      expect(isCiEnvironment({ CI: 'false' })).toBe(false);
      expect(isCiEnvironment({ CI: 'true' })).toBe(true);
      expect(isCiEnvironment({ CI: '1' })).toBe(true);
    });
  });

  describe('verify:workflows gate', () => {
    it('decides run/skip/fail purely from ci + actionlint availability', () => {
      expect(decideWorkflowsGate({ ci: true, actionlintAvailable: true })).toEqual({ action: 'run' });
      expect(decideWorkflowsGate({ ci: false, actionlintAvailable: true })).toEqual({ action: 'run' });
      expect(decideWorkflowsGate({ ci: false, actionlintAvailable: false })).toEqual({ action: 'skip' });
      expect(decideWorkflowsGate({ ci: true, actionlintAvailable: false })).toEqual({ action: 'fail' });
    });

    it('local + actionlint missing prints the exact SKIP text and returns rc=0 without running actionlint', () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const calls: string[][] = [];
      const spawn: GateSpawn = (command, args) => {
        calls.push([command, ...args]);
        return missingActionlint();
      };

      const rc = runWorkflowsGate({ env: {}, spawn });

      expect(SKIP_ACTIONLINT_MESSAGE).toBe('SKIP: actionlint not installed (CI installs it via Setup Go)');
      expect(rc).toBe(0);
      expect(log.mock.calls.map((entry) => String(entry[0]))).toContain(SKIP_ACTIONLINT_MESSAGE);
      // Only the availability probe was attempted; actionlint itself was never executed.
      expect(calls).toEqual([['actionlint', '--version']]);
    });

    it('CI=true + actionlint missing returns rc=1 with a stated reason and never SKIPs', () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const calls: string[][] = [];
      const spawn: GateSpawn = (command, args) => {
        calls.push([command, ...args]);
        return missingActionlint();
      };

      const rc = runWorkflowsGate({ env: { CI: 'true' }, spawn });

      expect(rc).toBe(1);
      const printed = [...log.mock.calls, ...error.mock.calls].map((entry) => String(entry[0])).join('\n');
      expect(printed).toContain('actionlint');
      expect(printed).toContain('CI');
      expect(printed).not.toContain(SKIP_ACTIONLINT_MESSAGE);
      expect(calls).toEqual([['actionlint', '--version']]);
    });

    it('actionlint present runs the real lint and propagates its exit code (local and CI alike)', () => {
      const calls: string[][] = [];
      const spawn: GateSpawn = (command, args) => {
        calls.push([command, ...args]);
        // first call is the --version probe, second is the real lint run.
        return args.length === 0 ? { status: 3 } : { status: 0 };
      };

      expect(runWorkflowsGate({ env: {}, spawn })).toBe(3);
      expect(runWorkflowsGate({ env: { CI: 'true' }, spawn })).toBe(3);
      expect(calls).toEqual([
        ['actionlint', '--version'],
        ['actionlint', '--version'],
        ['actionlint'],
        ['actionlint'],
      ]);
    });
  });

  describe('audit:prod gate', () => {
    it('parses the registry host and recognises only registry.npmjs.org as the real audit endpoint', () => {
      expect(parseRegistryHost('https://registry.npmjs.org/')).toBe('registry.npmjs.org');
      expect(parseRegistryHost('https://registry.npmjs.org')).toBe('registry.npmjs.org');
      expect(parseRegistryHost('https://REGISTRY.NPMJS.org/')).toBe('registry.npmjs.org');
      expect(parseRegistryHost('https://registry.npmmirror.com')).toBe('registry.npmmirror.com');
      expect(parseRegistryHost('not-a-url')).toBeNull();
      expect(parseRegistryHost(null)).toBeNull();
    });

    it('decides run/skip from ci + registry: mirror locally skips, CI never skips, unreadable registry runs', () => {
      expect(decideAuditGate({ ci: false, registry: 'https://registry.npmjs.org/' })).toEqual({ action: 'run' });
      expect(decideAuditGate({ ci: true, registry: 'https://registry.npmjs.org/' })).toEqual({ action: 'run' });
      expect(decideAuditGate({ ci: true, registry: 'https://registry.npmmirror.com' })).toEqual({ action: 'run' });
      expect(decideAuditGate({ ci: false, registry: 'https://registry.npmmirror.com' })).toEqual({
        action: 'skip',
        message: 'SKIP: registry https://registry.npmmirror.com has no audit endpoint',
      });
      expect(decideAuditGate({ ci: false, registry: null })).toEqual({ action: 'run' });
    });

    it('local + mirror registry prints the exact SKIP line, returns rc=0, and never spawns npm audit', () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const calls: string[][] = [];
      const spawn: GateSpawn = (command, args) => {
        calls.push([command, ...args]);
        if (args[0] === 'config') return { status: 0, stdout: 'https://registry.npmmirror.com\n' };
        throw new Error('npm audit must not be spawned on the SKIP path');
      };

      const rc = runAuditGate({ env: {}, spawn });

      expect(rc).toBe(0);
      expect(log.mock.calls.map((entry) => String(entry[0]))).toContain(
        'SKIP: registry https://registry.npmmirror.com has no audit endpoint',
      );
      expect(calls.filter((call) => call[1] === 'audit')).toEqual([]);
    });

    it('local + npmjs registry runs the real audit argv (injected spawn, no network) with rc propagated', () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const calls: string[][] = [];
      const spawn: GateSpawn = (command, args) => {
        calls.push([command, ...args]);
        if (args[0] === 'config') return { status: 0, stdout: 'https://registry.npmjs.org/\n' };
        return { status: 1 };
      };

      const rc = runAuditGate({ env: {}, spawn });

      expect(AUDIT_NPM_ARGS).toEqual(['audit', '--audit-level=high', '--omit=dev']);
      expect(rc).toBe(1);
      expect(calls).toEqual([['npm', 'config', 'get', 'registry'], ['npm', ...AUDIT_NPM_ARGS]]);
      expect(log.mock.calls.map((entry) => String(entry[0]))).toEqual([]);
    });

    it('CI runs npm audit even when the configured registry is a mirror (CI behavior unchanged)', () => {
      const calls: string[][] = [];
      const spawn: GateSpawn = (command, args) => {
        calls.push([command, ...args]);
        if (args[0] === 'config') return { status: 0, stdout: 'https://registry.npmmirror.com\n' };
        return { status: 0 };
      };

      expect(runAuditGate({ env: { CI: 'true' }, spawn })).toBe(0);
      expect(calls).toEqual([['npm', 'config', 'get', 'registry'], ['npm', ...AUDIT_NPM_ARGS]]);
    });
  });

  describe('package.json wiring', () => {
    it('routes verify:workflows and audit:prod through the gate scripts inside the unchanged ci:quality chain', () => {
      const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {
        scripts: Record<string, string>;
      };
      expect(packageJson.scripts['verify:workflows']).toBe('node scripts/verify-workflows.mjs');
      expect(packageJson.scripts['audit:prod']).toBe('node scripts/audit-prod.mjs');
      expect(packageJson.scripts['ci:quality']).toContain('npm run verify:workflows && npm run audit:prod &&');
    });
  });

  describe('end-to-end through the real process boundary', () => {
    // Budget rationale: each case cold-starts a child node process; the audit case additionally
    // pays one local `npm config get registry` CLI lookup. No network is involved — the mirror
    // SKIP path stops before npm audit and the actionlint probes never resolve a binary.
    const emptyBin = mkdtempSync(join(tmpdir(), 'dpp-empty-bin-'));

    function childEnv(overrides: Record<string, string | undefined>): Record<string, string> {
      const env = { ...process.env } as Record<string, string | undefined>;
      // An empty PATH makes the actionlint probe fail deterministically even on CI runners
      // where actionlint was installed by the workflow.
      env.PATH = emptyBin;
      for (const [key, value] of Object.entries(overrides)) {
        if (value === undefined) delete env[key];
        else env[key] = value;
      }
      return env as Record<string, string>;
    }

    it(
      'node scripts/verify-workflows.mjs exits 0 with the SKIP line when actionlint is absent outside CI',
      () => {
        const result = spawnSync(process.execPath, [resolve('scripts/verify-workflows.mjs')], {
          encoding: 'utf8',
          env: childEnv({ CI: undefined }),
        });
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('SKIP: actionlint not installed (CI installs it via Setup Go)');
      },
      30_000,
    );

    it(
      'node scripts/verify-workflows.mjs exits 1 with a reason when actionlint is absent in CI',
      () => {
        const result = spawnSync(process.execPath, [resolve('scripts/verify-workflows.mjs')], {
          encoding: 'utf8',
          env: childEnv({ CI: 'true' }),
        });
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('actionlint');
        expect(result.stdout).not.toContain('SKIP: actionlint not installed');
      },
      30_000,
    );

    it(
      'node scripts/audit-prod.mjs exits 0 with the SKIP line on a mirror registry outside CI',
      () => {
        const result = spawnSync(process.execPath, [resolve('scripts/audit-prod.mjs')], {
          encoding: 'utf8',
          env: childEnv({ CI: undefined, NPM_CONFIG_REGISTRY: 'https://registry.npmmirror.com' }),
        });
        expect(result.status).toBe(0);
        expect(result.stdout).toContain(
          'SKIP: registry https://registry.npmmirror.com has no audit endpoint',
        );
      },
      30_000,
    );
  });
});

// Keep the injected-vs-real spawn distinction honest: the unit cases above must use the
// fake, and the only place the real spawnSync is cast is documented below for reviewers.
void spawnSyncImpl;
