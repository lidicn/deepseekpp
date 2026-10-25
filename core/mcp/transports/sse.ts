import { buildMcpRequestHeaders } from '../store';
import type {
  McpJsonRpcNotification,
  McpJsonRpcRequest,
  McpJsonRpcResponse,
  McpProtocolTransport,
  McpServerConfig,
} from '../types';
import {
  McpTransportError,
  assertWithinByteLimit,
  drainSseEvents,
  ensureMcpServerOriginPermission,
  fetchWithTimeout,
  getMcpEndpointUrl,
  parseJsonRpcSseMessage,
  readChunkWithDeadline,
} from './common';

export function createMcpSseTransport(server: McpServerConfig): McpProtocolTransport {
  return {
    request(request, options) {
      return sendSseMessage(
        server,
        request,
        options?.timeoutMs,
        options?.maxResponseBytes,
        options?.signal,
      );
    },
    async notify(notification, options) {
      await sendSseMessage(
        server,
        notification,
        options?.timeoutMs,
        options?.maxResponseBytes,
        options?.signal,
      );
    },
  };
}

async function sendSseMessage<TParams extends Record<string, unknown> | undefined, TResult>(
  server: McpServerConfig,
  message: McpJsonRpcRequest<TParams> | McpJsonRpcNotification,
  timeoutMs: number = server.timeouts.requestMs,
  maxResponseBytes: number = server.limits.maxResultBytes,
  signal?: AbortSignal,
): Promise<McpJsonRpcResponse<TResult>> {
  await ensureMcpServerOriginPermission(server);
  const sseResponse = await fetchWithTimeout(getMcpEndpointUrl(server), {
    method: 'GET',
    credentials: 'omit',
    headers: {
      accept: 'text/event-stream',
      ...buildMcpRequestHeaders(server),
    },
    signal,
  }, timeoutMs);

  if (!sseResponse.ok || !sseResponse.body) {
    throw new McpTransportError('mcp_sse_connect_failed', `MCP SSE connect failed with HTTP ${sseResponse.status}.`);
  }

  const reader = sseResponse.body.getReader();
  const decoder = new TextDecoder();
  const postUrl = await readSseEndpoint(server, reader, decoder, timeoutMs, maxResponseBytes, signal);
  // 审计 #18（2026-10-24 报告 P1）：POST 抛错时控制流直接从 :68 跳出，
  // **reader 从未 cancel()** —— GET 连接会挂在服务端半开状态，浏览器侧 reader 泄漏。
  // 原有的 try/finally 只覆盖后面的「读响应」阶段，不含这次 POST。
  try {
    await postSseMessage(server, postUrl, message, timeoutMs, signal);
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }

  if (!('id' in message)) {
    reader.cancel().catch(() => undefined);
    return { jsonrpc: '2.0', id: null, result: undefined as TResult };
  }

  try {
    return await readSseResponseFromReader(
      reader,
      decoder,
      message as McpJsonRpcRequest<TParams>,
      maxResponseBytes,
      signal,
      timeoutMs,
    );
  } finally {
    reader.cancel().catch(() => undefined);
  }
}

async function readSseEndpoint(
  server: McpServerConfig,
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: TextDecoder,
  timeoutMs: number,
  maxResponseBytes: number,
  signal?: AbortSignal,
): Promise<URL> {
  const deadline = Date.now() + timeoutMs;
  let buffer = '';
  let totalBytes = 0;

  while (true) {
    throwIfSignalAborted(signal);
    const { done, value } = await readChunkWithDeadline(reader, deadline);
    throwIfSignalAborted(signal);
    if (done) break;
    totalBytes = assertWithinByteLimit(totalBytes, value.byteLength, maxResponseBytes, reader);
    buffer += decoder.decode(value, { stream: true });
    const drained = drainSseEvents(buffer);
    buffer = drained.remainder;
    for (const event of drained.events) {
      if (event.event !== 'endpoint') continue;
      return validateSsePostEndpoint(event.data, server);
    }
  }

  throw new McpTransportError('mcp_sse_endpoint_missing', 'MCP SSE stream did not provide a POST endpoint.');
}

