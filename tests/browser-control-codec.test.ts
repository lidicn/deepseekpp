import { describe, expect, it } from 'vitest';
import {
  decodeBrowserControlSettings,
  decodeBrowserControlState,
  decodeBrowserControlTarget,
  isBrowserControlToolName,
} from '../core/browser-control';

describe('browser control response codec', () => {
  it('decodes the released settings and state shapes without dropping additive fields', () => {
    const settings = {
      enabled: true,
      targetTabId: 7,
      includeSnapshotAfterActions: true,
      maxSnapshotNodes: 400,
      maxSnapshotTextBytes: 24_000,
      additive: 'kept',
    };
    const target = {
      id: 7,
      windowId: 1,
      groupId: -1,
      active: true,
      currentWindow: true,
      title: 'DeepSeek',
      url: 'https://chat.deepseek.com/',
      controllable: true,
    };

    expect(decodeBrowserControlSettings(settings)).toEqual(settings);
    expect(decodeBrowserControlState({
      supported: true,
      enabled: true,
      attached: true,
      targetTabId: 7,
      target,
      targets: [target],
      error: null,
      additive: 'kept',
    })).toMatchObject({ target, targets: [target], additive: 'kept' });
  });

  it('rejects malformed response fields instead of normalizing them into defaults', () => {
    expect(() => decodeBrowserControlSettings({ enabled: 'yes' }))
      .toThrow('browserControlSettings.enabled must be a boolean');
    expect(() => decodeBrowserControlState({
      supported: true,
      enabled: false,
      attached: false,
      targetTabId: null,
      target: null,
      targets: {},
      error: null,
    })).toThrow('browserControlState.targets must be an array');
  });
});

// T21 补充：target 解码往返与可选字段、state 嵌套 target、命令白名单拒绝未知 action。
describe('browser control target codec', () => {
  const target = {
    id: 7,
    windowId: 1,
    groupId: -1,
    active: true,
    currentWindow: true,
    title: 'DeepSeek',
    url: 'https://chat.deepseek.com/',
    controllable: true,
  };

  it('round-trips a target and omits optional groupName/reason when absent', () => {
    const decoded = decodeBrowserControlTarget(target);
    expect(decoded.id).toBe(7);
    expect(decoded.controllable).toBe(true);
    expect('groupName' in decoded).toBe(false);
    expect('reason' in decoded).toBe(false);
  });

  it('keeps optional groupName/reason when present', () => {
    const decoded = decodeBrowserControlTarget({ ...target, groupName: 'work', reason: 'no-permission' });
    expect(decoded.groupName).toBe('work');
    expect(decoded.reason).toBe('no-permission');
  });

  it('rejects a non-string title/url and a non-boolean controllable', () => {
    expect(() => decodeBrowserControlTarget({ ...target, title: 42 })).toThrow();
    expect(() => decodeBrowserControlTarget({ ...target, url: null })).toThrow();
    expect(() => decodeBrowserControlTarget({ ...target, controllable: 'yes' })).toThrow();
  });
});

describe('browser control state nested target and error', () => {
  const target = {
    id: 7, windowId: 1, groupId: -1, active: true, currentWindow: true,
    title: 'DeepSeek', url: 'https://chat.deepseek.com/', controllable: true,
  };

  it('decodes a nested target inside targets and accepts a string error', () => {
    const decoded = decodeBrowserControlState({
      supported: true, enabled: true, attached: true,
      targetTabId: 7, target, targets: [target], error: 'busy',
    });
    expect(decoded.target?.id).toBe(7);
    expect(decoded.targets).toHaveLength(1);
    expect(decoded.error).toBe('busy');
  });

  it('rejects a non-null non-string error', () => {
    expect(() => decodeBrowserControlState({
      supported: true, enabled: false, attached: false,
      targetTabId: null, target: null, targets: [], error: 42,
    })).toThrow();
  });
});

describe('browser control command whitelist', () => {
  it('accepts a known action and rejects an unknown command', () => {
    expect(isBrowserControlToolName('browser_click')).toBe(true);
    expect(isBrowserControlToolName('navigate')).toBe(false);
    expect(isBrowserControlToolName('browser_dancing')).toBe(false);
  });
});
