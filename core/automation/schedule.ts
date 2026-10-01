import type { AutomationSchedule } from './types';

export const DEFAULT_MINIMUM_INTERVAL_MINUTES = 15;
// Lookahead window must span at least one full leap cycle (4 years) so legal
// but rare expressions like `0 9 29 2 *` resolve instead of being rejected.
// With the field-carry solver (findNextCronRun) this window is scanned in a
// bounded number of calendar jumps, not per-minute, so widening it is cheap.
export const MAX_CRON_LOOKAHEAD_DAYS = 1500;

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

type RRuleFrequency = 'MINUTELY' | 'HOURLY' | 'DAILY';

interface ParsedCronField {
  values: Set<number>;
  wildcard: boolean;
}

interface ParsedCron {
  minute: ParsedCronField;
  hour: ParsedCronField;
  dayOfMonth: ParsedCronField;
  month: ParsedCronField;
  dayOfWeek: ParsedCronField;
}

interface ParsedRRule {
  frequency: RRuleFrequency;
  interval: number;
  intervalMinutes: number;
}

export type ParsedAutomationSchedule =
  | { kind: 'manual'; timezone: string }
  | { kind: 'cron'; expression: string; timezone: string; cron: ParsedCron }
  | { kind: 'rrule'; expression: string; timezone: string; rrule: ParsedRRule };

export interface ScheduleError {
  code: string;
  message: string;
}

export type ScheduleResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ScheduleError };

type ScheduleFailure = { ok: false; error: ScheduleError };

export interface ScheduleCalculationOptions {
  minimumIntervalMinutes?: number;
  maxLookaheadDays?: number;
}

export function parseAutomationSchedule(
  schedule: AutomationSchedule,
): ScheduleResult<ParsedAutomationSchedule> {
  const timezone = schedule.timezone || 'UTC';
  if (!isValidTimeZone(timezone)) {
    return error('invalid_timezone', `Invalid schedule timezone: ${timezone}`);
  }

  if (!schedule.enabled || schedule.kind === 'manual') {
    return { ok: true, value: { kind: 'manual', timezone } };
  }

  const expression = schedule.expression?.trim();
  if (!expression) {
    return error('missing_expression', 'Schedule expression is required.');
  }

  if (schedule.kind === 'rrule') {
    const parsed = parseRRule(expression);
    if (isScheduleFailure(parsed)) return failure(parsed);
    return {
      ok: true,
      value: {
        kind: 'rrule',
        expression,
        timezone,
        rrule: parsed.value,
      },
    };
  }

  if (schedule.kind === 'cron') {
    const parsed = parseCron(expression);
    if (isScheduleFailure(parsed)) return failure(parsed);
    return {
      ok: true,
      value: {
        kind: 'cron',
        expression,
        timezone,
        cron: parsed.value,
      },
    };
  }

  return error('unsupported_schedule', `Unsupported schedule kind: ${schedule.kind}`);
}

export function calculateNextRunAt(
  schedule: AutomationSchedule,
  referenceAt: number,
  options: ScheduleCalculationOptions = {},
): ScheduleResult<number | null> {
  const parsed = parseAutomationSchedule(schedule);
  if (isScheduleFailure(parsed)) return failure(parsed);
  if (parsed.value.kind === 'manual') return { ok: true, value: null };

  const minimumIntervalMinutes = resolveMinimumIntervalMinutes(
    schedule.minimumIntervalMinutes,
    options.minimumIntervalMinutes,
  );

  if (parsed.value.kind === 'rrule') {
    if (parsed.value.rrule.intervalMinutes < minimumIntervalMinutes) {
      return error(
        'schedule_too_frequent',
        `Schedule interval must be at least ${minimumIntervalMinutes} minutes.`,
      );
    }
    return {
      ok: true,
      value: referenceAt + parsed.value.rrule.intervalMinutes * MINUTE_MS,
    };
  }

  const first = findNextCronRun(parsed.value.cron, parsed.value.timezone, referenceAt, options);
  if (isScheduleFailure(first)) return failure(first);
  if (first.value == null) return first;

  const second = findNextCronRun(parsed.value.cron, parsed.value.timezone, first.value, options);
  if (!isScheduleFailure(second) && second.value != null) {
    const gapMinutes = (second.value - first.value) / MINUTE_MS;
    if (gapMinutes < minimumIntervalMinutes) {
      return error(
        'schedule_too_frequent',
        `Schedule interval must be at least ${minimumIntervalMinutes} minutes.`,
      );
    }
  }

  return first;
}

