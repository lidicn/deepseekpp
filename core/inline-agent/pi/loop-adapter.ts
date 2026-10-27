/**
 * pi-agent-core loop adapter (Issue A3-T1, B2-T5 dual backend).
 *
 * Drives the pi `runAgentLoop` over the selected model backend's StreamFn
 * and tool bridge, translating pi AgentEvents into the released AGENT_*
 * page protocol (locked by `tests/inline-agent-event-protocol-golden.test.ts`):
 *
 *  - one model request = one pi turn; a "step" = a request plus at most one
 *    nudge request (the released nudge semantics);
 *  - text deltas → AGENT_STREAM_CHUNK (12k clamp), tool execution start →
 *    AGENT_TOOL_DETECTED, step end → AGENT_STEP_COMPLETE, run end →
 *    AGENT_LOOP_COMPLETE / AGENT_LOOP_ERROR, abort → silent complete;
 *  - chain authority depends on the backend (B2):
 *      * `web` (default, released): the DS page conversation chain —
 *        `parentMessageId` lives in session state, tool calls without a
 *        continuable chain are blocked (beforeToolCall) and surfaced as an
 *        error, matching the original loop;
 *      * `official-api`: no page chain exists — the pi Context transcript
 *        IS the chain, so fail-closed checks verify the Context carries a
 *        valid assistant message before tools run.
 *
 * The released wire prompt contract (`<original_task>`/`<tool_results>`/
 * `<task_complete>`/nudge prompts) is preserved on the web path via
 * `buildContinuationPrompt` / `buildNudgePrompt` — pi's own prompt templates
 * are never used. The official-API path sends the pi Context as
 * OpenAI-compatible messages (mapMessages), which is the backend's native
 * shape; no page-injection template is involved either way.
 */
import type { Api, AssistantMessage, Model, Message, ToolResultMessage } from '@earendil-works/pi-ai';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { StreamFn, AgentEvent, AgentLoopConfig } from '@earendil-works/pi-agent-core';
import { runAgentLoop } from '@earendil-works/pi-agent-core';
import { DEFAULT_LOCALE, translate, type SupportedLocale } from '../../i18n';
import type { ToolCall, ToolDescriptor, ToolExecutionRecord, ToolProviderIdentity } from '../../types';
import { createClientHeaders } from '../../deepseek/adapter';
import { getDeepSeekApiKey } from '../../chat/api-key';
import { getOfficialApiChatConfig } from '../../chat/official-api-config';
import { createDeepSeekTurnSubmitter } from './deepseek-stream-fn';
import { createDeepSeekWebProvider, deepSeekWebProviderToStreamFn } from './deepseek-web-provider';
import { createDeepSeekApiProvider, createDeepSeekApiMessageMapper, deepSeekApiProviderToStreamFn } from './official-api-provider';
import type { DeepSeekSessionState, DeepSeekStreamFnDeps } from './stream-fn-port';
import {
  createPiAgentTools,
  createPiLoopBudgetMap,
  piToolResultToExecutionRecord,
} from './tool-bridge';
import { webHasContinuableChain } from './chain-continuation';
import {
  buildContinuationPrompt,
  buildNudgePrompt,
  extractTaskCompleteSignal,
  shouldNudge,
} from '../prompt';
import { stripRetiredArtifactProtocolBlocks } from '../retired-artifact';
import type {
  InlineAgentStartPayload,
  InlineAgentReasoningChunkMsg,
  InlineAgentStepCompleteMsg,
  InlineAgentStreamChunkMsg,
  InlineAgentToolDetectedMsg,
} from '../types';
import { INLINE_AGENT_MAX_STEPS } from '../types';
import { waitBetweenDeepSeekRequests } from '../step-control';

export type PostFn = (type: string, data: unknown) => void;
export type ExecuteToolFn = (call: ToolCall, signal?: AbortSignal) => Promise<ToolExecutionRecord>;

const INLINE_AGENT_STREAM_EVENT_MAX_CHARS = 12000;
const TRUNCATION_SUFFIX = '\n...[truncated]';

export interface PiLoopAdapterDeps {
  payload: InlineAgentStartPayload;
  post: PostFn;
  executeTool: ExecuteToolFn;
  signal: AbortSignal;
  /** M-URL 修复：传入图片 URL，由 background SW 下载并上传到 DeepSeek，返回 file_id */
  uploadImage?: (input: { url: string; name: string }) => Promise<string | null>;
}

