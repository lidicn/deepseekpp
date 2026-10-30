/**
 * 出站请求并发观测守卫（2.3）。
 *
 * 变异（可判红）：
 *   - `concurrent` 过滤条件去掉会话判断 ⇒ 用例 3 红（不同会话被误判并发）
 *   - `end()` 不移除 ⇒ 用例 2 红
 */
import { describe, expect, it } from 'vitest';
import {
  createRequestActivityTracker,
  formatConcurrentRequest,
} from '../core/deepseek/request-activity';

describe('request-activity · 并发观测', () => {
  it('★ 同一会话上第二个请求开始 ⇒ 报告并发', () => {
    const t = createRequestActivityTracker();
    t.begin({ requestId: 'a', chatSessionId: 's1', source: 'page', now: 1 });
    const second = t.begin({ requestId: 'b', chatSessionId: 's1', source: 'agent', now: 2 });
    expect(second.concurrent.map((x) => x.source)).toEqual(['page']);
  });

  it('★ end 之后不再算并发', () => {
    const t = createRequestActivityTracker();
    t.begin({ requestId: 'a', chatSessionId: 's1', source: 'page', now: 1 });
    t.end('a');
    const second = t.begin({ requestId: 'b', chatSessionId: 's1', source: 'agent', now: 2 });
    expect(second.concurrent).toEqual([]);
  });

  it('负控：不同会话互不影响', () => {
    const t = createRequestActivityTracker();
    t.begin({ requestId: 'a', chatSessionId: 's1', source: 'page', now: 1 });
    const other = t.begin({ requestId: 'b', chatSessionId: 's2', source: 'agent', now: 2 });
    expect(other.concurrent).toEqual([]);
  });

  it('负控：会话未知（null）时按同一桶处理（宁可多报，不漏报）', () => {
    const t = createRequestActivityTracker();
    t.begin({ requestId: 'a', chatSessionId: null, source: 'page', now: 1 });
    const second = t.begin({ requestId: 'b', chatSessionId: null, source: 'memory', now: 2 });
    expect(second.concurrent).toHaveLength(1);
  });

  it('★ 诊断文本含 self/others/session，便于事后取证', () => {
    const t = createRequestActivityTracker();
    const first = t.begin({ requestId: 'a', chatSessionId: 's1', source: 'page', now: 1 });
    const second = t.begin({ requestId: 'b', chatSessionId: 's1', source: 'agent', now: 2 });
    const line = formatConcurrentRequest(second.entry, second.concurrent);
    expect(line).toContain('self=agent');
    expect(line).toContain('session=s1');
    expect(line).toContain('others=1');
    expect(first.entry.source).toBe('page');
  });

  it('负控：reset 清空', () => {
    const t = createRequestActivityTracker();
    t.begin({ requestId: 'a', chatSessionId: 's1' });
    t.reset();
    expect(t.snapshot()).toEqual([]);
  });
});
