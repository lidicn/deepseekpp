import {
  stripToolCallsFromHistory,
  stripToolCallsFromIDBResult,
} from "./history-cleanup";
import { IDB_HOOK_MARKER, readHookState } from "./hook-state";

export async function interceptHistoryResponse(
  responsePromise: Promise<Response>,
): Promise<Response> {
  const response = await responsePromise;
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("json")) return response;

  try {
    const json = await response.json();
    stripToolCallsFromHistory(json, getHistoryCleanupOptions());
    return new Response(JSON.stringify(json), {
      headers: response.headers,
      status: response.status,
      statusText: response.statusText,
    });
  } catch {
    return response;
  }
}

export function setupXHRHistoryInterceptor(xhr: XMLHttpRequest) {
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

  let cachedFiltered: string | null = null;

  Object.defineProperty(xhr, "responseText", {
    get() {
      const raw = origResponseTextDesc?.get?.call(xhr) || "";
      if (xhr.readyState < 4) return raw;
      if (cachedFiltered !== null) return cachedFiltered;
      try {
        const json = JSON.parse(raw);
        stripToolCallsFromHistory(json, getHistoryCleanupOptions());
        cachedFiltered = JSON.stringify(json);
      } catch {
        cachedFiltered = raw;
      }
      return cachedFiltered;
    },
  });

  // Also override response for XHR response getter
  Object.defineProperty(xhr, "response", {
    get() {
      if (xhr.responseType === "" || xhr.responseType === "text") {
        const raw = origResponseTextDesc?.get?.call(xhr) || "";
        if (xhr.readyState < 4) return raw;
        if (cachedFiltered !== null) return cachedFiltered;
        try {
          const json = JSON.parse(raw);
          stripToolCallsFromHistory(json, getHistoryCleanupOptions());
          cachedFiltered = JSON.stringify(json);
        } catch {
          cachedFiltered = raw;
        }
        return cachedFiltered;
      }
      // Non-text response types: read from the native getter. Reading
      // `xhr.response` here would re-enter this overridden getter and overflow
      // the stack.
      return origResponseDesc?.get?.call(xhr);
    },
  });
}

export function getHistoryCleanupOptions() {
  return {
    toolDescriptors: readHookState().toolDescriptors,
    onToolCallsRestored: readHookState().onToolCallsRestored,
  };
}

// --- IndexedDB interception: strip tool-call blocks from cached messages ---

export function hookIndexedDB(): () => void {
  const prototype = IDBObjectStore.prototype as IDBObjectStore & {
    [IDB_HOOK_MARKER]?: true;
  };
  if (prototype[IDB_HOOK_MARKER]) return () => undefined;
  const origGet = prototype.get;
  const origGetAll = prototype.getAll;

  prototype.get = function (...args) {
    const request = origGet.apply(this, args);
    if (this.name === "history-message") {
      patchIDBRequest(request);
    }
    return request;
  };

  prototype.getAll = function (...args) {
    const request = origGetAll.apply(this, args);
    if (this.name === "history-message") {
      patchIDBRequest(request);
    }
    return request;
  };
  const hookedGet = prototype.get;
  const hookedGetAll = prototype.getAll;
  Object.defineProperty(prototype, IDB_HOOK_MARKER, {
    value: true,
    configurable: true,
  });
  return () => {
    if (prototype.get === hookedGet) prototype.get = origGet;
    if (prototype.getAll === hookedGetAll) prototype.getAll = origGetAll;
    delete prototype[IDB_HOOK_MARKER];
  };
}

export function patchIDBRequest(request: IDBRequest) {
  const origResultDesc = Object.getOwnPropertyDescriptor(
    IDBRequest.prototype,
    "result",
  );
  if (!origResultDesc) return;

  let cleaned = false;

  Object.defineProperty(request, "result", {
    get() {
      const result = origResultDesc.get!.call(this);
      if (result && !cleaned) {
        cleaned = true;
        stripToolCallsFromIDBResult(result, getHistoryCleanupOptions());
      }
      return result;
    },
  });
}
