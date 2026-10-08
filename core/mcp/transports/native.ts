import type {
  McpJsonRpcNotification,
  McpJsonRpcRequest,
  McpJsonRpcResponse,
  McpProtocolTransport,
  McpServerConfig,
} from '../types';
import { McpTransportError, normalizeJsonRpcResponse } from './common';
import { MULTIMODAL_MCP_NATIVE_HOST } from '../../multimodal';
import { getMultimodalNativeEnv } from '../../multimodal/settings';
import {
  MCP_NATIVE_ENVELOPE_PROTOCOL,
  MCP_NATIVE_ENVELOPE_VERSION,
  type McpNativeEnvelope,
} from '../native-contract';

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort?: () => void;
}

interface NativePortState {
  port: chrome.runtime.Port;
  pendingRequests: Map<number | string, PendingRequest>;
  // Audit fix S-3: set to false by onDisconnect. sendAndWait checks this
  // before postMessage and after — a message sent to a dead port would
  // otherwise silently sit in pendingRequests until the 120s total timeout.
  alive: boolean;
}

// Chrome native messaging enforces a ~1 MB cap per message over the Port
// (chrome.runtime.Port / connectNative). The previous 9 MB ceiling was never
// reachable in practice — large payloads were silently truncated or the host
// disconnected — which surfaced as opaque "QUOTA_BYTES" failures during long
// content writes (issue #297). Aligning here surfaces the failure early with
// an actionable message instead.
const MAX_NATIVE_MESSAGE_BYTES = 1 * 1024 * 1024;
// local_file_write content cap with headroom for the JSON-RPC envelope. Keep
// models writing in chunks: write the first section, then append the rest
// with append=true (issue #297).
const MAX_LOCAL_FILE_WRITE_BYTES = 900_000;

const nativePortStates = new Map<string, NativePortState>();

function getPortState(nativeHost: string): NativePortState {
  const existing = nativePortStates.get(nativeHost);
  if (existing) return existing;

  if (!chrome.runtime?.connectNative) {
    throw new McpTransportError('mcp_native_messaging_unavailable', 'Browser native messaging is unavailable.', {
      retryable: false,
    });
  }

  const port = chrome.runtime.connectNative(nativeHost);
  const state: NativePortState = {
    port,
    pendingRequests: new Map(),
    alive: true,
  };
  nativePortStates.set(nativeHost, state);

  port.onMessage.addListener((response: any) => {
    const id = response?.id ?? response?.result?.id;
    const rpcId = response?.jsonrpc === '2.0' ? response.id : id;
    if (rpcId != null && state.pendingRequests.has(rpcId)) {
      const pending = state.pendingRequests.get(rpcId)!;
      state.pendingRequests.delete(rpcId);
      clearTimeout(pending.timer);
      if (pending.signal && pending.onAbort) {
        pending.signal.removeEventListener('abort', pending.onAbort);
      }
      pending.resolve(response);
    } else {
      // M-1 fix: warn on unknown/malformed responses instead of silently
      // dropping them. Without this, a malformed response is invisible until
      // the 120s timeout fires, making native messaging issues hard to diagnose.
      console.warn('[MCP native] unexpected response from host:', {
        nativeHost,
        hasId: rpcId != null,
        rpcId,
        hasPending: rpcId != null ? state.pendingRequests.has(rpcId) : false,
        responseKeys: response && typeof response === 'object' ? Object.keys(response) : [],
      });
    }
  });

  port.onDisconnect.addListener(() => {
    const err = new McpTransportError(
      'mcp_native_host_disconnected',
      chrome.runtime.lastError?.message || 'Native host disconnected.',
      { retryable: true },
    );
    for (const pending of state.pendingRequests.values()) {
      clearTimeout(pending.timer);
      if (pending.signal && pending.onAbort) {
        pending.signal.removeEventListener('abort', pending.onAbort);
      }
      pending.reject(err);
    }
    state.pendingRequests.clear();
    // Audit fix S-3: mark dead BEFORE deleting from the map. Any sendAndWait
    // that captured this state before the delete will see alive=false and
    // reject immediately instead of posting to a dead port and waiting 120s.
    state.alive = false;
    nativePortStates.delete(nativeHost);
  });

  return state;
}

export function createMcpNativeMessagingTransport(server: McpServerConfig): McpProtocolTransport {
  return {
    request(request, options) {
      return sendNativeMessage(server, request, options?.timeoutMs, options?.signal);
    },
    async notify(notification, options) {
      await sendNativeMessage(server, notification, options?.timeoutMs, options?.signal);
    },
  };
}

async function sendNativeMessage<TParams extends Record<string, unknown> | undefined, TResult>(
  server: McpServerConfig,
  message: McpJsonRpcRequest<TParams> | McpJsonRpcNotification,
  timeoutMs: number = server.timeouts.requestMs,
  signal?: AbortSignal,
): Promise<McpJsonRpcResponse<TResult>> {
  throwIfNativeSignalAborted(signal);
  const nativeHost = server.transport.nativeHost;
  if (!nativeHost) {
    throw new McpTransportError('mcp_native_host_missing', 'Native messaging host is not configured.', {
      retryable: false,
    });
  }

  const expectedRequest = 'id' in message ? message as McpJsonRpcRequest<TParams> : undefined;
  const envelope = await createNativeEnvelope(server, message);
  // Notifications travel over the same port and the same browser cap, so they are
  // measured too; an oversized one used to fail as an opaque port disconnect.
  assertNativePayloadSize(nativeHost, envelope);

  let response: unknown;
  if (expectedRequest) {
    throwIfNativeSignalAborted(signal);
    response = await sendAndWait(nativeHost, envelope, expectedRequest.id, timeoutMs, signal);
    throwIfNativeSignalAborted(signal);
  } else {
    throwIfNativeSignalAborted(signal);
    const state = getPortState(nativeHost);
    state.port.postMessage(envelope);
    return undefined as any;
  }

  return normalizeJsonRpcResponse<TResult>(response, expectedRequest);
}

function throwIfNativeSignalAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new DOMException('Native MCP request was aborted.', 'AbortError');
}

function sendAndWait(
  nativeHost: string,
  envelope: McpNativeEnvelope,
  requestId: number | string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let state: NativePortState;
    try {
      state = getPortState(nativeHost);
      // Audit fix S-3: if the port was disconnected between getPortState and
      // here (race window), reject immediately instead of posting to a dead port.
      if (!state.alive) {
        nativePortStates.delete(nativeHost);
        reject(new McpTransportError(
          'mcp_native_host_disconnected',
          'Native host port was disconnected before the request could be sent.',
          { retryable: true },
        ));
        return;
      }
    } catch (err) {
      reject(err);
      return;
    }

    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      state.pendingRequests.delete(requestId);
      reject(new McpTransportError('mcp_native_timeout', `Native MCP request exceeded ${timeoutMs} ms.`));
    }, timeoutMs);

    const onAbort = () => {
      clearTimeout(timer);
      state.pendingRequests.delete(requestId);
      const reason = signal?.reason;
      reject(reason instanceof Error
        ? reason
        : new DOMException('Native MCP request was aborted.', 'AbortError'));
    };
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        reject(signal.reason instanceof Error
          ? signal.reason
          : new DOMException('Native MCP request was aborted.', 'AbortError'));
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    state.pendingRequests.set(requestId, {
      resolve,
      reject,
      timer,
      signal,
      onAbort: signal ? onAbort : undefined,
    });
    try {
      state.port.postMessage(envelope);
      // Audit fix S-3: postMessage to a dead port is async-silent in MV3.
      // Check alive immediately after — if onDisconnect fired during the
      // postMessage call, the pending entry was already rejected there.
      if (!state.alive && state.pendingRequests.has(requestId)) {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        state.pendingRequests.delete(requestId);
        reject(new McpTransportError(
          'mcp_native_host_disconnected',
          'Native host disconnected immediately after the request was posted.',
          { retryable: true },
        ));
      }
    } catch (err) {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      state.pendingRequests.delete(requestId);
      reject(err);
    }
  });
}

async function createNativeEnvelope(
  server: McpServerConfig,
  message: McpJsonRpcRequest<any> | McpJsonRpcNotification,
): Promise<McpNativeEnvelope> {
  const env = await createNativeEnv(server);
  return {
    protocol: MCP_NATIVE_ENVELOPE_PROTOCOL,
    version: MCP_NATIVE_ENVELOPE_VERSION,
    server: {
      id: server.id,
      command: server.transport.command,
      args: server.transport.args,
      cwd: server.transport.cwd,
      env,
    },
    message,
  };
}

function assertNativePayloadSize(nativeHost: string, envelope: McpNativeEnvelope): void {
  // The bound below is Chrome's own per-message native-messaging limit, so it applies
  // to every host, first-party or third-party: an oversized message fails inside the
  // browser as an opaque port disconnect, and surfacing it here is what makes it
  // actionable. Only the first-party multimodal host is exempt — its image/video
  // payloads are handed to the provider by the host itself (regression pinned for
  // analyze_images / analyze_video).
  if (nativeHost === MULTIMODAL_MCP_NATIVE_HOST) return;
  const writeContent = getLocalFileWriteContent(envelope.message);
  if (writeContent !== null) {
    const contentBytes = new Blob([writeContent]).size;
    if (contentBytes > MAX_LOCAL_FILE_WRITE_BYTES) {
      throw new McpTransportError(
        'mcp_native_payload_too_large',
        `local_file_write content is too large (${formatBytes(contentBytes)} > ${formatBytes(MAX_LOCAL_FILE_WRITE_BYTES)}). Write the file in chunks: send the first section now, then call local_file_write again with append=true for each remaining section.`,
        { retryable: false },
      );
    }
    if (contentBytes <= MAX_LOCAL_FILE_WRITE_BYTES && contentBytes > MAX_NATIVE_MESSAGE_BYTES / 2) {
      return;
    }
  }

  const envelopeBytes = new Blob([JSON.stringify(envelope)]).size;
  if (envelopeBytes > MAX_NATIVE_MESSAGE_BYTES) {
    throw new McpTransportError(
      'mcp_native_payload_too_large',
      `Native MCP request is too large (${formatBytes(envelopeBytes)} > ${formatBytes(MAX_NATIVE_MESSAGE_BYTES)}). Reduce the request size or split the work into smaller tool calls.`,
      { retryable: false },
    );
  }
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} bytes`;
}

function getLocalFileWriteContent(message: McpJsonRpcRequest<any> | McpJsonRpcNotification): string | null {
  if (message.method !== 'tools/call') return null;
  const params = message.params as { name?: unknown; arguments?: { content?: unknown } } | undefined;
  if (params?.name !== 'local_file_write') return null;
  const content = params.arguments?.content;
  return typeof content === 'string' ? content : null;
}

async function createNativeEnv(server: McpServerConfig): Promise<Record<string, string> | undefined> {
  if (server.transport.nativeHost === MULTIMODAL_MCP_NATIVE_HOST) {
    const env = await getMultimodalNativeEnv();
    return Object.keys(env).length > 0 ? env : undefined;
  }

  const env: Record<string, string> = { ...(server.transport.env ?? {}) };
  return Object.keys(env).length > 0 ? env : undefined;
}
