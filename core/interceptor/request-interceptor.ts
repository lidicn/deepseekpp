import { DEEPSEEK_BYPASS_HOOK_HEADER } from "../deepseek/contracts";
import {
  FETCH_HOOK_MARKER,
  XHR_HOOK_MARKER,
  readHookState,
  waitForInitialHookState,
  isInitialHookStateWaitComplete,
  type RequestBodyModification,
  type RequestContext,
} from "./hook-state";
import { captureDeepSeekClientHeaders, createRequestContext, createRequestContextFromBody } from "./request-context";
import { interceptHistoryResponse, setupXHRHistoryInterceptor } from "./history-idb-interceptor";
import { interceptFetchResponse, setupXHRResponseInterceptor } from "./response-interceptor";
import {
  isDeepSeekAugmentableWebRoute,
  matchDeepSeekWebRoute,
  normalizeDeepSeekMessageId,
} from "../deepseek/request-codec";
import type { ToolCallSource } from "../types";
import { createToolInvocationCatalog } from "../tool";
import { createStreamingToolTextAccumulator } from "./streaming-tool-text";
import {
  createStreamingToolCallParser,
  type ToolCallPayloadChunk,
} from "./streaming-tool-call-parser";
import { extractToolCalls } from "./tool-parser";
import { recordRequestFromBody, mountDebugToWindow } from "../debug/refactor-telemetry";

const BYPASS_HOOK_HEADER = DEEPSEEK_BYPASS_HOOK_HEADER;

/**
 * v1.15 结构校验（风险 R1 缓解）：DeepSeek 网页版改版时请求体结构可能变化。
 * 注入增强前先校验请求体是否为合法 JSON 对象且含已知 DeepSeek 字段；
 * 注意：regenerate 请求不含 prompt 字段（用 child_message_id 引用），
 * 因此不能仅校验 prompt，需校验至少一个已知 DeepSeek 请求字段。
 * 失配时不注入、原样透传，避免以难以理解的方式失败。
 */
const DEEPSEEK_KNOWN_PAYLOAD_FIELDS = new Set([
  'chat_session_id', 'prompt', 'parent_message_id', 'child_message_id',
  'model_type', 'search_enabled', 'thinking_enabled', 'ref_file_ids',
]);
function isExpectedChatPayload(body: string | Record<string, unknown>): boolean {
  let parsed: Record<string, unknown>;
  if (typeof body === 'string') {
    try {
      const result = JSON.parse(body) as unknown;
      if (!result || typeof result !== "object") return false;
      parsed = result as Record<string, unknown>;
    } catch {
      return false;
    }
  } else {
    parsed = body;
  }
  const keys = Object.keys(parsed);
  return keys.some((k) => DEEPSEEK_KNOWN_PAYLOAD_FIELDS.has(k));
}

function recordStructureMismatch(route: string | undefined, body: string): void {
  console.warn(
    `[DeepSeek++] request structure mismatch (route=${route ?? "unknown"}), ` +
    `passing through without augmentation. Body preview: ${body.substring(0, 120)}`,
  );
}

