import type { ToolCall, ToolDescriptor, ToolExecutionRecord } from '../types';
import type { SupportedLocale } from '../i18n';
import type { TraceEvent } from '../trace/report';

export interface InlineAgentStartPayload {
  loopId: string;
  /** Stable scope inherited from the user turn that exposed capability handles. */
  capabilityScopeRequestId?: string;
  chatSessionId: string;
  parentMessageId: number;
  originalPrompt: string;
  agentTaskPrompt: string;
  toolExecutions: ToolExecutionRecord[];
  promptOptions: InlineAgentPromptOptions;
  toolDescriptors: ToolDescriptor[];
  locale?: SupportedLocale;
  powWasmUrl?: string;
  /**
   * Model backend for this loop (B2). Defaults to `'web'` (released
   * DeepSeek-web path, golden-locked). `'official-api'` runs the same pi
   * loop over the DeepSeek official API (OpenAI-compatible messages +
   * reasoning); the caller selects it when an official API key is
   * configured, matching the sidepanel chat auto-switch semantics.
   */
  modelBackend?: 'web' | 'official-api';
}

export interface InlineAgentPromptOptions {
  modelType: string | null;
  searchEnabled: boolean;
  thinkingEnabled: boolean;
  refFileIds: string[];
}

export type InlineAgentStepStatus = 'streaming' | 'executing_tools' | 'complete' | 'error';
export type InlineAgentLoopStatus = 'idle' | 'running' | 'stopping' | 'complete' | 'error';

export interface InlineAgentStepState {
  index: number;
  status: InlineAgentStepStatus;
  streamedText: string;
  toolCalls: ToolCall[];
  toolExecutions: ToolExecutionRecord[];
  responseMessageId: number | null;
}

export interface InlineAgentLoopState {
  loopId: string;
  chatSessionId: string;
  parentMessageId: number | null;
  status: InlineAgentLoopStatus;
  currentStepIndex: number;
  steps: InlineAgentStepState[];
  totalToolExecutions: number;
  startedAt: number;
}

export interface InlineAgentTraceStepRecord {
  index: number;
  status: InlineAgentStepStatus;
  text: string;
  /** Accumulated reasoning/thinking text of the step, when the backend captured it. */
  reasoning?: string;
  toolExecutions: ToolExecutionRecord[];
  responseMessageId: number | null;
  collapsed: boolean;
}

export interface InlineAgentTraceRecord {
  id: string;
  loopId: string;
  chatSessionId: string;
  anchorMessageId: number;
  anchorMessageIndex?: number | null;
  anchorContent?: string;
  url: string;
  originalPrompt: string;
  agentTaskPrompt: string;
  status: InlineAgentLoopStatus;
  steps: InlineAgentTraceStepRecord[];
  /**
   * Tool executions of the ORIGINAL native turn that triggered the agent
   * (the full pre-loop execution set, including non-continuable tools such
   * as memory_save). Persisted so a restored console renders the complete
   * run record: the old-style tool block is suppressed for agent-owned
   * messages, and these executions render as the first (new style) tool
   * group instead — the count must not be lost on refresh.
   */
  initialExecutions?: ToolExecutionRecord[];
  /**
   * W29 轨迹事件流（2026-10-21 接线）。
   *
   * 「断流」类问题长期无法定位，是因为 loop-adapter 的续轮判定点没有任何记录。
   * 这里保存紧凑的事件流（无正文），供 renderTraceReport 渲染成可读报告：
   * 能直接看出「哪一轮 OPEN（从未结束）」「continuation.decision 是 true 还是 false」
   * 「turn.end 的 stopReason 是什么」。旧记录没有该字段，解码时按空数组处理。
   */
  events?: TraceEvent[];
  totalSteps: number;
  totalTools: number;
  finalText: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export interface InlineAgentStreamChunkMsg {
  loopId: string;
  stepIndex: number;
  text: string;
  fullText: string;
}

/** Reasoning/thinking deltas of the current step (real content, live). */
export interface InlineAgentReasoningChunkMsg {
  loopId: string;
  stepIndex: number;
  fullText: string;
}

export interface InlineAgentToolDetectedMsg {
  loopId: string;
  stepIndex: number;
  call: ToolCall;
}

export interface InlineAgentStepCompleteMsg {
  loopId: string;
  stepIndex: number;
  responseMessageId: number | null;
  toolExecutions: ToolExecutionRecord[];
}

export interface InlineAgentLoopCompleteMsg {
  loopId: string;
  totalSteps: number;
  totalTools: number;
  finalText: string;
  /**
   * W29 观测（2026-10-21）：这一轮是怎么结束的。
   *
   * 修复「静默结束」类 bug 的前提是能区分结束原因。此前 finalize 的两个
   * `signal.aborted` 分支都会 post `finalText: ''` 的 COMPLETE，从消息上无法
   * 与「正常但模型没产出」区分开，导致断流长期无法定位。
   *
   * - 'finalized'    正常收尾（finalText 可能为空，表示模型确实没产出）
   * - 'aborted'      信号被 abort（用户停止 / 步骤超时 / 通道断开），静默结束
   * - 'turn_error'   收尾时发现上一轮是错误轮
   * - 'loop_threw'   循环抛出异常
   */
  stopReason?: InlineAgentStopReason;
}

export type InlineAgentStopReason =
  | 'finalized'
  | 'aborted'
  | 'turn_error'
  | 'loop_threw';

export interface InlineAgentLoopErrorMsg {
  loopId: string;
  stepIndex: number;
  totalTools: number;
  error: string;
  stopReason?: InlineAgentStopReason;
}

export const INLINE_AGENT_MAX_STEPS = 25;
export const INLINE_AGENT_MAX_NUDGES = 8;
/**
 * Step timeout: must exceed the shell MCP request timeout (120s) so that
 * shell has its full budget and the agent still has headroom for the
 * continuation nudge. Double the shell timeout for safety.
 */
export const INLINE_AGENT_STEP_TIMEOUT_MS = 300_000;
export const INLINE_AGENT_REQUEST_DELAY_MIN_MS = 2_500;
export const INLINE_AGENT_REQUEST_DELAY_MAX_MS = 6_500;
