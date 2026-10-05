import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  applyTelemetryGate,
  isTelemetryCaptureEnabled,
  readTelemetrySetting,
} from '../core/debug/telemetry-gate';
import {
  mountDebugToWindow,
  recordRequestFromBody,
  refactorTelemetry,
} from '../core/debug/refactor-telemetry';

const PROMPT_SENTINEL = 'PROMPT-SENTINEL-4f9c-用户原话不得留存';
const MESSAGE_SENTINEL = 'MESSAGE-SENTINEL-7a13-用户原话不得留存';

function buildBody(promptTail: string, messageText: string): string {
  const prompt = [
    '## Memories',
    promptTail,
    '### Available Tools',
    '### Tool shell_exec',
    'runs a shell command',
    '### Tool web_fetch',
    'fetches a url',
    '## End',
  ].join('\n');
  return JSON.stringify({
    prompt,
    messages: [{ role: 'user', content: messageText }],
    tools: [{ type: 'function', function: { name: 'shell_exec' } }],
  });
}

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

function promptOf(body: string): string {
  return JSON.parse(body).prompt as string;
}

function dumpText(): string {
  return JSON.stringify(refactorTelemetry.dump());
}

beforeEach(() => {
  refactorTelemetry.reset();
  window.localStorage.clear();
  Reflect.deleteProperty(window, '__DPP_DEBUG__');
});

describe('refactor telemetry plaintext retention (DCD 20261005 §二 A)', () => {
  it('records a request without retaining prompt or body plaintext', () => {
    const body = buildBody(PROMPT_SENTINEL, MESSAGE_SENTINEL);
    recordRequestFromBody(body, 'chat', true);

    const dump = refactorTelemetry.dump();
    expect(dump.requests).toHaveLength(1);
    const record = dump.requests[0] as unknown as Record<string, unknown>;
    expect(Object.keys(record)).not.toContain('promptText');
    expect(Object.keys(record)).not.toContain('bodySample');
    const serialized = dumpText();
    expect(serialized).not.toContain(PROMPT_SENTINEL);
    expect(serialized).not.toContain(MESSAGE_SENTINEL);
    expect(serialized).not.toContain('### Available Tools');
  });

  it('keeps the prefix-consistency metric while dropping the previous prompt text', () => {
    const first = buildBody('共享前缀段落 AAA', MESSAGE_SENTINEL);
    const second = buildBody('共享前缀段落 BBB', '另一段原话');
    recordRequestFromBody(first, 'chat', true);
    recordRequestFromBody(second, 'chat', true);

    const summary = refactorTelemetry.summary();
    expect(summary.prefixConsistencySamples).toBe(1);
    expect(String(summary.prefixConsistencyRate)).toMatch(/^(\d+(\.\d+)?)%$/);
    expect(Number(String(summary.prefixConsistencyRate).replace('%', ''))).toBeGreaterThan(0);

    const serialized = dumpText();
    expect(serialized).not.toContain(MESSAGE_SENTINEL);
    expect(serialized).not.toContain('共享前缀段落');
    expect(serialized).not.toContain('另一段原话');
    expect(serialized).not.toContain('## Memories');
  });

  it('keeps the numeric conclusions the debug panel was built for', () => {
    const body = buildBody(PROMPT_SENTINEL, MESSAGE_SENTINEL);
    const prompt = promptOf(body);
    recordRequestFromBody(body, 'chat', true);

    const record = refactorTelemetry.dump().requests[0] as unknown as Record<string, unknown>;
    expect(record.route).toBe('chat');
    expect(record.augmentationApplied).toBe(true);
    expect(record.messageCount).toBe(1);
    expect(record.toolsCount).toBe(1);
    expect(record.toolsOrder).toEqual(['shell_exec']);
    expect(record.payloadBytes).toBe(utf8Bytes(body));
    expect(record.promptBytes).toBe(utf8Bytes(prompt));
    expect(record.toolCountInPrompt).toBe(2);
    expect(record.toolCatalogBytes).toBe(
      utf8Bytes(prompt.slice(prompt.indexOf('### Available Tools'))),
    );
    expect(record.toolsBytes).toBeGreaterThan(0);
    expect(record.candidateToolFields).toEqual({ tools: 1 });

    const summary = refactorTelemetry.summary();
    expect(summary.avgPromptBytes).toBe(utf8Bytes(prompt));
    expect(summary.avgToolCatalogBytes).toBeGreaterThan(0);
    expect(summary.avgToolCountInPrompt).toBe(2);
  });
});

