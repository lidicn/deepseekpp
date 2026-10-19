import { describe, it, expect } from 'vitest';
import {
  formatTransitionIssues,
  verifyTransitions,
  type TransitionSpec,
} from '../core/state-machine/verify';

const SPEC: TransitionSpec = {
  states: ['idle', 'running', 'done', 'failed'],
  transitions: [
    { from: 'idle', to: 'running' },
    { from: 'running', to: 'done' },
    { from: 'running', to: 'failed' },
    { from: 'failed', to: 'running' },
  ],
};

describe('verifyTransitions (W33)', () => {
  it('观察到的转移全部已声明且无冗余 → 空问题', () => {
    const observed = [
      { from: 'idle', to: 'running' },
      { from: 'running', to: 'done' },
    ];
    // 注意：running->failed、failed->running 未观察，会报 unobserved；
    // 用完整覆盖 spec 的观察集验证全匹配。
    const full = [
      { from: 'idle', to: 'running' },
      { from: 'running', to: 'done' },
      { from: 'running', to: 'failed' },
      { from: 'failed', to: 'running' },
    ];
    expect(verifyTransitions(SPEC, full)).toEqual([]);
    expect(verifyTransitions(SPEC, observed).some((i) => i.kind === 'undeclared')).toBe(false);
  });

  it('观察到 spec 未声明的转移 → 报 undeclared', () => {
    const issues = verifyTransitions(SPEC, [
      { from: 'idle', to: 'running' },
      { from: 'done', to: 'running' }, // 未声明
    ]);
    const undeclared = issues.filter((i) => i.kind === 'undeclared');
    expect(undeclared).toHaveLength(1);
    expect(undeclared[0]).toMatchObject({ from: 'done', to: 'running' });
    expect(formatTransitionIssues(issues)).toContain('undeclared: done->running');
  });

  it('spec 声明但从未观察到的转移 → 报 unobserved', () => {
    const issues = verifyTransitions(SPEC, [
      { from: 'idle', to: 'running' },
      { from: 'running', to: 'done' },
    ]);
    const unobserved = issues.filter((i) => i.kind === 'unobserved');
    const keys = unobserved.map((i) => `${i.from}->${i.to}`);
    expect(keys).toContain('running->failed');
    expect(keys).toContain('failed->running');
  });

  it('引用 spec.states 之外的状态 → 报 unknown-state（不报 undeclared）', () => {
    const issues = verifyTransitions(SPEC, [
      { from: 'idle', to: 'running' },
      { from: 'running', to: 'ghost' },
    ]);
    const unknown = issues.filter((i) => i.kind === 'unknown-state');
    expect(unknown).toHaveLength(1);
    expect(unknown[0].to).toBe('ghost');
    expect(issues.some((i) => i.kind === 'undeclared' && i.to === 'ghost')).toBe(false);
  });

  it('空 spec + 空 observed → 空问题（边界）', () => {
    expect(verifyTransitions({ states: [], transitions: [] }, [])).toEqual([]);
  });
});