export function validateAutomationSchedule(
  schedule: AutomationSchedule,
  referenceAt: number = Date.now(),
  options: ScheduleCalculationOptions = {},
): ScheduleResult<ParsedAutomationSchedule> {
  const parsed = parseAutomationSchedule(schedule);
  if (isScheduleFailure(parsed)) return failure(parsed);
  const next = calculateNextRunAt(schedule, referenceAt, options);
  if (isScheduleFailure(next)) return failure(next);
  return parsed;
}

function parseRRule(expression: string): ScheduleResult<ParsedRRule> {
  const normalized = expression.replace(/^RRULE:/i, '');
  const parts = new Map<string, string>();

  for (const part of normalized.split(';')) {
    const [rawKey, rawValue] = part.split('=');
    const key = rawKey?.trim().toUpperCase();
    const value = rawValue?.trim().toUpperCase();
    if (!key || !value) {
      return error('invalid_rrule', 'RRULE parts must use KEY=VALUE format.');
    }
    parts.set(key, value);
  }

  const frequency = parts.get('FREQ');
  if (!isRRuleFrequency(frequency)) {
    return error('invalid_rrule_frequency', 'RRULE FREQ must be MINUTELY, HOURLY, or DAILY.');
  }

  const intervalRaw = parts.get('INTERVAL') ?? '1';
  const interval = parseStrictInteger(intervalRaw);
  if (interval === undefined || interval < 1) {
    return error('invalid_rrule_interval', 'RRULE INTERVAL must be a positive integer.');
  }

  const unsupported = [...parts.keys()].filter((key) => key !== 'FREQ' && key !== 'INTERVAL');
  if (unsupported.length > 0) {
    return error('unsupported_rrule_part', `Unsupported RRULE part: ${unsupported.join(', ')}.`);
  }

  return {
    ok: true,
    value: {
      frequency,
      interval,
      intervalMinutes: intervalToMinutes(frequency, interval),
    },
  };
}

function parseCron(expression: string): ScheduleResult<ParsedCron> {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    return error('invalid_cron', 'Cron expression must have 5 fields.');
  }

  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
  const parsedMinute = parseCronField(minute, 0, 59);
  const parsedHour = parseCronField(hour, 0, 23);
  const parsedDayOfMonth = parseCronField(dayOfMonth, 1, 31);
  const parsedMonth = parseCronField(month, 1, 12);
  const parsedDayOfWeek = parseCronField(dayOfWeek, 0, 7, normalizeDayOfWeek);

  if (isScheduleFailure(parsedMinute)) return failure(parsedMinute);
  if (isScheduleFailure(parsedHour)) return failure(parsedHour);
  if (isScheduleFailure(parsedDayOfMonth)) return failure(parsedDayOfMonth);
  if (isScheduleFailure(parsedMonth)) return failure(parsedMonth);
  if (isScheduleFailure(parsedDayOfWeek)) return failure(parsedDayOfWeek);

  return {
    ok: true,
    value: {
      minute: parsedMinute.value,
      hour: parsedHour.value,
      dayOfMonth: parsedDayOfMonth.value,
      month: parsedMonth.value,
      dayOfWeek: parsedDayOfWeek.value,
    },
  };
}

