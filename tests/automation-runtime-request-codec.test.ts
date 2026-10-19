import { describe, expect, it } from 'vitest';
import {
  decodeAutomationCreateInput,
  decodeAutomationIdRequest,
  decodeAutomationRunsRequest,
  decodeAutomationStatusRequest,
  decodeAutomationUpdateRequest,
} from '../core/automation/runtime-request-codec';

// T15: 纯解码器，覆盖合法往返、缺字段拒绝、非法类型拒绝、多余字段拒绝。

const manualSchedule = {
  kind: 'manual',
  expression: null,
  timezone: 'UTC',
  enabled: false,
  minimumIntervalMinutes: 0,
};

const promptOptions = {
  modelType: null,
  searchEnabled: false,
  thinkingEnabled: false,
  refFileIds: [],
};

describe('decodeAutomationRunsRequest', () => {
  it('round-trips automationId and a positive integer limit', () => {
    expect(decodeAutomationRunsRequest({ automationId: 'auto-1', limit: 10 })).toEqual({
      automationId: 'auto-1',
      limit: 10,
    });
  });

  it('omits limit when not provided', () => {
    expect(decodeAutomationRunsRequest({ automationId: 'auto-1' })).toEqual({ automationId: 'auto-1' });
  });

  it('rejects a missing automationId', () => {
    expect(() => decodeAutomationRunsRequest({ limit: 5 })).toThrow();
  });

  it('rejects a non-positive / non-integer / typed limit', () => {
    expect(() => decodeAutomationRunsRequest({ automationId: 'a', limit: 0 })).toThrow();
    expect(() => decodeAutomationRunsRequest({ automationId: 'a', limit: 1.5 })).toThrow();
    expect(() => decodeAutomationRunsRequest({ automationId: 'a', limit: '5' })).toThrow();
  });

  it('rejects unsupported fields', () => {
    expect(() => decodeAutomationRunsRequest({ automationId: 'a', limit: 3, stray: 1 })).toThrow();
  });
});

describe('decodeAutomationCreateInput', () => {
  it('round-trips a valid manual schedule and prompt options', () => {
    const decoded = decodeAutomationCreateInput({
      name: 'Demo',
      prompt: 'do the thing',
      schedule: manualSchedule,
      promptOptions,
    });
    expect(decoded.name).toBe('Demo');
    expect(decoded.prompt).toBe('do the thing');
    expect(decoded.schedule.kind).toBe('manual');
    expect(decoded.promptOptions.refFileIds).toEqual([]);
  });

  it('rejects a missing prompt', () => {
    expect(() =>
      decodeAutomationCreateInput({ name: 'Demo', schedule: manualSchedule, promptOptions }),
    ).toThrow();
  });

  it('rejects a blank name and an unsupported top-level field', () => {
    expect(() =>
      decodeAutomationCreateInput({ name: '   ', prompt: 'p', schedule: manualSchedule, promptOptions }),
    ).toThrow();
    expect(() =>
      decodeAutomationCreateInput({ name: 'n', prompt: 'p', schedule: manualSchedule, promptOptions, extra: 1 }),
    ).toThrow();
  });

  it('rejects a promptOptions whose flags are not booleans', () => {
    expect(() =>
      decodeAutomationCreateInput({
        name: 'n',
        prompt: 'p',
        schedule: manualSchedule,
        promptOptions: { modelType: null, searchEnabled: 'yes', thinkingEnabled: false, refFileIds: [] },
      }),
    ).toThrow();
  });
});

describe('decodeAutomationUpdateRequest', () => {
  it('round-trips a valid status patch and null nextRunAt', () => {
    const decoded = decodeAutomationUpdateRequest({
      id: 'auto-1',
      patch: { status: 'paused', nextRunAt: null },
    });
    expect(decoded.id).toBe('auto-1');
    expect(decoded.patch.status).toBe('paused');
    expect(decoded.patch.nextRunAt).toBeNull();
  });

  it('rejects an invalid status', () => {
    expect(() => decodeAutomationUpdateRequest({ id: 'a', patch: { status: 'running' } })).toThrow();
  });

  it('rejects a non-finite nextRunAt and an out-of-range timestamp', () => {
    expect(() => decodeAutomationUpdateRequest({ id: 'a', patch: { nextRunAt: 'soon' } })).toThrow();
    expect(() => decodeAutomationUpdateRequest({ id: 'a', patch: { nextRunAt: -1 } })).toThrow();
  });

  it('rejects unsupported patch fields', () => {
    expect(() => decodeAutomationUpdateRequest({ id: 'a', patch: { status: 'active', rogue: true } })).toThrow();
  });
});

describe('decodeAutomationStatusRequest', () => {
  it('returns ok:true for a valid status', () => {
    expect(decodeAutomationStatusRequest({ id: 'a', status: 'archived' })).toEqual({
      ok: true,
      id: 'a',
      status: 'archived',
    });
  });

  it('returns ok:false for an invalid status without throwing', () => {
    expect(decodeAutomationStatusRequest({ id: 'a', status: 'banana' })).toEqual({
      ok: false,
      error: 'invalid_automation_status',
    });
  });
});

describe('decodeAutomationIdRequest', () => {
  it('round-trips a valid id', () => {
    expect(decodeAutomationIdRequest({ id: 'auto-1' }, 'GET_AUTOMATION')).toEqual({ id: 'auto-1' });
  });

  it('rejects a missing id and unsupported fields', () => {
    expect(() => decodeAutomationIdRequest({}, 'GET_AUTOMATION')).toThrow();
    expect(() => decodeAutomationIdRequest({ id: 'a', other: 1 }, 'GET_AUTOMATION')).toThrow();
  });
});
