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
}

function createPassiveDeepSeekStreamState(
  requestContext: RequestContext,
): PassiveDeepSeekStreamState {
  const frameDecoder = createDeepSeekSseFrameDecoder();
  const summary = createDeepSeekStreamSummary();
  const filter = new XmlToolStreamFilter(
    requestContext.toolDescriptors,
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
        promptOptions: requestContext.promptOptions,
      };
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
  const decoder = new TextDecoder();
  let streamState: PassiveDeepSeekStreamState | null = null;
  const getStreamState = () => {
    streamState ??= createPassiveDeepSeekStreamState(requestContext);
    return streamState;
  };
  let cancelled = false;
  let finished = false;

  const stream = new ReadableStream(
    {
      async pull(controller) {
        if (cancelled || finished) return;
        try {
          const { done, value } = await reader.read();
          if (cancelled) return;
          if (!done) {
            getStreamState().append(
              decoder.decode(value, { stream: true }),
              controller,
            );
            return;
          }

          const finalText = decoder.decode();
          if (finalText) getStreamState().append(finalText, controller);
          const complete = getStreamState().finish(controller);
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
            try {
              controller.error(error);
            } finally {
              notifyTerminal();
            }
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
      return undefined;
    },
    configurable: true,
  });

  return notifyFailure;
}

// --- History API interception: strip tool-call blocks from saved messages ---