function parseCronField(
  field: string,
  min: number,
  max: number,
  normalize: (value: number) => number = (value) => value,
): ScheduleResult<ParsedCronField> {
  const values = new Set<number>();
  const wildcard = field === '*' || field === '?';

  for (const token of field.split(',')) {
    const parsed = parseCronToken(token.trim(), min, max);
    if (isScheduleFailure(parsed)) return failure(parsed);
    for (let value = parsed.value.start; value <= parsed.value.end; value += parsed.value.step) {
      values.add(normalize(value));
    }
  }

  if (values.size === 0) {
    return error('invalid_cron_field', `Cron field "${field}" does not select any values.`);
  }

  return { ok: true, value: { values, wildcard } };
}

function parseCronToken(
  token: string,
  min: number,
  max: number,
): ScheduleResult<{ start: number; end: number; step: number }> {
  if (!token) return error('invalid_cron_field', 'Cron field contains an empty token.');

  const [rangePart, stepPart] = token.split('/');
  const step = stepPart == null ? 1 : parseStrictInteger(stepPart);
  if (step === undefined || step < 1) {
    return error('invalid_cron_step', `Invalid cron step "${stepPart}".`);
  }

  if (rangePart === '*' || rangePart === '?') {
    return { ok: true, value: { start: min, end: max, step } };
  }

  const [startRaw, endRaw] = rangePart.split('-');
  const start = parseStrictInteger(startRaw);
  const end = endRaw == null ? start : parseStrictInteger(endRaw);

  if (
    start === undefined
    || end === undefined
    || start < min
    || end > max
    || start > end
  ) {
    return error('invalid_cron_range', `Invalid cron range "${rangePart}".`);
  }

  return { ok: true, value: { start, end, step } };
}

function findNextCronRun(
  cron: ParsedCron,
  timezone: string,
  referenceAt: number,
  options: ScheduleCalculationOptions,
): ScheduleResult<number | null> {
  const maxLookaheadMs = (options.maxLookaheadDays ?? MAX_CRON_LOOKAHEAD_DAYS) * DAY_MS;
  const endAt = referenceAt + maxLookaheadMs;
  const start = zonedPartsOf(referenceAt, timezone);

  // Day-level scan over the local calendar. Date-field matching (month,
  // day-of-month, day-of-week) uses pure integer arithmetic off a UTC epoch-day
  // counter, so rare expressions (e.g. `0 9 29 2 *`) skip ~1460 non-matching
  // days without touching Intl. Only a date-matching day pays the two-pass
  // local->UTC wall-clock conversion. This replaces the previous per-minute
  // brute force (up to 532800 iterations, each rebuilding a formatter).
  const startEpochDay = Math.floor(Date.UTC(start.year, start.month - 1, start.day) / DAY_MS);
  const maxDays = Math.ceil(maxLookaheadMs / DAY_MS) + 1;

  for (let offset = 0; offset <= maxDays; offset++) {
    const epochDay = startEpochDay + offset;
    if (offset > 0 && epochDay * DAY_MS > endAt + DAY_MS) {
      break;
    }
    const dayUtc = new Date(epochDay * DAY_MS);
    const year = dayUtc.getUTCFullYear();
    const month = dayUtc.getUTCMonth() + 1;
    const dayOfMonth = dayUtc.getUTCDate();
    const dayOfWeek = dayUtc.getUTCDay();

    if (!cron.month.values.has(month)) continue;
    if (!matchesCronDay(cron, dayOfMonth, dayOfWeek)) continue;

    for (const hour of sortedValues(cron.hour.values)) {
      for (const minute of sortedValues(cron.minute.values)) {
        const candidate = wallToUtc(timezone, year, month, dayOfMonth, hour, minute);
        if (candidate > referenceAt && candidate <= endAt) {
          return { ok: true, value: candidate };
        }
      }
    }
  }

  return error('cron_no_next_run', 'No cron run was found within the lookahead window.');
}

