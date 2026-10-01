import { describe, expect, it } from 'vitest';
import {
  calculateNextRunAt,
  parseAutomationSchedule,
  validateAutomationSchedule,
} from '../core/automation/schedule';
import type { AutomationSchedule } from '../core/automation/types';

function cronSchedule(expression: string, timezone = 'UTC'): AutomationSchedule {
  return {
    kind: 'cron',
    expression,
    timezone,
    enabled: true,
    minimumIntervalMinutes: 15,
  };
}

function rruleSchedule(expression: string): AutomationSchedule {
  return {
    kind: 'rrule',
    expression,
    timezone: 'UTC',
    enabled: true,
    minimumIntervalMinutes: 15,
  };
}

const REFERENCE = Date.UTC(2026, 0, 15, 12, 0, 0);

function zonedParts(timestamp: number, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(new Date(timestamp));
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
  };
}

describe('calculateNextRunAt cron solver', () => {
  it('resolves a common daily cron to the next matching local minute', () => {
    const result = calculateNextRunAt(cronSchedule('30 9 * * *', 'UTC'), REFERENCE);
    expect(result.ok).toBe(true);
    if (!result.ok || result.value == null) return;
    expect(result.value).toBeGreaterThan(REFERENCE);
    const parts = zonedParts(result.value, 'UTC');
    expect(parts.hour).toBe(9);
    expect(parts.minute).toBe(30);
    expect(parts.day).toBe(16);
  });

  it('runs the solver in bounded time instead of a per-minute brute force (F1)', () => {
    const started = performance.now();
    const result = calculateNextRunAt(cronSchedule('*/15 * * * *', 'UTC'), REFERENCE);
    const elapsed = performance.now() - started;
    expect(result.ok).toBe(true);
    // The old brute force spent ~25s on a rare/full-window scan; a correct
    // day-carry solver finishes a routine scan well under a second.
    expect(elapsed).toBeLessThan(50);
  });

  it('accepts a legal but rare leap-day cron beyond the old 370-day window (F3)', () => {
    // `0 9 29 2 *` next fires 2028-02-29 (2 leap years away, > 370 days).
    const from = Date.UTC(2026, 1, 1, 0, 0, 0);
    const result = calculateNextRunAt(cronSchedule('0 9 29 2 *', 'UTC'), from);
    expect(result.ok).toBe(true);
    if (!result.ok || result.value == null) return;
    const parts = zonedParts(result.value, 'UTC');
    expect(parts).toEqual({ year: 2028, month: 2, day: 29, hour: 9, minute: 0 });
    const daysAhead = (result.value - from) / 86_400_000;
    expect(daysAhead).toBeGreaterThan(370);
  });

  it('rejects an impossible cron quickly without a full-window freeze', () => {
    const started = performance.now();
    const result = calculateNextRunAt(cronSchedule('0 0 30 2 *', 'UTC'), REFERENCE);
    const elapsed = performance.now() - started;
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('cron_no_next_run');
    expect(elapsed).toBeLessThan(100);
  });

  it('respects a timezone offset for the local wall clock', () => {
    const timezone = 'Asia/Kolkata'; // UTC+05:30, no DST
    const result = calculateNextRunAt(cronSchedule('0 6 * * *', timezone), REFERENCE);
    expect(result.ok).toBe(true);
    if (!result.ok || result.value == null) return;
    const parts = zonedParts(result.value, timezone);
    expect(parts.hour).toBe(6);
    expect(parts.minute).toBe(0);
  });

  it('combines day-of-month and day-of-week with OR when both are restricted', () => {
    const result = calculateNextRunAt(cronSchedule('0 0 13 * 5', 'UTC'), REFERENCE);
    expect(result.ok).toBe(true);
    if (!result.ok || result.value == null) return;
    expect(result.value).toBeGreaterThan(REFERENCE);
  });
});

describe('calculateNextRunAt frequency guard', () => {
  it('flags an every-minute cron below the default minimum interval (F5 guard stays live)', () => {
    // A NaN-poisoned guard would let this pass; a correct guard rejects it.
    const result = calculateNextRunAt(cronSchedule('* * * * *', 'UTC'), REFERENCE);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('schedule_too_frequent');
  });

  it('treats an undefined schedule minimum as the default floor, not NaN (F5)', () => {
    const schedule = {
      kind: 'cron',
      expression: '*/10 * * * *',
      timezone: 'UTC',
      enabled: true,
    } as unknown as AutomationSchedule;
    const result = calculateNextRunAt(schedule, REFERENCE);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('schedule_too_frequent');
    expect(result.error.message).toContain('15 minutes');
  });

  it('computes an RRULE next run at the interval offset', () => {
    const result = calculateNextRunAt(rruleSchedule('RRULE:FREQ=DAILY;INTERVAL=1'), REFERENCE);
    expect(result.ok).toBe(true);
    if (!result.ok || result.value == null) return;
    expect(result.value).toBe(REFERENCE + 24 * 60 * 60_000);
  });
});

describe('schedule field validation', () => {
  it('rejects a cron token with trailing garbage instead of silently truncating (F4)', () => {
    const parsed = parseAutomationSchedule(cronSchedule('5abc * * * *', 'UTC'));
    expect(parsed.ok).toBe(false);
  });

  it('rejects a non-numeric RRULE interval (F4)', () => {
    const parsed = parseAutomationSchedule(rruleSchedule('RRULE:FREQ=MINUTELY;INTERVAL=2abc'));
    expect(parsed.ok).toBe(false);
  });

  it('accepts a well-formed cron expression', () => {
    expect(parseAutomationSchedule(cronSchedule('*/15 9-17 * * 1-5', 'UTC')).ok).toBe(true);
  });
});

describe('validateAutomationSchedule', () => {
  it('fails for an impossible cron', () => {
    const result = validateAutomationSchedule(cronSchedule('0 0 30 2 *', 'UTC'), REFERENCE);
    expect(result.ok).toBe(false);
  });

  it('passes for a valid daily cron', () => {
    expect(validateAutomationSchedule(cronSchedule('0 9 * * *', 'UTC'), REFERENCE).ok).toBe(true);
  });
});
