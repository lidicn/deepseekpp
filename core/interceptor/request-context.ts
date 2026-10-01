import { normalizeDeepSeekMessageId } from "../deepseek/request-codec";
import { isInlineAgentContinuationRequest } from "../inline-agent/prompt";
import {
  readHookState,
  type RequestContext,
  type RequestContextOverrides,
  type ResponseCompletePayload,
} from "./hook-state";

const DEFAULT_APP_VERSION = "2.0.0";
const DEEPSEEK_CLIENT_PLATFORM = "web";

export function captureDeepSeekClientHeaders(
  headersInit: HeadersInit | undefined,
): Record<string, string> | null {
  const headers = normalizeHeaders(headersInit);
  if (!headers) return null;

  const authorization = headers.get("authorization");
  if (!authorization) return null;

  return {
    Authorization: authorization,
    "X-App-Version": headers.get("x-app-version") || DEFAULT_APP_VERSION,
    "x-client-platform":
      headers.get("x-client-platform") || DEEPSEEK_CLIENT_PLATFORM,
    "x-client-version": headers.get("x-client-version") || DEFAULT_APP_VERSION,
    "x-client-locale": headers.get("x-client-locale") || getDeepSeekLocale(),
    "x-client-timezone-offset":
      headers.get("x-client-timezone-offset") ||
      String(-new Date().getTimezoneOffset() * 60),
  };
}

function normalizeHeaders(
  headersInit: HeadersInit | undefined,
): Headers | null {
  if (!headersInit) return null;
  try {
    return new Headers(headersInit);
  } catch {
    return null;
  }
}

function getDeepSeekLocale(): string {
  return document.documentElement.lang || navigator.language || "en-US";
}

export function createRequestContext(
  bodyStr: string,
  overrides: RequestContextOverrides = {},
): RequestContext {
  try {
    const body = JSON.parse(bodyStr) as Record<string, unknown>;
    return createRequestContextFromBody(body, bodyStr, overrides);
  } catch {
    return createRequestContextFromBody(null, bodyStr, overrides);
  }
}

/**
 * v1.17 性能优化：接受已解析的 body 对象，避免重复 JSON.parse。
 * request-interceptor.ts 在进入 hook 前 parse 一次，然后传给这里。
 */
export function createRequestContextFromBody(
  body: Record<string, unknown> | null,
  _bodyStr: string,
  overrides: RequestContextOverrides = {},
): RequestContext {
  const state = readHookState();
  const requestId = overrides.requestId ?? crypto.randomUUID();
  if (body) {
    const bodyPrompt = typeof body.prompt === "string" ? body.prompt : "";
    const originalPrompt =
      typeof overrides.originalPrompt === "string"
        ? overrides.originalPrompt
        : typeof body.prompt === "string"
          ? body.prompt
          : "";
    return {
      requestId,
      originalPrompt,
      agentTaskPrompt: overrides.agentTaskPrompt ?? bodyPrompt,
      chatSessionId:
        typeof body.chat_session_id === "string" ? body.chat_session_id : null,
      parentMessageId: normalizeDeepSeekMessageId(body.parent_message_id),
      promptOptions: overrides.promptOptions ?? readRequestPromptOptions(body),
      suppressPageEvents: isInlineAgentContinuationRequest(
        originalPrompt,
        overrides.agentTaskPrompt ?? bodyPrompt,
      ),
      toolDescriptors: overrides.toolDescriptors ?? [
        ...state.toolDescriptors,
      ],
      ...(overrides.activeLocalSkillDir !== undefined
        ? { activeLocalSkillDir: overrides.activeLocalSkillDir }
        : {}),
    };
  }
  return {
    requestId,
    originalPrompt: overrides.originalPrompt ?? "",
    agentTaskPrompt:
      overrides.agentTaskPrompt ?? overrides.originalPrompt ?? "",
    chatSessionId: null,
    parentMessageId: null,
    promptOptions: overrides.promptOptions ?? readRequestPromptOptions(null),
    suppressPageEvents: isInlineAgentContinuationRequest(
      overrides.originalPrompt ?? "",
      overrides.agentTaskPrompt ?? "",
    ),
    toolDescriptors: overrides.toolDescriptors ?? [
      ...state.toolDescriptors,
    ],
    ...(overrides.activeLocalSkillDir !== undefined
      ? { activeLocalSkillDir: overrides.activeLocalSkillDir }
      : {}),
  };
}

export function readRequestPromptOptions(
  body: Record<string, unknown> | null,
): ResponseCompletePayload["promptOptions"] {
  return {
    modelType: typeof body?.model_type === "string" ? body.model_type : null,
    searchEnabled: body?.search_enabled === true,
    thinkingEnabled: body?.thinking_enabled === true,
    refFileIds: Array.isArray(body?.ref_file_ids)
      ? body.ref_file_ids.filter(
          (item): item is string => typeof item === "string",
        )
      : [],
  };
}
