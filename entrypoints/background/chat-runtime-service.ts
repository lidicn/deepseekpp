import type { OfficialApiChatConfig } from '../../core/chat/official-api-config-contract';
import type { ChatLoopProvider, InterruptedChatLoop } from '../../core/chat/active-loop';
import { evaluateBudgetForText, type BudgetState } from '../../core/chat/context-budget';
// P0-3: 工具执行状态持久化 helper
import {
  appendToolExecution,
  clearCurrentTool,
  getActiveChatLoop,
  setCurrentTool,
  updateMarker,
} from '../../core/chat/active-loop';
import { createResumeGate, normalizeFlags, RESUME_FLAGS_STORAGE_KEY } from '../../core/chat/resume-gate';
import { waitForWakeReconcile } from '../../core/chat/wake-reconcile-timeout';
import { diagnosticLogBuffer } from '../../core/diagnostics/log-buffer';
import {
  runResumeToolLoop,
  type ResumeToolLoopDeps,
  type ResumeToolLoopPlan,
} from '../../core/chat/resume-tool-loop';
import type { ModelTurn, SubmitPromptInput } from '../../core/deepseek/automation-client-port';
import { DeepSeekAuthError } from '../../core/deepseek/errors';
import type { DeepSeekUploadedFile } from '../../core/deepseek/contracts';
import type {
  OfficialDeepSeekCallbacks,
  OfficialDeepSeekMessage,
  OfficialDeepSeekTurn,
  SubmitOfficialDeepSeekInput,
} from '../../core/deepseek/official-api';
import { extractToolCalls } from '../../core/interceptor/tool-parser';
import {
  materializeDeepSeekImageUpload,
  type EncodedDeepSeekImageUploadRequest,
} from '../../core/messaging/deepseek-runtime-request-codec';
import type { RuntimeToolCallOptions } from '../../core/tool/runtime';
import type {
  ToolCall,
  ToolDescriptor,
  ToolResult,
} from '../../core/tool/types';
import type { ToolExecutionRecord } from '../../core/types';

import {
  MAX_AUTO_CONTINUE,
  MAX_CHAT_TOOL_STEPS,
  serializeToolExecutions,
} from '../../core/chat/loop-contract';
import {
  createBackgroundWebChatTrace,
  utf8ByteLength,
  type BackgroundWebChatTrace,
} from '../../core/trace/background-web-chat-trace';

/**
 * R08：工具运行事件，随 CHAT_STREAM_CHUNK 广播给侧边栏工具面板。
 * start 在工具派发前发出；end 在结算后发出（成功/失败都发）。
 */
export interface ToolRunEvent {
  phase: 'start' | 'end';
  name: string;
  /** 工具所在的工具循环轮次（0 起），供 R09 步骤时间线分组。 */
  step?: number;
  /** start 时刻的 Date.now()，用于 start/end 配对与计时。 */
  startedAt?: number;
  /** 仅 end：工具是否成功。 */
  ok?: boolean;
  /** 仅 end：本次执行耗时。 */
  durationMs?: number;
  /** 仅 end：截断到 200 字的结果摘要。 */
  summary?: string;
}

export interface ChatStreamChunk {
  text: string;
  done: boolean;
  error?: string;
  reasoningText?: string;
  phase?: 'reasoning' | 'answer';
  toolEvent?: ToolRunEvent;
  /** R06：本地粗估上下文预算档位（ok/warn/critical + remaining），UI 据此显隐提示条。 */
  budget?: BudgetState;
}

export interface ChatPromptBuildRequest {
  prompt: string;
  isFirstMessage: boolean;
  messageCount: number;
}

export interface ChatPromptBuildResult {
  augmented: string;
  enabledDescriptors: ToolDescriptor[];
}

export interface ChatRuntimeServiceDependencies {
  getChatEnabled(): Promise<boolean>;
  getDeepSeekApiKey(): Promise<string | null>;
  getOfficialApiChatConfig(): Promise<OfficialApiChatConfig>;
  loadClientHeaders(preferredTabId?: number): Promise<Record<string, string> | null>;
  getModelType(): Promise<string | null>;
  buildPrompt(request: ChatPromptBuildRequest): Promise<ChatPromptBuildResult>;
  executeToolCall(call: ToolCall, options: RuntimeToolCallOptions): Promise<ToolResult>;
  createChatSession(headers: Record<string, string>, signal: AbortSignal): Promise<string>;
  createPowHeaders(
    headers: Record<string, string>,
    signal: AbortSignal,
  ): Promise<Record<string, string>>;
  createUploadPowHeaders(
    headers: Record<string, string>,
    signal: AbortSignal,
  ): Promise<Record<string, string>>;
  submitWebPrompt(
    input: SubmitPromptInput,
    callbacks: {
      onTextChunk?(text: string, fullText: string): void;
      onReasoningChunk?(reasoning: string, fullReasoning: string): void;
    },
    signal: AbortSignal,
  ): Promise<ModelTurn>;
  submitOfficialPrompt(
    input: SubmitOfficialDeepSeekInput,
    callbacks: OfficialDeepSeekCallbacks,
    signal: AbortSignal,
  ): Promise<OfficialDeepSeekTurn>;
  uploadFile(
    input: {
      file: Blob;
      filename: string;
      modelType: string | null;
      clientHeaders: Record<string, string>;
      powHeaders: Record<string, string>;
    },
    signal: AbortSignal,
  ): Promise<DeepSeekUploadedFile>;
  markChatLoopStarted(provider: ChatLoopProvider): Promise<void>;
  markChatLoopFinished(): Promise<void>;
  reconcileInterruptedChatLoop(): Promise<InterruptedChatLoop | null>;
  broadcastChunk(chunk: ChatStreamChunk, excludeTabId?: number): void;
  continueWithToolResults(toolResults: string): string;
  maxToolStepsMessage(): string;
  missingAuthMessage(): string;
  interruptedMessage(): string;
  reportError(code: string, error: unknown): void;
}

