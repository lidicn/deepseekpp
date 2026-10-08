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
  const quota = (chrome.storage.local.QUOTA_BYTES as number | undefined) ?? 10_485_760;
  return Math.floor(quota * TRACE_BUDGET_RATIO);
}

/**
 * Drop the oldest traces until the serialized array fits within the budget.
 * The newest trace is always retained so the current execution is never lost.
 */
function trimTracesToFit(
  traces: InlineAgentTraceRecord[],
  budgetBytes: number,
): InlineAgentTraceRecord[] {
  let candidate = traces;
  while (candidate.length > 1) {
    const serialized = JSON.stringify(candidate);
    if (new Blob([serialized]).size <= budgetBytes) return candidate;
    // Drop oldest (highest index — newest is appended at the end).
    candidate = candidate.slice(0, -1);
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
