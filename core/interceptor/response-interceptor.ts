import { STREAM_KEEPALIVE_MS, decidePageKeepAlive, pageIdleMs } from "./stream-keepalive";
import { diagnosticLogBuffer } from "../diagnostics/log-buffer";
import type {
  ToolCall,
  ToolCallRestoreRecord,
  ToolCallSource,
  ToolDescriptor,
} from "../types";
import { sanitizeInternalPromptText } from "../prompt";
import { createToolInvocationCatalog } from "../tool";
import {
  findFirstXmlToolTag,
  getPartialXmlToolTagTailLength,
} from "../tool/xml-tags";
import {
  consumeDeepSeekSseFrames,
  createDeepSeekSseFrameDecoder,
  createDeepSeekStreamSummary,
  extractResponseTextForTokenSpeed,
  extractResponseTextFromParsed,
  extractResponseUsageStatsFromParsed,
  isResponseTextPatchPath,
  replaceDeepSeekSseFrameData,
  type DeepSeekSseFrame,
} from "../deepseek/stream-codec";
import {
  createResponseTokenSpeedTracker,
} from "../deepseek/stream-metrics";
import { createStreamingToolTextAccumulator } from "./streaming-tool-text";
import {
  createStreamingToolCallParser,
  type ToolCallPayloadChunk,
} from "./streaming-tool-call-parser";
import { extractToolCalls } from "./tool-parser";
import {
  readHookState,
  TOKEN_SPEED_EMIT_INTERVAL_MS,
  type RequestContext,
  type ResponseCompletePayload,
  type ResponseTokenSpeedPayload,
} from "./hook-state";
import { XmlToolStreamFilter } from "./xml-tool-stream-filter";
import { extractCleanResponseTextForParsing } from "./response-patch";

const RESPONSE_TOOL_FALLBACK_PARSE_MAX_CHARS = 120_000;

export function createStreamingResponseToolState(
  descriptors: readonly ToolDescriptor[],
  getSource: () => ToolCallSource,
  options: { suppressEvents?: boolean; activeLocalSkillDir?: string } = {},
) {
  // Internal inline-agent continuation requests suppress all page-facing
  // events, so the streaming tool parsers' output is never consumed (the
  // suppressed path returns before reading getVisibleText). Skip building and
  // feeding the accumulators/parsers entirely.
  if (options.suppressEvents) {
    return {
      append() {},
      finish() {},
      getVisibleText() {
        return "";
      },
    };
  }

  const toolText = createStreamingToolTextAccumulator(descriptors);
  const toolCalls = createStreamingToolCallParser(descriptors, {
    activeLocalSkillDir: options.activeLocalSkillDir,
  });
  const notifiedToolSignatures = new Set<string>();
  let fallbackText = "";
  let fallbackTextTruncated = false;
  let legacyCallIndex = 0;

  const emitStarted = (call: ToolCall) => {
    const callWithSource = { ...call, source: getSource() };
    if (shouldRenderStreamingToolStart(callWithSource)) {
      readHookState().onToolCallStarted(callWithSource);
    }
  };

  const emitCompleted = (call: ToolCall) => {
    const callWithSource = { ...call, source: getSource() };
    notifiedToolSignatures.add(
      createToolCallNotificationSignature(callWithSource),
    );
    readHookState().onToolCall(callWithSource);
  };

  const emitChunk = (chunk: ToolCallPayloadChunk) => {
    readHookState().onToolCallChunk({ ...chunk, requestId: getSource().requestId });
  };

  return {
    append(text: string) {
      toolText.append(text);
      appendFallbackText(text);
      const event = toolCalls.append(text);
      event.started.forEach(emitStarted);
      event.streamed.forEach(emitChunk);
      event.completed.forEach(emitCompleted);
      event.failed.forEach(emitCompleted);
    },
    finish() {
      toolText.flush();
      const event = toolCalls.flush();
      event.streamed.forEach(emitChunk);
      event.completed.forEach(emitCompleted);
      event.failed.forEach(emitCompleted);
      notifyLegacyFallbackToolCalls();
    },
    getVisibleText() {
      return toolText.getVisibleText();
    },
  };

  function appendFallbackText(text: string) {
    if (fallbackTextTruncated) return;
    if (
      fallbackText.length + text.length >
      RESPONSE_TOOL_FALLBACK_PARSE_MAX_CHARS
    ) {
      fallbackTextTruncated = true;
      fallbackText = "";
      return;
    }
    fallbackText += text;
  }

  function notifyLegacyFallbackToolCalls() {
    if (fallbackTextTruncated || !fallbackText.includes("｜DSML｜")) return;
    for (const call of extractToolCalls(fallbackText, { descriptors })) {
      const source = getSource();
      const callWithSource = {
        ...call,
        id:
          call.id ??
          `legacy:${source.requestId ?? "request"}:${legacyCallIndex++}`,
        source,
      };
      const signature = createToolCallNotificationSignature(callWithSource);
      if (notifiedToolSignatures.has(signature)) continue;
      notifiedToolSignatures.add(signature);
      readHookState().onToolCall(callWithSource);
    }
  }
}

