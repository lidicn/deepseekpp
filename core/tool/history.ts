import type { ToolCall, ToolCallHistoryRecord, ToolExecutionTrigger, ToolResult } from './types';
import { decodeToolCallHistory, encodeToolCallHistory } from './history-codec';
import { createCoalescingMutationQueue } from '../persistence/coalescing-mutation-queue';
import { refactorTelemetry } from '../debug/refactor-telemetry';

export const TOOL_HISTORY_STORAGE_KEY = 'deepseek_pp_tool_history';
// Lowered from 200 → 100. Each record carries detail/output snapshots, and each
// persisted burst replaces the whole key. 200 records of untrimmed MCP output
// easily pushed the serialized payload past chrome.storage.local's QUOTA_BYTES
// (10 MB), which then failed on every subsequent write (issue #297). 100
// trimmed records keep the working set well under quota.
const MAX_HISTORY = 100;
// Reserve headroom so other storage keys (memories, skills, settings) are not
// evicted when tool history grows. 0.75 of the per-key budget.
const HISTORY_BUDGET_RATIO = 0.75;
type ToolHistoryMutation = {
  call: ToolCall;
  result: ToolResult;
  source: ToolExecutionTrigger;
};
const toolHistoryOperations = createCoalescingMutationQueue<
  ToolHistoryMutation,
  ToolCallHistoryRecord
>(persistToolHistoryBurst);

export async function appendToolCallHistory(
  call: ToolCall,
  result: ToolResult,
  source: ToolExecutionTrigger,
): Promise<ToolCallHistoryRecord> {
  return toolHistoryOperations.mutate({ call, result, source });
}

async function persistToolHistoryBurst(
  mutations: readonly ToolHistoryMutation[],
): Promise<ToolCallHistoryRecord[]> {
  // B2 fix: flush 写回前检查 barrier 干扰 —— 如果 clear 在 read 和 write 之间
  // 跑过，storage key 会消失。此时跳过写回并返回空数组，让 queue 不 reject。
  // 注意：serial-operation-queue 虽然让 settleBatch 和 barrier 串行排队，
  // 但 settleBatch 内部 await readToolCallHistoryAlreadyOwned() 让出后，
  // barrier 会在下一个 tick 开始（serial queue 是"operation 串行但内部 await 可穿插"）。
  // 这就是 race：settleBatch read → await → barrier remove → settleBatch write（复活）。
  const preCheck = await chrome.storage.local.get(TOOL_HISTORY_STORAGE_KEY) as Record<string, unknown>;
  if (!(TOOL_HISTORY_STORAGE_KEY in preCheck)) {
    // key 不存在 —— clear 已经先执行，跳过写回
    console.debug('[DPP] B2 race: mutate batch skipped write-back (clear barrier won)');
    return [];
  }

  let history = orderToolCallHistory(await readToolCallHistoryAlreadyOwned());
  const results: ToolCallHistoryRecord[] = [];
  const budgetBytes = getHistoryBudgetBytes();
  for (const { call, result, source } of mutations) {
    const record: ToolCallHistoryRecord = {
      id: crypto.randomUUID(),
      call: sanitizeCall(call),
      result: sanitizeResult(result),
      source,
      createdAt: Date.now(),
    };
    history = trimToFit([record, ...history.slice(0, MAX_HISTORY)], budgetBytes)
      .slice(0, MAX_HISTORY);
    results.push(record);
  }
  // B2 fix: write-back 前再检查一次 —— 防 clear 在 write 前瞬间执行
  const postCheck = await chrome.storage.local.get(TOOL_HISTORY_STORAGE_KEY) as Record<string, unknown>;
  if (!(TOOL_HISTORY_STORAGE_KEY in postCheck)) {
    console.debug('[DPP] B2 race: post-read clear detected, skipping write-back');
    return [];
  }
  await chrome.storage.local.set({
    [TOOL_HISTORY_STORAGE_KEY]: encodeToolCallHistory(history),
  });
  return results;
}

export async function getToolCallHistory(limit: number = MAX_HISTORY): Promise<ToolCallHistoryRecord[]> {
  return toolHistoryOperations.barrier(async () => {
    const history = orderToolCallHistory(await readToolCallHistoryAlreadyOwned());
    return history.slice(0, limit);
  });
}

export async function clearToolCallHistory(): Promise<void> {
  await toolHistoryOperations.barrier(async () => {
    await readToolCallHistoryAlreadyOwned();
    await chrome.storage.local.remove(TOOL_HISTORY_STORAGE_KEY);
  });
}

