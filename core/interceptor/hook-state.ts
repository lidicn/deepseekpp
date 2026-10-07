import type { DeepSeekAugmentableWebRoute } from "../deepseek/request-codec";
import type {
  ToolCall,
  ToolCallRestoreRecord,
  ToolDescriptor,
} from "../types";
import type { ToolCallPayloadChunk } from "./streaming-tool-call-parser";
import type { ResponseTokenSpeedPayload } from "../deepseek/stream-metrics";

export const INITIAL_HOOK_STATE_WAIT_MS = 5_000;
// R2-F4: After a wait timeout with no SW response, mark complete so subsequent
// requests don't each block for the full 5s. Reset after this cooldown so a
// later request can retry once the SW may have recovered.
export const INITIAL_HOOK_STATE_WAIT_RESET_MS = 30_000;
export const TOKEN_SPEED_EMIT_INTERVAL_MS = 250;

export const FETCH_HOOK_MARKER = Symbol.for("deepseek-pp.fetch-hook-installed");
export const XHR_HOOK_MARKER = Symbol.for("deepseek-pp.xhr-hook-installed");
export const IDB_HOOK_MARKER = Symbol.for("deepseek-pp.idb-hook-installed");

let initialHookStateWaitComplete = false;
let initialHookStateReadyResolved = false;
let resolveInitialHookState: (() => void) | null = null;
let hookStateWaitResetTimer: ReturnType<typeof setTimeout> | null = null;
const initialHookStateReady = new Promise<void>((resolve) => {
  resolveInitialHookState = resolve;
});

export interface HookState {
  toolDescriptors: ToolDescriptor[];
  onRequestBody: (
    body: string,
    requestId: string,
    route: DeepSeekAugmentableWebRoute,
  ) => Promise<RequestBodyModification | null>;
  onHeadersCaptured: (headers: Record<string, string> | null) => void;
  onToolCallStarted: (call: ToolCall) => void;
  onToolCall: (call: ToolCall) => void;
  onToolCallChunk: (chunk: ToolCallPayloadChunk) => void;
  onToolCallsRestored: (records: ToolCallRestoreRecord[]) => void;
  onResponseTokenSpeed: (progress: ResponseTokenSpeedPayload) => void;
  onResponseComplete: (complete: ResponseCompletePayload) => void;
  onRequestTerminal: (terminal: RequestTerminalPayload) => void;
  onMemoriesUsed: (ids: number[]) => void;
}

function createEmptyHookState(): HookState {
  return {
    toolDescriptors: [],
    onRequestBody: async () => null,
    onHeadersCaptured: () => {},
    onToolCallStarted: () => {},
    onToolCall: () => {},
    onToolCallChunk: () => {},
    onToolCallsRestored: () => {},
    onResponseTokenSpeed: () => {},
    onResponseComplete: () => {},
    onRequestTerminal: () => {},
    onMemoriesUsed: () => {},
  };
}

let hookState: HookState = createEmptyHookState();

export function readHookState(): HookState {
  return hookState;
}

export function updateHookState(partial: Partial<HookState>) {
  hookState = { ...hookState, ...partial };
  if (Object.prototype.hasOwnProperty.call(partial, "toolDescriptors")) {
    markInitialHookStateReady();
  }
}

export function markInitialHookStateReady() {
  initialHookStateWaitComplete = true;
  // R2-F4: SW has responded — cancel any pending cooldown reset so the
  // resolved state stays latched.
  if (hookStateWaitResetTimer) {
    clearTimeout(hookStateWaitResetTimer);
    hookStateWaitResetTimer = null;
  }
  if (!initialHookStateReadyResolved) {
    initialHookStateReadyResolved = true;
    resolveInitialHookState?.();
  }
}