function shouldRenderStreamingToolStart(call: ToolCall): boolean {
  return (
    call.name === "artifact_create" || call.name === "artifact_bundle_create"
  );
}

function createToolCallNotificationSignature(call: ToolCall): string {
  return call.id
    ? `id:${call.id}`
    : `${call.provider?.id ?? ""}:${call.name}:${call.invocationName ?? ""}:${call.raw}`;
}

function createManualChatToolCallSource(
  requestContext: RequestContext,
  assistantMessageId: number | null,
): ToolCallSource {
  return {
    trigger: "manual_chat",
    requestId: requestContext.requestId,
    chatSessionId: requestContext.chatSessionId,
    parentMessageId: requestContext.parentMessageId,
    messageId: assistantMessageId,
  };
}

// --- SSE stream interception: strip XML tool-call blocks from text events ---


export interface PassiveDeepSeekStreamState {
  append(
    text: string,
    controller: ReadableStreamDefaultController<Uint8Array>,
  ): void;
  finish(
    controller: ReadableStreamDefaultController<Uint8Array>,
  ): ResponseCompletePayload | null;
  cancel(): void;
  /** 是否正在扣帧（见 stream-keepalive.ts）。 */
  isSuppressing(): boolean;
}

function createPassiveDeepSeekStreamState(
  requestContext: RequestContext,
): PassiveDeepSeekStreamState {
  const frameDecoder = createDeepSeekSseFrameDecoder();
  const summary = createDeepSeekStreamSummary();
  const filter = new XmlToolStreamFilter(
    requestContext.filterToolDescriptors,
    requestContext.originalPrompt,
  );
  let cancelled = false;
  let completed = false;

  const responseToolState = createStreamingResponseToolState(
    requestContext.toolDescriptors,
    () =>
      createManualChatToolCallSource(requestContext, summary.responseMessageId),
    {
      suppressEvents: requestContext.suppressPageEvents,
      activeLocalSkillDir: requestContext.activeLocalSkillDir,
    },
  );
  const speedTracker = createResponseTokenSpeedTracker((progress) => {
    if (!requestContext.suppressPageEvents && !cancelled) {
      readHookState().onResponseTokenSpeed(
        attachResponseContextToTokenSpeedProgress(
          progress,
          requestContext,
          summary.responseMessageId,
        ),
      );
    }
  }, TOKEN_SPEED_EMIT_INTERVAL_MS);

  const processFrames = (
    frames: readonly DeepSeekSseFrame[],
    controller: ReadableStreamDefaultController<Uint8Array>,
  ) => {
    if (cancelled || frames.length === 0) return;
    const wasFinished = summary.finished;
    consumeDeepSeekSseFrames(frames, summary, {
      retainAssistantText: false,
      onParsed(parsed, event) {
        speedTracker.updateServerStats(
          extractResponseUsageStatsFromParsed(parsed, event.type),
        );
        const tokenSpeedText = extractResponseTextForTokenSpeed(parsed);
        if (tokenSpeedText) speedTracker.append(tokenSpeedText);
        const eventText = extractCleanResponseTextForParsing(parsed);
        if (eventText) responseToolState.append(eventText);
      },
    });
    if (!wasFinished && summary.finished) speedTracker.finish();
    filter.processFrames(frames, controller);
  };

  return {
    append(text, controller) {
      processFrames(frameDecoder.push(text), controller);
    },
    finish(controller) {
      if (cancelled || completed) return null;
      processFrames(frameDecoder.finish(), controller);
      filter.flush(controller);
      responseToolState.finish();
      speedTracker.finish();
      completed = true;
      if (requestContext.suppressPageEvents) return null;
      return {
        requestId: requestContext.requestId,
        text: responseToolState.getVisibleText(),
        originalPrompt: requestContext.originalPrompt,
        agentTaskPrompt: requestContext.agentTaskPrompt,
        chatSessionId: requestContext.chatSessionId,
        parentMessageId: requestContext.parentMessageId,
        assistantMessageId: summary.responseMessageId,
        // 2026-10-30：把"是否真截断"带给页面侧 —— 文本形状判定会漏（实测 458 字仍被截）。
        truncated: !summary.finished,
        promptOptions: requestContext.promptOptions,
      };
    },
    isSuppressing() {
      return filter.isSuppressing();
    },
    cancel() {
      if (cancelled || completed) return;
      speedTracker.finish();
      cancelled = true;
    },
  };
}

