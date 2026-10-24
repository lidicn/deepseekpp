import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  executeSandboxToolCall,
  isTrustedSandboxMessageEvent,
  normalizeSandboxBoundaryRequest,
  normalizeSandboxExecutionResult,
  normalizeSandboxRunRequest,
  parseSandboxEnvelope,
  readSandboxRequestId,
  SANDBOX_FRAME_TARGET_ORIGIN,
  SANDBOX_HTML_BOUNDARY_MAX_CHARS,
  SANDBOX_MESSAGE_TYPES,
  SANDBOX_OFFSCREEN_PORT,
} from '../core/sandbox';
import { decodeToolRuntimePayload } from '../core/messaging/tool-runtime-request-codec';
import type { ToolCall } from '../core/tool/types';
import {
  SANDBOX_BOUNDARY_REGRESSION_CASES,
  SANDBOX_ENVELOPE_TYPES,
  SANDBOX_ERROR_CODES,
  SANDBOX_EXECUTION_RESULT,
  SANDBOX_LEGAL_ENVELOPES,
  SANDBOX_NORMALIZATION_CASES,
  SANDBOX_REJECTED_REQUESTS,
} from './fixtures/runtime-contract/sandbox';

const sandboxSources = [
  'core/sandbox/tool.ts',
  'core/sandbox/worker-runner.ts',
  'core/sandbox/python-worker.ts',
  'entrypoints/background.ts',
  'entrypoints/sandbox-offscreen/main.ts',
  'entrypoints/sandbox-runner/main.ts',
].map((path) => readFileSync(path, 'utf8'));
const combinedSandboxSource = sandboxSources.join('\n');

