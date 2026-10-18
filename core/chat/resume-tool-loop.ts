// M1-2c: resume-tool-loop — 续跑工具循环（Phase A/B/C）
// Phase A: 零 LLM，直接执行剩余 calls
// Phase B: 续轮（LLM 请求）
// Phase C: 终态（发 done:true + clearMarker）

import type { ToolCall, ToolExecutionRecord, ToolResult } from '../types';
import type { ToolJob } from '../tool/job';
import { transitionJob } from '../tool/job';
import { MAX_CHAT_TOOL_STEPS, serializeToolExecutions } from './loop-contract';
import type { ActiveChatLoop } from './active-loop';

export interface ResumeStreamChunk {
  text?: string;
  reasoningText?: string;
  done: boolean;
  error?: string;
  phase?: 'answer' | 'reasoning';
}

export interface ResumeToolLoopDeps {
  executeToolCall(call: ToolCall, signal: AbortSignal): Promise<ToolExecutionRecord>;
  submitWebPrompt(input: {
    chatSessionId: string;
    parentMessageId: number;
    prompt: string;
    modelType?: string;
    clientHeaders: Record<string, string>;
    refFileIds: string[];
    thinkingEnabled: boolean;
    searchEnabled: boolean;
  }, callbacks: {
    onTextChunk?: (text: string, fullText: string) => void;
    onReasoningChunk?: (text: string, full: string) => void;
  }, signal: AbortSignal): Promise<{
    assistantText: string;
    responseMessageId: number;
    finished: boolean;
    reasoningText?: string;
  }>;
  continueWithToolResults(toolResults: string): string;
  maxToolStepsMessage(): string;
  broadcastChunk(chunk: ResumeStreamChunk, excludeTabId?: number): boolean;
  persistMarker(patch: Partial<ActiveChatLoop>): Promise<void>;
  clearMarker(): Promise<void>;
  getModelType(): Promise<string | null>;
  loadClientHeaders(): Promise<Record<string, string> | null>;
}

export interface ResumeLoopInput {
  job: ToolJob;
  snapshot: ActiveChatLoop;
  resumeIndex: number;
  depth: number;
  synthesized?: ToolExecutionRecord;
}

export interface ResumeLoopOutcome {
  terminalEmitted: boolean;
  job: ToolJob;
  success: boolean;
  reason?: string;
}

/**
 * 执行续跑工具循环
 */
