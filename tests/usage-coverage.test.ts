import { describe, expect, it } from 'vitest';
import {
  dayKeyToTimestamp,
  getUsageModelKey,
  getUsageModelLabel,
  normalizeUsageRangeDays,
  summarizeUsage,
  toLocalDayKey,
} from '../core/usage/stats';
import type { UsageTurnRecord } from '../core/usage/types';

// T24: 补既有 usage-stats.test.ts 未覆盖的分桶长度/越界过滤/跨天独立桶、
// 计数规范化、model key/label 映射、share 比例、heatmap level。

const DAY_MS = 24 * 60 * 60 * 1000;

function makeRecord(overrides: Partial<UsageTurnRecord>): UsageTurnRecord {
  const recordedAt = overrides.recordedAt ?? Date.now();
  return {
    id: 'r',
    recordedAt,
    day: toLocalDayKey(recordedAt),
    source: 'deepseek-web',
    chatSessionId: 's',
    assistantMessageId: 1,
    modelType: null,
    totalTokens: 0,
    tokenSource: 'server',
    tps: 10,
    speedSource: 'server',
    elapsedMs: 1000,
    messageCount: 1,
    ...overrides,
  };
}

describe('normalizeUsageRangeDays', () => {
  it('keeps 7 and collapses every other value to 30', () => {
    expect(normalizeUsageRangeDays(7)).toBe(7);
    expect(normalizeUsageRangeDays(30)).toBe(30);
    expect(normalizeUsageRangeDays(14)).toBe(30);
    expect(normalizeUsageRangeDays(undefined as unknown)).toBe(30);
  });
});

describe('summarizeUsage · bucket length and out-of-window filtering', () => {
  const now = new Date(2026, 5, 18, 12).getTime();

  it('builds exactly 7 buckets for rangeDays 7 and 30 for rangeDays 30', () => {
    expect(summarizeUsage([], { rangeDays: 7, now }).days).toHaveLength(7);
    expect(summarizeUsage([], { rangeDays: 30, now }).days).toHaveLength(30);
  });

  it('drops records outside the 7-day window', () => {
    const summary = summarizeUsage([
      makeRecord({ id: 'old', recordedAt: now - 8 * DAY_MS, totalTokens: 500 }),
      makeRecord({ id: 'now', recordedAt: now, totalTokens: 10 }),
    ], { rangeDays: 7, now });
    expect(summary.totalTokens).toBe(10);
    expect(summary.turnCount).toBe(1);
  });

  it('keeps adjacent-day records in separate buckets without mixing tokens', () => {
    const yesterday = now - DAY_MS;
    const summary = summarizeUsage([
      makeRecord({ id: 'y', recordedAt: yesterday, day: toLocalDayKey(yesterday), totalTokens: 100, chatSessionId: 'a' }),
      makeRecord({ id: 't', recordedAt: now, day: toLocalDayKey(now), totalTokens: 250, chatSessionId: 'b' }),
    ], { rangeDays: 7, now });
    const today = summary.days.find((d) => d.day === toLocalDayKey(now))!;
    const prev = summary.days.find((d) => d.day === toLocalDayKey(yesterday))!;
    expect(today.tokens).toBe(250);
    expect(prev.tokens).toBe(100);
    expect(summary.activeDays).toBe(2);
  });

  it('normalizes negative/non-finite token counts to zero', () => {
    const summary = summarizeUsage([
      makeRecord({ id: 'neg', recordedAt: now, totalTokens: -50 }),
      makeRecord({ id: 'nan', recordedAt: now, totalTokens: Number.NaN }),
    ], { rangeDays: 7, now });
    expect(summary.totalTokens).toBe(0);
  });
});

describe('model key / label mapping', () => {
  it('maps null/blank to the default key and Chat label', () => {
    expect(getUsageModelKey(null)).toBe('deepseek-default');
    expect(getUsageModelKey('   ')).toBe('deepseek-default');
    expect(getUsageModelLabel(undefined)).toBe('DeepSeek Chat');
    expect(getUsageModelLabel('default')).toBe('DeepSeek Chat');
  });

  it('lowercases the key and maps known labels, passthrough otherwise', () => {
    expect(getUsageModelKey(' Expert ')).toBe('expert');
    expect(getUsageModelLabel('EXPERT')).toBe('DeepSeek Expert');
    expect(getUsageModelLabel('Vision')).toBe('DeepSeek Vision');
    expect(getUsageModelLabel('custom-x')).toBe('custom-x');
  });
});

describe('model share and heatmap level', () => {
  const now = new Date(2026, 5, 18, 12).getTime();

  it('assigns proportional share and zero share when total is zero', () => {
    const summary = summarizeUsage([
      makeRecord({ id: 'a', recordedAt: now, totalTokens: 100, modelType: 'expert', chatSessionId: 'a' }),
      makeRecord({ id: 'b', recordedAt: now, totalTokens: 300, modelType: 'vision', chatSessionId: 'b' }),
    ], { rangeDays: 7, now });
    const shares = Object.fromEntries(summary.modelUsage.map((m) => [m.modelKey, m.share]));
    expect(shares.expert).toBeCloseTo(0.25, 5);
    expect(shares.vision).toBeCloseTo(0.75, 5);

    const empty = summarizeUsage([], { rangeDays: 7, now });
    expect(empty.modelUsage).toEqual([]);
  });

  it('marks every heatmap cell level 0 when there is no usage', () => {
    const summary = summarizeUsage([], { rangeDays: 7, now });
    expect(summary.heatmap.every((cell) => cell.level === 0)).toBe(true);
  });
});

describe('dayKeyToTimestamp', () => {
  it('parses a valid day and returns 0 for malformed input', () => {
    expect(dayKeyToTimestamp('2026-06-18')).toBe(new Date(2026, 5, 18).getTime());
    expect(dayKeyToTimestamp('garbage')).toBe(0);
    expect(dayKeyToTimestamp('')).toBe(0);
  });
});
