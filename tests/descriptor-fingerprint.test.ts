import { describe, it, expect } from 'vitest';
import { fingerprintDescriptors, hasDescriptorChanged } from '../core/tool/descriptor-fingerprint';

describe('descriptor-fingerprint', () => {
  it('顺序无关', () => {
    const a = fingerprintDescriptors([{ invocationName: 'b', name: 'B' }, { invocationName: 'a', name: 'A' }]);
    const b = fingerprintDescriptors([{ invocationName: 'a', name: 'A' }, { invocationName: 'b', name: 'B' }]);
    expect(a).toBe(b);
  });
  it('内容变化检出', () => {
    const a = fingerprintDescriptors([{ invocationName: 'a', name: 'A' }]);
    const b = fingerprintDescriptors([{ invocationName: 'a', name: 'B' }]);
    expect(hasDescriptorChanged(a, b)).toBe(true);
  });
  it('空数组', () => {
    expect(fingerprintDescriptors([])).toBe('');
  });
  it('稳定性', () => {
    const d = [{ invocationName: 'a', name: 'A' }];
    expect(fingerprintDescriptors(d)).toBe(fingerprintDescriptors(d));
  });
});
