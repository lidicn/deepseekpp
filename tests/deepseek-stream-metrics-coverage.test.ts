import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createResponseTokenSpeedTracker,
  shouldIgnoreEmptyTokenSpeedProgress,
  type ResponseTokenSpeedPayload,
} from '../core/deepseek/stream-metrics';

// T13: 只补 token-speed.test.ts 未覆盖的边界，不重复 requestId 主链路。
function createProgress(overrides: Partial<ResponseTokenSpeedPayload> = {}): ResponseTokenSpeedPayload {
  return {
    requestId: undefined,
    chatSessionId: null,
    assistantMessageId: null,
    active: false,
    estimatedTokens: 0,
    accumulatedTokens: null,
    tokensPerSecond: 0,
    elapsedMs: 0,
    textLength: 0,
    tokenSource: 'estimated',
    speedSource: 'estimated',
    modelType: null,
    ...overrides,
  };
}

describe('shouldIgnoreEmptyTokenSpeedProgress · id 分支补漏', () => {
  it('ignores an empty repeat keyed by assistantMessageId when requestId is absent', () => {
    const previous = createProgress({ assistantMessageId: 7, estimatedTokens: 24, textLength: 80, active: true });
    const repeat = createProgress({ assistantMessageId: 7, estimatedTokens: 0, textLength: 0, active: true });
    expect(shouldIgnoreEmptyTokenSpeedProgress(repeat, previous)).toBe(true);
  });

  it('does not ignore an empty frame for a different assistantMessageId', () => {
    const previous = createProgress({ assistantMessageId: 7, estimatedTokens: 24, textLength: 80, active: true });
    const repeat = createProgress({ assistantMessageId: 9, estimatedTokens: 0, textLength: 0, active: true });
    expect(shouldIgnoreEmptyTokenSpeedProgress(repeat, previous)).toBe(false);
  });

  it('falls back to chatSessionId when both requestId and assistantMessageId are absent', () => {
    const previous = createProgress({ chatSessionId: 'sess-1', estimatedTokens: 24, textLength: 80, active: true });
    const repeat = createProgress({ chatSessionId: 'sess-1', estimatedTokens: 0, textLength: 0, active: true });
    expect(shouldIgnoreEmptyTokenSpeedProgress(repeat, previous)).toBe(true);
  });

  it('does not ignore an empty frame for a different chatSessionId fallback', () => {
    const previous = createProgress({ chatSessionId: 'sess-1', estimatedTokens: 24, textLength: 80, active: true });
    const repeat = createProgress({ chatSessionId: 'sess-2', estimatedTokens: 0, textLength: 0, active: true });
    expect(shouldIgnoreEmptyTokenSpeedProgress(repeat, previous)).toBe(false);
  });

  it('does not ignore an empty frame when the previous progress was also empty', () => {
    const previous = createProgress({ estimatedTokens: 0, textLength: 0 });
    const repeat = createProgress({ requestId: 'r1', estimatedTokens: 0, textLength: 0, active: true });
    expect(shouldIgnoreEmptyTokenSpeedProgress(repeat, previous)).toBe(false);
  });

  it('does not suppress a non-empty progress frame even within the same request', () => {
    const previous = createProgress({ requestId: 'r1', estimatedTokens: 24, textLength: 80, active: true });
    const next = createProgress({ requestId: 'r1', estimatedTokens: 30, textLength: 96, active: true });
    expect(shouldIgnoreEmptyTokenSpeedProgress(next, previous)).toBe(false);
  });
});

describe('createResponseTokenSpeedTracker · finish 幂等与收尾闸门', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function setupTracker() {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const payloads: ResponseTokenSpeedPayload[] = [];
    const tracker = createResponseTokenSpeedTracker((p) => payloads.push(p), 250);
    return {
      tracker,
      payloads,
      advanceTo(ms: number) {
        now = ms;
      },
    };
  }

  it('marks the terminal frame active:false on finish()', () => {
    const { tracker, payloads } = setupTracker();
    tracker.finish();
    const terminal = payloads[payloads.length - 1];
    expect(terminal.active).toBe(false);
  });

  it('finish() is idempotent: a second finish() emits no extra frame and does not throw', () => {
    const { tracker, payloads } = setupTracker();
    tracker.finish();
    const afterFirst = payloads.length;
    expect(() => tracker.finish()).not.toThrow();
    expect(payloads.length).toBe(afterFirst);
    expect(payloads[payloads.length - 1].active).toBe(false);
  });

  it('blocks ordinary append() progress frames after finish()', () => {
    const { tracker, payloads, advanceTo } = setupTracker();
    tracker.finish();
    const afterFinish = payloads.length;
    advanceTo(5000);
    tracker.append('late text that arrived after finish');
    expect(payloads.length).toBe(afterFinish);
  });

  it('still emits a terminal frame when late server stats arrive after finish()', () => {
    const { tracker, payloads } = setupTracker();
    tracker.finish();
    const beforeLate = payloads.length;
    tracker.updateServerStats({ accumulatedTokenUsage: 128, updatedAt: 1.5 });
    expect(payloads.length).toBeGreaterThan(beforeLate);
    const late = payloads[payloads.length - 1];
    expect(late.active).toBe(false);
    expect(late.accumulatedTokens).toBe(128);
  });

  it('ignores null/undefined server stats without emitting', () => {
    const { tracker, payloads } = setupTracker();
    const before = payloads.length;
    tracker.updateServerStats(null);
    tracker.updateServerStats(undefined);
    expect(payloads.length).toBe(before);
  });
});