export function hookFetch(): () => void {
  mountDebugToWindow();
  const currentFetch = window.fetch as typeof window.fetch & {
    [FETCH_HOOK_MARKER]?: true;
  };
  if (currentFetch[FETCH_HOOK_MARKER]) return () => undefined;
  const originalFetch = window.fetch;

  const hookedFetch = async function (
    this: Window,
    input: RequestInfo | URL,
    init?: RequestInit,
  ) {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input instanceof Request
            ? input.url
            : null;
    const method =
      init?.method !== undefined
        ? init.method
        : input instanceof Request
          ? input.method
          : "GET";
    const route =
      url !== null && typeof method === "string"
        ? matchDeepSeekWebRoute({ url, method, baseUrl: document.baseURI })
        : null;

    if (route === "history") {
      return interceptHistoryResponse(originalFetch.call(this, input, init));
    }
    if (
      !isDeepSeekAugmentableWebRoute(route) ||
      typeof init?.body !== "string"
    ) {
      return originalFetch.call(this, input, init);
    }

    if (hasBypassHookHeader(init.headers)) {
      return originalFetch.call(this, input, {
        ...init,
        headers: stripBypassHookHeader(init.headers),
      });
    }

    // v1.17 性能优化：提前 parse body 一次，传给 structure check +
    // request context，消除 request-interceptor / request-context /
    // request-augmentation 三重 JSON.parse。
    // 只在这里 parse；下游都复用 parsed body。
    const initBodyStr = init.body;
    let initBodyParsed: Record<string, unknown> | null = null;
    try {
      const result = JSON.parse(initBodyStr) as unknown;
      if (result && typeof result === 'object' && !Array.isArray(result)) {
        initBodyParsed = result as Record<string, unknown>;
      }
    } catch {
      initBodyParsed = null;
    }

    if (!initBodyParsed || !isExpectedChatPayload(initBodyParsed)) {
      recordStructureMismatch(route, initBodyStr);
      return originalFetch.call(this, input, init);
    }
    await waitForInitialHookState();
    readHookState().onHeadersCaptured(captureDeepSeekClientHeaders(init.headers));
    const originalContext = createRequestContextFromBody(initBodyParsed, initBodyStr);
    const fallbackToolDescriptors = [...readHookState().toolDescriptors];
    let modified: RequestBodyModification | null = null;
    let augmentationFailed = false;
    try {
      modified = await readHookState().onRequestBody(
        initBodyStr,
        originalContext.requestId,
        route,
      );
    } catch (error) {
      augmentationFailed = true;
      console.error(
        "[DeepSeek++] fetch request augmentation failed; sending original request",
        error,
      );
    }
    const requestBodyStr = modified?.body ?? initBodyStr;
    const executableToolDescriptors = augmentationFailed
      ? []
      : (modified?.toolDescriptors ?? fallbackToolDescriptors);
    const filterToolDescriptors = augmentationFailed
      ? fallbackToolDescriptors
      : executableToolDescriptors;
    recordRequestFromBody(requestBodyStr, route ?? "unknown", modified !== null);
    // 如果 body 没变（modified.body === init.body），直接复用 originalContext
    // 的 parsed body 来消除第二次 JSON.parse。
    const bodyUnchanged = requestBodyStr === initBodyStr && initBodyParsed !== null;
    const requestContext = bodyUnchanged
      ? { ...originalContext,
          requestId: modified?.requestId ?? originalContext.requestId,
          originalPrompt: modified?.originalPrompt ?? originalContext.originalPrompt,
          agentTaskPrompt: modified?.agentTaskPrompt ?? originalContext.agentTaskPrompt,
          toolDescriptors: executableToolDescriptors,
          filterToolDescriptors,
          ...(modified?.promptOptions ? { promptOptions: modified.promptOptions } : {}),
          ...(modified?.activeLocalSkillDir !== undefined
            ? { activeLocalSkillDir: modified.activeLocalSkillDir } : {}),
        }
      : createRequestContext(
          requestBodyStr,
          {
            requestId: originalContext.requestId,
            ...(modified?.requestId ? { requestId: modified.requestId } : {}),
            originalPrompt: modified?.originalPrompt ?? originalContext.originalPrompt,
            agentTaskPrompt: modified?.agentTaskPrompt ?? originalContext.agentTaskPrompt,
            toolDescriptors: executableToolDescriptors,
            filterToolDescriptors,
            ...(modified?.promptOptions ? { promptOptions: modified.promptOptions } : {}),
            ...(modified?.activeLocalSkillDir !== undefined
              ? { activeLocalSkillDir: modified.activeLocalSkillDir } : {}),
          },
        );
    const requestInit = modified ? { ...init, body: modified.body } : init;
    return interceptFetchResponse(
      originalFetch.call(this, input, requestInit),
      requestContext,
    );
  };
  Object.defineProperty(hookedFetch, FETCH_HOOK_MARKER, {
    value: true,
    configurable: true,
  });
  window.fetch = hookedFetch;
  return () => {
    if (window.fetch === hookedFetch) window.fetch = originalFetch;
  };
}

