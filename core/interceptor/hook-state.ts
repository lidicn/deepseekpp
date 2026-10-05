import type { DeepSeekAugmentableWebRoute } from "../deepseek/request-codec";
import type {
  ToolCall,
  ToolCallRestoreRecord,
  ToolDescriptor,
} from "../types";
import type { ToolCallPayloadChunk } from "./streaming-tool-call-parser";
import type { ResponseTokenSpeedPayload } from "../deepseek/stream-metrics";

export const INITIAL_HOOK_STATE_WAIT_MS = 1_500;
export const TOKEN_SPEED_EMIT_INTERVAL_MS = 250;

export const FETCH_HOOK_MARKER = Symbol.for("deepseek-pp.fetch-hook-installed");
export const XHR_HOOK_MARKER = Symbol.for("deepseek-pp.xhr-hook-installed");
export const IDB_HOOK_MARKER = Symbol.for("deepseek-pp.idb-hook-installed");

let initialHookStateWaitComplete = false;
let initialHookStateReadyResolved = false;
let resolveInitialHookState: (() => void) | null = null;
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
  if (!initialHookStateReadyResolved) {
    initialHookStateReadyResolved = true;
    resolveInitialHookState?.();
  }
}

export async function waitForInitialHookState(): Promise<void> {
  if (initialHookStateWaitComplete) return;

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    initialHookStateReady,
    new Promise<void>((resolve) => {
      timeoutId = setTimeout(resolve, INITIAL_HOOK_STATE_WAIT_MS);
    }),
  ]);
  if (timeoutId) clearTimeout(timeoutId);
  initialHookStateWaitComplete = true;
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
