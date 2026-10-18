import { describe, it, expect } from 'vitest';
import { rebuildJobFromMarker, resolveResumeIndex, alignExecutions } from '../core/chat/resume-runner';
import type { ActiveChatLoop } from '../core/chat/active-loop';

const baseMarker: ActiveChatLoop = {
  active: true,
  startedAt: Date.now() - 1000,
  provider: 'web',
  executions: [],
  currentTool: null,
  schemaVersion: 1,
  revision: 1,
  turnId: 'test-turn',
  jobId: 'test-job',
  jobState: 'running',
  calls: [{ name: 'search', payload: {}, raw: '{}' }],
  position: { callIndex: 0, depth: 0 },
  parentMessageId: 12345,
  chatSessionId: 'test-session',
  attempt: 0,
  lastUpsertAt: Date.now() - 1000,
  resumeDeadline: Date.now() + 600_000,
};

describe('rebuildJobFromMarker', () => {
  it('v1 合法 marker 重建成功', () => {
    const result = rebuildJobFromMarker(baseMarker, Date.now());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.job.id).toBe('test-job');
      expect(result.job.turnId).toBe('test-turn');
      expect(result.job.state).toBe('interrupted');
    }
  });

  it('v0 旧 marker 拒绝', () => {
    const m = { ...baseMarker, schemaVersion: 0 };
    const result = rebuildJobFromMarker(m, Date.now());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('marker_v0');
  });

  it('official-api 拒绝', () => {
    const m = { ...baseMarker, provider: 'official-api' as const };
    const result = rebuildJobFromMarker(m, Date.now());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('provider_not_resumable');
  });

  it('超 TTL 拒绝', () => {
    const m = { ...baseMarker, resumeDeadline: Date.now() - 1000 };
    const result = rebuildJobFromMarker(m, Date.now());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('deadline_expired');
  });

  it('parentMessageId null 拒绝', () => {
    const m = { ...baseMarker, parentMessageId: null };
    const result = rebuildJobFromMarker(m, Date.now());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('no_parent_message');
  });

  it('calls 空 拒绝', () => {
    const m = { ...baseMarker, calls: [] };
    const result = rebuildJobFromMarker(m, Date.now());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('no_calls');
  });
});

describe('resolveResumeIndex', () => {
  it('无执行 → resumeIndex=0', () => {
    const job = {
      ...baseMarker,
      calls: [{ name: 'a', payload: {}, raw: '{}' }],
      executions: [],
      position: { callIndex: 0, depth: 0 },
      state: 'interrupted' as const,
      attempt: 0,
      startedAt: Date.now() - 1000,
    };
    const result = resolveResumeIndex(job, baseMarker);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.cursor.resumeIndex).toBe(0);
  });

  it('水位线权威', () => {
    const job = {
      ...baseMarker,
      calls: [{ name: 'a', payload: {}, raw: '{}' }, { name: 'b', payload: {}, raw: '{}' }],
      executions: [{ name: 'a', result: { ok: true, summary: '' } }],
      position: { callIndex: 1, depth: 0 },
      state: 'interrupted' as const,
      attempt: 0,
      startedAt: Date.now() - 1000,
    };
    const result = resolveResumeIndex(job, baseMarker);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.cursor.resumeIndex).toBe(1);
  });

  it('in-flight 默认 synthesize', () => {
    const marker = { ...baseMarker, currentTool: { name: 'b', startedAt: Date.now() } };
    const job = {
      ...baseMarker,
      calls: [{ name: 'a', payload: {}, raw: '{}' }, { name: 'b', payload: {}, raw: '{}' }],
      executions: [{ name: 'a', result: { ok: true, summary: '' } }],
      position: { callIndex: 1, depth: 0 },
      state: 'interrupted' as const,
      attempt: 0,
      startedAt: Date.now() - 1000,
    };
    const result = resolveResumeIndex(job, marker);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.cursor.resumeIndex).toBe(2);
      expect(result.cursor.synthesized).toBeDefined();
    }
  });
});

describe('alignExecutions', () => {
  it('前缀对齐', () => {
    const calls = [
      { name: 'a', payload: {}, raw: '{}' },
      { name: 'b', payload: {}, raw: '{}' },
    ];
    const executions = [
      { name: 'a', result: { ok: true, summary: '' } },
      { name: 'b', result: { ok: true, summary: '' } },
    ];
    expect(alignExecutions(calls, executions)).toBe(2);
  });

  it('部分对齐', () => {
    const calls = [
      { name: 'a', payload: {}, raw: '{}' },
      { name: 'b', payload: {}, raw: '{}' },
    ];
    const executions = [{ name: 'a', result: { ok: true, summary: '' } }];
    expect(alignExecutions(calls, executions)).toBe(1);
  });
});