export interface ChatSubmitRequest {
  text: string;
  config?: OfficialApiChatConfig;
  refFileIds: string[];
}

export interface ChatRuntimeService {
  submitPrompt(
    request: ChatSubmitRequest,
    excludeTabId?: number,
  ): Promise<{ ok: true } | { ok: false; error: string }>;
  uploadImage(
    request: EncodedDeepSeekImageUploadRequest,
    excludeTabId?: number,
  ): Promise<{ ok: true; file: DeepSeekUploadedFile } | { ok: false; error: string }>;
  resetSession(): Promise<void>;
  reconcileInterruptedOnWake(): Promise<void>;
}

interface ActiveChatTurn {
  generation: number;
  capabilityScopeId: string;
  controller: AbortController;
  settled: Promise<void>;
  terminal?: { chunk: ChatStreamChunk; excludeTabId?: number };
}

interface PendingChatAdmission {
  generation: number;
}

interface ActiveChatUpload {
  controller: AbortController;
  settled: Promise<void>;
}

export function createChatRuntimeService(
  dependencies: ChatRuntimeServiceDependencies,
): ChatRuntimeService {
  let chatSessionId: string | null = null;
  let chatParentMessageId: number | null = null;
  let officialApiChatMessages: OfficialDeepSeekMessage[] = [];
  let activeTurn: ActiveChatTurn | null = null;
  let pendingAdmission: PendingChatAdmission | null = null;
  let generation = 0;
  let resetOperation: Promise<void> | null = null;
  let wakeReconcileOperation: Promise<void> | null = null;
  let wakeReconciled = false;
  const activeUploads = new Set<ActiveChatUpload>();

  const assertTurnActive = (turn: ActiveChatTurn): void => {
    if (
      activeTurn === turn
      && turn.generation === generation
      && !turn.controller.signal.aborted
    ) return;
    if (turn.controller.signal.reason instanceof Error) throw turn.controller.signal.reason;
    throw new DOMException('Chat turn was cancelled.', 'AbortError');
  };

  const emitChunk = (
    turn: ActiveChatTurn,
    chunk: ChatStreamChunk,
    excludeTabId?: number,
  ): void => {
    if (
      activeTurn !== turn
      || turn.generation !== generation
      || turn.controller.signal.aborted
    ) return;
    if (chunk.done) {
      turn.terminal ??= { chunk, excludeTabId };
      return;
    }
    dependencies.broadcastChunk(chunk, excludeTabId);
  };

  const buildPrompt = (prompt: string): Promise<ChatPromptBuildResult> => (
    dependencies.buildPrompt({
      prompt,
      isFirstMessage: chatSessionId === null && officialApiChatMessages.length === 0,
      messageCount: officialApiChatMessages.length + 1,
    })
  );

  const executeChatTool = async (
    turn: ActiveChatTurn,
    call: ToolCall,
    step?: number,
    excludeTabId?: number,
    webTrace?: BackgroundWebChatTrace,
  ): Promise<ToolExecutionRecord> => {
    assertTurnActive(turn);

    // P0-3: 持久化当前工具执行状态（fire-and-forget，失败不阻塞）
    void setCurrentTool(call.name).catch(() => {});

    // R08: 派发前广播 start，让侧边栏工具面板先显示"运行中"。
    const startedAt = Date.now();
    emitChunk(turn, {
      text: '',
      done: false,
      toolEvent: { phase: 'start', name: call.name, step, startedAt },
    }, excludeTabId);

    let result: ToolExecutionRecord;
    let ok = false;
    let summary = '';
    let durationMs = 0;
    try {
      const rawResult = await dependencies.executeToolCall(call, {
        signal: turn.controller.signal,
        assertActive: () => assertTurnActive(turn),
        trustedCapabilityScopeId: turn.capabilityScopeId,
      });
      assertTurnActive(turn);
      if (!rawResult.ok && rawResult.error?.details?.externalOutcome === 'ambiguous') {
        summary = rawResult.error.message || rawResult.detail || rawResult.summary;
        throw new Error(summary);
      }
      result = buildExecutionRecord(call, rawResult);
      ok = result.result.ok;
      summary = result.result.summary ?? '';
    } finally {
      durationMs = Date.now() - startedAt;
      // P0-2: W29 tool.exec with real duration on the background web path.
      webTrace?.toolExec(call.name, durationMs, ok);
      // P0-3: 清除当前工具标记 + 追加到历史
      void clearCurrentTool().catch(() => {});
      // R08: 成功/失败都在结算后广播 end（finally 保证不遗漏）。
      emitChunk(turn, {
        text: '',
        done: false,
        toolEvent: {
          phase: 'end',
          name: call.name,
          step,
          startedAt,
          ok,
          durationMs,
          summary: summary.slice(0, 200),
        },
      }, excludeTabId);
      // 注意：即使工具失败，也记录失败结果（让 reconcile 能看到"执行过但失败了"）
    }

    // P0-3: 持久化执行记录（不阻塞返回）
    void appendToolExecution(result).catch(() => {});
    return result;
  };

  const runWebToolLoop = async (
    turn: ActiveChatTurn,
    input: Omit<SubmitPromptInput, 'powHeaders'>,
    toolDescriptors: ToolDescriptor[],
    excludeTabId?: number,
  ): Promise<void> => {
    let currentInput = input;
    // R07: 无工具截断续轮单独计数，区别于含工具的 step，超限即停（防空转烧配额）。
    let autoContinues = 0;
    // P0-2: background web path W29 trace (persisted to dpp_inline_agent_traces).
    const webTrace = createBackgroundWebChatTrace();
    let totalTools = 0;
    let lastFullText = '';

    const persistWebTrace = (status: 'complete' | 'error') => {
      void webTrace.persist({
        chatSessionId: currentInput.chatSessionId,
        originalPrompt: input.prompt ?? '',
        agentTaskPrompt: input.prompt ?? '',
        finalText: lastFullText,
        totalTools,
        status,
      });
    };

    for (let step = 0; step < MAX_CHAT_TOOL_STEPS; step++) {
      assertTurnActive(turn);
      let accumulated = '';
      // One model request = one W29 turn (same semantics as content inline agent).
      webTrace.beginTurn(`web-chat:${step}`);
      const powStartedAt = Date.now();
      const powHeaders = await dependencies.createPowHeaders(
        currentInput.clientHeaders,
        turn.controller.signal,
      );
      const powMs = Date.now() - powStartedAt;
      assertTurnActive(turn);
      // P0-2: request.sent immediately before the completion POST.
      webTrace.requestSent(utf8ByteLength(currentInput.prompt ?? ''), powMs);
      // R06: web 路径历史在服务端，本地只能粗估当前 prompt + 本轮已生成文本（非全量，见账本决策）。
      // 仅 warn/critical 才广播，ok 不发 chunk，避免插队污染既有流顺序与取消判定。
      const webBudget = evaluateBudgetForText(`${currentInput.prompt ?? ''}\n${accumulated}`);
      if (webBudget.level !== 'ok') {
        emitChunk(
          turn,
          { text: '', done: false, phase: 'answer', budget: webBudget },
          excludeTabId,
        );
      }
      let firstFrameRecorded = false;
      const result = await dependencies.submitWebPrompt({
        ...currentInput,
        powHeaders,
      }, {
        onTextChunk(newText, fullText) {
          if (!firstFrameRecorded) {
            firstFrameRecorded = true;
            // First frame flush = TTFT (same Step 2.2 semantics).
            webTrace.sseFrame('text');
          }
          accumulated = fullText;
          emitChunk(turn, { text: newText, done: false, phase: 'answer' }, excludeTabId);
        },
        // The web stream routes THINK-fragment deltas through the reasoning
        // channel (they are excluded from the text channel since the
        // stream-codec split); forward them like the official-API loop so the
        // sidepanel keeps showing the thinking process.
        onReasoningChunk(newText) {
          if (!firstFrameRecorded) {
            firstFrameRecorded = true;
            webTrace.sseFrame('think');
          }
          emitChunk(turn, {
            text: '',
            reasoningText: newText,
            done: false,
            phase: 'reasoning',
          }, excludeTabId);
        },
      }, turn.controller.signal);
      assertTurnActive(turn);

      chatParentMessageId = result.responseMessageId;
      // M1-2: 写 parentMessageId 到 marker
      void updateMarker({ parentMessageId: chatParentMessageId }).catch(() => {});
      const fullText = accumulated || result.assistantText;
      lastFullText = fullText || lastFullText;
      if (!fullText) {
        // 2026-10-30 真机：截断时正文常为 0 字（只有 THINK 片段），页面仍显示那段思考，
        // 用户看到的就是"第一步就停"。原逻辑把它当"空回答"直接 endTurn 返回，
        // **永远走不到下面的续轮分支** —— 这就是"对话开头必停"的总闸。
        if (!result.finished && chatParentMessageId != null) {
          if (autoContinues >= MAX_AUTO_CONTINUE) {
            diagnosticLogBuffer.record({
              level: 'warn',
              source: 'chat-runtime',
              message: 'chat_auto_continue_exhausted',
              details: `path=web-empty step=${step} tries=${autoContinues}`,
            });
            webTrace.endTurn('auto_continue_exhausted', false);
            persistWebTrace('error');
            emitChunk(turn, {
              text: '',
              done: true,
              error: 'auto_continue_exhausted',
            }, excludeTabId);
            return;
          }
          autoContinues++;
          diagnosticLogBuffer.record({
            level: 'warn',
            source: 'chat-runtime',
            message: 'chat_auto_continue',
            details: `path=web-empty step=${step} tries=${autoContinues} parent=${chatParentMessageId} status=truncated`,
          });
          webTrace.endTurn('auto_continue', false);
          currentInput = {
            ...currentInput,
            prompt: dependencies.continueWithToolResults('(stream interrupted before any answer text — retry the same request)'),
            parentMessageId: chatParentMessageId,
          };
          continue;
        }
        webTrace.endTurn('empty', false);
        persistWebTrace('error');
        emitChunk(turn, {
          text: '',
          done: true,
          error: result.finished ? undefined : 'stream_interrupted',
        }, excludeTabId);
        return;
      }

      const toolCalls = extractToolCalls(fullText, { descriptors: toolDescriptors });
      // M1-2: 写 calls 到 marker
      void updateMarker({
        calls: toolCalls,
        position: { callIndex: 0, depth: step },
      }).catch(() => {});
      if (toolCalls.length === 0) {
        // 报告 R3 修复：流被截断且无工具调用时自动续轮，而非静默 done:true。
        // 只有在 parentMessageId 有效时才能续轮（首次请求即截断时 responseMessageId 可能为 null）。
        if (!result.finished && chatParentMessageId != null) {
          // R07: 续轮次数超限 → 明确广播 exhausted，不再空转。
          if (autoContinues >= MAX_AUTO_CONTINUE) {

          diagnosticLogBuffer.record({
            level: 'warn',
            source: 'chat-runtime',
            message: 'chat_auto_continue_exhausted',
            details: `path=web step=${step} tries=${autoContinues} len=${(fullText ?? "").length}`,
          });
            console.log('[chat-runtime] auto-continue exhausted', { step, autoContinues });
            webTrace.endTurn('auto_continue_exhausted', false);
            persistWebTrace('error');
            emitChunk(turn, {
              text: fullText,
              done: true,
              error: 'auto_continue_exhausted',
            }, excludeTabId);
            return;
          }
          autoContinues++;

          // 观测（2026-10-30）：续轮原只 console ⇒ 验收脚本看不到，等于黑箱。
          diagnosticLogBuffer.record({
            level: 'warn',
            source: 'chat-runtime',
            message: 'chat_auto_continue',
            details: `path=web step=${step} finished=${result.finished} parent=${chatParentMessageId ?? 'none'} len=${(fullText ?? "").length}`,
          });
          console.log('[chat-runtime] truncated stream without tool calls, auto-continuing', { step, autoContinues });
          webTrace.endTurn('auto_continue', false);
          currentInput = {
            ...currentInput,
            prompt: dependencies.continueWithToolResults('(stream interrupted, no new tool results — please continue completing your answer)'),
            parentMessageId: chatParentMessageId,
          };
          continue;
        }
        // 观测（2026-10-30）：普通对话**不走 active-client**，这里是唯一的流结束点。
        // 之前只在活跃客户端落盘 ⇒ 普通对话的结束形态一直是盲的（验收脚本读不到）。
        void (async () => {
          try {
            const key = 'dpp_stream_ends';
            const prev = (await chrome.storage.local.get(key))[key];
            const list = Array.isArray(prev) ? prev : [];
            list.push({
              at: Date.now(),
              src: 'chat',
              cls: result.finished ? 'chat-clean' : 'chat-truncated',
              finished: result.finished,
              endedBy: 'chat-runtime',
              status: null,
              fragments: null,
              msgId: chatParentMessageId,
              frames: null,
              textLen: (fullText ?? "").length,
              tail: (fullText ?? "").slice(-60),
            });
            await chrome.storage.local.set({ [key]: list.slice(-20) });
          } catch { /* 存储不可用：忽略 */ }
        })();
        webTrace.endTurn(result.finished ? 'finalized' : 'partial', true);
        persistWebTrace('complete');
        emitChunk(turn, {
          text: fullText,
          done: true,
          error: result.finished ? undefined : 'stream_interrupted',
        }, excludeTabId);
        return;
      }

      const executions: ToolExecutionRecord[] = [];
      for (const call of toolCalls) {
        executions.push(await executeChatTool(turn, call, step, excludeTabId, webTrace));
        totalTools += 1;
      }
      webTrace.endTurn('step_advanced', false);
      persistWebTrace('complete');
      const continuationPrompt = dependencies.continueWithToolResults(
        serializeToolExecutions(executions),
      );
      currentInput = {
        ...currentInput,
        prompt: continuationPrompt,
        parentMessageId: chatParentMessageId,
      };
    }

    webTrace.endTurn('max_tool_steps', false);
    persistWebTrace('complete');
    emitChunk(
      turn,
      { text: dependencies.maxToolStepsMessage(), done: true },
      excludeTabId,
    );
  };

  const runWebPrompt = async (
    turn: ActiveChatTurn,
    request: ChatSubmitRequest,
    excludeTabId?: number,
  ): Promise<void> => {
    const headers = await dependencies.loadClientHeaders(excludeTabId);
    assertTurnActive(turn);
    if (!headers) {
      emitChunk(
        turn,
        { text: '', done: true, error: dependencies.missingAuthMessage() },
        excludeTabId,
      );
      return;
    }

    if (!chatSessionId) {
      const nextSessionId = await dependencies.createChatSession(
        headers,
        turn.controller.signal,
      );
      assertTurnActive(turn);
      chatSessionId = nextSessionId;
      chatParentMessageId = null;
    }

    const promptContext = await buildPrompt(request.text);
    assertTurnActive(turn);
    const storedModelType = await dependencies.getModelType();
    assertTurnActive(turn);
    const modelType = request.refFileIds.length > 0 ? 'vision' : storedModelType;

    await runWebToolLoop(turn, {
      chatSessionId,
      parentMessageId: chatParentMessageId,
      modelType,
      prompt: promptContext.augmented,
      refFileIds: request.refFileIds,
      thinkingEnabled: false,
      searchEnabled: false,
      clientHeaders: headers,
    }, promptContext.enabledDescriptors, excludeTabId);
  };

  const runOfficialToolLoop = async (
    turn: ActiveChatTurn,
    input: SubmitOfficialDeepSeekInput,
    toolDescriptors: ToolDescriptor[],
    excludeTabId?: number,
  ): Promise<OfficialDeepSeekMessage[]> => {
    let currentMessages = [...input.messages];
    // R07: 无工具截断续轮单独计数，超限即停。
    let autoContinues = 0;

    for (let step = 0; step < MAX_CHAT_TOOL_STEPS; step++) {
      assertTurnActive(turn);
      let accumulated = '';
      let reasoningAccumulated = '';
      // R06: official 路径持有本地完整消息数组，按其全文粗估预算；仅 warn/critical 广播，ok 不发。
      const officialBudget = evaluateBudgetForText(
        currentMessages.map((m) => m.content ?? '').join('\n'),
      );
      if (officialBudget.level !== 'ok') {
        emitChunk(
          turn,
          { text: '', done: false, phase: 'answer', budget: officialBudget },
          excludeTabId,
        );
      }
      const result = await dependencies.submitOfficialPrompt({
        ...input,
        messages: currentMessages,
      }, {
        onTextChunk(newText, fullText) {
          accumulated = fullText;
          emitChunk(
            turn,
            { text: newText, done: false, phase: 'answer' },
            excludeTabId,
          );
        },
        onReasoningChunk(newText, fullText) {
          reasoningAccumulated = fullText;
          emitChunk(turn, {
            text: '',
            reasoningText: newText,
            done: false,
            phase: 'reasoning',
          }, excludeTabId);
        },
      }, turn.controller.signal);
      assertTurnActive(turn);

      const fullText = accumulated || result.assistantText;
      if (!fullText) {
        emitChunk(turn, {
          text: '',
          done: true,
          error: result.finished ? undefined : 'stream_interrupted',
        }, excludeTabId);
        return currentMessages;
      }

      currentMessages = [
        ...currentMessages,
        {
          role: 'assistant',
          content: fullText,
          reasoningContent: reasoningAccumulated || result.reasoningText || undefined,
        },
      ];
      const toolCalls = extractToolCalls(fullText, { descriptors: toolDescriptors });
      // M1-2: 写 calls 到 marker
      void updateMarker({
        calls: toolCalls,
        position: { callIndex: 0, depth: step },
      }).catch(() => {});
      if (toolCalls.length === 0) {
        // 报告 R3 修复：official-API 路径 —— 截断且无工具时自动续轮。
        // R07：续轮次数超限 → 明确广播 exhausted，不再空转。
        if (!result.finished) {
          if (autoContinues >= MAX_AUTO_CONTINUE) {

          diagnosticLogBuffer.record({
            level: 'warn',
            source: 'chat-runtime',
            message: 'chat_auto_continue_exhausted',
            details: `path=official step=${step} tries=${autoContinues}`,
          });
            console.log('[chat-runtime] official auto-continue exhausted', { step, autoContinues });
            emitChunk(turn, {
              text: '',
              done: true,
              error: 'auto_continue_exhausted',
            }, excludeTabId);
            return currentMessages;
          }
          autoContinues++;

          diagnosticLogBuffer.record({
            level: 'warn',
            source: 'chat-runtime',
            message: 'chat_auto_continue',
            details: `path=official step=${step} tries=${autoContinues}`,
          });
          console.log('[chat-runtime] official-api truncated stream without tool calls, auto-continuing', { step, autoContinues });
          currentMessages = [
            ...currentMessages,
            {
              role: 'user',
              content: dependencies.continueWithToolResults('(stream interrupted, no new tool results — please continue completing your answer)'),
            },
          ];
          continue;
        }
        emitChunk(turn, {
          text: '',
          done: true,
          error: result.finished ? undefined : 'stream_interrupted',
        }, excludeTabId);
        return currentMessages;
      }

      const executions: ToolExecutionRecord[] = [];
      for (const call of toolCalls) executions.push(await executeChatTool(turn, call, step, excludeTabId));
      currentMessages = [
        ...currentMessages,
        {
          role: 'user',
          content: dependencies.continueWithToolResults(serializeToolExecutions(executions)),
        },
      ];
    }

    emitChunk(
      turn,
      { text: dependencies.maxToolStepsMessage(), done: true },
      excludeTabId,
    );
    return currentMessages;
  };

  const runOfficialPrompt = async (
    turn: ActiveChatTurn,
    request: ChatSubmitRequest,
    apiKey: string,
    excludeTabId?: number,
  ): Promise<void> => {
    const promptContext = await buildPrompt(request.text);
    assertTurnActive(turn);
    const config = request.config ?? await dependencies.getOfficialApiChatConfig();
    assertTurnActive(turn);
    const messages = await runOfficialToolLoop(turn, {
      apiKey,
      config,
      messages: [
        ...officialApiChatMessages,
        { role: 'user', content: promptContext.augmented },
      ],
    }, promptContext.enabledDescriptors, excludeTabId);
    assertTurnActive(turn);
    officialApiChatMessages = messages;
  };

  const runChatTurn = async (
    turn: ActiveChatTurn,
    request: ChatSubmitRequest,
    excludeTabId?: number,
  ): Promise<void> => {
    let markerStarted = false;
    try {
      const apiKey = await dependencies.getDeepSeekApiKey();
      assertTurnActive(turn);
      const provider: ChatLoopProvider = apiKey ? 'official-api' : 'web';
      await dependencies.markChatLoopStarted(provider);
      // B4 fix: markerStarted MUST be set immediately after markChatLoopStarted
      // succeeds, BEFORE any updateMarker / assertTurnActive call that may throw.
      // If an exception lands here, the finally block must still release the
      // keepalive refcount acquired by markChatLoopStarted above.
      markerStarted = true;
      // M1-2: 扩展 marker 加 job 状态字段
      await updateMarker({
        schemaVersion: 1,
        turnId: crypto.randomUUID(),
        jobId: crypto.randomUUID(),
        jobState: 'running',
        calls: [],
        position: { callIndex: 0, depth: 0 },
        parentMessageId: null,
        chatSessionId: chatSessionId ?? null,
        attempt: 0,
        resumeDeadline: Date.now() + 10 * 60 * 1000, // 10 min TTL
      });
      assertTurnActive(turn);

      if (apiKey) {
        await runOfficialPrompt(turn, request, apiKey, excludeTabId);
      } else {
        await runWebPrompt(turn, request, excludeTabId);
      }
    } catch (error) {
      if (!isExpectedCancellation(turn, activeTurn, generation)) {
        // DPP-082 fix: preserve error name (e.g. DOMException "AbortError")
        const message = error instanceof Error
          ? (error.name ? `${error.name}: ${error.message}` : error.message)
          : String(error);
        emitChunk(turn, { text: '', done: true, error: message }, excludeTabId);
        // Audit fix #6: use error type instead of fragile string matching.
        // DeepSeekAuthError is thrown by the active-client layer on 401/invalid-token
        // responses; resetting the cached sessionId forces re-auth on the next turn.
        if (error instanceof DeepSeekAuthError) {
          chatSessionId = null;
        }
      }
    } finally {
      if (markerStarted) {
        try {
          // M1-2: 写终态 jobState
          await updateMarker({ jobState: 'succeeded' });
          await dependencies.markChatLoopFinished();
        } catch (error) {
          dependencies.reportError('chat_loop_finish_failed', error);
        }
      }
      const terminal = turn.terminal;
      const shouldPublishTerminal = Boolean(
        terminal
        && activeTurn === turn
        && turn.generation === generation
        && !turn.controller.signal.aborted,
      );
      if (activeTurn === turn) activeTurn = null;
      if (shouldPublishTerminal && terminal) {
        dependencies.broadcastChunk(terminal.chunk, terminal.excludeTabId);
      }
    }
  };

  const submitPrompt: ChatRuntimeService['submitPrompt'] = async (request, excludeTabId) => {
    // M1-2c H2: 用户新消息优先，取消延迟 arm 的 resume
    const cancelResume = (globalThis as unknown as { __dppResumeCancelled?: () => void }).__dppResumeCancelled;
    if (cancelResume) cancelResume();
    // 2026-10-22：并发检查提前到任何 await 之前。
    // 原来它在 ensureWakeReconciled() 之后，而那个 await 可能挂住；挂起期间
    // 后来的请求全都堵在同一个 promise 上，永远走不到「已有会话在跑」的快速返回。
    if (activeTurn || pendingAdmission || resetOperation) {
      return { ok: false, error: 'chat_already_running' };
    }
    await ensureWakeReconciled();
    // reconcile 期间可能有别的请求抢进来，再判一次。
    if (activeTurn || pendingAdmission || resetOperation) {
      return { ok: false, error: 'chat_already_running' };
    }

    const admission: PendingChatAdmission = { generation };
    pendingAdmission = admission;
    let enabled: boolean;
    try {
      enabled = await dependencies.getChatEnabled();
    } catch (error) {
      if (pendingAdmission !== admission || admission.generation !== generation) {
        return { ok: false, error: 'chat_already_running' };
      }
      pendingAdmission = null;
      throw error;
    }
    if (pendingAdmission !== admission || admission.generation !== generation || resetOperation) {
      return { ok: false, error: 'chat_already_running' };
    }
    if (!enabled) {
      pendingAdmission = null;
      return { ok: false, error: 'chat_disabled' };
    }
    if (!request.text.trim()) {
      pendingAdmission = null;
      return { ok: false, error: 'empty_prompt' };
    }

    const turn: ActiveChatTurn = {
      generation,
      capabilityScopeId: crypto.randomUUID(),
      controller: new AbortController(),
      settled: Promise.resolve(),
    };
    activeTurn = turn;
    pendingAdmission = null;
    turn.settled = runChatTurn(turn, request, excludeTabId);
    return { ok: true };
  };

  const runImageUpload = async (
    request: EncodedDeepSeekImageUploadRequest,
    controller: AbortController,
    excludeTabId?: number,
  ): Promise<{ ok: true; file: DeepSeekUploadedFile } | { ok: false; error: string }> => {
    // M-URL 修复：图片上传不需要 chat 功能启用，只需用户登录（有 client headers）
    assertSignalActive(controller.signal);

    // M-URL 修复：如果传入的是 URL，先在 background SW 中下载（不受页面 Mixed Content 限制）
    let uploadRequest = request;
    const url = typeof request.url === 'string' ? request.url : '';
    if (url && /^https?:\/\//i.test(url)) {
      try {
        // 审计 P2-62：与调用方 controller.signal 组合独立下载超时，防止某调用方
        // 未挂超时导致下载无限悬挂阻塞 SW。
        const DOWNLOAD_TIMEOUT_MS = 60_000;
        const downloadSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)]);
        const response = await fetch(url, { signal: downloadSignal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const contentType = response.headers.get('content-type') ?? '';
        const mimeType = contentType.split(';')[0]?.trim() ?? '';
        // 审计 P1-59：MIME 白名单 + 大小上限，避免把 text/html 等任意内容当图片
        // 传上游，也避免超大流在判大小前全量进内存。
        const ALLOWED_IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
        const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
        if (!ALLOWED_IMAGE_MIME.has(mimeType)) throw new Error(`Unsupported image MIME: ${mimeType || '(empty)'}`);
        const sourceBuffer = await response.arrayBuffer();
        if (sourceBuffer.byteLength > MAX_IMAGE_BYTES) {
          throw new Error(`Image too large: ${sourceBuffer.byteLength} bytes`);
        }
        let sizeBytes = sourceBuffer.byteLength;
        let finalMimeType = mimeType;
        let arrayBuffer = sourceBuffer;

        // M-URL 优化：图片降采样，避免大图占用过多上下文
        // 用户实测 width=256 时最稳妥，这里限制最大宽度 512px
        const MAX_IMAGE_WIDTH = 512;
        try {
          const imageBitmap = await createImageBitmap(new Blob([arrayBuffer], { type: mimeType }));
          if (imageBitmap.width > MAX_IMAGE_WIDTH) {
            const scale = MAX_IMAGE_WIDTH / imageBitmap.width;
            const newWidth = MAX_IMAGE_WIDTH;
            const newHeight = Math.round(imageBitmap.height * scale);
            const canvas = new OffscreenCanvas(newWidth, newHeight);
            const ctx = canvas.getContext('2d');
            if (ctx) {
              ctx.drawImage(imageBitmap, 0, 0, newWidth, newHeight);
              const resizedBlob = await canvas.convertToBlob({ type: 'image/png' });
              arrayBuffer = await resizedBlob.arrayBuffer();
              sizeBytes = arrayBuffer.byteLength;
              finalMimeType = 'image/png';
              // 审计 P2-61：删除生产 console.log 调试输出
            }
          }
          imageBitmap.close();
        } catch (resizeError) {
          // 降采样失败时使用原图，不阻断上传
          console.warn('[M-URL-SW] 图片降采样失败，使用原图:', resizeError);
        }

        // 转 base64
        const bytes = new Uint8Array(arrayBuffer);
        let binary = '';
        for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
        const base64 = btoa(binary);
        const dataUrl = `data:${finalMimeType};base64,${base64}`;
        const name = typeof request.name === 'string' && request.name.trim()
          ? request.name.trim()
          : url.split('/').pop()?.split('?')[0] || 'image.png';
        uploadRequest = {
          ...request,
          dataUrl,
          name,
          mimeType: finalMimeType,
          sizeBytes,
        };
      } catch (error) {
        console.warn('[M-URL-SW] 图片下载失败:', error);
        return { ok: false, error: `Failed to download image from URL: ${error instanceof Error ? error.message : String(error)}` };
      }
    }

    console.log('[M-URL-SW] 开始上传图片到 DeepSeek');
    const materialized = materializeDeepSeekImageUpload(uploadRequest);
    assertSignalActive(controller.signal);
    const headers = await dependencies.loadClientHeaders(excludeTabId);
    assertSignalActive(controller.signal);
    if (!headers) return { ok: false, error: dependencies.missingAuthMessage() };
    const powHeaders = await dependencies.createUploadPowHeaders(headers, controller.signal);
    assertSignalActive(controller.signal);
    const file = await dependencies.uploadFile({
      file: materialized.file,
      filename: materialized.name,
      modelType: 'vision',
      clientHeaders: headers,
      powHeaders,
    }, controller.signal);
    assertSignalActive(controller.signal);
    return { ok: true, file };
  };

  const uploadImage: ChatRuntimeService['uploadImage'] = async (request, excludeTabId) => {
    await ensureWakeReconciled();
    if (resetOperation) return { ok: false, error: 'chat_already_running' };

    const entry: ActiveChatUpload = {
      controller: new AbortController(),
      settled: Promise.resolve(),
    };
    activeUploads.add(entry);
    const operation = runImageUpload(request, entry.controller, excludeTabId);
    entry.settled = operation.then(() => undefined, () => undefined);
    try {
      return await operation;
    } finally {
      activeUploads.delete(entry);
    }
  };

  const performSessionReset = async (): Promise<void> => {
    generation += 1;
    pendingAdmission = null;
    const turn = activeTurn;
    const uploads = [...activeUploads];
    turn?.controller.abort(new DOMException('Chat session was reset.', 'AbortError'));
    for (const upload of uploads) {
      upload.controller.abort(new DOMException('Chat session was reset.', 'AbortError'));
    }
    await Promise.all([
      turn?.settled ?? Promise.resolve(),
      ...uploads.map((upload) => upload.settled),
    ]);
    chatSessionId = null;
    chatParentMessageId = null;
    officialApiChatMessages = [];
  };

  const beginSessionReset = (): Promise<void> => {
    if (resetOperation) return resetOperation;
    resetOperation = performSessionReset().finally(() => {
      resetOperation = null;
    });
    return resetOperation;
  };

  const resetSession = async (): Promise<void> => {
    const generationBeforeRecovery = generation;
    await ensureWakeReconciled();
    if (generation !== generationBeforeRecovery) return;
    await beginSessionReset();
  };

  const reconcileInterruptedOnWake = (): Promise<void> => {
    if (wakeReconciled) return Promise.resolve();
    if (wakeReconcileOperation) return wakeReconcileOperation;

    const operation = (async () => {
      // 续跑：先捕获当前 active loop marker（提供 chatSessionId 等续轮上下文），
      // 再创建 gate。controller 同时供工具执行与续轮请求共享中断信号。
      const resumeSnapshot = await getActiveChatLoop().catch(() => null);
      const resumeController = new AbortController();

      const resumeDeps: ResumeToolLoopDeps = {
        executeToolCall: async (call) => {
          const rawResult = await dependencies.executeToolCall(call, {
            signal: resumeController.signal,
          });
          return buildExecutionRecord(call, rawResult);
        },
        submitContinuation: async ({ parentMessageId, toolResults, signal }) => {
          // O1 去重（第十批 E2）：节流只保留 resume-tool-loop.ts 步内那一道
          // （贴近请求发送点、每步恰好一次）。此处再等会叠加成 5–13s/步。
          const headers = await dependencies.loadClientHeaders();
          if (!headers) throw new Error('resume_missing_client_headers');
          const modelType = await dependencies.getModelType();
          const continuationPrompt = dependencies.continueWithToolResults(toolResults);
          const { enabledDescriptors } = await dependencies.buildPrompt({
            prompt: continuationPrompt,
            isFirstMessage: false,
            messageCount: 1,
          });
          const powHeaders = await dependencies.createPowHeaders(headers, signal);

          let accumulated = '';
          const modelTurn = await dependencies.submitWebPrompt(
            {
              chatSessionId: resumeSnapshot?.chatSessionId ?? '',
              parentMessageId,
              modelType,
              prompt: continuationPrompt,
              refFileIds: [],
              thinkingEnabled: false,
              searchEnabled: false,
              clientHeaders: headers,
              powHeaders,
            },
            {
              onTextChunk: (_newText, fullText) => {
                accumulated = fullText;
              },
            },
            signal,
          );

          const assistantText = accumulated || modelTurn.assistantText;
          return {
            responseMessageId: modelTurn.responseMessageId == null
              ? null
              : String(modelTurn.responseMessageId),
            assistantText,
            finished: modelTurn.finished,
            toolCalls: extractToolCalls(assistantText, { descriptors: enabledDescriptors }),
          };
        },
        broadcastChunk: (chunk: { type: string; [key: string]: unknown }) => {
          dependencies.broadcastChunk({
            text: typeof chunk.text === 'string' ? chunk.text : '',
            done: chunk.done === true,
            phase: 'answer',
          });
        },
        finalize: async () => {
          await dependencies.markChatLoopFinished();
        },
        updateMarker: (patch) => updateMarker(patch),
      };

      const resumeRunner = {
        run: (plan: ResumeToolLoopPlan, signal: AbortSignal) =>
          runResumeToolLoop(plan, resumeDeps, signal),
      };

      const resumeGate = await createResumeGate({
        readFlags: async () => {
          try {
            const raw = await chrome.storage.session.get(RESUME_FLAGS_STORAGE_KEY) as Record<string, unknown>;
            return normalizeFlags(raw[RESUME_FLAGS_STORAGE_KEY]);
          } catch (error) {
            dependencies.reportError('resume_flags_read_failed', error);
            return normalizeFlags(undefined);
          }
        },
        readMarker: () => getActiveChatLoop(),
        legacyReconcile: async () => dependencies.reconcileInterruptedChatLoop(),
        reportError: (code, error) => dependencies.reportError(code, error),
        runner: resumeRunner,
        abortController: resumeController,
      });

      const interrupted = await resumeGate();
      if (interrupted) {
        await beginSessionReset();
        dependencies.broadcastChunk({
          text: '',
          done: true,
          error: dependencies.interruptedMessage(),
        });
      }
      wakeReconciled = true;
    })();
    wakeReconcileOperation = operation.finally(() => {
      wakeReconcileOperation = null;
    });
    return wakeReconcileOperation;
  };

  /**
   * reconcile 等待上限。
   *
   * 2026-10-22 修复：原实现直接 `await reconcileInterruptedOnWake()`，没有超时。
   * 该操作内部会等待 storage / 网络，一旦挂住（残留 marker、storage 异常、
   * 原生宿主无响应），`wakeReconcileOperation` 这个模块级共享 promise 就永远
   * 不 settle，而它又是**单例**的 —— 之后每次 submitPrompt 都复用同一个挂起
   * 的 promise，于是整个侧边栏对话永久不可用，UI 只显示「...」且零诊断。
   *
   * 真机复现过：手工写入一个残留的 active-loop marker 后即触发此状，
   * 只能清 storage + 重载扩展才恢复。
   */
  const WAKE_RECONCILE_TIMEOUT_MS = 5_000;

  async function ensureWakeReconciled(): Promise<void> {
    if (wakeReconciled) return;
    await waitForWakeReconcile({
      reconcile: () => reconcileInterruptedOnWake(),
      timeoutMs: WAKE_RECONCILE_TIMEOUT_MS,
      scheduleTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
      clearScheduledTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
      onTimeout: () => {
        console.warn('[dpp] wake reconcile timed out, continuing without it');
        diagnosticLogBuffer.record({
          level: 'warn',
          source: 'chat-runtime',
          message: 'wake_reconcile_timeout',
          details: `exceeded ${WAKE_RECONCILE_TIMEOUT_MS}ms; continuing without resume reconcile`,
        });
      },
    });
  }

  return Object.freeze({
    submitPrompt,
    uploadImage,
    resetSession,
    reconcileInterruptedOnWake,
  });
}

