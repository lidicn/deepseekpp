/**
 * W33 状态机转移校验器（纯函数，零 IO）。
 *
 * 用途：给一个「合法转移声明 spec」，对照「运行中实际观察到的转移序列」，输出两类问题：
 *   1. undeclared：观察到了但 spec 未声明的转移（非法跳变）；
 *   2. unobserved：spec 声明了但运行中从未出现的转移（声明冗余 / 死边）。
 * 另报告 observed 中引用了 spec.states 之外状态的 unknown-state。
 *
 * 本模块只做校验，不内置任何具体状态机（ToolJob / ActiveChatLoop / circuit breaker /
 * resume cursor 的 spec 由调用方提供；W33 备选：只做校验器，不写 job.ts 的 spec）。
 */

export interface MachineTransition {
  from: string;
  to: string;
}

export interface TransitionSpec {
  states: readonly string[];
  transitions: readonly MachineTransition[];
}

/** 校验结果分类。 */
export type TransitionIssueKind = 'undeclared' | 'unobserved' | 'unknown-state';

export interface TransitionIssue {
  kind: TransitionIssueKind;
  from: string;
  to: string;
}

function edgeKey(from: string, to: string): string {
  return `${from}->${to}`;
}

/**
 * 对照 spec 校验 observed 转移序列，返回问题列表（纯函数，不修改入参）。
 * 同一转移重复观察只计一次；输出顺序：先按 observed 去重顺序报 undeclared/unknown-state，
 * 再按 spec 声明顺序报 unobserved。
 */
export function verifyTransitions(
  spec: TransitionSpec,
  observed: readonly MachineTransition[],
): TransitionIssue[] {
  const declared = new Set(spec.transitions.map((t) => edgeKey(t.from, t.to)));
  const knownStates = new Set(spec.states);
  const observedSeen = new Set<string>();
  const issues: TransitionIssue[] = [];

  for (const edge of observed) {
    const key = edgeKey(edge.from, edge.to);
    if (observedSeen.has(key)) continue;
    observedSeen.add(key);

    if (!knownStates.has(edge.from) || !knownStates.has(edge.to)) {
      issues.push({ kind: 'unknown-state', from: edge.from, to: edge.to });
    } else if (!declared.has(key)) {
      issues.push({ kind: 'undeclared', from: edge.from, to: edge.to });
    }
  }

  for (const edge of spec.transitions) {
    const key = edgeKey(edge.from, edge.to);
    if (!observedSeen.has(key)) {
      issues.push({ kind: 'unobserved', from: edge.from, to: edge.to });
    }
  }

  return issues;
}

/** 把问题列表渲染成可读字符串行（便于测试断言与日志）。 */
export function formatTransitionIssues(issues: readonly TransitionIssue[]): string[] {
  return issues.map((issue) => `${issue.kind}: ${issue.from}->${issue.to}`);
}