function matchesCronDay(cron: ParsedCron, dayOfMonth: number, dayOfWeek: number): boolean {
  const dayOfMonthMatches = cron.dayOfMonth.values.has(dayOfMonth);
  const dayOfWeekMatches = cron.dayOfWeek.values.has(dayOfWeek);
  if (!cron.dayOfMonth.wildcard && !cron.dayOfWeek.wildcard) {
    return dayOfMonthMatches || dayOfWeekMatches;
  }
  return dayOfMonthMatches && dayOfWeekMatches;
}

function sortedValues(values: Set<number>): number[] {
  return [...values].sort((a, b) => a - b);
}

interface ZonedWallParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function zonedFormatter(timezone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timezone);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    hourCycle: 'h23',
  });
  formatterCache.set(timezone, formatter);
  return formatter;
}

function zonedPartsOf(timestamp: number, timezone: string): ZonedWallParts {
  const parts = Object.fromEntries(
    zonedFormatter(timezone)
      .formatToParts(new Date(timestamp))
      .map((part) => [part.type, part.value]),
  );

  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    weekday: weekdayToNumber(parts.weekday),
  };
}

/**
 * Resolve a local wall-clock time in `timezone` to a UTC instant. Two-pass
 * offset correction converges for normal zones; a local time that does not
 * exist (DST spring-forward) resolves to the post-transition instant and one
 * that occurs twice (fall-back) resolves to the first — the documented DST
 * limitation for cron scheduling.
 */
function wallToUtc(
  timezone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): number {
  const asUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
  let instant = asUtc - zonedOffsetAt(timezone, asUtc);
  instant = asUtc - zonedOffsetAt(timezone, instant);
  return instant;
}

function zonedOffsetAt(timezone: string, timestamp: number): number {
  const parts = zonedPartsOf(timestamp, timezone);
  const wallAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0);
  return wallAsUtc - Math.floor(timestamp / MINUTE_MS) * MINUTE_MS;
}

function isRRuleFrequency(value: string | undefined): value is RRuleFrequency {
  return value === 'MINUTELY' || value === 'HOURLY' || value === 'DAILY';
}

function intervalToMinutes(frequency: RRuleFrequency, interval: number): number {
  if (frequency === 'MINUTELY') return interval;
  if (frequency === 'HOURLY') return interval * 60;
  return interval * 24 * 60;
}

function normalizeDayOfWeek(value: number): number {
  return value === 7 ? 0 : value;
}

function weekdayToNumber(value: string | undefined): number {
  switch (value) {
    case 'Sun':
      return 0;
    case 'Mon':
      return 1;
    case 'Tue':
      return 2;
    case 'Wed':
      return 3;
    case 'Thu':
      return 4;
    case 'Fri':
      return 5;
    case 'Sat':
      return 6;
    default:
      return 0;
  }
}

function isValidTimeZone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

// Number.parseInt("5abc") silently yields 5, accepting malformed cron/RRULE
// tokens. Require the whole token to be decimal digits before parsing.
function parseStrictInteger(raw: string): number | undefined {
  if (!/^\d+$/.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : undefined;
}

function resolveMinimumIntervalMinutes(
  scheduleMinimum: number | undefined,
  optionMinimum: number | undefined,
): number {
  // Math.max(15, undefined, 0) returns NaN, which makes every `gap < min`
  // guard silently false. Only fold in finite numbers, and always keep the
  // default floor.
  let maximum = DEFAULT_MINIMUM_INTERVAL_MINUTES;
  for (const candidate of [scheduleMinimum, optionMinimum]) {
    if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate > maximum) {
      maximum = candidate;
    }
  }
  return maximum;
}

function error<T = never>(code: string, message: string): ScheduleResult<T> {
  return { ok: false, error: { code, message } };
}

function failure<T>(result: ScheduleFailure): ScheduleResult<T> {
  return { ok: false, error: result.error };
}

function isScheduleFailure<T>(result: ScheduleResult<T>): result is ScheduleFailure {
  return result.ok === false;
}