describe('debug telemetry capture gate', () => {
  it('captures by default so existing triage flows keep their data', () => {
    expect(isTelemetryCaptureEnabled()).toBe(true);
    recordRequestFromBody(buildBody(PROMPT_SENTINEL, MESSAGE_SENTINEL), 'chat', true);
    expect(refactorTelemetry.dump().requests).toHaveLength(1);

    mountDebugToWindow();
    expect(typeof (window as unknown as Record<string, any>).__DPP_DEBUG__.dump).toBe('function');
  });

  it('stops capturing and mounting once the page gate is closed', () => {
    applyTelemetryGate(false);
    expect(isTelemetryCaptureEnabled()).toBe(false);

    recordRequestFromBody(buildBody(PROMPT_SENTINEL, MESSAGE_SENTINEL), 'chat', true);
    refactorTelemetry.recordTruncation({
      timestamp: Date.now(),
      layer: 'mcp',
      toolName: 'shell_exec',
      originalBytes: 10,
      truncatedBytes: 5,
      limit: 6,
      truncated: true,
      markerPresent: true,
    });
    expect(refactorTelemetry.dump().requests).toHaveLength(0);
    expect(refactorTelemetry.dump().truncations).toHaveLength(0);

    mountDebugToWindow();
    expect(Reflect.has(window, '__DPP_DEBUG__')).toBe(false);
  });
});

describe('sidepanel setting mirror', () => {
  it('treats an absent setting as enabled and mirrors an explicit value', async () => {
    await expect(readTelemetrySetting({ get: async () => ({}) })).resolves.toBe(true);
    await expect(
      readTelemetrySetting({ get: async () => ({ dpp_debug_telemetry_enabled: false }) }),
    ).resolves.toBe(false);
    await expect(
      readTelemetrySetting({ get: async () => ({ dpp_debug_telemetry_enabled: true }) }),
    ).resolves.toBe(true);
  });

  it('writes the page gate from the setting value', async () => {
    const value = await readTelemetrySetting({
      get: async () => ({ dpp_debug_telemetry_enabled: false }),
    });
    applyTelemetryGate(value);
    expect(window.localStorage.getItem('dpp_debug')).toBe('0');
    expect(isTelemetryCaptureEnabled()).toBe(false);

    applyTelemetryGate(true);
    expect(window.localStorage.getItem('dpp_debug')).toBe('1');
    expect(isTelemetryCaptureEnabled()).toBe(true);
  });
});

describe('debug telemetry switch wiring', () => {
  function capabilityRegion(source: string): string {
    const start = source.indexOf('function createDebugTelemetryCapability');
    expect(start).toBeGreaterThanOrEqual(0);
    return source.slice(start, start + 1_500);
  }

  it('mirrors the sidepanel setting into the page gate from the content capability', () => {
    const source = readFileSync(join(process.cwd(), 'entrypoints/content.ts'), 'utf8');
    expect(source).toMatch(/createDebugTelemetryCapability\(\),/);
    const region = capabilityRegion(source);
    expect(region).toMatch(/id:\s*["']debug-telemetry["']/);
    expect(region).toMatch(/readTelemetrySetting\(chrome\.storage\.local\)/);
    expect(region).toMatch(/applyTelemetryGate\(/);
    expect(region).toMatch(/TELEMETRY_SETTING_STORAGE_KEY/);
  });

  it('renders the toggle from the sidepanel general settings page with i18n labels', () => {
    const controller = readFileSync(
      join(process.cwd(), 'entrypoints/sidepanel/controllers/useSettingsController.ts'),
      'utf8',
    );
    expect(controller).toMatch(/dpp_debug_telemetry_enabled/);
    const page = readFileSync(
      join(process.cwd(), 'entrypoints/sidepanel/components/settings/GeneralSubPage.tsx'),
      'utf8',
    );
    expect(page).toMatch(/t\(['"]sidepanel\.settings\.debugTelemetry['"]\)/);
    expect(page).toMatch(/state\.handleDebugTelemetryToggle/);
  });
});
