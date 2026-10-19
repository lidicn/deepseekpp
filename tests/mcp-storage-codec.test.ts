import { describe, it, expect } from 'vitest';
import {
  createEmptyMcpStorageState,
  decodeMcpStorageState,
  encodeMcpStorageState,
} from '../core/mcp/storage-codec';

describe('mcp/storage-codec', () => {
  it('空状态', () => {
    const s = createEmptyMcpStorageState();
    expect(s.version).toBe(2);
    expect(s.servers).toEqual([]);
  });

  it('编解码往返', () => {
    const state = createEmptyMcpStorageState();
    const encoded = encodeMcpStorageState(state);
    const decoded = decodeMcpStorageState(encoded);
    expect(decoded).toEqual(state);
  });

  it('null 输入抛错', () => {
    expect(() => decodeMcpStorageState(null)).toThrow();
  });

  it('损坏输入拒绝', () => {
    expect(() => decodeMcpStorageState('invalid')).toThrow();
  });
});