describe('sandbox compatibility contract', () => {
  it.each(SANDBOX_NORMALIZATION_CASES)('normalizes legal request: $name', ({ input, output }) => {
    expect(normalizeSandboxRunRequest(input)).toEqual(output);
  });

  it('accepts exactly 30000 UTF-8 bytes and rejects the next multibyte character', () => {
    expect(new TextEncoder().encode('界'.repeat(10_000))).toHaveLength(30_000);
    expect(normalizeSandboxRunRequest({
      language: 'javascript',
      code: '界'.repeat(10_000),
    }).code).toHaveLength(10_000);
    expect(() => normalizeSandboxRunRequest({
      language: 'javascript',
      code: '界'.repeat(10_001),
    })).toThrow('code is too large; max 30000 bytes');
  });

  it.each(SANDBOX_REJECTED_REQUESTS)('rejects malformed request: $name', ({ input, error }) => {
    expect(() => normalizeSandboxRunRequest(input)).toThrow(error);
  });

  it('preserves successful ToolResult identity across the injected runtime', async () => {
    const result = await executeSandboxToolCall({
      async runSandbox(request) {
        expect(request).toEqual({
          language: 'javascript',
          code: 'return 42;',
          input: undefined,
          timeoutMs: 5_000,
        });
        return {
          ok: SANDBOX_EXECUTION_RESULT.ok,
          summary: 'Sandbox executed',
          detail: SANDBOX_EXECUTION_RESULT.result,
          output: SANDBOX_EXECUTION_RESULT,
        };
      },
    }, sandboxCall('sandbox_run', { language: 'javascript', code: 'return 42;' }), 'en');

    expect(result).toEqual({
      ok: true,
      summary: 'Sandbox executed',
      detail: '42',
      output: SANDBOX_EXECUTION_RESULT,
      name: 'sandbox_run',
      provider: {
        kind: 'local',
        id: 'sandbox',
        displayName: 'Browser Sandbox',
        transport: 'in_process',
      },
      descriptorId: undefined,
    });
  });

  it('preserves explicit tool, runtime, and invalid-request error codes', async () => {
    const unsupported = await executeSandboxToolCall(null, sandboxCall('not_sandbox', {}), 'en');
    const unavailable = await executeSandboxToolCall(null, sandboxCall('sandbox_run', {
      language: 'javascript',
      code: 'return 42;',
    }), 'en');
    const invalid = await executeSandboxToolCall({
      async runSandbox() {
        throw new Error('must not execute invalid input');
      },
    }, sandboxCall('sandbox_run', { language: 'ruby', code: 'puts 42' }), 'en');

    expect(unsupported).toMatchObject({ ok: false, error: { code: 'sandbox_tool_unsupported', retryable: false } });
    expect(unavailable).toMatchObject({ ok: false, error: { code: 'sandbox_runtime_unavailable', retryable: false } });
    expect(invalid).toMatchObject({ ok: false, error: { code: 'sandbox_invalid_request', retryable: false } });
  });

  it('enumerates every multi-hop envelope and stable sandbox error code', () => {
    expect(SANDBOX_OFFSCREEN_PORT).toBe(SANDBOX_ENVELOPE_TYPES.backgroundPort.port);
    expect(SANDBOX_MESSAGE_TYPES).toEqual({
      offscreenRun: SANDBOX_ENVELOPE_TYPES.backgroundPort.request,
      offscreenResult: SANDBOX_ENVELOPE_TYPES.backgroundPort.response,
      frameRun: SANDBOX_ENVELOPE_TYPES.frame.request,
      frameResult: SANDBOX_ENVELOPE_TYPES.frame.response,
      htmlLog: SANDBOX_ENVELOPE_TYPES.html.log,
      htmlError: SANDBOX_ENVELOPE_TYPES.html.error,
      htmlDone: SANDBOX_ENVELOPE_TYPES.html.done,
    });
    expect(SANDBOX_LEGAL_ENVELOPES.map((envelope) => envelope.type))
      .toEqual(Object.values(SANDBOX_MESSAGE_TYPES));
    for (const envelope of SANDBOX_LEGAL_ENVELOPES) {
      expect(parseSandboxEnvelope(envelope, envelope.type)).toEqual(envelope);
    }
    expect(parseSandboxEnvelope(null, SANDBOX_MESSAGE_TYPES.frameRun)).toBeNull();
    expect(parseSandboxEnvelope([], SANDBOX_MESSAGE_TYPES.frameRun)).toBeNull();
    expect(parseSandboxEnvelope({ type: 'UNKNOWN', requestId: 'sandbox-contract-1' }, SANDBOX_MESSAGE_TYPES.frameRun)).toBeNull();
    expect(parseSandboxEnvelope({ type: SANDBOX_MESSAGE_TYPES.frameRun, requestId: 7 }, SANDBOX_MESSAGE_TYPES.frameRun)).toBeNull();
    expect(parseSandboxEnvelope(
      { type: SANDBOX_MESSAGE_TYPES.offscreenResult, requestId: 'stale', result: SANDBOX_EXECUTION_RESULT },
      SANDBOX_MESSAGE_TYPES.offscreenResult,
      'sandbox-contract-1',
    )).toBeNull();

    const sourceErrorCodes = new Set(
      [...combinedSandboxSource.matchAll(/['"](sandbox_[a-z_]+)['"]/g)]
        .map((match) => match[1])
        .filter((code) => code !== 'sandbox_run'),
    );
    expect(sourceErrorCodes).toEqual(new Set(SANDBOX_ERROR_CODES));
  });

  it('closes divergent validators and permissive result normalization gaps', () => {
    expect(SANDBOX_BOUNDARY_REGRESSION_CASES.map((gap) => gap.target)).toEqual([
      'explicit-strip-at-T2.1-boundary',
      'shared-sandbox-boundary-at-T2.1',
      'explicit-invalid-result-at-T2.1-boundary',
      'opaque-sandbox-origin-policy-at-T2.1',
      'reject-malformed-envelope-at-T2.1-boundary',
      'reject-malformed-envelope-at-T2.1-boundary',
    ]);
    expect(normalizeSandboxRunRequest(SANDBOX_BOUNDARY_REGRESSION_CASES[0].input)).toEqual({
      language: 'javascript',
      code: 'return 42;',
      input: undefined,
      timeoutMs: 5_000,
    });
    expect(() => normalizeSandboxBoundaryRequest(SANDBOX_BOUNDARY_REGRESSION_CASES[1].input.payload, {
      invalidLanguage: 'invalid language',
      invalidCode: 'invalid code',
    })).toThrow('code is too large; max 30000 bytes');
    expect(() => normalizeSandboxExecutionResult(SANDBOX_BOUNDARY_REGRESSION_CASES[2].input))
      .toThrow('Invalid sandbox execution result.');
    expect(SANDBOX_FRAME_TARGET_ORIGIN).toBe(SANDBOX_BOUNDARY_REGRESSION_CASES[3].input.targetOrigin);
    expect(parseSandboxEnvelope(
      SANDBOX_BOUNDARY_REGRESSION_CASES[4].input,
      SANDBOX_MESSAGE_TYPES.frameRun,
    )).toBeNull();
    expect(parseSandboxEnvelope(
      SANDBOX_BOUNDARY_REGRESSION_CASES[5].input,
      SANDBOX_MESSAGE_TYPES.offscreenResult,
    )).toBeNull();
  });

  it('keeps opaque-origin sending bounded by exact source and origin checks', () => {
    const source = {};
    expect(SANDBOX_FRAME_TARGET_ORIGIN).toBe('*');
    expect(isTrustedSandboxMessageEvent(source, source, 'null', 'null')).toBe(true);
    expect(isTrustedSandboxMessageEvent({}, source, 'null', 'null')).toBe(false);
    expect(isTrustedSandboxMessageEvent(source, source, 'https://example.test', 'null')).toBe(false);
  });

  it.each([
    ['run without payload', { type: SANDBOX_MESSAGE_TYPES.offscreenRun, requestId: 'bad-1' }, SANDBOX_MESSAGE_TYPES.offscreenRun],
    ['result with negative duration', {
      type: SANDBOX_MESSAGE_TYPES.offscreenResult,
      requestId: 'bad-2',
      result: { ...SANDBOX_EXECUTION_RESULT, durationMs: -1 },
    }, SANDBOX_MESSAGE_TYPES.offscreenResult],
    ['HTML log with non-string value', {
      type: SANDBOX_MESSAGE_TYPES.htmlLog,
      requestId: 'bad-3',
      level: 'log',
      values: [{}],
    }, SANDBOX_MESSAGE_TYPES.htmlLog],
    ['HTML error without message', {
      type: SANDBOX_MESSAGE_TYPES.htmlError,
      requestId: 'bad-4',
    }, SANDBOX_MESSAGE_TYPES.htmlError],
    ['HTML done without serialized document', {
      type: SANDBOX_MESSAGE_TYPES.htmlDone,
      requestId: 'bad-5',
      title: '',
      text: '',
    }, SANDBOX_MESSAGE_TYPES.htmlDone],
  ] as const)('rejects malformed nested sandbox envelope: %s', (_name, message, type) => {
    expect(readSandboxRequestId(message, type)).toBe(message.requestId);
    expect(parseSandboxEnvelope(message, type)).toBeNull();
  });

  it('validates Pyodide asset URLs at the frame execution boundary', () => {
    expect(normalizeSandboxBoundaryRequest({
      language: 'python',
      code: 'print(42)',
      pyodideBaseUrl: 'chrome-extension://contract/pyodide/',
    }, {
      invalidLanguage: 'invalid language',
      invalidCode: 'invalid code',
      includePyodideBaseUrl: true,
      pyodideOrigin: 'chrome-extension://contract',
    })).toEqual({
      language: 'python',
      code: 'print(42)',
      input: undefined,
      timeoutMs: 15_000,
      pyodideBaseUrl: 'chrome-extension://contract/pyodide/',
    });

    for (const pyodideBaseUrl of [
      'https://example.test/pyodide/',
      'chrome-extension://other/pyodide/',
      'chrome-extension://contract/other/',
      'chrome-extension://contract/pyodide/?override=1',
    ]) {
      expect(() => normalizeSandboxBoundaryRequest({
        language: 'python',
        code: 'print(42)',
        pyodideBaseUrl,
      }, {
        invalidLanguage: 'invalid language',
        invalidCode: 'invalid code',
        includePyodideBaseUrl: true,
        pyodideOrigin: 'chrome-extension://contract',
      })).toThrow('Pyodide base URL is invalid.');
    }
  });

  it('normalizes RUN_ARTIFACT_CODE at the typed handler boundary', () => {
    expect(decodeToolRuntimePayload('RUN_ARTIFACT_CODE', {
      language: 'javascript',
      code: 'return 42;',
    })).toEqual({
      ok: true,
      payload: {
        language: 'javascript',
        code: 'return 42;',
        input: undefined,
        timeoutMs: 5_000,
      },
    });
    expect(decodeToolRuntimePayload('RUN_ARTIFACT_CODE', {
      language: 'ruby',
      code: 'puts 42',
    })).toMatchObject({
      ok: false,
      detail: 'language must be javascript, typescript, python, or html',
    });
  });

  // X-69：出参长度边界兜底。沙箱内模型可自 postMessage 伪造信封，边界不能信
  // 生产侧已截断。5e7 字符的 html/result/previewText/error 必须被拒（非法结果）。
  it('rejects oversized optional result fields (X-69 boundary cap)', () => {
    const base = {
      ok: true,
      stdout: 'x',
      stderr: '',
      durationMs: 1,
      truncated: false,
    };
    const huge = 'x'.repeat(50_000_000);
    for (const field of ['html', 'result', 'previewText', 'error'] as const) {
      expect(() => normalizeSandboxExecutionResult({ ...base, [field]: huge }))
        .toThrow('Invalid sandbox execution result.');
    }
  });

  it('accepts an optional result field sized exactly at the boundary cap (X-69)', () => {
    const base = {
      ok: true,
      stdout: 'x',
      stderr: '',
      durationMs: 1,
      truncated: false,
    };
    // html 取到上界长度仍合法（<=），多一字符才拒
    const atCap = 'h'.repeat(SANDBOX_HTML_BOUNDARY_MAX_CHARS);
    expect(normalizeSandboxExecutionResult({ ...base, html: atCap }).html)
      .toHaveLength(SANDBOX_HTML_BOUNDARY_MAX_CHARS);
    expect(() => normalizeSandboxExecutionResult({
      ...base,
      html: 'h'.repeat(SANDBOX_HTML_BOUNDARY_MAX_CHARS + 1),
    })).toThrow('Invalid sandbox execution result.');
  });

  it('producer-side: worker error is capped and html is actually sliced (X-69)', () => {
    // normalizeWorkerResult / sandbox-runner main 不导出，用源码结构断言守护：
    // error 必须过 limitText；html 必须 limitText 切片且 truncated 并入 html.truncated。
    const worker = sandboxSources.find((s) => s.includes('WORKER_RESULT_MAX_CHARS = 512'))
      ?? combinedSandboxSource;
    expect(worker).toMatch(/limitText\(rawError/);
    expect(worker).toMatch(/errorText\.truncated/);

    const htmlRunner = sandboxSources.find((s) => s.includes('HTML_OUTPUT_LIMIT = 12_000'))
      ?? combinedSandboxSource;
    expect(htmlRunner).toMatch(/const html = limitText\(typeof value\.html/);
    expect(htmlRunner).toMatch(/html\.truncated/);
  });
});

function sandboxCall(name: string, payload: Record<string, unknown>): ToolCall {
  return {
    name,
    payload,
    raw: `<${name}>${JSON.stringify(payload)}</${name}>`,
  };
}
