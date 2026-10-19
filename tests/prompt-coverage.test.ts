import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PROMPT_INJECTION_SETTINGS,
  normalizePromptInjectionSettings,
  shouldInjectPresetForTurn,
} from '../core/prompt/settings';
import {
  createToolBlockParts,
  measureCatalogParts,
  renderCatalogParts,
  renderCatalogSharedRegion,
  utf8ByteLength,
} from '../core/prompt/catalog-template';

// T27: core/prompt 非快照逻辑。prompt-output-contract.test.ts 是快照，不碰。

describe('normalizePromptInjectionSettings', () => {
  it('collapses null / non-object / array input to defaults', () => {
    expect(normalizePromptInjectionSettings(null)).toEqual(DEFAULT_PROMPT_INJECTION_SETTINGS);
    expect(normalizePromptInjectionSettings('x')).toEqual(DEFAULT_PROMPT_INJECTION_SETTINGS);
    expect(normalizePromptInjectionSettings([1])).toEqual(DEFAULT_PROMPT_INJECTION_SETTINGS);
  });

  it('keeps an explicit false for memory/system switches', () => {
    const normalized = normalizePromptInjectionSettings({
      memoryEnabled: false,
      systemPromptEnabled: false,
    });
    expect(normalized.memoryEnabled).toBe(false);
    expect(normalized.systemPromptEnabled).toBe(false);
  });

  it('falls back for an unknown cadence and an unsupported forced language', () => {
    const normalized = normalizePromptInjectionSettings({
      presetCadence: 'bogus' as never,
      forceResponseLanguage: 'bogus-locale' as never,
    });
    expect(normalized.presetCadence).toBe('default');
    expect(normalized.forceResponseLanguage).toBe('auto');
  });
});

describe('shouldInjectPresetForTurn · cadence', () => {
  const base = { hasActivePreset: true, isFirstMessage: false, messageCount: 5 };

  it('never injects without an active preset, regardless of cadence', () => {
    expect(shouldInjectPresetForTurn({ ...base, hasActivePreset: false, cadence: 'every_message' })).toBe(false);
  });

  it('off always skips; first_message only on the first turn; every_message always injects', () => {
    expect(shouldInjectPresetForTurn({ ...base, cadence: 'off' })).toBe(false);
    expect(shouldInjectPresetForTurn({ ...base, cadence: 'first_message', isFirstMessage: true })).toBe(true);
    expect(shouldInjectPresetForTurn({ ...base, cadence: 'first_message', isFirstMessage: false })).toBe(false);
    expect(shouldInjectPresetForTurn({ ...base, cadence: 'every_message' })).toBe(true);
  });

  it('default injects on the first turn or when message count hits the reinjection interval', () => {
    expect(shouldInjectPresetForTurn({ ...base, cadence: 'default', isFirstMessage: true })).toBe(true);
    expect(shouldInjectPresetForTurn({ ...base, cadence: 'default', isFirstMessage: false, messageCount: 1 })).toBe(false);
    expect(shouldInjectPresetForTurn({ ...base, cadence: 'default', isFirstMessage: false, messageCount: 10 })).toBe(true);
  });
});

describe('catalog-template pure rendering', () => {
  it('utf8ByteLength counts ASCII as 1 and CJK as 3 bytes', () => {
    expect(utf8ByteLength('abc')).toBe(3);
    expect(utf8ByteLength('你')).toBe(3);
    expect(utf8ByteLength('a你')).toBe(4);
  });

  it('emits an alias line only when accepted names exceed one, and renders parts in order', () => {
    const single = createToolBlockParts({
      preferredName: 'shell_exec',
      acceptedNames: ['shell_exec'],
      title: 'Run a shell command',
      description: 'Executes a command.',
      inputSchema: { type: 'object' },
    });
    expect(single.some((p) => p.category === 'aliases')).toBe(false);

    const multi = createToolBlockParts({
      preferredName: 'shell_exec',
      acceptedNames: ['shell_exec', 'shell'],
      title: 'Run a shell command',
      description: 'Executes a command.',
      inputSchema: { type: 'object' },
    });
    const alias = multi.find((p) => p.category === 'aliases');
    expect(alias?.text).toContain('shell_exec, shell');
    expect(renderCatalogParts(multi)).toContain('Parameters JSON Schema: ');
  });

  it('measureCatalogParts equals the sum of per-part UTF-8 byte lengths', () => {
    const parts = createToolBlockParts({
      preferredName: 'greet',
      acceptedNames: ['greet'],
      title: '打招呼',
      description: 'Says hello.',
      inputSchema: { type: 'object' },
    });
    const expected = parts.reduce((sum, p) => sum + utf8ByteLength(p.text), 0);
    expect(measureCatalogParts(parts)).toBe(expected);
  });

  it('renderCatalogSharedRegion picks Chinese for zh and English otherwise', () => {
    expect(renderCatalogSharedRegion('zh')).toContain('### 调用格式');
    expect(renderCatalogSharedRegion(undefined)).toContain('### Call format');
    expect(renderCatalogSharedRegion('fr')).toContain('### Call format');
  });
});
