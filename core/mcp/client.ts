import type {
  ToolDescriptor,
  ToolResult,
} from '../tool/types';
import type {
  McpCallToolOptions,
  McpCallToolResult,
  McpInitializeResult,
  McpListToolsResult,
  McpProtocolClient,
  McpProtocolTransport,
  McpServerConfig,
} from './types';
import { getExtensionVersion } from '../version';
import {
  MCP_PROTOCOL_VERSION,
  MCP_SUPPORTED_PROTOCOL_VERSIONS,
} from './constants';
import { isShellMcpServer } from '../shell/policy';
import {
  McpProtocolError,
  createMcpRequest,
  createMcpNotification,
  unwrapMcpResponse,
  normalizeMcpToolDescriptor,
  applyMcpToolPolicy,
  normalizeMcpToolResult,
  getMcpToolName,
  jsonRecordValue,
  clientInfoValue,
  stringValue,
} from './client-descriptor';
import { callLocalFileReadAuto } from './client-file-read';

const CLIENT_NAME = 'DeepSeek++';

export function createMcpProtocolClient(
  server: McpServerConfig,
  transport: McpProtocolTransport,
): McpProtocolClient {
  return {
    initialize() {
      return initializeMcpServer(server, transport);
    },
    listTools() {
      return listMcpTools(server, transport);
    },
    callTool(options) {
      return callMcpTool(server, transport, options);
    },
  };
}

export async function initializeMcpServer(
  server: McpServerConfig,
  transport: McpProtocolTransport,
  options?: { signal?: AbortSignal },
): Promise<McpInitializeResult> {
  const response = await transport.request<Record<string, unknown>, McpInitializeResult>(
    createMcpRequest('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: {
        name: CLIENT_NAME,
        version: getExtensionVersion(),
      },
    }),
    {
      timeoutMs: server.timeouts.connectMs,
      maxResponseBytes: server.limits.maxResultBytes,
      signal: options?.signal,
    },
  );
  const result = unwrapMcpResponse(response, 'mcp_initialize_failed');
  const rawResult = result as unknown as Record<string, unknown>;
  const hasAdvertisedProtocolVersion = Object.prototype.hasOwnProperty.call(
    rawResult,
    'protocolVersion',
  );
  const advertisedProtocolVersion = rawResult.protocolVersion;
  const protocolVersion = hasAdvertisedProtocolVersion
    ? advertisedProtocolVersion
    : MCP_PROTOCOL_VERSION;
  if (
    typeof protocolVersion !== 'string' ||
    !MCP_SUPPORTED_PROTOCOL_VERSIONS.includes(
      protocolVersion as typeof MCP_SUPPORTED_PROTOCOL_VERSIONS[number],
    )
  ) {
    throw new McpProtocolError(
      'mcp_protocol_version_unsupported',
      'Unsupported MCP protocol version.',
      {
        details: {
          requestedProtocolVersion: MCP_PROTOCOL_VERSION,
          advertisedProtocolVersion,
        },
      },
    );
  }
  const initialization = {
    protocolVersion,
    capabilities: jsonRecordValue(rawResult.capabilities),
    serverInfo: clientInfoValue(rawResult.serverInfo),
    instructions: stringValue(rawResult.instructions),
  };
  transport.commitInitialization?.(initialization);

  if (transport.notify) {
    await transport.notify(createMcpNotification('notifications/initialized'), {
      timeoutMs: server.timeouts.requestMs,
      signal: options?.signal,
    });
  }

  return initialization;
}

export async function listMcpTools(
  server: McpServerConfig,
  transport: McpProtocolTransport,
  options?: { signal?: AbortSignal },
): Promise<ToolDescriptor[]> {
  const tools: ToolDescriptor[] = [];
  const maxToolCount = Math.max(0, Math.floor(server.limits.maxToolCount));
  if (maxToolCount === 0) return tools;
  let cursor: string | undefined;

  do {
    const response = await transport.request<Record<string, unknown>, McpListToolsResult>(
      createMcpRequest('tools/list', cursor ? { cursor } : undefined),
      {
        timeoutMs: server.timeouts.discoveryMs,
        maxResponseBytes: server.limits.maxResultBytes,
        signal: options?.signal,
      },
    );
    const result = unwrapMcpResponse(response, 'mcp_tools_list_failed') as McpListToolsResult;
    const nextTools = Array.isArray(result.tools) ? result.tools : [];
    const remaining = maxToolCount - tools.length;
    tools.push(...nextTools
      .slice(0, remaining)
      .map((tool) => normalizeMcpToolDescriptor(server, tool)));
    cursor = typeof result.nextCursor === 'string' && result.nextCursor ? result.nextCursor : undefined;
  } while (cursor && tools.length < maxToolCount);

  return applyMcpToolPolicy(tools, server);
}

export async function callMcpTool(
  server: McpServerConfig,
  transport: McpProtocolTransport,
  options: McpCallToolOptions,
): Promise<ToolResult> {
  const startedAt = Date.now();
  const mcpToolName = getMcpToolName(options.call, options.descriptor);
  if (mcpToolName === 'local_file_read' && isShellMcpServer(server)) {
    return callLocalFileReadAuto(server, transport, options);
  }

  try {
    const response = await transport.request<Record<string, unknown>, McpCallToolResult>(
      createMcpRequest('tools/call', {
        name: mcpToolName,
        arguments: options.call.payload,
      }),
      {
        timeoutMs: options.timeoutMs ?? server.timeouts.requestMs,
        maxResponseBytes: options.maxResultBytes ?? server.limits.maxResultBytes,
        signal: options.signal,
      },
    );
    const result = unwrapMcpResponse(response, 'mcp_tool_call_failed') as McpCallToolResult;
    const normalized = normalizeMcpToolResult(server, options.call, result, startedAt, options.maxResultBytes);
    return normalized;
  } catch (err) {
    return {
      ok: false,
      summary: 'MCP 工具调用失败',
      detail: err instanceof Error ? err.message : String(err),
      name: options.call.name,
      provider: options.call.provider,
      descriptorId: options.call.descriptorId,
      startedAt,
      completedAt: Date.now(),
      durationMs: Date.now() - startedAt,
      error: {
        code: err instanceof McpProtocolError ? err.code : 'mcp_tool_call_failed',
        message: err instanceof Error ? err.message : String(err),
        retryable: err instanceof McpProtocolError ? err.retryable : true,
        details: err instanceof McpProtocolError && err.details?.externalOutcome === 'confirmed'
          ? err.details
          : {
            ...(err instanceof McpProtocolError ? err.details : undefined),
            externalOutcome: 'ambiguous',
            retrySafe: false,
          },
      },
    };
  }
}

// Re-export for backward compatibility
export {
  McpProtocolError,
  normalizeMcpToolDescriptor,
  applyMcpToolPolicy,
  createMcpRequest,
  createMcpNotification,
  unwrapMcpResponse,
} from './client-descriptor';
export { callLocalFileReadAuto } from './client-file-read';