export async function interceptFetchResponse(
  responsePromise: Promise<Response>,
  requestContext: RequestContext,
): Promise<Response> {
  let terminalSent = false;
  const notifyTerminal = () => {
    if (terminalSent) return;
    terminalSent = true;
    readHookState().onRequestTerminal({ requestId: requestContext.requestId });
  };
  let response: Response;
  try {
    response = await responsePromise;
  } catch (error) {
    notifyTerminal();
    throw error;
  }
  if (!response.body) {
    notifyTerminal();
    return response;
  }

  const reader = response.body.getReader();
  // #4: stream:true — 多字节 UTF-8 字符跨 chunk 截断时，保留不完整序列到下一块。
  // TS 类型定义 TextDecoderOptions 不含 stream，但浏览器运行时实际接受。
  const decoder = new TextDecoder(undefined, { stream: true } as TextDecoderOptions);
  let streamState: PassiveDeepSeekStreamState | null = null;
  const getStreamState = () => {
    streamState ??= createPassiveDeepSeekStreamState(requestContext);
    return streamState;
  };
  let cancelled = false;
  let finished = false;
  // 保活竞速用：上游读取结果先落到这里，避免"定时器赢了就把数据丢了"。
  // 评审 §3.4：保活必须基于"上一次真实写入页面流的时间"，不能拿常量冒充。
  let lastPageWriteAt = Date.now();
  // 区分"上游故障"（该让页面知道）与"dpp 内部处理异常"（不该外溢）。
  let processingFailed = false;
  let bufferedRead: ReadableStreamReadResult<Uint8Array> | null = null;
  // 上游错误必须保留：吞掉的话页面永远收不到错误（旧版把 rejection 静默了）。
  let upstreamError: unknown = null;
  let inflightRead: Promise<void> | null = null;
  const pumpUpstream = () => {
    // 上游错误必须保留：不能吞（吞了页面就永远读不到错误，测试会超时）。
    inflightRead ??= reader.read().then(
      (result) => { bufferedRead = result; inflightRead = null; },
      (error) => { upstreamError = error; inflightRead = null; },
    );
    return inflightRead;
  };

    const stream = new ReadableStream(
      {
        async pull(controller) {
          if (cancelled || finished) return;
          try {
            // 保活（评审 §3.4 修正版）：读上游与保活定时器竞速；定时器先到就写零长度块，
            // 上游那次读取的结果留在 bufferedRead 里，下一次 pull 继续用 —— 不丢数据。
            const inflight = pumpUpstream();
            const idleTimer = new Promise<"idle">((resolve) => {
              setTimeout(() => resolve("idle"), STREAM_KEEPALIVE_MS);
            });
            const raced = await Promise.race([inflight, idleTimer]);
            if (raced === "idle") {
              const suppressing = streamState ? streamState.isSuppressing() : false;
              const now = Date.now();
              // 空闲时间必须是**真实测量**的（旧版把常量当 idleMs，判据恒真）。
              if (decidePageKeepAlive({ suppressing, lastWriteAt: lastPageWriteAt, now, finished })) {
                diagnosticLogBuffer.record({
                  level: 'warn',
                  source: 'stream',
                  message: 'page_stream_keepalive',
                  details: `idle=${pageIdleMs(lastPageWriteAt, now)}ms`,
                });
                try {
                  // 零长度块：不产生任何 SSE 行，只让页面的 reader 收到一次数据。
                  controller.enqueue(new Uint8Array(0));
                  lastPageWriteAt = Date.now();
                } catch { /* 页面已关流 */ }
              }
              return;
            }
            if (upstreamError) throw upstreamError;
            const { done, value } = bufferedRead ?? { done: false, value: undefined };
            bufferedRead = null;
            if (cancelled) return;
            if (!done) {
              try {
                getStreamState().append(decoder.decode(value, { stream: true }), controller);
                lastPageWriteAt = Date.now();
              } catch (processingError) {
                processingFailed = true;
                throw processingError;
              }
              return;
            }

            const finalText = decoder.decode();
            let complete: ResponseCompletePayload | null = null;
            try {
              if (finalText) getStreamState().append(finalText, controller);
              complete = getStreamState().finish(controller);
              lastPageWriteAt = Date.now();
            } catch (processingError) {
              processingFailed = true;
              throw processingError;
            }
            if (complete) readHookState().onResponseComplete(complete);
            finished = true;
            controller.close();
            notifyTerminal();
          } catch (error) {
            cancelled = true;
            streamState?.cancel();
            try {
              await reader.cancel(error);
            } finally {
              // 评审 §3.3：区分两类错误 ——
              //   上游故障 ⇒ 页面**必须**知道（否则半截答案会被当成正常结束）；
              //   dpp 内部处理异常 ⇒ 不外溢给页面，改为优雅关闭 + 留诊断。
              if (processingFailed) {
                diagnosticLogBuffer.record({
                  level: 'warn',
                  source: 'stream',
                  message: 'page_stream_error_swallowed',
                  details: String((error as Error)?.message ?? error).slice(0, 80),
                });
                try {
                  controller.close();
                } catch { /* 页面已关流 */ }
              } else {
                try {
                  controller.error(error);
                } catch { /* 页面已关流 */ }
              }
              notifyTerminal();
            }
          }
        },
        async cancel(reason) {
          if (cancelled || finished) return;
          cancelled = true;
          streamState?.cancel();
          try {
            await reader.cancel(reason);
          } finally {
            notifyTerminal();
          }
        },
      },
      // HWM 保持 0：改成 1 会打破既有的「最多一格读前」契约
      //（tests/fetch-hook-request-lifecycle.test.ts 里那条用例会红）。
      // 评审建议改 1 以解开反压耦合，但需要配套重设计（显式泵而非 desiredSize 驱动），
      // 不在凌晨随手翻 —— 已记入待办。
      { highWaterMark: 0 },
    );

  // The filtered body no longer matches the upstream byte length, and fetch
  // already decompressed it: forwarding the stale `content-length` would make
  // the page's reader truncate (or pad) the stream, and a forwarded
  // `content-encoding` would make it try to decode already-plain bytes.
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');

  const filteredResponse = new Response(stream, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
  // The Response constructor has no url option; preserve the final
  // (post-redirect) URL so page/extension code that consults `response.url`
  // still sees the real endpoint.
  if (response.url) {
    Object.defineProperty(filteredResponse, 'url', {
      value: response.url,
      enumerable: true,
      configurable: true,
    });
  }
  return filteredResponse;
}

function attachResponseContextToTokenSpeedProgress(
  progress: ResponseTokenSpeedPayload,
  requestContext: RequestContext,
  assistantMessageId: number | null,
): ResponseTokenSpeedPayload {
  return {
    ...progress,
    requestId: requestContext.requestId,
    chatSessionId: requestContext.chatSessionId,
    assistantMessageId,
    modelType: progress.modelType ?? requestContext.promptOptions.modelType,
  };
}

export function setupXHRResponseInterceptor(
  xhr: XMLHttpRequest,
  requestContext: RequestContext,
): () => void {
  let lastLen = 0;
  let filteredResponse = "";
  const streamState = createPassiveDeepSeekStreamState(requestContext);
  let responseFinished = false;

  let terminalSent = false;
  const notifyTerminal = () => {
    if (terminalSent) return;
    terminalSent = true;
    readHookState().onRequestTerminal({ requestId: requestContext.requestId });
  };

  const origResponseTextDesc =
    Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, "responseText") ||
    Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(XMLHttpRequest.prototype),
      "responseText",
    );

  const origResponseDesc =
    Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, "response") ||
    Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(XMLHttpRequest.prototype),
      "response",
    );

  // Create a fake controller that accumulates filtered text
  const fakeController = {
    enqueue(data: Uint8Array) {
      filteredResponse += new TextDecoder().decode(data);
    },
  } as unknown as ReadableStreamDefaultController<Uint8Array>;

  const consumeAvailableResponse = () => {
    const raw = origResponseTextDesc?.get?.call(xhr) || "";
    const newData = raw.slice(lastLen);
    lastLen = raw.length;
    if (newData) streamState.append(newData, fakeController);
  };
  const finishResponse = () => {
    if (responseFinished) return;
    consumeAvailableResponse();
    const complete = streamState.finish(fakeController);
    responseFinished = true;
    if (complete) readHookState().onResponseComplete(complete);
  };
  const finishSuccessfulResponse = () => {
    // XHR also enters DONE before abort/error/timeout. A non-zero status is
    // available before DONE for same-origin DeepSeek HTTP responses and keeps
    // failure paths from publishing a false RESPONSE_COMPLETE event.
    if (xhr.readyState === 4 && xhr.status !== 0) finishResponse();
  };

  xhr.addEventListener("readystatechange", function () {
    if (xhr.readyState === 3 || xhr.readyState === 4) {
      consumeAvailableResponse();
      finishSuccessfulResponse();
    }
  });
  xhr.addEventListener(
    "load",
    () => {
      try {
        finishResponse();
      } finally {
        notifyTerminal();
      }
    },
    { once: true },
  );
  const notifyFailure = () => {
    streamState.cancel();
    notifyTerminal();
  };
  xhr.addEventListener("abort", notifyFailure, { once: true });
  xhr.addEventListener("error", notifyFailure, { once: true });
  xhr.addEventListener("timeout", notifyFailure, { once: true });

  Object.defineProperty(xhr, "responseText", {
    get() {
      if (xhr.readyState === 3 || xhr.readyState === 4)
        consumeAvailableResponse();
      finishSuccessfulResponse();
      return filteredResponse;
    },
    configurable: true,
  });
  Object.defineProperty(xhr, "response", {
    get() {
      if (xhr.responseType === "" || xhr.responseType === "text") {
        if (xhr.readyState === 3 || xhr.readyState === 4)
          consumeAvailableResponse();
        finishSuccessfulResponse();
        return filteredResponse;
      }
      // #35: 非 text responseType 透传原生 response，不要返回 undefined 违反契约。
      // 原生 responseType=blob/arraybuffer/document 各有自己的返回类型。
      return origResponseDesc?.get?.call(xhr);
    },
    configurable: true,
  });

  return notifyFailure;
}

// --- History API interception: strip tool-call blocks from saved messages ---