/** Runs the pi engine with the released inline-agent semantics. */
export async function runPiInlineAgentLoop(deps: PiLoopAdapterDeps): Promise<void> {
  const { payload, post, executeTool, signal } = deps;
  const { loopId, chatSessionId, toolDescriptors, promptOptions } = payload;
  const { powWasmUrl } = payload;
  const locale = payload.locale ?? DEFAULT_LOCALE;

  // ------------------------------------------------------------------ state
  const session: DeepSeekSessionState = {
    chatSessionId,
    parentMessageId: payload.parentMessageId,
    setParentMessageId: (id) => {
      session.parentMessageId = id;
    },
  };

  // Chain authority by backend (B2): the web path uses the DS page session
  // chain (`parentMessageId`); the official-API path has no page chain — the
  // pi Context transcript IS the chain, so `hasContinuableChain` is
  // trivially true there and fail-closed checks verify the Context carries a
  // valid assistant message instead (beforeToolCall).
  const backend = payload.modelBackend ?? 'web';
  const hasContinuableChain = (): boolean => {
    if (backend === 'official-api') return true;
    return session.parentMessageId !== null;
  };
  // 痛点 1-B：工具执行链放行——首轮（stepIndex===0）即使页面链 parentMessageId
  // 尚未建立也放行第一步工具调用；第二轮起严格要求 parentMessageId（不削弱 R2）。
  // 仅用于工具路径（beforeToolCall / turn_end 工具校验 / shouldStopAfterTurn 有工具分支），
  // 绝不用于无工具收尾判定，避免把"无 id 的纯文本最终答案"误判为可续。
  const canRunTools = (): boolean => {
    if (backend === 'official-api') return true;
    return webHasContinuableChain({
      stepIndex,
      parentMessageId: session.parentMessageId,
    });
  };
  const chainResponseMessageId = (): number | null =>
    backend === 'official-api' ? null : session.parentMessageId;
  const collectedExecutions: ToolExecutionRecord[] = [...payload.toolExecutions];
  const executedInStep: ToolExecutionRecord[] = [];
  // M-URL 修复：待加入下一次请求 refFileIds 的图片 file_id 列表
  const pendingImageFileIds: string[] = [];
  // R2 修复：图片物化在后台跑，不阻塞 turn_end；下一次请求前 await 汇合
  let pendingImageMaterialization: Promise<void> | null = null;
  const descriptorByName = new Map<string, ToolDescriptor>(toolDescriptors.map((d) => [d.invocationName, d]));
  const nudge = {
    active: false, // serializer should build a nudge prompt for the current turn
    pendingTurn: false, // prepareNextTurn queued a nudge; the next turn is a nudge turn
    currentTurnIsNudge: false, // the turn now streaming is a nudge turn
    nudgedInStep: false, // this step already consumed its single nudge
    nudgedOnContinuation: false, // gave one extra nudge after the nudge turn still nudging (续一轮)
    count: 0, // total nudges issued (token-speed request ids)
    lastAssistantText: '',
  };

  let stepIndex = 0; // completed steps (0-based index of the current step)
  let lastStepCompleted = false; // whether the current step already posted STEP_COMPLETE
  let stepText = ''; // current turn's visible text
  let lastPostedText = '';
  let stepReasoning = ''; // current step's accumulated reasoning text (per-turn thinking deltas)
  let lastPostedReasoning = '';
  let finalizeDone = false;
  let resolvedFinalText: string | null = null;
  let stopNotice: string | null = null;
  let lastTurnWasError = false;
  let lastErrorMessage = '';
  let lastTurnText = '';
  let lastTurnHasTools = false;
  let turnsElapsed = 0;
  let parentMessageIdAtTurnStart: number | null = null;

  const clampStreamEventText = (value: string): string =>
    value.length > INLINE_AGENT_STREAM_EVENT_MAX_CHARS
      ? `${value.slice(0, INLINE_AGENT_STREAM_EVENT_MAX_CHARS)}${TRUNCATION_SUFFIX}`
      : value;

  const postStreamChunk = (nextText: string) => {
    const fullText = clampStreamEventText(nextText);
    if (fullText === lastPostedText) return;
    lastPostedText = fullText;
    post('AGENT_STREAM_CHUNK', {
      loopId,
      stepIndex,
      text: '',
      fullText,
    } satisfies InlineAgentStreamChunkMsg);
  };

  const postReasoningChunk = (nextReasoning: string) => {
    const fullText = clampStreamEventText(nextReasoning);
    if (fullText === lastPostedReasoning) return;
    lastPostedReasoning = fullText;
    post('AGENT_REASONING_CHUNK', {
      loopId,
      stepIndex,
      fullText,
    } satisfies InlineAgentReasoningChunkMsg);
  };

  const postStepComplete = () => {
    post('AGENT_STEP_COMPLETE', {
      loopId,
      stepIndex,
      responseMessageId: chainResponseMessageId(),
      toolExecutions: [...executedInStep],
    } satisfies InlineAgentStepCompleteMsg);
  };

  const postToolDetected = (toolCallId: string, toolName: string, args: unknown) => {
    const descriptor = descriptorByName.get(toolName);
    post('AGENT_TOOL_DETECTED', {
      loopId,
      stepIndex,
      call: {
        id: toolCallId,
        name: descriptor?.name ?? toolName,
        invocationName: toolName,
        payload: (args ?? {}) as Record<string, unknown>,
        raw: '',
      },
    } satisfies InlineAgentToolDetectedMsg);
  };

  const providerFor = (toolName: string): ToolProviderIdentity =>
    descriptorByName.get(toolName)?.provider ?? {
      kind: 'local',
      id: 'unknown',
      displayName: 'Unknown',
      transport: 'in_process',
    };

  // ------------------------------------------------------------- DS backend
  // Shared per-run stream wiring: model selection + pacing wrapper. The web
  // path keeps the released semantics byte-for-byte (golden); the
  // official-api path is a peer backend over the same pi loop.
  let requestCount = 0;
  const mapToolCall = (call: { name: string; invocationName: string; payload: Record<string, unknown> }, index: number) => ({
    type: 'toolCall' as const,
    // XML indexes restart at zero for every model response. A single inline
    // run intentionally reuses one background authorization grant, so the raw
    // `xml:${index}` id made the first tool in turn 2 look like a replay of the
    // first tool in turn 1. Bind the id to the model-request sequence while
    // keeping it stable for any parsing/retry inside that same request.
    id: `turn:${requestCount}:xml:${index}`,
    name: call.invocationName,
    arguments: call.payload,
  });

  let streamFn: StreamFn;
  let model: Model<Api>;
  if (backend === 'official-api') {
    // B2: official API backend. No page chain: the pi Context transcript is
    // the chain (fail-closed checks in beforeToolCall/shouldStopAfterTurn
    // use the Context, see below).
    const provider = createDeepSeekApiProvider({
      getApiKey: () => getDeepSeekApiKey(),
      getConfig: () => getOfficialApiChatConfig(),
      mapMessages: createDeepSeekApiMessageMapper(),
    }, {
      toolDescriptors,
      mapToolCall,
    });
    model = provider.getModels()[0];
    streamFn = deepSeekApiProviderToStreamFn(provider);
  } else {
    const submitter = createDeepSeekTurnSubmitter({ powWasmUrl });
    const streamFnDeps = {
      submitTurn: submitter,
      session,
      serializePrompt: () => {
        if (nudge.active) {
          nudge.active = false;
          nudge.currentTurnIsNudge = true;
          return buildNudgePrompt(payload.originalPrompt, nudge.lastAssistantText, collectedExecutions, nudge.count, locale);
        }
        return buildContinuationPrompt(payload.originalPrompt, collectedExecutions, locale, toolDescriptors);
      },
      mapToolCall,
      toolDescriptors,
      turnDefaults: {
        modelType: promptOptions.modelType,
        // M-URL 修复：动态合并待处理的图片 file_id
        //
        // 审计 #27（2026-10-24 报告 P1）——**按需加载，挂载一次即消费**。
        //
        // 本文件的设计注释（见 :747「file_id 会被加入 pendingImageFileIds，
        // 在**下一次请求**时通过 refFileIds 传递给模型」、以及 :121）写得很清楚：
        // 这些 id 只需要进**紧接着的那一次**请求。但原实现只合并、从不清空 ——
        // 于是第 N 轮的图片会被第 N+1、N+2…轮的请求**反复重挂**，
        // 循环越长请求体越大（每多一轮就多挂一次全部历史图片）。
        //
        // 现在合并后立刻清空：**本次请求拿到的就是全部待挂载图片，下一轮不会重复**。
        // 历史轮次的图片由服务端会话保留，不需要客户端重复上传。
        //
        // ⚠ 已知边界：若同一轮请求**重试**，重试时 pending 已空 ⇒ 拿不到这些图片。
        //    权衡：重试路径罕见，而"每轮重复挂载全部历史图片"是每轮必发生。
        //    若将来重试变常见，改成"按 step 记已认领快照"即可（约 30 行）。
        get refFileIds() {
          return takePendingImageFileIds(promptOptions.refFileIds, pendingImageFileIds);
        },
        thinkingEnabled: promptOptions.thinkingEnabled,
        searchEnabled: promptOptions.searchEnabled,
      },
      onTokenSpeed: (progress) => {
        post('AGENT_TOKEN_SPEED', {
          ...progress,
          requestId: `agent:${loopId}:step:${stepIndex}${nudge.currentTurnIsNudge ? `:nudge:${nudge.count}` : ''}`,
          chatSessionId,
          modelType: progress.modelType ?? promptOptions.modelType,
        });
      },
    } satisfies DeepSeekStreamFnDeps;

    // The deepseek-web backend is registered as a first-class pi-ai provider
    // (B1): the loop consumes the released `runAgentLoop` seam through
    // `provider.stream` instead of a hand-built StreamFn. The provider owns no
    // session state (the injected `session` is the chain authority) and its
    // auth surface is ambient: `createClientHeaders` resolves the page session
    // headers or throws when the login token is missing — provider auth
    // resolution reports that as "not configured".
    const provider = createDeepSeekWebProvider({
      ...streamFnDeps,
      resolveAuthHeaders: () => {
        try {
          return createClientHeaders();
        } catch {
          return undefined;
        }
      },
    });
    model = provider.getModels()[0];
    streamFn = deepSeekWebProviderToStreamFn(provider);
  }

  // One 2.5–6.5s throttle delay before every DS request except the first
  // (released request pacing).
  const pacedStreamFn: StreamFn = async (model, context, options) => {
    // R2 修复：等待上一步的后台图片物化完成，确保 pendingImageFileIds 已填充
    if (pendingImageMaterialization) {
      await pendingImageMaterialization;
      pendingImageMaterialization = null;
    }
    if (requestCount > 0) {
      await waitBetweenDeepSeekRequests(signal);
    }
    requestCount += 1;
    return streamFn(model, context, options);
  };

  const piTools = createPiAgentTools({
    descriptors: toolDescriptors,
    executeTool,
    callSource: {
      requestId: payload.capabilityScopeRequestId ?? `agent:${loopId}`,
      chatSessionId,
    },
  });

  const budget = createPiLoopBudgetMap();
  const config: AgentLoopConfig = {
    model,
    toolExecution: 'sequential',
    convertToLlm: (messages: AgentMessage[]): Message[] =>
      messages.filter((m) => m.role === 'user' || m.role === 'assistant' || m.role === 'toolResult'),
    shouldStopAfterTurn: ({ message }) => {
      lastTurnText = extractText(message);
      lastTurnHasTools = message.content.some((block) => block.type === 'toolCall');
      if (stepIndex >= budget.maxSteps) {
        if (stopNotice === null && collectedExecutions.length > 0) {
          stopNotice = buildInlineAgentBudgetNotice(locale, stepIndex);
        }
        return true;
      }
      // Partial completion (stream cut mid-response, stopReason='length'):
      // the turn already emitted recoverable partial text. End normally
      // instead of nudging for another round — the next user turn or a
      // follow-up request can resume the chain. Without this short-circuit
      // the loop would treat the partial text as an incomplete answer and
      // nudge, then re-call the stream and hang when the mock is exhausted.
      if (message.stopReason === 'length' && !lastTurnHasTools) {
        resolvedFinalText = lastTurnText;
        return true;
      }
      const text = lastTurnText;
      const hasTools = lastTurnHasTools;

      if (hasTools) {
        // 工具链放行：首轮放行第一步工具（痛点 1-B）；第二轮起 parentMessageId 丢失则阻断（R2）。
        if (!canRunTools()) {
          throw new Error(chainErrorText(nudge.currentTurnIsNudge));
        }
        return false;
      }
      // 无工具收尾：空文本无论 chain 状态都是错误——模型这一轮没产出任何
      // 可展示内容也没产生新 message id（responseMessageId=null），继续 nudge
      // 只会让 mock/真实流在第二轮挂起（已提交测试 line 227/249/278 复现）。
      if (!text.trim()) {
        throw new Error('DeepSeek returned an empty agent continuation without a continuable response message.');
      }
      if (!hasContinuableChain()) {
        resolvedFinalText = text;
        return true;
      }

      if (extractTaskCompleteSignal(text)) {
        resolvedFinalText = text;
        return true;
      }
      // Nudge decisions run on the USER-VISIBLE text: retired artifact XML
      // (an internal control protocol the loop cannot execute) is stripped
      // first, so a turn whose visible tail still promises a deliverable
      // ("now creating a report for you" with nothing renderable following)
      // is nudged instead of ending on an empty promise — the deliverable
      // must never be silently swallowed.
      const nudging = shouldNudge(
        payload.originalPrompt,
        collectedExecutions,
        stripRetiredArtifactProtocolBlocks(text),
      );
      if (nudge.currentTurnIsNudge) {
        if (nudging) {
          // The model promised a deliverable but still hasn't produced tools.
          // Allow ONE more continuation after a nudge turn (续一轮): if the
          // NEXT turn ALSO still needs nudging, we stop with a budget notice.
          // This is the "保留上下文再续一轮" recovery from the断流修复 —
          // the model gets exactly one more chance to deliver, no more.
          if (!nudge.nudgedOnContinuation) {
            nudge.nudgedOnContinuation = true;
            nudge.nudgedInStep = false; // reset so getSteeringMessages fires
            return false;
          }
          // Already gave one extra round — stop gracefully with notice.
          stopNotice = buildInlineAgentBudgetNotice(locale, stepIndex + 1);
        } else {
          resolvedFinalText = text;
        }
        return true;
      }
      if (nudging) return false; // getSteeringMessages issues the single-step nudge
      resolvedFinalText = text;
      return true;
    },
    // The pi inner loop only continues with another LLM call when tools were
    // executed or steering messages are pending. The released nudge semantics
    // (one no-tool correction request per step) are implemented as steering:
    // after a no-tool turn that still needs nudging, shouldStopAfterTurn
    // returns false and getSteeringMessages returns the nudge prompt message.
    getSteeringMessages: async () => {
      // The pi loop polls steering before the first turn too; the released
      // nudge semantics only apply after a real turn has run.
      if (turnsElapsed === 0) return [];
      if (!lastTurnHasTools && !nudge.nudgedInStep && hasContinuableChain()
        && !extractTaskCompleteSignal(lastTurnText)
        && shouldNudge(
          payload.originalPrompt,
          collectedExecutions,
          stripRetiredArtifactProtocolBlocks(lastTurnText),
        )) {
        // R4 修复：nudge 受 maxNudges 封顶（之前是死字段，只增不减）
        if (nudge.count >= budget.maxNudges) {
          console.warn(`[inline-agent] nudge budget exhausted (${nudge.count}/${budget.maxNudges}), stopping nudges`);
          return [];
        }
        nudge.count += 1;
        nudge.nudgedInStep = true;
        nudge.pendingTurn = true;
        nudge.active = true;
        // The nudge shows the model what the USER saw: retired artifact XML
        // is internal protocol, so the model sees the visible tail (e.g. the
        // empty promise) and re-delivers in a renderable form.
        nudge.lastAssistantText = stripRetiredArtifactProtocolBlocks(lastTurnText);
        return [{
          role: 'user',
          content: buildNudgePrompt(
            payload.originalPrompt,
            nudge.lastAssistantText,
            collectedExecutions,
            nudge.count,
            locale,
          ),
          timestamp: Date.now(),
        }];
      }
      return [];
    },
    beforeToolCall: async ({ context }) => {
      // 痛点 1-B：首轮工具放行（canRunTools），第二轮起严格（R2）。
      if (!canRunTools()) {
        return { block: true, reason: chainErrorText(nudge.currentTurnIsNudge) };
      }
      // The model returned tool calls but this turn did NOT establish a new
      // responseMessageId (session.parentMessageId unchanged since turn start).
      // These tools are outside the conversation chain — block before execution
      // (tests 249/278: executeTool must never fire for a chain-less tool turn).
      if (
        backend === 'web' &&
        parentMessageIdAtTurnStart !== null &&
        parentMessageIdAtTurnStart === session.parentMessageId
      ) {
        return { block: true, reason: chainErrorText(nudge.currentTurnIsNudge) };
      }
      // Official-API backend: the pi Context transcript IS the chain, so
      // also fail closed unless the Context carries a valid assistant
      // message (the model actually produced a turn before tools run).
      if (backend === 'official-api' && !contextHasAssistantMessage(context)) {
        return { block: true, reason: chainErrorText(nudge.currentTurnIsNudge) };
      }
      return undefined;
    },
  };

  // --------------------------------------------------------------- event sink
  const handleEvent = async (event: AgentEvent): Promise<void> => {
    switch (event.type) {
      case 'turn_start':
        nudge.currentTurnIsNudge = false;
        // Released semantics: each request's visible text replaces the
        // previous one within a step (nudge text is not concatenated).
        stepText = '';
        lastPostedText = '';
        // Snapshot the chain id at turn start; in turn_end we compare it
        // against the current parentMessageId to detect whether this turn
        // actually produced a new responseMessageId. Tools returned in a
        // turn that did NOT establish a new id (responseMessageId=null) are
        // outside the conversation chain and must be refused (tests 249/278).
        parentMessageIdAtTurnStart = session.parentMessageId;
        // Post-abort the pi engine may still start one more turn after a
        // tool batch; the released loop never emits that ghost step.
        if (signal.aborted && turnsElapsed > 0) return;
        if (nudge.pendingTurn) {
          nudge.pendingTurn = false;
        } else {
          lastStepCompleted = false;
          stepReasoning = '';
          lastPostedReasoning = '';
          post('AGENT_STEP_STARTED', { loopId, stepIndex });
        }
        break;
      case 'message_update': {
        const assistantEvent = event.assistantMessageEvent;
        const delta = assistantEvent.type === 'text_delta' ? assistantEvent.delta : '';
        if (delta) {
          stepText += delta;
          postStreamChunk(stepText);
        }
        if (assistantEvent.type === 'thinking_delta' && assistantEvent.delta) {
          stepReasoning += assistantEvent.delta;
          postReasoningChunk(stepReasoning);
        }
        break;
      }
      case 'tool_execution_start':
        postToolDetected(event.toolCallId, event.toolName, event.args);
        break;
      case 'tool_execution_end': {
        const descriptor = descriptorByName.get(event.toolName);
        const resultMessage: ToolResultMessage = {
          role: 'toolResult',
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          content: [{ type: 'text', text: extractResultText(event.result) }],
          details: (event.result as { details?: unknown } | undefined)?.details,
          isError: event.isError,
          timestamp: Date.now(),
        };
        executedInStep.push(piToolResultToExecutionRecord({
          toolName: descriptor?.name ?? event.toolName,
          provider: providerFor(event.toolName),
          message: resultMessage,
        }));
        break;
      }
      case 'turn_end': {
        turnsElapsed += 1;
        const turnMessage = event.message as AssistantMessage;
        if (turnMessage.stopReason === 'error' || turnMessage.stopReason === 'aborted') {
          lastTurnWasError = true;
          lastErrorMessage = turnMessage.errorMessage ?? 'DeepSeek agent turn failed.';
          stepText = '';
          lastPostedText = '';
          // R4-N2: 失败 turn 里 tool_execution_end 已 push 进 executedInStep，但既没进
          // collectedExecutions 也没清；下一个成功 turn 的 hasTools 分支会把这些残留
          // 重复计入，导致 nudge/continuation prompt 出现重复工具结果、模型重复执行。
          executedInStep.length = 0;
          return;
        }
        const hasTools = turnMessage.content.some((block) => block.type === 'toolCall');
        if (hasTools) {
          // Fail-closed: tools without a continuable chain were blocked in
          // beforeToolCall; surface the refusal as the released error.
          // 首轮放行（canRunTools）；第二轮起 parentMessageId 丢失仍阻断（R2）。
          if (!canRunTools()) {
            throw new Error(chainErrorText(nudge.currentTurnIsNudge));
          }
          // The model returned tool calls but the turn did NOT establish a new
          // responseMessageId (session.parentMessageId unchanged from turn start).
          // These tools are outside the conversation chain — refuse to execute
          // them (tests 249/278). canRunTools()'s first-turn exemption only
          // applies when the turn actually produces a chained message id.
          // B9 fix: official-api backend has no page chain (session.parentMessageId
          // stays null), so this guard must be web-only — otherwise every turn
          // throws and tool execution is completely blocked.
          if (
            backend === 'web' &&
            parentMessageIdAtTurnStart !== null &&
            parentMessageIdAtTurnStart === session.parentMessageId
          ) {
            throw new Error(chainErrorText(nudge.currentTurnIsNudge));
          }
          collectedExecutions.push(...executedInStep);
          // R2 修复：图片物化移出阻塞路径。先推进 UI 与预算，物化在后台跑；
          // 下一次 LLM 请求前在 pacedStreamFn 里 await 汇合，确保 refFileIds 已填充。
          postStepComplete();
          stepIndex += 1;
          pendingImageMaterialization = materializeAndUploadToolResultImages(
            executedInStep,
            deps.uploadImage,
            pendingImageFileIds,
          ).catch((error) => {
            console.warn('[M-URL] 后台图片物化异常:', error);
          });
          lastStepCompleted = true;
          stepText = '';
          lastPostedText = '';
          executedInStep.length = 0;
          nudge.nudgedInStep = false;
        } else {
          stepText = extractText(turnMessage);
          postStreamChunk(stepText);
        }
        break;
      }
      case 'agent_end':
        finalize();
        break;
      default:
        break;
    }
  };

  const finalize = () => {
    if (finalizeDone) return;
    finalizeDone = true;

    // An abort is a silent COMPLETE even after an errored turn: `signal.aborted`
    // alone gates this branch (the removed `lastTurnWasError && signal.aborted`
    // term was dead code — `||` already short-circuits on `signal.aborted`).
    if (signal.aborted) {
      post('AGENT_LOOP_COMPLETE', {
        loopId,
        totalSteps: stepIndex,
        totalTools: collectedExecutions.length,
        finalText: '',
        // W29: 标注这是 abort 导致的静默结束（不是模型没产出），否则无法与
        // 「正常但空答案」区分，断流取证会失去方向。
        stopReason: 'aborted',
      });
      return;
    }
    if (lastTurnWasError) {
      post('AGENT_LOOP_ERROR', {
        loopId,
        stepIndex,
        totalTools: collectedExecutions.length,
        error: lastErrorMessage,
        stopReason: 'turn_error',
      });
      return;
    }
    if (stopNotice === null && resolvedFinalText === null && collectedExecutions.length > 0
      && stepIndex >= INLINE_AGENT_MAX_STEPS) {
      stopNotice = buildInlineAgentBudgetNotice(locale, stepIndex);
    }
    if (!lastStepCompleted) {
      postStepComplete();
    }
    // 2026-10-22 修复 Bug A：走到这里意味着「既没有模型给出的最终文本，
    // 也没有预算提示」——此前 finalText 保持空串，却仍以
    // stopReason:'finalized' 对外宣称完成。用户侧看到的就是
    // 「工具跑完了，但什么都没有」，零解释、零诊断。
    // 真机证据：trace 记录 status='complete' 而 finalTextLen=0。
    //
    // 注意判空用 trim()：resolvedFinalText 可能是空串（不是 null），
    // 例如失败 turn 被清成 stepText='' 的那条路径。
    const hasFinalText = resolvedFinalText !== null && resolvedFinalText.trim().length > 0;
    let finalText = '';
    if (hasFinalText) {
      finalText = resolvedFinalText as string;
    } else if (!signal.aborted && stopNotice !== null) {
      finalText = stopNotice;
    } else if (!signal.aborted) {
      finalText = translate(locale, 'content.agent.emptyOutcome');
    }
    post('AGENT_LOOP_COMPLETE', {
      loopId,
      totalSteps: lastStepCompleted ? stepIndex : stepIndex + 1,
      totalTools: collectedExecutions.length,
      finalText,
      stopReason: 'finalized',
    });
  };

  // ------------------------------------------------------------------- run
  try {
    const initialMessage: Message = {
      role: 'user',
      content: payload.originalPrompt,
      timestamp: Date.now(),
    };
    await runAgentLoop(
      [initialMessage],
      { systemPrompt: '', messages: [], tools: piTools },
      config,
      handleEvent,
      signal,
      pacedStreamFn,
    );
  } catch (err) {
    if (finalizeDone) return;
    finalizeDone = true;
    if (signal.aborted) {
      post('AGENT_LOOP_COMPLETE', {
        loopId,
        totalSteps: stepIndex,
        totalTools: collectedExecutions.length,
        finalText: '',
        stopReason: 'aborted',
      });
      return;
    }
    post('AGENT_LOOP_ERROR', {
      loopId,
      stepIndex,
      totalTools: collectedExecutions.length,
      error: err instanceof Error ? err.message : String(err),
      stopReason: 'loop_threw',
    });
  }
}

