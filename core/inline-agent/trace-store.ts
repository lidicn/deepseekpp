import { withSyncLocalStateLock } from '../persistence/local-state-lock';
import {
  createChromeStorageSlot,
  createVersionedRepository,
  type StorageSlotPort,
} from '../persistence/versioned-repository';
import type { InlineAgentTraceRecord } from './types';
import { inlineAgentTraceCodec } from './trace-codec';

export const INLINE_AGENT_TRACES_STORAGE_KEY = 'dpp_inline_agent_traces';
export const INLINE_AGENT_TRACE_LIMIT = 100;
export const INLINE_AGENT_TRACE_TTL_MS = 1000 * 60 * 60 * 24 * 30;

// Budget control: inline-agent traces carry full prompts and tool outputs
// (often 80-100KB per trace). 100 untrimmed traces easily exceed chrome.storage
// quota and cause QuotaBytes errors on every subsequent write, which then
// breaks main-world message handling. Reserve 20% of total quota for traces;
// the rest stays for tool history, memories, settings, and other keys.
const TRACE_BUDGET_RATIO = 0.20;

function getTraceBudgetBytes(): number {
  // chrome.storage.local.QUOTA_BYTES is 10 MB (10,485,760) for unpacked/packed
  // extensions; fall back to that constant if the runtime does not expose it.
  // Guard against `chrome is not defined` in non-privileged contexts (jsdom tests,
  // SW not yet ready window) — trace persistence is best-effort and must not
  // throw ReferenceError into the agent loop.
  if (typeof chrome === 'undefined' || !chrome.storage?.local?.QUOTA_BYTES) {
    return Math.floor(10_485_760 * TRACE_BUDGET_RATIO);
  }
  const quota = chrome.storage.local.QUOTA_BYTES as number;
  return Math.floor(quota * TRACE_BUDGET_RATIO);
}

/**
 * Drop the oldest traces until the serialized array fits within the budget.
 * The newest trace is always retained so the current execution is never lost.
 *
 * 2026-10-21 修复（真机定位）：原实现用 `candidate.slice(0, -1)` 裁剪，
 * 而 `upsert` 是把新记录 **append 到数组末尾** 的（见 upsert 的
 * `[...current.filter(...), decoded]`）。于是「丢弃最旧的」实际丢的是
 * **最新的那条**，与注释和调用方预期完全相反。
 *
 * 后果：存储一旦接近预算（真机实测 1.85 MB / 2 MB 预算），每次写入新轨迹
 * 都会把刚写进去的那条裁掉 —— 表现为 trace 数量长期不变、时间戳停在几天前，
 * 让 W29 观测看起来「完全没生效」。这也是「工具确实执行了、循环也确实启动了，
 * 却没有留下任何轨迹」的直接原因。
 *
 * 现在改为 `slice(1)`：丢索引 0（最旧），保留末尾（最新）。
 */
function trimTracesToFit(
  traces: InlineAgentTraceRecord[],
  budgetBytes: number,
): InlineAgentTraceRecord[] {
  let candidate = traces;
  while (candidate.length > 1) {
    const serialized = JSON.stringify(candidate);
    if (new Blob([serialized]).size <= budgetBytes) return candidate;
    // 丢最旧的（索引 0）；最新的在末尾，必须保留。
    candidate = candidate.slice(1);
  }
  return candidate;
}

export interface InlineAgentTraceStore {
  read(): Promise<InlineAgentTraceRecord[]>;
  upsert(trace: InlineAgentTraceRecord, now?: number): Promise<void>;
}

export function createInlineAgentTraceStore(
  storage: StorageSlotPort = createChromeStorageSlot(INLINE_AGENT_TRACES_STORAGE_KEY),
): InlineAgentTraceStore {
  const repository = createVersionedRepository({
    label: 'inlineAgentTraces',
    createDefault: () => [],
    codec: inlineAgentTraceCodec,
    storage,
  });

  return {
    read: () => repository.read(),
    async upsert(trace, now = Date.now()) {
      await withSyncLocalStateLock(async () => {
        const decoded = inlineAgentTraceCodec.decode([trace], 'inlineAgentTraces.upsert')[0];
        const current = await repository.readAlreadyLocked();
        let next = [
          ...current.filter((item) => item.id !== decoded.id),
          decoded,
        ]
          .filter((item) => now - item.createdAt < INLINE_AGENT_TRACE_TTL_MS)
          .slice(-INLINE_AGENT_TRACE_LIMIT);

        // Budget control: trim oldest traces if the serialized payload would
        // exceed our share of the storage quota. This prevents QuotaBytes errors
        // from cascading into main-world message handling failures.
        const budgetBytes = getTraceBudgetBytes();
        next = trimTracesToFit(next, budgetBytes);

        try {
          await repository.writeAfterReadAlreadyLocked(next);
        } catch (error) {
          // Graceful degradation: trace persistence is best-effort. A quota
          // exceeded error must not bubble up and break the agent loop.
          console.warn('[DeepSeek++] inline-agent trace write failed (degraded):', error);
        }
      });
    },
  };
}

const inlineAgentTraceStore = createInlineAgentTraceStore();

export function readPersistedInlineAgentTraces(): Promise<InlineAgentTraceRecord[]> {
  return inlineAgentTraceStore.read();
}

export function upsertPersistedInlineAgentTrace(
  trace: InlineAgentTraceRecord,
  now?: number,
): Promise<void> {
  return inlineAgentTraceStore.upsert(trace, now);
}