async function readToolCallHistoryAlreadyOwned(): Promise<ToolCallHistoryRecord[]> {
  const data = await chrome.storage.local.get(TOOL_HISTORY_STORAGE_KEY) as Record<string, unknown>;
  return decodeToolCallHistory(data[TOOL_HISTORY_STORAGE_KEY]);
}

function orderToolCallHistory(
  history: readonly ToolCallHistoryRecord[],
): ToolCallHistoryRecord[] {
  return [...history].sort((a, b) => b.createdAt - a.createdAt);
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function sanitizeCall(call: ToolCall): ToolCall {
  return {
    ...call,
    payload: truncateRecordBytes(call.payload, 4_000),
    raw: truncateStringBytes(call.raw, 4_000) ?? call.raw,
  };
}

function sanitizeResult(result: ToolResult): ToolResult {
  const sanitized: ToolResult = {
    ...result,
    detail: truncateStringBytes(result.detail, 16_000),
    output: result.output === undefined ? undefined : truncateStringBytes(JSON.stringify(result.output), 32_000),
    error: result.error
      ? {
        ...result.error,
        message: truncateStringBytes(result.error.message, 2_000) ?? '',
        details: result.error.details ? truncateRecordBytes(result.error.details, 2_000) : undefined,
      }
      : undefined,
  };
  // Record storage-layer truncation for telemetry (does NOT affect model context).
  if (sanitized.detail !== result.detail) {
    const originalBytes = result.detail ? encoder.encode(result.detail).byteLength : 0;
    const truncatedBytes = sanitized.detail ? encoder.encode(sanitized.detail).byteLength : 0;
    refactorTelemetry.recordTruncation({
      timestamp: Date.now(),
      layer: 'storage',
      toolName: result.name ?? 'unknown',
      originalBytes,
      truncatedBytes,
      limit: 16_000,
      truncated: true,
      markerPresent: (sanitized.detail ?? '').includes('[truncated]'),
    });
  }
  return sanitized;
}

function truncateRecordBytes(value: Record<string, unknown>, maxBytes: number): Record<string, unknown> {
  const json = JSON.stringify(value);
  if (encoder.encode(json).byteLength <= maxBytes) return value;
  return { truncated: true, preview: truncateStringBytes(json, maxBytes) ?? json.slice(0, maxBytes) };
}

function truncateStringBytes(value: string | undefined, maxBytes: number): string | undefined {
  if (!value) return value;
  const bytes = encoder.encode(value);
  if (bytes.byteLength <= maxBytes) return value;
  const marker = '\n...[truncated]';
  const markerBytes = encoder.encode(marker).byteLength;
  const limit = Math.max(0, maxBytes - markerBytes);
  const boundary = findUtf8Boundary(bytes, limit);
  return `${decoder.decode(bytes.subarray(0, boundary))}${marker}`;
}

/** Walk back from `limit` to a boundary that does not split a multi-byte UTF-8 char. */
function findUtf8Boundary(bytes: Uint8Array, limit: number): number {
  if (limit >= bytes.byteLength) return bytes.byteLength;
  let boundary = limit;
  while (boundary > 0 && (bytes[boundary] & 0xC0) === 0x80) boundary--;
  return boundary;
}

/**
 * Drop the oldest records until the serialized history fits within the budget.
 * Prevents the chrome.storage.local.set() call from throwing QUOTA_BYTES on
 * every tool call once the key fills up (issue #297). The newest record is
 * always retained so the current execution is never lost.
 */
function trimToFit(records: ToolCallHistoryRecord[], budgetBytes: number): ToolCallHistoryRecord[] {
  let candidate = records;
  while (candidate.length > 1) {
    const serialized = JSON.stringify(candidate);
    if (new Blob([serialized]).size <= budgetBytes) return candidate;
    // Drop oldest (highest index after we prepended the newest at index 0).
    candidate = candidate.slice(0, -1);
  }
  return candidate;
}

function getHistoryBudgetBytes(): number {
  // chrome.storage.local.QUOTA_BYTES is 10 MB (10,485,760) for unpacked/packed
  // extensions; fall back to that constant if the runtime does not expose it.
  const quota = (chrome.storage.local.QUOTA_BYTES as number | undefined) ?? 10_485_760;
  return Math.floor(quota * HISTORY_BUDGET_RATIO);
}
