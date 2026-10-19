import { describe, expect, it } from 'vitest';
import { decodeScenario, decodeScenarioState, scenarioCodec } from '../core/scenario/codec';
import { decodeScenarioRuntimeRequest } from '../core/scenario/runtime-request-codec';
import { applyScenarioTemplate, buildContextMenuLabel } from '../core/scenario/store';
import type { ScenarioConfig } from '../core/types';

// T30: scenario 编解码往返、非法输入、runtime 请求解码、模板/标签纯函数。

const validScenario: ScenarioConfig = {
  id: 'tone-pro',
  label: 'Professional',
  template: 'Please rewrite: {text}',
  builtIn: true,
  enabled: false,
};

describe('decodeScenarioState · round-trip and rejection', () => {
  it('returns a parsed array preserving every field', () => {
    const out = decodeScenarioState([validScenario]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject(validScenario);
  });

  it('rejects non-array input and a versioned object schema', () => {
    expect(() => decodeScenarioState('nope')).toThrow(/must use the released array schema/);
    expect(() => decodeScenarioState({ schemaVersion: 1, scenarios: [] })).toThrow(/schemaVersion is not supported/);
  });

  it('rejects duplicate scenario ids', () => {
    expect(() => decodeScenarioState([validScenario, { ...validScenario, label: 'Other' }]))
      .toThrow(/duplicate scenario: tone-pro/);
  });
});

describe('decodeScenario · field type validation', () => {
  it('rejects a missing or non-string label and a non-boolean enabled', () => {
    expect(() => decodeScenario({ id: 'a', template: 't', builtIn: true, enabled: true }))
      .toThrow(/label must be a string/);
    expect(() => decodeScenario({ id: 'a', label: 'x', template: 't', builtIn: true, enabled: 'yes' }))
      .toThrow(/enabled must be a boolean/);
  });

  it('codec.encode runs the same array validation on valid input', () => {
    expect(scenarioCodec.encode([validScenario])).toHaveLength(1);
    expect(() => decodeScenarioState({})).toThrow(/must use the released array schema/);
  });
});

describe('decodeScenarioRuntimeRequest', () => {
  it('defaults undefined to refresh and accepts get / refresh with no extra keys', () => {
    expect(decodeScenarioRuntimeRequest(undefined)).toEqual({ operation: 'refresh' });
    expect(decodeScenarioRuntimeRequest({ operation: 'get' })).toEqual({ operation: 'get' });
  });

  it('rejects unknown operations, extra fields, and empty add/delete strings', () => {
    expect(() => decodeScenarioRuntimeRequest({ operation: 'nuke' })).toThrow(/not supported/);
    expect(() => decodeScenarioRuntimeRequest({ operation: 'refresh', extra: 1 })).toThrow(/unsupported field/);
    expect(() => decodeScenarioRuntimeRequest({ operation: 'add', label: '  ', template: 't' }))
      .toThrow(/label must be a non-empty string/);
    expect(() => decodeScenarioRuntimeRequest({ operation: 'delete', id: '' }))
      .toThrow(/id must be a non-empty string/);
  });

  it('decodes save through decodeScenario and add/delete trim their strings', () => {
    const saved = decodeScenarioRuntimeRequest({ operation: 'save', scenario: validScenario });
    expect(saved.operation).toBe('save');
    const added = decodeScenarioRuntimeRequest({ operation: 'add', label: '  Tag ', template: '  Tpl ' });
    expect(added.operation).toBe('add');
    if (added.operation !== 'add') throw new Error('expected add branch');
    expect(added.label).toBe('Tag');
    expect(added.template).toBe('Tpl');
  });
});

describe('store pure functions', () => {
  it('buildContextMenuLabel returns the label and applyScenarioTemplate substitutes {text}', () => {
    expect(buildContextMenuLabel(validScenario)).toBe('Professional');
    expect(applyScenarioTemplate('Rewrite: {text}', 'hello world')).toBe('Rewrite: hello world');
  });
});