/**
 * Resolves the SSE `endpoint` event and enforces that the POST target stays
 * on the configured server origin (scheme + host + port). The extension only
 * holds host permission for that origin; without this check a malicious or
 * compromised MCP server could redirect the authenticated POST (Bearer/Basic/
 * custom headers plus the JSON-RPC payload) to an arbitrary origin (H3).
 */
function validateSsePostEndpoint(data: string, server: McpServerConfig): URL {
  const configured = getMcpEndpointUrl(server);
  let resolved: URL;
  try {
    resolved = new URL(data, configured);
  } catch {
    throw new McpTransportError(
      'mcp_sse_endpoint_invalid',
      'MCP SSE endpoint event is not a valid URL.',
      { retryable: false },
    );
  }
  if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
    throw new McpTransportError(
      'mcp_sse_endpoint_invalid',
      `MCP SSE endpoint uses an unsupported protocol: ${resolved.protocol}`,
      { retryable: false },
    );
  }
  if (resolved.origin !== configured.origin) {
    throw new McpTransportError(
      'mcp_sse_endpoint_origin_mismatch',
      `MCP SSE endpoint origin ${resolved.origin} does not match the configured server origin ${configured.origin}.`,
      { retryable: false },
    );
  }
  return resolved;
}

async function postSseMessage(
  server: McpServerConfig,
  postUrl: URL,
  message: McpJsonRpcRequest<any> | McpJsonRpcNotification,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetchWithTimeout(postUrl, {
    method: 'POST',
    credentials: 'omit',
    headers: {
      'content-type': 'application/json',
      ...buildMcpRequestHeaders(server),
    },
    body: JSON.stringify(message),
    signal,
  }, timeoutMs);

  if (!response.ok) {
    // 审计 #17（2026-10-24 报告 P1）：失败分支原来直接 throw，
    // **响应体既不消费也不取消** —— 未消费的 body 会让底层连接在浏览器连接池里
    // 挂到 GC 为止。高频 MCP 调用下连接池会被耗尽，后续 SSE 请求排队超时。
    await response.body?.cancel().catch(() => undefined);
    throw new McpTransportError('mcp_sse_post_failed', `MCP SSE POST failed with HTTP ${response.status}.`);
  }
  // 成功分支同样要处理：MCP SSE 的 POST 响应体是**空体或一次性 ACK**，
  // 真正的数据走 GET 流。不消费就会占住连接，所以显式读完并忽略。
  await response.body?.cancel().catch(() => undefined);
}

async function readSseResponseFromReader<TResult>(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: TextDecoder,
  expectedRequest: McpJsonRpcRequest<any>,
  maxResponseBytes: number,
  signal?: AbortSignal,
  timeoutMs: number = 30_000,
): Promise<McpJsonRpcResponse<TResult>> {
  // Response bodies have no inherent deadline: a server that accepts the POST
  // but never emits the matching `message` event would hang the request
  // forever (M17). Enforce the same deadline budget as the connect phase.
  const deadline = Date.now() + timeoutMs;
  let buffer = '';
  let totalBytes = 0;

  while (true) {
    throwIfSignalAborted(signal);
    const { done, value } = await readChunkWithDeadline(reader, deadline);
    throwIfSignalAborted(signal);
    if (done) break;
    totalBytes = assertWithinByteLimit(totalBytes, value.byteLength, maxResponseBytes, reader);
    buffer += decoder.decode(value, { stream: true });
    const drained = drainSseEvents(buffer);
    buffer = drained.remainder;
    for (const event of drained.events) {
      if (event.event !== 'message') continue;
      const response = parseJsonRpcSseMessage<TResult>(event.data, expectedRequest);
      if (response) return response;
    }
  }

  throw new McpTransportError('mcp_sse_response_missing', 'MCP SSE stream ended without a matching response.');
}

function throwIfSignalAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new DOMException('MCP SSE request was aborted.', 'AbortError');
}
