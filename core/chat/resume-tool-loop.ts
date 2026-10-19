// M1-2c: resume-tool-loop — 续跑核心循环
// Phase A: 执行剩余工具调用
// Phase B: 发 LLM 请求续轮
// H3: 续跑可用步数 = MAX_CHAT_TOOL_STEPS - (depth+1)
// H1: 复用 markChatLoopFinished（不新造 clearMarker）

import type { ActiveChatLoop } from './active-loop';
import type { ToolJob } from '../tool/job';
import { MAX_CHAT_TOOL_STEPS, serializeToolExecutions } from './loop-contract';
import type { ToolCall, ToolExecutionRecord } from '../types';
import { waitBetweenDeepSeekRequests } from '../inline-agent/step-control';

export interface ResumeToolLoopDeps {
  // Phase A: 执行单个工具调用
  executeToolCall(call: ToolCall): Promise<ToolExecutionRecord>;
  // Phase B: 发 LLM 请求
  submitContinuation(input: {
    parentMessageId: number | null;
    toolResults: string;
    signal: AbortSignal;
  }): Promise<{
    responseMessageId: string | null;
    assistantText: string;
    finished: boolean;
    toolCalls: ToolCall[];
  }>;
  // 广播 chunk 到侧面板
  broadcastChunk(chunk: { type: string; [key: string]: unknown }): void;
  // 终态清理（复用 markChatLoopFinished）
  finalize(): Promise<void>;
  // 写 marker
  updateMarker(patch: Partial<ActiveChatLoop>): Promise<void>;
}

export interface ResumeToolLoopPlan {
  job: ToolJob;
  snapshot: ActiveChatLoop;
  resumeIndex: number;
  depth: number;
  synthesized?: ToolExecutionRecord;
}

export type ResumeToolLoopResult =
  | { ok: true; terminalEmitted: boolean }
  | { ok: false; reason: string };

export async function runResumeToolLoop(
  plan: ResumeToolLoopPlan,
  deps: ResumeToolLoopDeps,
  signal: AbortSignal,
): Promise<ResumeToolLoopResult> {
  const { job, snapshot, resumeIndex, depth, synthesized } = plan;

  // H3: 续跑可用步数 = MAX_CHAT_TOOL_STEPS - (depth+1)
  const remainingSteps = MAX_CHAT_TOOL_STEPS - (depth + 1);
  if (remainingSteps <= 0) {
    deps.broadcastChunk({
      type: 'AGENT_LOOP_COMPLETED',
      done: true,
      reason: 'max_tool_steps_reached',
    });
    await deps.finalize();
    return { ok: true, terminalEmitted: true };
  }

  let executions: ToolExecutionRecord[] = [...(job.executions ?? [])];
  if (synthesized) {
    executions.push(synthesized);
  }

  // Phase A: 执行剩余工具调用
  let currentIndex = resumeIndex;
  while (currentIndex < job.calls.length) {
    if (signal.aborted) {
      await deps.finalize();
      return { ok: false, reason: 'aborted' };
    }

    const call = job.calls[currentIndex];
    deps.broadcastChunk({
      type: 'AGENT_TOOL_STARTED',
      toolName: call.name,
    });

    const execution = await deps.executeToolCall(call);
    executions.push(execution);

    deps.broadcastChunk({
      type: 'AGENT_TOOL_COMPLETED',
      toolName: call.name,
      ok: execution.result.ok,
    });

    currentIndex++;

    // 写 marker（m5: revision CAS 由调用方保证）
    await deps.updateMarker({
      executions,
      position: { callIndex: currentIndex, depth: depth },
    }).catch(() => {});
  }

  // Phase B: 发 LLM 请求续轮
  const toolResultsText = serializeToolExecutions(executions.slice(resumeIndex));

  for (let step = 0; step < remainingSteps; step++) {
    if (signal.aborted) {
      await deps.finalize();
      return { ok: false, reason: 'aborted' };
    }

    deps.broadcastChunk({
      type: 'AGENT_TURN_STARTED',
      turn: depth + step + 1,
    });

    // 第四件：submitContinuation 前必须 await waitBetweenDeepSeekRequests
    // （2500-6500ms 随机，风控防线不可省）
    await waitBetweenDeepSeekRequests(signal);

    const result = await deps.submitContinuation({
      parentMessageId: snapshot.parentMessageId ?? null,
      toolResults: toolResultsText,
      signal,
    });

    if (result.toolCalls.length === 0) {
      // 无工具调用 → 完成
      deps.broadcastChunk({
        type: 'AGENT_LOOP_COMPLETED',
        done: true,
        text: result.assistantText,
      });
      await deps.finalize();
      return { ok: true, terminalEmitted: true };
    }

    // 有工具调用 → 执行
    for (const call of result.toolCalls) {
      const execution = await deps.executeToolCall(call);
      executions.push(execution);
    }
  }

  // 步数用完 → 强制完成
  deps.broadcastChunk({
    type: 'AGENT_LOOP_COMPLETED',
    done: true,
    reason: 'max_tool_steps_reached',
  });
  await deps.finalize();
  return { ok: true, terminalEmitted: true };
}
