import { describe, it, expect } from 'vitest';
import {
  createJob,
  transitionJob,
  resumeJob,
  isResumable,
  canTransition,
  type ToolJob,
} from '../core/tool/job';

const mockCall = { id: 'call-1', name: 'shell_exec', payload: { command: 'ls' }, raw: '{}' };

describe('ToolJob 状态机', () => {
  it('createJob 初始状态 pending', () => {
    const job = createJob({
      id: 'job-1',
      turnId: 'turn-1',
      parentMessageId: null,
      calls: [mockCall],
    });
    expect(job.state).toBe('pending');
    expect(job.position).toEqual({ callIndex: 0, depth: 0 });
    expect(job.attempt).toBe(0);
  });

  it('pending → running 合法', () => {
    const job = createJob({ id: 'j', turnId: 't', parentMessageId: null, calls: [] });
    expect(canTransition('pending', 'running')).toBe(true);
  });

  it('running → succeeded 合法', () => {
    expect(canTransition('running', 'succeeded')).toBe(true);
  });

  it('running → interrupted 合法', () => {
    expect(canTransition('running', 'interrupted')).toBe(true);
  });

  it('interrupted → resumed 合法', () => {
    expect(canTransition('interrupted', 'resumed')).toBe(true);
  });

  it('succeeded → 任何状态非法', () => {
    expect(canTransition('succeeded', 'running')).toBe(false);
    expect(canTransition('succeeded', 'interrupted')).toBe(false);
  });

  it('transitionJob 非法转移抛错', () => {
    const job = createJob({ id: 'j', turnId: 't', parentMessageId: null, calls: [] });
    expect(() => transitionJob(job, 'succeeded')).toThrow();
  });

  it('resumeJob 从 interrupted 恢复并 +1 attempt', () => {
    let job = createJob({ id: 'j', turnId: 't', parentMessageId: null, calls: [mockCall] });
    job = transitionJob(job, 'running');
    job = transitionJob(job, 'interrupted');
    job = resumeJob(job);
    expect(job.state).toBe('resumed');
    expect(job.attempt).toBe(1);
  });

  it('isResumable: interrupted 且 calls 未执行完', () => {
    let job = createJob({ id: 'j', turnId: 't', parentMessageId: null, calls: [mockCall, mockCall] });
    job = transitionJob(job, 'running');
    job = transitionJob(job, 'interrupted');
    expect(isResumable(job)).toBe(true);
  });

  it('isResumable: interrupted 但 calls 已执行完', () => {
    let job = createJob({ id: 'j', turnId: 't', parentMessageId: null, calls: [mockCall] });
    job = transitionJob(job, 'running');
    job.position.callIndex = 1; // 全部执行完
    job = transitionJob(job, 'interrupted');
    expect(isResumable(job)).toBe(false);
  });
});
