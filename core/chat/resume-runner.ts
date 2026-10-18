// M1-2c: resume-runner — marker→ToolJob 重建 + cursor 解析
// 纯函数，无 I/O，可被纯内存单测覆盖

import type { ActiveChatLoop } from './active-loop';
import type { ToolJob, ToolCallPosition } from '../tool/job';
import { createJob, transitionJob, resumeJob } from '../tool/job';
import type { ToolCall, ToolExecutionRecord } from '../types';

export type RebuildRejectReason =
  | 'marker_missing' | 'marker_v0' | 'provider_not_resumable' | 'missing_ids'
  | 'no_calls' | 'no_parent_message' | 'no_session' | 'deadline_expired'
  | 'illegal_transition';

export type RebuildJobResult =
  | { ok: true; job: ToolJob; snapshot: ActiveChatLoop }
  | { ok: false; reason: RebuildRejectReason };

/**
 * 从 marker 重建 ToolJob
 * 走合法状态机：pending → running → interrupted（SW 死亡事实）
 */
export function rebuildJobFromMarker(
  snapshot: ActiveChatLoop,
  now: number,
): RebuildJobResult {
  // 前置校验
  if (snapshot.schemaVersion !== 1) {
    return { ok: false, reason: 'marker_v0' };
  }
  if (snapshot.provider !== 'web') {
    return { ok: false, reason: 'provider_not_resumable' };
  }
  if (typeof snapshot.jobId !== 'string' || !snapshot.jobId) {
    return { ok: false, reason: 'missing_ids' };
  }
  if (typeof snapshot.turnId !== 'string' || !snapshot.turnId) {
    return { ok: false, reason: 'missing_ids' };
  }
  if (!Array.isArray(snapshot.calls) || snapshot.calls.length === 0) {
    return { ok: false, reason: 'no_calls' };
  }
  if (snapshot.parentMessageId === null || snapshot.parentMessageId === undefined) {
    return { ok: false, reason: 'no_parent_message' };
  }
  if (!snapshot.chatSessionId) {
    return { ok: false, reason: 'no_session' };
  }

  // TTL 判定
  const deadline = snapshot.resumeDeadline ?? snapshot.startedAt + 600_000;
  if (now > deadline) {
    return { ok: false, reason: 'deadline_expired' };
  }

  // 走合法状态机重建
  try {
    let job = createJob({
      id: snapshot.jobId,
      turnId: snapshot.turnId,
      parentMessageId: snapshot.parentMessageId,
      calls: snapshot.calls,
    });
    // 回填元数据（不改状态机）
    job = {
      ...job,
      executions: snapshot.executions ?? [],
      position: snapshot.position ?? { callIndex: 0, depth: 0 },
      attempt: snapshot.attempt ?? 0,
      startedAt: snapshot.startedAt,
    };
    // pending → running → interrupted（SW 死亡事实）
    job = transitionJob(job, 'running');
    job = transitionJob(job, 'interrupted');
    return { ok: true, job, snapshot };
  } catch {
    return { ok: false, reason: 'illegal_transition' };
  }
}

// --- 游标解析 ---

export interface ResumeCursor {
  resumeIndex: number;
  depth: number;
  synthesized?: ToolExecutionRecord;
  evidence: {
    watermark: number;
    aligned: number;
    matchedCandidates: number;
    inFlightTool: string | null;
  };
}

export type CursorRejectReason =
  | 'cursor_conflict'
  | 'cursor_ambiguous'
  | 'in_flight_mismatch'
  | 'in_flight_abort';

export type ResolveCursorResult =
  | { ok: true; cursor: ResumeCursor }
  | { ok: false; reason: CursorRejectReason };

function callKey(call: { name: string; provider?: unknown; descriptorId?: string }): string {
  const providerStr = typeof call.provider === 'string' ? call.provider : JSON.stringify(call.provider ?? '');
  return `${call.name}\u0000${providerStr}\u0000${call.descriptorId ?? ''}`;
}

/**
 * executions 与 calls 前缀对齐
 * 返回匹配的 j 个数（0/1/多）
 */
export function alignExecutions(
  calls: ToolCall[],
  executions: ToolExecutionRecord[],
): number {
  const maxJ = Math.min(calls.length, executions.length);
  let matched = 0;
  for (let j = 1; j <= maxJ; j++) {
    const callsPrefix = calls.slice(0, j).map(callKey);
    const execTail = executions.slice(executions.length - j).map(callKey);
    if (callsPrefix.every((k, i) => k === execTail[i])) {
      matched = j;
    }
  }
  return matched;
}

/**
 * 解析续跑游标
 * 双通道：水位线（runner 自维护）+ executions 前缀对齐（legacy 兜底）
 */
export function resolveResumeIndex(
  job: ToolJob,
  marker: ActiveChatLoop,
  inFlightPolicy: 'abort' | 'synthesize' | 'replay' = 'synthesize',
): ResolveCursorResult {
  const watermark = job.position.callIndex;
  const aligned = alignExecutions(job.calls, job.executions);
  const currentToolName = marker.currentTool?.name ?? null;

  // 水位线冲突
  if (watermark > 0 && watermark !== aligned) {
    return { ok: false, reason: 'cursor_conflict' };
  }

  // 水位线权威
  let resumeIndex = watermark > 0 ? watermark : aligned;

  // 重名工具歧义
  if (watermark === 0) {
    const maxJ = Math.min(job.calls.length, job.executions.length);
    let candidates = 0;
    for (let j = 1; j <= maxJ; j++) {
      const callsPrefix = job.calls.slice(0, j).map(callKey);
      const execTail = job.executions.slice(job.executions.length - j).map(callKey);
      if (callsPrefix.every((k, i) => k === execTail[i])) {
        candidates++;
      }
    }
    if (candidates > 1) {
      return { ok: false, reason: 'cursor_ambiguous' };
    }
  }

  // in-flight 工具处理
  if (currentToolName !== null) {
    const expectedKey = callKey(job.calls[resumeIndex] ?? { name: '' });
    const actualKey = callKey({ name: currentToolName });
    if (expectedKey !== actualKey) {
      return { ok: false, reason: 'in_flight_mismatch' };
    }

    if (inFlightPolicy === 'abort') {
      return { ok: false, reason: 'in_flight_abort' };
    }

    if (inFlightPolicy === 'synthesize') {
      const synthesized: ToolExecutionRecord = {
        name: currentToolName,
        result: {
          ok: false,
          summary: 'resume_tool_outcome_unknown',
          error: {
            code: 'resume_tool_outcome_unknown',
            message: 'Tool was interrupted before completion; outcome unknown',
            retryable: false,
          },
        },
      };
      return {
        ok: true,
        cursor: {
          resumeIndex: resumeIndex + 1,
          depth: job.position.depth,
          synthesized,
          evidence: {
            watermark,
            aligned,
            matchedCandidates: aligned,
            inFlightTool: currentToolName,
          },
        },
      };
    }

    // replay: 重放该工具
    return {
      ok: true,
      cursor: {
        resumeIndex,
        depth: job.position.depth,
        evidence: {
          watermark,
          aligned,
          matchedCandidates: aligned,
          inFlightTool: currentToolName,
        },
      },
    };
  }

  return {
    ok: true,
    cursor: {
      resumeIndex,
      depth: job.position.depth,
      evidence: {
        watermark,
        aligned,
        matchedCandidates: aligned,
        inFlightTool: null,
      },
    },
  };
}

/**
 * 进入 resumed 状态
 */
export function activateResume(job: ToolJob): ToolJob {
  return resumeJob(job);
}
