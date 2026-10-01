import { McpTransportError } from './transport-errors';
import type { McpJsonRpcError, McpJsonRpcRequest, McpJsonRpcResponse, McpServerConfig } from '../types';
import { createAbortScope } from '../../network/abort';


export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const callerSignal = init.signal;
  if (callerSignal?.aborted) throwSignalReason(callerSignal);
  const abortScope = createAbortScope(callerSignal, timeoutMs);
  let responseReturned = false;
  try {
    const response = await fetch(input, {
      ...init,
      signal: abortScope.signal,
    });
    abortScope.clearDeadline();
    responseReturned = true;
    if (!callerSignal) {
      abortScope.cleanup();
      return response;
    }
    return wrapResponseBodyWithCleanup(response, abortScope.cleanup);
  } catch (err) {
    if (callerSignal?.aborted) throwSignalReason(callerSignal);
    if (abortScope.timedOut()) {
      throw new McpTransportError('mcp_transport_timeout', `MCP request exceeded ${timeoutMs} ms.`);
    }
    if (err instanceof TypeError) {
      const endpoint = typeof input === 'string' || input instanceof URL ? String(input) : 'configured endpoint';
      throw new McpTransportError(
        'mcp_network_error',
        `Cannot reach MCP server at ${endpoint}. Start the local provider, verify the URL, then retry.`,
      );
    }
    throw err;
  } finally {
    if (!responseReturned) abortScope.cleanup();
  }
}

function wrapResponseBodyWithCleanup(response: Response, cleanup: () => void): Response {
  if (!response.body) {
    cleanup();
    return response;
  }

  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          cleanup();
          controller.close();
          return;
        }
        controller.enqueue(chunk.value);
      } catch (error) {
        cleanup();
        controller.error(error);
      }
    },
    async cancel(reason) {
      cleanup();
      await reader.cancel(reason);
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function throwSignalReason(signal: AbortSignal): never {
  if (signal.reason instanceof Error) throw signal.reason;
  throw new DOMException('MCP request was aborted.', 'AbortError');
}

// Re-export for backward compatibility
export {
  getMcpEndpointUrl,
  getMcpOriginPattern,
  hasMcpServerOriginPermission,
  ensureMcpServerOriginPermission,
} from './transport-endpoint';
export {
  readJsonRpcResponse,
  readSseJsonRpcResponse,
  readResponseTextWithLimit,
  readChunkWithDeadline,
  assertWithinByteLimit,
  drainSseEvents,
  normalizeJsonRpcResponse,
  parseJsonRpcSseMessage,
} from './transport-jsonrpc';
export type { SseEvent } from './transport-jsonrpc';

export { McpTransportError } from './transport-errors';
