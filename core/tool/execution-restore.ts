import type { JsonValue, ToolCardResult, ToolExecutionRecord } from '../types';
import { clampTextToBytes, utf8ByteLength } from '../text/truncate-bytes';

// 2026-10-22：默认预算改为**字节**口径，与 TOOL_EXECUTION_*_MAX_BYTES 之类的
// 调用方命名对齐。原实现用 `value.length` / `slice`（UTF-16 code unit 字符），
// CJK 下同样字符数对应的字节数约 3 倍，导致字节预算被放宽 3 倍，
// 与「防止把 MB 级数据推进 chrome.storage.local」的意图不符。
const DEFAULT_DETAIL_MAX_BYTES = 1_000_000;
const DEFAULT_OUTPUT_MAX_BYTES = 2_000_000;

export interface ToolExecutionRestoreLimits {
  /** detail 的字节上限（UTF-8），不是字符数。 */
  detailMaxBytes?: number;
  /** output 序列化后的字节上限（UTF-8），不是字符数。 */
  outputMaxBytes?: number;
}

export function sanitizeToolExecutionForRestoreStorage(
  execution: ToolExecutionRecord,
  limits: ToolExecutionRestoreLimits = {},
): ToolExecutionRecord {
  return {
    name: execution.name,
    provider: execution.provider,
    descriptorId: execution.descriptorId,
    result: sanitizeToolCardResultForRestoreStorage(execution.result, limits),
  };
}

export function normalizeRestoredToolExecution(execution: ToolExecutionRecord): ToolExecutionRecord {
  return {
    name: execution.name,
    provider: execution.provider,
    descriptorId: execution.descriptorId,
    result: normalizeRestoredToolCardResult(execution.result),
  };
}

export function normalizeRestoredToolCardResult(result: ToolCardResult): ToolCardResult {
  return {
    ...result,
    output: normalizeRestoredOutput(result.output),
  };
}

function sanitizeToolCardResultForRestoreStorage(
  result: ToolCardResult,
  limits: ToolExecutionRestoreLimits,
): ToolCardResult {
  const detailMaxBytes = limits.detailMaxBytes ?? DEFAULT_DETAIL_MAX_BYTES;
  const outputMaxBytes = limits.outputMaxBytes ?? DEFAULT_OUTPUT_MAX_BYTES;
  return {
    ...result,
    detail: clampTextToBytes(result.detail, detailMaxBytes),
    output: sanitizeOutputForStorage(result.output, outputMaxBytes),
  };
}

function sanitizeOutputForStorage(output: JsonValue | undefined, maxBytes: number): JsonValue | undefined {
  if (output === undefined) return undefined;

  const serialized = safeStringify(output);
  if (utf8ByteLength(serialized) <= maxBytes) return output;
  return clampTextToBytes(serialized, maxBytes);
}

function normalizeRestoredOutput(output: JsonValue | undefined): JsonValue | undefined {
  if (typeof output !== 'string') return output;

  const trimmed = output.trim();
  if (!trimmed.startsWith('{')) return output;

  try {
    const parsed = JSON.parse(trimmed) as JsonValue;
    return isKnownStructuredToolOutput(parsed) ? parsed : output;
  } catch {
    return output;
  }
}

function isKnownStructuredToolOutput(value: JsonValue): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const kind = value.kind;
  return kind === 'artifact' || kind === 'skill_draft' || kind === 'memory_import_preview';
}

function safeStringify(value: JsonValue): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
