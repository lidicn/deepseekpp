/**
 * 串行化守卫（2.3）。
 *
 * 变异（可判红）：
 *   - 允许 `page` 请求等待 ⇒ 用例 2 红（页面被延迟是绝对不允许的）
 *   - 去掉 timeout-proceed ⇒ 用例 4 红（agent 会被永久卡住）
 *   - 不看 `activeOnSameSession` 里是否有 page ⇒ 用例 3 红（无谓等待）
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SERIALIZER_MAX_WAIT_MS,
  SERIALIZER_POLL_MS,
  decideSerialization,

    awaitRequestSlot,
  resolveSerializerMaxWaitMs,
} from '../core/deepseek/request-serializer';
import type { RequestActivityEntry } from '../core/deepseek/request-activity';

const pageEntry: RequestActivityEntry = {
  requestId: 'p',
  chatSessionId: 's1',
  parentMessageId: null,
  source: 'page',
  startedAt: 1,
};
const agentEntry: RequestActivityEntry = {
  requestId: 'a',
  chatSessionId: 's1',
  parentMessageId: null,
  source: 'agent',
  startedAt: 2,
};

describe('decideSerialization', () => {
  it('★ 没有并发 ⇒ proceed', () => {
    expect(
      decideSerialization({
        selfSource: 'agent',
        activeOnSameSession: [],
        waitedMs: 0,
        maxWaitMs: DEFAULT_SERIALIZER_MAX_WAIT_MS,
      }),
    ).toEqual({ action: 'proceed' });
  });

  it('★★ 页面请求永不等待（即使同会话有别的请求在飞）', () => {
    expect(
      decideSerialization({
        selfSource: 'page',
        activeOnSameSession: [agentEntry],
        waitedMs: 0,
        maxWaitMs: DEFAULT_SERIALIZER_MAX_WAIT_MS,
      }),
    ).toEqual({ action: 'proceed' });
  });

  it('★ agent 请求遇到页面在飞 ⇒ wait（不超过轮询间隔）', () => {
    const decision = decideSerialization({
      selfSource: 'agent',
      activeOnSameSession: [pageEntry],
      waitedMs: 0,
      maxWaitMs: DEFAULT_SERIALIZER_MAX_WAIT_MS,
    });
    expect(decision.action).toBe('wait');
    if (decision.action === 'wait') expect(decision.waitMs).toBeLessThanOrEqual(SERIALIZER_POLL_MS);
  });

  it('★ 同会话只有别的 agent ⇒ 不等待', () => {
    expect(
      decideSerialization({
        selfSource: 'agent',
        activeOnSameSession: [agentEntry],
        waitedMs: 0,
        maxWaitMs: DEFAULT_SERIALIZER_MAX_WAIT_MS,
      }),
    ).toEqual({ action: 'proceed' });
  });

  it('★★ 等够上限 ⇒ timeout-proceed（绝不把 agent 卡死）', () => {
    expect(
      decideSerialization({
        selfSource: 'memory',
        activeOnSameSession: [pageEntry],
        waitedMs: DEFAULT_SERIALIZER_MAX_WAIT_MS,
        maxWaitMs: DEFAULT_SERIALIZER_MAX_WAIT_MS,
      }),
    ).toEqual({ action: 'timeout-proceed' });
  });

  it('负控：maxWaitMs=0 ⇒ 关闭，一律 proceed', () => {
    expect(
      decideSerialization({
        selfSource: 'agent',
        activeOnSameSession: [pageEntry],
        waitedMs: 0,
        maxWaitMs: 0,
      }),
    ).toEqual({ action: 'proceed' });
  });
});

describe('resolveSerializerMaxWaitMs（开关）', () => {
  it('★ 默认 5s；`0` 关闭；数字覆盖', () => {
    localStorage.removeItem('dpp:requestSerializer');
    expect(resolveSerializerMaxWaitMs()).toBe(DEFAULT_SERIALIZER_MAX_WAIT_MS);

    localStorage.setItem('dpp:requestSerializer', '0');
    expect(resolveSerializerMaxWaitMs()).toBe(0);

    localStorage.setItem('dpp:requestSerializer', '1234');
    expect(resolveSerializerMaxWaitMs()).toBe(1234);

    localStorage.removeItem('dpp:requestSerializer');
  });
});
describe('awaitRequestSlot（注入 sleep/clock）', () => {
  it('★ 页面请求在飞时等待，页面一结束就放行', async () => {
    let t = 0;
    const sleep = async (ms: number) => { t += ms; };
    let pageInFlight = true;
    const result = await awaitRequestSlot({
      selfSource: 'agent',
      activeOnSameSession: () => (pageInFlight ? [pageEntry] : []),
      maxWaitMs: 1_000,
      sleep,
      now: () => t,
    });
    // 永远在飞 ⇒ 到上限后 timeout-proceed
    expect(result.timedOut).toBe(true);
    expect(result.waitedMs).toBeGreaterThanOrEqual(1_000);

    pageInFlight = false;
    const quick = await awaitRequestSlot({
      selfSource: 'agent',
      activeOnSameSession: () => [],
      maxWaitMs: 1_000,
      sleep,
      now: () => t,
    });
    expect(quick).toEqual({ waitedMs: 0, timedOut: false });
  });

  it('★ 关闭（maxWaitMs=0）⇒ 立即放行', async () => {
    const result = await awaitRequestSlot({
      selfSource: 'agent',
      activeOnSameSession: () => [pageEntry],
      maxWaitMs: 0,
      sleep: async () => {},
      now: () => 0,
    });
    expect(result).toEqual({ waitedMs: 0, timedOut: false });
  });

  it('★ 页面请求本身永不等待', async () => {
    const result = await awaitRequestSlot({
      selfSource: 'page',
      activeOnSameSession: () => [agentEntry],
      maxWaitMs: 1_000,
      sleep: async () => {},
      now: () => 0,
    });
    expect(result).toEqual({ waitedMs: 0, timedOut: false });
  });
});
describe('页面请求永不等待（更强守卫）', () => {
  it('★★ 同会话有**另一个页面请求**在飞 ⇒ 页面请求仍 proceed', () => {
    expect(
      decideSerialization({
        selfSource: 'page',
        activeOnSameSession: [pageEntry, agentEntry],
        waitedMs: 0,
        maxWaitMs: DEFAULT_SERIALIZER_MAX_WAIT_MS,
      }),
    ).toEqual({ action: 'proceed' });
  });
});
describe('awaitRequestSlot 有界保护', () => {
  it('★★ 时钟冻结 + 页面一直在飞 ⇒ 必须终止（timedOut），绝不无限循环', async () => {
    const result = await awaitRequestSlot({
      selfSource: 'agent',
      activeOnSameSession: () => [pageEntry],
      maxWaitMs: 1_000,
      sleep: async () => {},
      now: () => 0,
    });
    expect(result.timedOut).toBe(true);
  });
});