// 报告 R4 修复：侧面板工具结果序列化加截断，与 inline-agent renderToolResult 语义一致
// M1-2c D1: MAX_CHAT_TOOL_STEPS / serializeToolExecutions / clampSidebarText
// 已抽到 core/chat/loop-contract.ts，与续跑循环共享

function isExpectedCancellation(
  turn: ActiveChatTurn,
  activeTurn: ActiveChatTurn | null,
  generation: number,
): boolean {
  return turn.controller.signal.aborted
    || activeTurn !== turn
    || turn.generation !== generation;
}

function assertSignalActive(signal: AbortSignal): void {
  if (!signal.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new DOMException('Chat operation was cancelled.', 'AbortError');
}

/**
 * 把 runtime 返回的 ToolResult 映射成持久化用的 ToolExecutionRecord。
 * 纯函数：正常工具循环与续跑（resume）共用，禁止 `as unknown as` 强转。
 */
function buildExecutionRecord(call: ToolCall, rawResult: ToolResult): ToolExecutionRecord {
  return {
    name: rawResult.name ?? call.name,
    provider: rawResult.provider ?? call.provider,
    descriptorId: rawResult.descriptorId ?? call.descriptorId,
    result: {
      ok: rawResult.ok,
      name: rawResult.name,
      provider: rawResult.provider,
      descriptorId: rawResult.descriptorId,
      summary: rawResult.summary,
      detail: rawResult.detail,
      output: rawResult.output,
      truncated: rawResult.truncated,
      error: rawResult.error,
    },
  };
}
