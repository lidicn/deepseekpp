import { describe, expect, it } from 'vitest';
import {
  isSandboxToolName,
  normalizeSandboxBoundaryRequest,
  normalizeSandboxExecutionResult,
  normalizeSandboxRunRequest,
  parseSandboxEnvelope,
  readSandboxRequestId,
  SANDBOX_MESSAGE_TYPES,
} from '../core/sandbox';

// T22: 只补既有 sandbox-contract.test.ts 未覆盖的策略缝隙：
// boundary 错误文案映射、pyodide 开关、execution result 往返剥字段、timeout clamp、命令名判定。

const MESSAGES = {
  invalidLanguage: 'invalid language',
  invalidCode: 'invalid code',
};

describe('normalizeSandboxBoundaryRequest · error mapping and pyodide switch', () => {
  it('maps an unsupported language to the caller-provided invalidLanguage message', () => {
    expect(() => normalizeSandboxBoundaryRequest({ language: 'ruby', code: 'puts 42' }, MESSAGES))
      .toThrow('invalid language');
  });

  it('maps a blank code to the caller-provided invalidCode message', () => {
    expect(() => normalizeSandboxBoundaryRequest({ language: 'javascript', code: '   ' }, MESSAGES))
      .toThrow('invalid code');
  });

  it('drops pyodideBaseUrl when includePyodideBaseUrl is false', () => {
    const decoded = normalizeSandboxBoundaryRequest(
      { language: 'python', code: 'print(1)', pyodideBaseUrl: 'chrome-extension://x/pyodide/' },
      { ...MESSAGES, includePyodideBaseUrl: false },
    );
    expect('pyodideBaseUrl' in decoded).toBe(false);
    expect(decoded.language).toBe('python');
  });
});

describe('normalizeSandboxExecutionResult · round-trip and rejection', () => {
  const legal = {
    ok: true,
    stdout: '42\n',
    stderr: '',
    result: '42',
    durationMs: 12,
    truncated: false,
    unknownField: 'should-be-stripped',
  };

  it('keeps declared fields and strips additive unknown fields', () => {
    const decoded = normalizeSandboxExecutionResult(legal);
    expect(decoded.ok).toBe(true);
    expect(decoded.stdout).toBe('42\n');
    expect(decoded.durationMs).toBe(12);
    expect('unknownField' in decoded).toBe(false);
  });

  it('rejects a non-boolean ok and a negative durationMs', () => {
    expect(() => normalizeSandboxExecutionResult({ ...legal, ok: 'yes' })).toThrow();
    expect(() => normalizeSandboxExecutionResult({ ...legal, durationMs: -0.5 })).toThrow();
  });
});

describe('normalizeSandboxRunRequest · timeout clamp', () => {
  it('floors below 1000 and caps above 15000', () => {
    expect(normalizeSandboxRunRequest({ language: 'javascript', code: 'return 1;', timeoutMs: 50 }).timeoutMs).toBe(1_000);
    expect(normalizeSandboxRunRequest({ language: 'javascript', code: 'return 1;', timeoutMs: 99_999 }).timeoutMs).toBe(15_000);
  });

  it('falls back to a finite in-range default when timeoutMs is not a number', () => {
    const decoded = normalizeSandboxRunRequest({ language: 'javascript', code: 'return 1;', timeoutMs: 'soon' });
    expect(Number.isFinite(decoded.timeoutMs)).toBe(true);
    expect(decoded.timeoutMs).toBeGreaterThanOrEqual(1_000);
    expect(decoded.timeoutMs).toBeLessThanOrEqual(15_000);
  });
});

describe('sandbox command name and envelope read gaps', () => {
  it('accepts only the sandbox_run tool name', () => {
    expect(isSandboxToolName('sandbox_run')).toBe(true);
    expect(isSandboxToolName('browser_click')).toBe(false);
    expect(isSandboxToolName('')).toBe(false);
  });

  it('readSandboxRequestId returns null on a type mismatch and keeps id on match', () => {
    expect(readSandboxRequestId({ type: SANDBOX_MESSAGE_TYPES.frameResult, requestId: 'r1' }, SANDBOX_MESSAGE_TYPES.frameRun)).toBeNull();
    expect(readSandboxRequestId({ type: SANDBOX_MESSAGE_TYPES.frameRun, requestId: 'r1' }, SANDBOX_MESSAGE_TYPES.frameRun)).toBe('r1');
  });

  it('parseSandboxEnvelope preserves payload and rejects a type mismatch', () => {
    const env = { type: SANDBOX_MESSAGE_TYPES.frameRun, requestId: 'r1', payload: { language: 'javascript', code: 'x' } };
    expect(parseSandboxEnvelope(env, SANDBOX_MESSAGE_TYPES.frameRun)).toEqual(env);
    expect(parseSandboxEnvelope(env, SANDBOX_MESSAGE_TYPES.frameResult)).toBeNull();
  });
});