export async function waitForInitialHookState(): Promise<void> {
  // SW 已经推送过工具目录（包括空数组=明确禁用），直接返回
  if (initialHookStateWaitComplete) return;

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    initialHookStateReady,
    new Promise<void>((resolve) => {
      timeoutId = setTimeout(resolve, INITIAL_HOOK_STATE_WAIT_MS);
    }),
  ]);
  if (timeoutId) clearTimeout(timeoutId);
  // R2-F4 (revised 20261007): Two completion semantics:
  // 1. SW actually pushed toolDescriptors (initialHookStateReady resolved) →
  //    permanently mark complete. This is the ideal path.
  // 2. Timeout with no SW response → temporarily mark complete for a 30s
  //    cooldown, then reset so a later request can retry. This avoids every
  //    subsequent request blocking for the full 5s when the SW is slow to
  //    cold-start (MV3 teardown race).
  //
  // Known tradeoff during the cooldown window: toolDescriptors is empty, so
  // createStreamingToolCallParser([]) returns early on append() — tool calls
  // are not parsed and raw XML may leak into visible text. This is preferable
  // to blocking every request for 5s when the SW is unreachable. If the SW
  // recovers during the cooldown, markInitialHookStateReady() cancels the
  // reset timer and latches the real state immediately.
  if (initialHookStateReadyResolved) {
    initialHookStateWaitComplete = true;
    return;
  }
  // R2-F4: Timeout with no SW response. Mark complete temporarily so subsequent
  // requests don't each block for the full 5s (degradation from the original
  // one-time 1.5s wait). Schedule a reset after the cooldown so a later request
  // can retry once the SW may have recovered.
  initialHookStateWaitComplete = true;
  if (hookStateWaitResetTimer) clearTimeout(hookStateWaitResetTimer);
  hookStateWaitResetTimer = setTimeout(() => {
    // Only reset if the SW still hasn't responded; if it did, markInitialHookStateReady
    // already cleared this timer.
    if (!initialHookStateReadyResolved) {
      initialHookStateWaitComplete = false;
    }
    hookStateWaitResetTimer = null;
  }, INITIAL_HOOK_STATE_WAIT_RESET_MS);
}

export interface ResponseCompletePayload {
  requestId: string;
  text: string;
  originalPrompt: string;
  agentTaskPrompt: string;
  chatSessionId: string | null;
  parentMessageId: number | null;
  assistantMessageId: number | null;
  promptOptions: {
    modelType: string | null;
    searchEnabled: boolean;
    thinkingEnabled: boolean;
    refFileIds: string[];
  };
}

export interface RequestTerminalPayload {
  requestId: string;
}

export type { ResponseTokenSpeedPayload } from "../deepseek/stream-metrics";

export interface RequestContext {
  requestId: string;
  originalPrompt: string;
  agentTaskPrompt: string;
  chatSessionId: string | null;
  parentMessageId: number | null;
  promptOptions: ResponseCompletePayload["promptOptions"];
  suppressPageEvents: boolean;
  toolDescriptors: ToolDescriptor[];
  // Presentation-only snapshot for the SSE/XML filter. When request augmentation
  // fails open, execution rights are cleared but the page must still not see the
  // raw XML of a known tool, so the filter keeps reading the authorized set.
  filterToolDescriptors: ToolDescriptor[];
  // The active local skill's skillDir for the current request (isolated by requestId);
  // computed at augment time and passed via RequestBodyModification, pinning cwd during response parsing.
  // Request-scoped data; never use global mutable state (Review #1 concurrency isolation requirement).
  activeLocalSkillDir?: string;
}

export interface RequestContextOverrides {
  requestId?: string;
  originalPrompt?: string;
  agentTaskPrompt?: string;
  toolDescriptors?: ToolDescriptor[];
  filterToolDescriptors?: ToolDescriptor[];
  promptOptions?: ResponseCompletePayload["promptOptions"];
  activeLocalSkillDir?: string;
}

export interface RequestBodyModification {
  body: string;
  originalPrompt?: string;
  agentTaskPrompt: string;
  requestId?: string;
  toolDescriptors?: ToolDescriptor[];
  promptOptions?: ResponseCompletePayload["promptOptions"];
  // The current request's active local skill skillDir computed at augment time;
  // travels with the request into RequestContext for cwd pinning during response-stream parsing (request-scoped isolation).
  activeLocalSkillDir?: string;
}


export function isInitialHookStateWaitComplete(): boolean {
  return initialHookStateWaitComplete;
}