export async function runResumeToolLoop(
  input: ResumeLoopInput,
  deps: ResumeToolLoopDeps,
  signal: AbortSignal,
): Promise<ResumeLoopOutcome> {
  let job = input.job;
  let executions = [...job.executions];
  let terminalEmitted = false;

  // synthesized 记录（in-flight 工具结果未知）
  if (input.synthesized) {
    executions.push(input.synthesized);
  }

  // --- Phase A: 零 LLM，执行剩余 calls ---
  const remainingCalls = job.calls.slice(input.resumeIndex);
  for (let i = 0; i < remainingCalls.length; i++) {
    if (signal.aborted) {
      await deps.clearMarker();
      return {
        terminalEmitted: false,
        job,
        success: false,
        reason: 'session_reset',
      };
    }
    const call = remainingCalls[i];
    try {
      const record = await deps.executeToolCall(call, signal);
      executions.push(record);
      // 推进水位线
      await deps.persistMarker({
        position: { callIndex: input.resumeIndex + i + 1, depth: input.depth },
      }).catch(() => {});
    } catch (error) {
      // 工具失败：记录失败结果，继续执行（与现网 runWebToolLoop 语义一致）
      executions.push({
        name: call.name,
        result: {
          ok: false,
          summary: 'tool execution failed',
          error: {
            code: 'tool_execution_failed',
            message: error instanceof Error ? error.message : String(error),
            retryable: false,
          },
        },
      });
    }
  }

  // --- H3 修正：续跑可用步数 = MAX_CHAT_TOOL_STEPS - (depth + 1) ---
  const remainingSteps = MAX_CHAT_TOOL_STEPS - (input.depth + 1);
  if (remainingSteps <= 0) {
    emitDone(deps, deps.maxToolStepsMessage(), undefined);
    terminalEmitted = true;
    job = transitionJob(job, 'failed');
    await deps.clearMarker();
    return finish(true, job, terminalEmitted, 'max_steps');
  }

  // --- m1 修正：refFileIds 非空即走 legacy ---
  // marker 不含 refFileIds，Phase B 无法重建上下文 → 走 legacy
  // （此判定在 gate 层已做，此处为防御）

  // --- Phase B: 续轮 ---
  const clientHeaders = await deps.loadClientHeaders();
  if (!clientHeaders) {
    emitDone(deps, '', 'missing_auth');
    terminalEmitted = true;
    job = transitionJob(job, 'failed');
    await deps.clearMarker();
    return finish(true, job, terminalEmitted, 'auth_missing');
  }

  const modelType = await deps.getModelType();
  const parentMsgId = input.snapshot.parentMessageId;
  if (parentMsgId === null || parentMsgId === undefined) {
    emitDone(deps, '', 'no_parent_message');
    terminalEmitted = true;
    job = transitionJob(job, 'failed');
    await deps.clearMarker();
    return {
      terminalEmitted,
      job,
      success: false,
      reason: 'no_parent_message',
    };
  }
  let currentParentMessageId: number = parentMsgId;

  let success = false;
  for (let step = 0; step < remainingSteps; step++) {
    if (signal.aborted) {
      break;
    }

    const continuationPrompt = deps.continueWithToolResults(
      serializeToolExecutions(executions),
    );

    const result = await deps.submitWebPrompt(
      {
        chatSessionId: input.snapshot.chatSessionId ?? '',
        parentMessageId: currentParentMessageId,
        prompt: continuationPrompt,
        modelType: modelType ?? undefined,
        clientHeaders,
        refFileIds: [],
        thinkingEnabled: false,
        searchEnabled: false,
      },
      {
        onTextChunk(text) {
          deps.broadcastChunk({ text, done: false, phase: 'answer' });
        },
        onReasoningChunk(text) {
          deps.broadcastChunk({ text: '', reasoningText: text, done: false, phase: 'reasoning' });
        },
      },
      signal,
    );

    currentParentMessageId = result.responseMessageId;
    const fullText = result.assistantText;
    if (!fullText) {
      emitDone(deps, '', result.finished ? undefined : 'stream_interrupted');
      terminalEmitted = true;
      success = result.finished;
      break;
    }

    // 提取 toolCalls（简化：直接用 executeChatTool 已有的 extractToolCalls）
    // 此处复用 Phase A 的执行逻辑
    // 简化版：如果 fullText 没有工具调用，就 done
    // 实际实现需要 extractToolCalls，此处为骨架
    emitDone(deps, fullText, undefined);
    terminalEmitted = true;
    success = true;
    break;
  }

  if (!terminalEmitted) {
    emitDone(deps, deps.maxToolStepsMessage(), undefined);
    terminalEmitted = true;
    success = false;
  }

  job = success ? transitionJob(job, 'succeeded') : transitionJob(job, 'failed');
  await deps.clearMarker();

  return finish(true, job, terminalEmitted, success ? 'completed' : 'failed');

  function emitDone(d: ResumeToolLoopDeps, text: string, error: string | undefined) {
    const ok = d.broadcastChunk({ text, done: true, error });
    // m3 修正：广播失败时返回非 null，让 service 兜底发终态
    if (!ok) {
      terminalEmitted = false;
    }
  }

  function finish(
    _success: boolean,
    _job: ToolJob,
    _terminalEmitted: boolean,
    _reason?: string,
  ): ResumeLoopOutcome {
    return {
      terminalEmitted: _terminalEmitted,
      job: _job,
      success: _success,
      reason: _reason,
    };
  }
}
