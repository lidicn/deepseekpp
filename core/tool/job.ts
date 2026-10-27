/**
 * Tool Job — M1 真续跑任务模型
 *
 * 把一次工具调用序列建模为一个可持久化、可恢复的 job。
 * 状态机：pending → running → succeeded / failed / interrupted → resumed
 *
 * 设计参考：doc/设计/m1-真续跑-执行计划-20261016.md §M1-1
 */

import type { ToolCall, ToolExecutionRecord } from '../types';

/** job 生命周期状态 */
export type JobState =
  | 'pending'      // 已创建，未开始执行
  | 'running'      // 执行中
  | 'succeeded'    // 全部工具执行成功
  | 'failed'       // 某个工具执行失败且不可恢复
  | 'interrupted'  // 被 SW 回收中断（可续跑）
  | 'resumed';     // 从中断恢复执行中

/** 单个工具调用的执行坐标 */
export interface ToolCallPosition {
  /** 工具在 calls 数组中的索引 */
  callIndex: number;
  /** 嵌套深度（对齐 engine.ts position.depth） */
  depth: number;
}

/** 可持久化的 job 结构 */
export interface ToolJob {
  /** 唯一 ID */
  id: string;
  /** 所属 turn ID */
  turnId: string;
  /** 会话链位置（parentMessageId） */
  parentMessageId: number | null;
  /** 待执行的工具调用列表 */
  calls: ToolCall[];
  /** 已执行的工具结果 */
  executions: ToolExecutionRecord[];
  /** 当前执行坐标 */
  position: ToolCallPosition;
  /** job 当前状态 */
  state: JobState;
  /** 已重试次数 */
  attempt: number;
  /** 结果外置化指针（若大结果外置） */
  resultHandle?: string;
  /** 创建时间 */
  startedAt: number;
  /** 完成时间（succeeded/failed 时填） */
  finishedAt?: number;
}

/** 状态机合法转移表 */
const VALID_TRANSITIONS: Record<JobState, JobState[]> = {
  pending: ['running', 'failed'],
  running: ['succeeded', 'failed', 'interrupted'],
  interrupted: ['resumed', 'failed'],
  resumed: ['succeeded', 'failed', 'interrupted'],
  succeeded: [],
  failed: [],
};

/**
 * 检查状态转移是否合法。
 */
export function canTransition(from: JobState, to: JobState): boolean {
  return VALID_TRANSITIONS[from].includes(to);
}

/**
 * 创建一个新 job（初始状态 pending）。
 */
export function createJob(params: {
  id: string;
  turnId: string;
  parentMessageId: number | null;
  calls: ToolCall[];
}): ToolJob {
  return {
    id: params.id,
    turnId: params.turnId,
    parentMessageId: params.parentMessageId,
    calls: params.calls,
    executions: [],
    position: { callIndex: 0, depth: 0 },
    state: 'pending',
    attempt: 0,
    startedAt: Date.now(),
  };
}

/**
 * 转移 job 状态。
 * @throws 非法转移时抛错（fail-closed，不静默）
 */
export function transitionJob(job: ToolJob, to: JobState): ToolJob {
  if (!canTransition(job.state, to)) {
    throw new Error(`Invalid job state transition: ${job.state} → ${to}`);
  }
  return {
    ...job,
    state: to,
    finishedAt: to === 'succeeded' || to === 'failed' ? Date.now() : job.finishedAt,
  };
}

/**
 * 从中断状态恢复 job（回到 running）。
 * #57: 加上限 —— 超过 MAX_RESUME_ATTEMPTS 不再续跑，直接置 failed。
 */
const MAX_RESUME_ATTEMPTS = 5;

export function resumeJob(job: ToolJob): ToolJob {
  if (job.state !== 'interrupted' && job.state !== 'resumed') {
    throw new Error(`Cannot resume job in state: ${job.state}`);
  }
  if (job.attempt >= MAX_RESUME_ATTEMPTS) {
    return {
      ...job,
      state: 'failed',
      finishedAt: Date.now(),
    };
  }
  return {
    ...job,
    state: 'resumed',
    attempt: job.attempt + 1,
  };
}

/**
 * 判断 job 是否可续跑（interrupted 且 calls 未全部执行完）。
 */
export function isResumable(job: ToolJob): boolean {
  return job.state === 'interrupted' && job.position.callIndex < job.calls.length;
}
