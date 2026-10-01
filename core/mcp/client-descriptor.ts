import type {
  JsonValue,
  ToolCall,
  ToolDescriptor,
  ToolDescriptorSchema,
  ToolResult,
  ToolRiskLevel,
  ToolTransportKind,
} from '../tool/types';
import type {
  McpCallToolOptions,
  McpCallToolResult,
  McpContentBlock,
  McpInitializeResult,
  McpJsonRpcNotification,
  McpJsonRpcRequest,
  McpJsonRpcResponse,
  McpListToolsResult,
  McpProtocolClient,
  McpProtocolTransport,
  McpServerConfig,
  McpToolDefinition,
} from './types';
import { getExtensionVersion } from '../version';
import {
  MCP_PROTOCOL_VERSION,
  MCP_SUPPORTED_PROTOCOL_VERSIONS,
} from './constants';
import { createMcpDescriptorId, createMcpInvocationName } from './descriptor-identity';
import { isShellMcpServer } from '../shell/policy';
import { sanitizeToolSchema } from './schema-sanitizer';
import { refactorTelemetry } from '../debug/refactor-telemetry';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class McpProtocolError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, options?: { retryable?: boolean; details?: Record<string, unknown> }) {
    super(message);
    this.name = 'McpProtocolError';
    this.code = code;
    this.retryable = options?.retryable ?? false;
    this.details = options?.details;
  }
}


export function normalizeMcpToolDescriptor(server: McpServerConfig, tool: McpToolDefinition): ToolDescriptor {
  const invocationName = createMcpInvocationName(server.id, tool.name);
  return {
    id: createMcpDescriptorId(server.id, tool.name),
    provider: {
      kind: 'mcp',
      id: server.id,
      displayName: server.displayName,
      transport: server.transport.kind as ToolTransportKind,
    },
    name: tool.name,
    invocationName,
    title: stringValue(tool.title) || tool.name,
    description: stringValue(tool.description) || `MCP tool ${tool.name}`,
    inputSchema: normalizeToolSchema(tool.inputSchema),
    outputSchema: normalizeToolSchema(tool.outputSchema),
    execution: {
      mode: server.execution.mode,
      enabled: server.enabled && server.execution.enabled,
      risk: toolRiskValue(tool.annotations?.risk),
      timeoutMs: server.timeouts.requestMs,
      maxResultBytes: server.limits.maxResultBytes,
    },
    annotations: {
      ...stringAnnotations(tool.annotations),
      mcpServerId: server.id,
      mcpToolName: tool.name,
    },
  };
}

export function applyMcpToolPolicy(tools: ToolDescriptor[], server: McpServerConfig): ToolDescriptor[] {
  const names = new Set(server.allowlist.toolNames);
  return tools.map((tool) => {
    const selected = names.has(tool.name) || names.has(tool.invocationName);
    const allowed = server.allowlist.mode === 'all'
      ? true
      : server.allowlist.mode === 'allow'
        ? selected
        : !selected;
    return {
      ...tool,
      provider: {
        ...tool.provider,
        displayName: server.displayName,
        transport: server.transport.kind as ToolTransportKind,
      },
      execution: {
        ...tool.execution,
        mode: server.execution.mode,
        enabled: server.enabled && server.execution.enabled && server.execution.mode !== 'disabled' && allowed,
        timeoutMs: server.timeouts.requestMs,
        maxResultBytes: server.limits.maxResultBytes,
      },
    };
  });
}

export function createMcpRequest<TParams extends Record<string, unknown> | undefined>(
  method: string,
  params?: TParams,
): McpJsonRpcRequest<TParams> {
  return {
    jsonrpc: '2.0',
    id: crypto.randomUUID(),
    method,
    ...(params ? { params } : {}),
  };
}

export function createMcpNotification<TParams extends Record<string, unknown> | undefined>(
  method: string,
  params?: TParams,
): McpJsonRpcNotification<TParams> {
  return {
    jsonrpc: '2.0',
    method,
    ...(params ? { params } : {}),
  };
}

export function unwrapMcpResponse<TResult>(
  response: McpJsonRpcResponse<TResult>,
  errorCode: string,
): TResult {
  if (response.error) {
    throw new McpProtocolError(errorCode, response.error.message, {
      retryable: response.error.code === -32000 || response.error.code === -32603,
      details: {
        jsonRpcCode: response.error.code,
        data: response.error.data,
        externalOutcome: 'confirmed',
        retrySafe: false,
      },
    });
  }
  if (!('result' in response)) {
    throw new McpProtocolError(errorCode, 'MCP response did not include a result.', {
      retryable: true,
      details: { externalOutcome: 'ambiguous', retrySafe: false },
    });
  }
  return response.result as TResult;
}

export function getMcpToolResultSummary(call: ToolCall, result: McpCallToolResult): string {
  if (call.name === 'python_exec') return result.isError ? '工具返回错误' : '工具已执行';
  return result.isError ? 'MCP 工具返回错误' : 'MCP 工具已执行';
}

