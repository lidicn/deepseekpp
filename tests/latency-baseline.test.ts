import { describe, it, expect } from 'vitest';
import { createLatencyBaseline } from '../core/tool/latency-baseline';

describe('latency-baseline', () => {
  it('空基线', () => {
    const lb = createLatencyBaseline();
    expect(lb.stats().count).toBe(0);
  });
  it('记录与统计', () => {
    const lb = createLatencyBaseline();
    for (let i = 1; i <= 10; i++) lb.record(i * 100);
    expect(lb.stats().count).toBe(10);
    expect(lb.stats().p50).toBe(500);
  });
  it('窗口溢出', () => {
    const lb = createLatencyBaseline(5);
    for (let i = 1; i <= 10; i++) lb.record(i * 100);
    expect(lb.stats().count).toBe(5);
  });
  it('isSlow', () => {
    const lb = createLatencyBaseline();
    for (let i = 1; i <= 10; i++) lb.record(100);
    expect(lb.isSlow(500)).toBe(true);
    expect(lb.isSlow(200)).toBe(false);
  });
  it('空基线 isSlow', () => {
    const lb = createLatencyBaseline();
    expect(lb.isSlow(1000)).toBe(false);
  });
});
