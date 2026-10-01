import { describe, expect, it } from 'vitest';
import { truncateToolResultDetail } from '../core/tool/result-governance';
import type { ToolResult } from '../core/types';

const encoder = new TextEncoder();

function makeResult(detail: string): ToolResult {
  return { ok: true, summary: 's', detail, name: 'demo' };
}

// B7 boundary: byte governance must never emit more bytes than the budget
// allows, at any limit — including tiny/zero limits where the truncation
// marker cannot fit.
describe('truncateToolResultDetail byte-budget invariant (B7)', () => {
  const longDetail = 'x'.repeat(20000);

  for (const limit of [0, 1, 20, 50, 99, 100, 101, 120, 8000]) {
    it(`respects the limit for maxBytes=${limit}`, () => {
      const out = truncateToolResultDetail(makeResult(longDetail), limit);
      const emitted = encoder.encode(out.detail ?? '').byteLength;
      expect(emitted).toBeLessThanOrEqual(limit);
    });
  }

  it('keeps the truncation marker when the budget can carry it (limit >= 100)', () => {
    const out = truncateToolResultDetail(makeResult(longDetail), 8000);
    expect(out.truncated).toBe(true);
    expect(out.detail).toContain('[result-truncated, original=');
  });

  it('drops the marker but still flags truncation when the budget is tiny', () => {
    const out = truncateToolResultDetail(makeResult(longDetail), 50);
    expect(out.truncated).toBe(true);
    expect(out.detail).not.toContain('[result-truncated');
    expect(encoder.encode(out.detail ?? '').byteLength).toBeLessThanOrEqual(50);
  });

  it('does not truncate when the result already fits', () => {
    const short = makeResult('hello');
    const out = truncateToolResultDetail(short, 8000);
    expect(out.truncated).toBeUndefined();
    expect(out.detail).toBe('hello');
  });
});