export function hookXHR(): () => void {
  const prototype = XMLHttpRequest.prototype as XMLHttpRequest & {
    [XHR_HOOK_MARKER]?: true;
  };
  if (prototype[XHR_HOOK_MARKER]) return () => undefined;
  const xhrRoutes = new WeakMap<
    XMLHttpRequest,
    ReturnType<typeof matchDeepSeekWebRoute>
  >();
  const xhrHeaders = new WeakMap<XMLHttpRequest, Record<string, string>>();
  const origOpen = XMLHttpRequest.prototype.open;
  const origSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
  const origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (
    method: string,
    url: string | URL,
    ...rest: any[]
  ) {
    const previousRoute = xhrRoutes.get(this);
    const previousHeaders = xhrHeaders.get(this);
    const routeUrl =
      typeof url === "string" ? url : url instanceof URL ? url.href : null;
    const route =
      typeof method === "string" && routeUrl !== null
        ? matchDeepSeekWebRoute({
            method,
            url: routeUrl,
            baseUrl: document.baseURI,
          })
        : null;

    // Native open() synchronously emits OPENED/readystatechange before it
    // returns. Publish this request's metadata first so a handler that calls
    // setRequestHeader()/send() during that event cannot observe stale state.
    xhrRoutes.set(this, route);
    xhrHeaders.set(this, {});
    try {
      return origOpen.apply(this, [method, url, ...rest] as any);
    } catch (error) {
      if (previousRoute === undefined) xhrRoutes.delete(this);
      else xhrRoutes.set(this, previousRoute);
      if (previousHeaders === undefined) xhrHeaders.delete(this);
      else xhrHeaders.set(this, previousHeaders);
      throw error;
    }
  };

  XMLHttpRequest.prototype.setRequestHeader = function (
    name: string,
    value: string,
  ) {
    const headers = xhrHeaders.get(this);
    if (headers) headers[name] = value;
    return origSetRequestHeader.call(this, name, value);
  };

  XMLHttpRequest.prototype.send = function (
    body?: Document | XMLHttpRequestBodyInit | null,
  ) {
    const route = xhrRoutes.get(this);
    if (isDeepSeekAugmentableWebRoute(route) && typeof body === "string") {
      const xhr = this;
      const sendChatRequest = async () => {
        // v1.15 结构校验：失配则原样透传，不注入
        if (!isExpectedChatPayload(body)) {
          recordStructureMismatch(route, body);
          return origSend.call(xhr, body);
        }
        const originalContext = createRequestContext(body);
        let cancelResponseInterceptor: (() => void) | null = null;
        try {
          readHookState().onHeadersCaptured(
            captureDeepSeekClientHeaders(xhrHeaders.get(xhr)),
          );
          const fallbackToolDescriptors = [...readHookState().toolDescriptors];
          let modified: RequestBodyModification | null = null;
          let augmentationFailed = false;
          try {
            modified = await readHookState().onRequestBody(
              body,
              originalContext.requestId,
              route,
            );
          } catch (error) {
            // XMLHttpRequest.send() cannot surface this asynchronous failure to
            // the page. The old path only logged the rejection and never called
            // the native send(), leaving DeepSeek's UI in an infinite loading
            // state. Fail open to the original request bytes instead.
            augmentationFailed = true;
            console.error(
              "[DeepSeek++] XHR request augmentation failed; sending original request",
              error,
            );
          }
          const requestBody = modified?.body ?? body;
          const executableToolDescriptors = augmentationFailed
            ? []
            : (modified?.toolDescriptors ?? fallbackToolDescriptors);
          const filterToolDescriptors = augmentationFailed
            ? fallbackToolDescriptors
            : executableToolDescriptors;
          recordRequestFromBody(requestBody, route ?? "unknown", modified !== null);
          cancelResponseInterceptor = setupXHRResponseInterceptor(
            xhr,
            createRequestContext(requestBody, {
              requestId: originalContext.requestId,
              ...(modified?.requestId ? { requestId: modified.requestId } : {}),
              originalPrompt:
                modified?.originalPrompt ?? originalContext.originalPrompt,
              agentTaskPrompt:
                modified?.agentTaskPrompt ?? originalContext.agentTaskPrompt,
              toolDescriptors: executableToolDescriptors,
              filterToolDescriptors,
              ...(modified?.promptOptions
                ? { promptOptions: modified.promptOptions }
                : {}),
              ...(modified?.activeLocalSkillDir !== undefined
                ? { activeLocalSkillDir: modified.activeLocalSkillDir }
                : {}),
            }),
          );
          return origSend.call(xhr, requestBody);
        } catch (error) {
          if (cancelResponseInterceptor) cancelResponseInterceptor();
          else
            readHookState().onRequestTerminal({
              requestId: originalContext.requestId,
            });
          throw error;
        }
      };
      const reportSendFailure = (error: unknown) => {
        console.error("[DeepSeek++] intercepted XHR request failed", error);
      };
      if (isInitialHookStateWaitComplete()) {
        void sendChatRequest().catch(reportSendFailure);
        return;
      }
      void waitForInitialHookState()
        .then(sendChatRequest)
        .catch(reportSendFailure);
      return;
    }
    if (route === "history") {
      setupXHRHistoryInterceptor(this);
    }
    return origSend.call(this, body);
  };
  const hookedOpen = prototype.open;
  const hookedSetRequestHeader = prototype.setRequestHeader;
  const hookedSend = prototype.send;
  Object.defineProperty(prototype, XHR_HOOK_MARKER, {
    value: true,
    configurable: true,
  });
  return () => {
    if (prototype.open === hookedOpen) prototype.open = origOpen;
    if (prototype.setRequestHeader === hookedSetRequestHeader) {
      prototype.setRequestHeader = origSetRequestHeader;
    }
    if (prototype.send === hookedSend) prototype.send = origSend;
    delete prototype[XHR_HOOK_MARKER];
  };
}

function hasBypassHookHeader(headers: HeadersInit | undefined): boolean {
  if (!headers) return false;
  return new Headers(headers).has(BYPASS_HOOK_HEADER);
}

function stripBypassHookHeader(
  headers: HeadersInit | undefined,
): HeadersInit | undefined {
  if (!headers) return headers;
  const next = new Headers(headers);
  next.delete(BYPASS_HOOK_HEADER);
  return next;
}
