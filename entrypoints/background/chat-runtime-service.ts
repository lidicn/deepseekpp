import type { OfficialApiChatConfig } from '../../core/chat/official-api-config-contract';
import type { ChatLoopProvider, InterruptedChatLoop } from '../../core/chat/active-loop';
// P0-3: 工具执行状态持久化 helper
import { appendToolExecution, clearCurrentTool, setCurrentTool, updateMarker } from '../../core/chat/active-loop';
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

import { MAX_CHAT_TOOL_STEPS, serializeToolExecutions } from '../../core/chat/loop-contract';

export interface ChatStreamChunk {
  text: string;
  done: boolean;
  error?: string;
  reasoningText?: string;
  phase?: 'reasoning' | 'answer';
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
  ): Promise<ToolExecutionRecord> => {
    assertTurnActive(turn);

    // P0-3: 持久化当前工具执行状态（fire-and-forget，失败不阻塞）
    void setCurrentTool(call.name).catch(() => {});

    let result: ToolExecutionRecord;
    try {
      const rawResult = await dependencies.executeToolCall(call, {
        signal: turn.controller.signal,
        assertActive: () => assertTurnActive(turn),
        trustedCapabilityScopeId: turn.capabilityScopeId,
      });
      assertTurnActive(turn);
      if (!rawResult.ok && rawResult.error?.details?.externalOutcome === 'ambiguous') {
        throw new Error(rawResult.error.message || rawResult.detail || rawResult.summary);
      }
      result = {
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
    } finally {
      // P0-3: 清除当前工具标记 + 追加到历史
      void clearCurrentTool().catch(() => {});
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

    for (let step = 0; step < MAX_CHAT_TOOL_STEPS; step++) {
      assertTurnActive(turn);
      let accumulated = '';
      const powHeaders = await dependencies.createPowHeaders(
        currentInput.clientHeaders,
        turn.controller.signal,
      );
      assertTurnActive(turn);
      const result = await dependencies.submitWebPrompt({
        ...currentInput,
        powHeaders,
      }, {
        onTextChunk(newText, fullText) {
          accumulated = fullText;
          emitChunk(turn, { text: newText, done: false, phase: 'answer' }, excludeTabId);
        },
        // The web stream routes THINK-fragment deltas through the reasoning
        // channel (they are excluded from the text channel since the
        // stream-codec split); forward them like the official-API loop so the
        // sidepanel keeps showing the thinking process.
        onReasoningChunk(newText) {
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
      if (!fullText) {
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
          console.log('[chat-runtime] truncated stream without tool calls, auto-continuing', { step });
          currentInput = {
            ...currentInput,
            prompt: dependencies.continueWithToolResults('(stream interrupted, no new tool results — please continue completing your answer)'),
            parentMessageId: chatParentMessageId,
          };
          continue;
        }
        emitChunk(turn, {
          text: fullText,
          done: true,
          error: result.finished ? undefined : 'stream_interrupted',
        }, excludeTabId);
        return;
      }

      const executions: ToolExecutionRecord[] = [];
      for (const call of toolCalls) executions.push(await executeChatTool(turn, call));
      const continuationPrompt = dependencies.continueWithToolResults(
        serializeToolExecutions(executions),
      );
      currentInput = {
        ...currentInput,
        prompt: continuationPrompt,
        parentMessageId: chatParentMessageId,
      };
    }

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

    for (let step = 0; step < MAX_CHAT_TOOL_STEPS; step++) {
      assertTurnActive(turn);
      let accumulated = '';
      let reasoningAccumulated = '';
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
        if (!result.finished) {
          console.log('[chat-runtime] official-api truncated stream without tool calls, auto-continuing', { step });
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
      for (const call of toolCalls) executions.push(await executeChatTool(turn, call));
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
    await ensureWakeReconciled();
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
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const contentType = response.headers.get('content-type') ?? 'image/png';
        const mimeType = contentType.split(';')[0]?.trim() ?? 'image/png';
        let arrayBuffer = await response.arrayBuffer();
        let sizeBytes = arrayBuffer.byteLength;
        let finalMimeType = mimeType;

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
              console.log('[M-URL-SW] 图片降采样:', { originalWidth: imageBitmap.width, originalHeight: imageBitmap.height, newWidth, newHeight, originalSize: sizeBytes, newSize: arrayBuffer.byteLength });
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
      const interrupted = await dependencies.reconcileInterruptedChatLoop();
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

  async function ensureWakeReconciled(): Promise<void> {
    if (wakeReconciled) return;
    await reconcileInterruptedOnWake();
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