export function normalizeMcpToolResult(
  server: McpServerConfig,
  call: ToolCall,
  result: McpCallToolResult,
  startedAt: number,
  maxResultBytes: number | undefined,
): ToolResult {
  const completedAt = Date.now();
  const output = normalizeToolOutput(result);
  const rendered = stringifyOutput(output);
  const limit = maxResultBytes ?? server.limits.maxResultBytes;
  const detailSource = result.isError ? extractMcpErrorMessage(result, rendered) : rendered;
  // For large limits, reserve 80 bytes for the marker so total stays within limit.
  // For tiny limits (< 100), truncate to limit and append marker (total may exceed limit,
  // which is the expected behavior for edge-case tiny budgets).
  const contentLimit = limit >= 100 ? Math.max(0, limit - 80) : limit;
  const detailProjection = truncateUtf8ToByteLimit(detailSource, contentLimit);
  const detail = detailProjection.truncated
    ? `${detailProjection.value}\n...[truncated, original=${detailProjection.originalBytes}B, limit=${limit}B]`
    : detailProjection.value;

  refactorTelemetry.recordTruncation({
    timestamp: Date.now(),
    layer: 'mcp',
    toolName: call.name,
    originalBytes: detailProjection.originalBytes,
    truncatedBytes: encoder.encode(detail).length,
    limit,
    truncated: detailProjection.truncated,
    markerPresent: detail.includes('[truncated, original='),
  });

  return {
    ok: result.isError !== true,
    summary: getMcpToolResultSummary(call, result),
    detail,
    name: call.name,
    provider: call.provider,
    descriptorId: call.descriptorId,
    output,
    startedAt,
    completedAt,
    durationMs: completedAt - startedAt,
    truncated: detailProjection.truncated,
    error: result.isError
      ? {
        code: 'mcp_tool_result_error',
        message: detail || 'MCP tool returned isError=true.',
        retryable: false,
        details: {
          externalOutcome: 'confirmed',
          retrySafe: false,
        },
      }
      : undefined,
  };
}

export function truncateUtf8ToByteLimit(value: string, maxBytes: number): { value: string; truncated: boolean; originalBytes: number } {
  const limit = Number.isFinite(maxBytes) ? Math.max(0, Math.floor(maxBytes)) : 0;
  const bytes = encoder.encode(value);
  if (bytes.byteLength <= limit) return { value, truncated: false, originalBytes: bytes.byteLength };

  let boundary = limit;
  while (boundary > 0 && isUtf8ContinuationByte(bytes[boundary])) boundary -= 1;
  return {
    value: decoder.decode(bytes.subarray(0, boundary)),
    truncated: true,
    originalBytes: bytes.byteLength,
  };
}

export function isUtf8ContinuationByte(value: number | undefined): boolean {
  return value !== undefined && (value & 0b1100_0000) === 0b1000_0000;
}

export function extractMcpErrorMessage(result: McpCallToolResult, fallback: string): string {
  if (Array.isArray(result.content)) {
    const textBlocks = result.content
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => (block as { text: string }).text);
    if (textBlocks.length > 0) return textBlocks.join('\n');
  }
  if (result.structuredContent && typeof result.structuredContent === 'object') {
    const sc = result.structuredContent as Record<string, unknown>;
    if (typeof sc.message === 'string') return sc.message;
    if (typeof sc.error === 'string') return sc.error;
    if (sc.error && typeof sc.error === 'object') {
      const err = sc.error as Record<string, unknown>;
      if (typeof err.message === 'string') return err.message;
    }
  }
  return fallback;
}

export function normalizeToolOutput(result: McpCallToolResult): JsonValue {
  if (result.structuredContent !== undefined) return jsonValue(result.structuredContent);
  if (Array.isArray(result.content)) {
    return result.content.map((block) => jsonValue(normalizeContentBlock(block)));
  }
  return null;
}

export function normalizeContentBlock(block: McpContentBlock): Record<string, JsonValue> {
  const normalized: Record<string, JsonValue> = {
    type: stringValue(block.type) || 'unknown',
  };
  for (const [key, value] of Object.entries(block)) {
    if (value !== undefined) normalized[key] = jsonValue(value);
  }
  return normalized;
}

export function getMcpToolName(call: ToolCall, descriptor?: ToolDescriptor): string {
  const annotatedName = descriptor?.annotations?.mcpToolName;
  if (annotatedName) return annotatedName;
  if (call.provider?.kind === 'mcp') return call.name;
  return call.invocationName || call.name;
}

export function normalizeToolSchema(value: unknown): ToolDescriptorSchema {
  const sanitized = sanitizeToolSchema(value);
  return {
    ...sanitized,
    type: 'object',
    properties: (sanitized.properties as Record<string, JsonValue> | undefined) ?? {},
  } as ToolDescriptorSchema;
}

export function toolRiskValue(value: unknown): ToolRiskLevel {
  return value === 'low' || value === 'high' ? value : 'medium';
}

export function stringAnnotations(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined && entry !== null)
      .map(([key, entry]) => [key, typeof entry === 'string' ? entry : JSON.stringify(entry)]),
  );
}

export function clientInfoValue(value: unknown): { name: string; version: string } | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const name = stringValue(raw.name);
  const version = stringValue(raw.version);
  return name || version ? { name, version } : undefined;
}

export function jsonRecordValue(value: unknown): Record<string, JsonValue> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, jsonValue(entry)]),
  );
}

export function jsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) return value.map(jsonValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, jsonValue(entry)]),
    );
  }
  return null;
}

export function stringifyOutput(value: JsonValue): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
}

export function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
