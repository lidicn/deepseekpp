import type { ToolResult } from '../types';
import { refactorTelemetry } from '../debug/refactor-telemetry';

/**
 * Universal tool result byte governance: truncates the detail text that gets
 * fed back into the model context. MCP tools have their own governance
 * (client-descriptor normalizeMcpToolResult), so this only applies when the
 * result does not already carry an MCP truncation marker.
 */

export const DEFAULT_TOOL_RESULT_BYTES = 8000;

const MCP_TRUNCATION_MARKER = '[truncated, original=';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function truncateToolResultDetail(
  result: ToolResult,
  maxBytes: number = DEFAULT_TOOL_RESULT_BYTES,
): ToolResult {
  if (!result.detail) return result;
  // MCP results are governed by normalizeMcpToolResult (server.limits.maxResultBytes),
  // generic layer must not double-truncate them regardless of whether MCP actually truncated.
  if (result.provider?.kind === 'mcp') return result;
  // Skip if already truncated by MCP governance (legacy marker check)
  if (result.detail.includes(MCP_TRUNCATION_MARKER)) return result;
  if (result.truncated) return result;

  const bytes = encoder.encode(result.detail);
  const limit = Number.isFinite(maxBytes) ? Math.max(0, Math.floor(maxBytes)) : 0;
  if (bytes.byteLength <= limit) return result;
  // Reserve 80 bytes for the truncation marker so content + marker always fit
  // within `limit` (the marker string is < 80 bytes for realistic byte counts).
  // When the whole budget is too small to also carry the marker (limit < 100),
  // hard-truncate to the budget WITHOUT the marker — governance must never
  // emit more bytes than allowed (B7: tiny-limit overshoot). `truncated` and
  // telemetry still record the truncation in that case.
  const MARKER_RESERVE = 80;
  const canCarryMarker = limit >= 100;
  const contentLimit = canCarryMarker ? Math.max(0, limit - MARKER_RESERVE) : limit;

  let boundary = contentLimit;
  while (boundary > 0 && (bytes[boundary] & 0b1100_0000) === 0b1000_0000) boundary -= 1;
  const truncatedValue = decoder.decode(bytes.subarray(0, boundary));
  const marker = `\n...[result-truncated, original=${bytes.byteLength}B, limit=${limit}B]`;
  const newDetail = canCarryMarker ? `${truncatedValue}${marker}` : truncatedValue;

  refactorTelemetry.recordTruncation({
    timestamp: Date.now(),
    layer: 'governance',
    toolName: result.name ?? 'unknown',
    originalBytes: bytes.byteLength,
    truncatedBytes: encoder.encode(newDetail).length,
    limit,
    truncated: true,
    markerPresent: newDetail.includes('[result-truncated, original='),
  });

  return {
    ...result,
    detail: newDetail,
    truncated: true,
  };
}