function extractText(message: { content: Array<{ type: string; text?: string }> }): string {
  return message.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

function extractResultText(result: unknown): string {
  const content = (result as { content?: Array<{ type?: string; text?: string }> } | undefined)?.content;
  if (!content) return '';
  return content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

function chainErrorText(nudgeTurn: boolean): string {
  return nudgeTurn
    ? 'DeepSeek returned nudge tool calls without a continuable response message; refusing to execute tools outside the conversation chain.'
    : 'DeepSeek returned agent tool calls without a continuable response message; refusing to execute tools outside the conversation chain.';
}

/**
 * Official-API fail-closed check: the pi Context transcript is the chain, so
 * tools may only run after the model actually produced an assistant message
 * in this loop (a valid turn), not on an empty/seed Context.
 */
function contextHasAssistantMessage(context: { messages: ReadonlyArray<{ role: string }> }): boolean {
  return context.messages.some((message) => message.role === 'assistant');
}

/**
 * 审计 #27（2026-10-24 报告 P1）——**按需加载：挂载一次即消费**。
 *
 * 背景：工具结果里的图片会被物化成 deepseek `file_id` 放进 `pending`，
 * 等**下一次** LLM 请求时通过 `refFileIds` 传给模型
 * （本文件 `materializeAndUploadToolResultImages` 的注释原话就是「在下一次请求时」）。
 * 但原实现只合并、从不清空 ⇒ 第 N 轮上传的图片会被 N+1、N+2…轮**反复重挂**，
 * 循环越长请求体越大。
 *
 * 现在合并后立刻清空 pending：本次请求拿到全部待挂载图片，下一轮不会重复。
 * 历史轮次的图片由服务端会话保留，客户端不需要重复上传。
 *
 * ⚠ 已知边界：同一轮请求**重试**时 pending 已空 ⇒ 重试拿不到这些图片。
 *   权衡：重试罕见，而「每轮重复挂载全部历史图片」每轮必发生。
 *   若将来重试变常见，改成「按 step 记已认领快照」即可（约 30 行）。
 *
 * 导出以便测试直接断言（纯函数、无副作用，副作用只有清空传入的 pending 数组）。
 */
export function takePendingImageFileIds(
  base: readonly string[],
  pending: string[],
): string[] {
  const merged = [...base, ...pending];
  if (pending.length > 0) pending.length = 0;
  return merged;
}
function buildInlineAgentBudgetNotice(locale: SupportedLocale, completedSteps: number): string {
  return translate(locale, 'content.agent.budgetReached', { count: completedSteps });
}

/**
 * M-URL 修复：扫描工具执行结果中的图片 URL，传给 background SW 下载并上传得到 file_id。
 * file_id 会被加入 pendingImageFileIds，在下一次请求时通过 refFileIds 传递给模型。
 * 下载和上传都在 background SW 中执行（避免 content script 的 Mixed Content 限制）。
 */
async function materializeAndUploadToolResultImages(
  executions: readonly ToolExecutionRecord[],
  uploadImage: PiLoopAdapterDeps['uploadImage'],
  pendingImageFileIds: string[],
): Promise<void> {
  if (!uploadImage) return;

  for (const execution of executions) {
    const result = execution.result;
    if (!result || !result.ok) continue;

    // 收集工具结果中的文本：output JSON + detail + summary
    const textParts: string[] = [];
    if (result.output !== undefined) {
      try {
        textParts.push(JSON.stringify(result.output));
      } catch {
        // ignore
      }
    }
    if (result.detail) {
      textParts.push(result.detail);
    }
    if (result.summary) {
      textParts.push(result.summary);
    }
    const resultText = textParts.join('\n');
    if (!resultText) continue;

    // 扫描图片 URL
    const { scanImageUrlsFromText } = await import('../../multimodal/media');
    const scanned = scanImageUrlsFromText(resultText);

    for (const item of scanned) {
      try {
        // #79: 移除遗留 console.log 调试日志 — console.warn 保留（操作级告警）
        // 直接传 URL 给 background SW 下载并上传
        const fileId = await uploadImage({
          url: item.url,
          name: `tool-result-image-${Date.now()}.png`,
        });
        if (fileId) {
          pendingImageFileIds.push(fileId);
        } else {
          console.warn('[M-URL] 图片上传失败，返回空 file_id');
        }
      } catch (error) {
        console.warn('[M-URL] 图片上传异常:', error);
        // 下载或上传失败的 URL 跳过，不阻断主流程
      }
    }
  }
}
