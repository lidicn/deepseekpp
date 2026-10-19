import { describe, expect, it } from 'vitest';
import {
  AutomationStorageContractError,
  AUTOMATION_STORAGE_VERSION,
  decodeAutomationStorageState,
} from '../core/automation/storage-codec';

// T16: 直接打纯解码器，聚焦损坏输入（null/undefined/非对象/类型错/数组混杂物），
// 不走 store 与 chrome；合法投影已由 automation-storage-contract.test.ts 覆盖。

const validAutomation = {
  id: 'auto-1',
  name: 'Automation',
  prompt: 'Run safely.',
  status: 'active',
  version: 1,
  schedule: {
    kind: 'manual',
    expression: null,
    timezone: 'UTC',
    enabled: false,
    minimumIntervalMinutes: 0,
  },
  promptOptions: {
    modelType: null,
    searchEnabled: false,
    thinkingEnabled: false,
    refFileIds: [],
  },
  createdAt: 1_000,
  updatedAt: 1_000,
  lastRunAt: null,
  nextRunAt: null,
  lastError: null,
};

const validRun = {
  id: 'run-1',
  automationId: 'auto-1',
  trigger: 'manual',
  status: 'queued',
  scheduledFor: null,
  attempt: 1,
  request: null,
  result: null,
  error: null,
  createdAt: 1_000_000,
  startedAt: null,
  completedAt: null,
  updatedAt: 1_000_000,
};

function corrupt(raw: unknown) {
  return expect(() => decodeAutomationStorageState(raw)).toThrow(
    expect.objectContaining({
      name: AutomationStorageContractError.name,
      code: 'automation_storage_corrupt',
    }),
  );
}

describe('decodeAutomationStorageState · top-level damage', () => {
  it('treats undefined as an empty v1 state', () => {
    const decoded = decodeAutomationStorageState(undefined);
    expect(decoded.version).toBe(AUTOMATION_STORAGE_VERSION);
    expect(decoded.automations).toEqual([]);
    expect(decoded.runs).toEqual([]);
  });

  it('rejects null as corrupt', () => corrupt(null));

  it.each([
    ['an array', []],
    ['a string', 'not-an-object'],
    ['a number', 42],
    ['a boolean', true],
  ])('rejects %s as corrupt', (_label, raw) => corrupt(raw));
});

describe('decodeAutomationStorageState · collection damage', () => {
  it('rejects automations that are not an array', () =>
    corrupt({ version: 1, automations: {}, runs: [] }));

  it('rejects runs that are not an array', () =>
    corrupt({ version: 1, automations: [], runs: 'many' }));

  it('rejects an automations array mixed with a non-object row', () =>
    corrupt({ version: 1, automations: [validAutomation, 'junk'], runs: [] }));

  it('rejects a runs array mixed with a non-object row', () =>
    corrupt({ version: 1, automations: [], runs: [validRun, 999] }));
});

describe('decodeAutomationStorageState · field-type damage', () => {
  it('rejects an invalid status enum on an automation', () =>
    corrupt({ version: 1, automations: [{ ...validAutomation, status: 'running' }], runs: [] }));

  it('rejects a non-finite createdAt on an automation', () =>
    corrupt({ version: 1, automations: [{ ...validAutomation, createdAt: 'today' }], runs: [] }));

  it('rejects an invalid schedule kind', () =>
    corrupt({
      version: 1,
      automations: [{ ...validAutomation, schedule: { ...validAutomation.schedule, kind: 'hourly' } }],
      runs: [],
    }));

  it('rejects an invalid run status enum', () =>
    corrupt({ version: 1, automations: [], runs: [{ ...validRun, status: 'executing' }] }));

  it('rejects a non-positive attempt on a run', () =>
    corrupt({ version: 1, automations: [], runs: [{ ...validRun, attempt: 0 }] }));

  it('rejects an empty-string id on an automation', () =>
    corrupt({ version: 1, automations: [{ ...validAutomation, id: '  ' }], runs: [] }));
});
