import { hookFetch, hookXHR } from "./request-interceptor";
import { hookIndexedDB } from "./history-idb-interceptor";

export function installFetchHook(): () => void {
  const cleanups: Array<() => void> = [];
  try {
    cleanups.push(hookFetch());
    cleanups.push(hookXHR());
    cleanups.push(hookIndexedDB());
  } catch (error) {
    for (const cleanup of cleanups.reverse()) cleanup();
    throw error;
  }
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    for (const cleanup of cleanups.reverse()) cleanup();
  };
}

// --- Re-export facade: preserve all 13 original exports ---

export { updateHookState } from "./hook-state";
export type {
  ResponseCompletePayload,
  RequestTerminalPayload,
  RequestContext,
  RequestBodyModification,
  ResponseTokenSpeedPayload,
} from "./hook-state";
export { hookFetch, hookXHR } from "./request-interceptor";
export { createRequestContext } from "./request-context";
export type { BlankLineCollapseFenceState } from "./response-patch";
export { XmlToolStreamFilter } from "./xml-tool-stream-filter";
export { interceptFetchResponse } from "./response-interceptor";
