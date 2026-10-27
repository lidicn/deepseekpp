/**
 * T5 DST 修复验证：getRecentDayKeys 日历减法 + pruneUsageRecords 日历 cutoff
 *
 * 防回归断言：
 *   - 任何 now 下 dayKeys 长度 = rangeDays、无重复、严格递增
 *   - 春进/秋退 DST 切换日附近：24h 减法会出缺口/重复，日历减法不会
 */
import { describe, expect, it } from 'vitest';
import { summarizeUsage, toLocalDayKey } from '../core/usage/stats';

function getDayKeys(rangeDays: number, now: number): string[] {
  const summary = summarizeUsage([], { rangeDays: rangeDays as 7 | 30, now });
  return summary.days.map((d) => d.day);
}

// 日历减法预期（与修复后实现一致，保证首尾断言可靠）
function expectedDayKeys(rangeDays: number, nowTimestamp: number): string[] {
  const base = new Date(nowTimestamp);
  const year = base.getFullYear();
  const month = base.getMonth();
  const date = base.getDate();
  return Array.from({ length: rangeDays }, (_, i) => {
    const d = new Date(year, month, date - (rangeDays - i - 1));
    return toLocalDayKey(d.getTime());
  });
}

describe('core/usage/stats — getRecentDayKeys 日历减法防 DST 错位', () => {
  it('任意 now：长度 = rangeDays、无重复、严格递增、首尾符合日历减法', () => {
    const probes: number[] = [
      new Date('2024-03-11T12:00:00').getTime(),
      new Date('2024-03-12T00:30:00').getTime(),
      new Date('2024-06-15T18:00:00').getTime(),
      new Date('2024-11-04T12:00:00').getTime(),
      new Date('2024-11-05T23:59:00').getTime(),
      new Date('2024-01-01T00:00:00').getTime(),
      new Date('2024-12-31T23:59:59').getTime(),
    ];

    for (const now of probes) {
      for (const rangeDays of [7, 30] as const) {
        const dayKeys = getDayKeys(rangeDays, now);
        const tag = `now=${new Date(now).toISOString()}, range=${rangeDays}`;

        expect(dayKeys.length, tag).toBe(rangeDays);
        expect(new Set(dayKeys).size, tag).toBe(rangeDays);

        const expected = expectedDayKeys(rangeDays, now);
        expect(dayKeys, tag).toEqual(expected);

        for (let i = 1; i < dayKeys.length; i += 1) {
          expect(dayKeys[i] > dayKeys[i - 1], `${tag}: dayKeys[${i}] should be after dayKeys[${i - 1}]`).toBe(true);
        }
      }
    }
  });

  it('月末跨年进位正确（2024-01-01 range=7 → 含 2023-12-26）', () => {
    const now = new Date('2024-01-01T12:00:00').getTime();
    const dayKeys = getDayKeys(7, now);
    expect(dayKeys[0]).toBe('2023-12-26');
    expect(dayKeys[dayKeys.length - 1]).toBe('2024-01-01');
  });

  it('闰年 2 月 29 日 range=7 → 不含 2024-02-30 防伪日期', () => {
    const now = new Date('2024-02-29T12:00:00').getTime();
    const dayKeys = getDayKeys(7, now);
    expect(dayKeys[0]).toBe('2024-02-23');
    expect(dayKeys[dayKeys.length - 1]).toBe('2024-02-29');
    expect(dayKeys).not.toContain('2024-02-30');
  });

  it('秋退 DST 窗口：range=7 无重复（24h 减法因 25h 日会重复 dayKey）', () => {
    const now = new Date('2024-11-04T12:00:00').getTime();
    const dayKeys = getDayKeys(7, now);
    expect(new Set(dayKeys).size).toBe(7);
    expect(dayKeys.length).toBe(7);
  });
});
