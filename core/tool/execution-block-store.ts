import { withSyncLocalStateLock } from '../persistence/local-state-lock';
import {
  createChromeStorageSlot,
  createVersionedRepository,
  type StorageSlotPort,
} from '../persistence/versioned-repository';
import {
  toolExecutionBlockCodec,
  type PersistedToolExecutionBlock,
} from './execution-block-codec';

export const TOOL_EXECUTION_BLOCKS_STORAGE_KEY = 'dpp_tool_execution_blocks';
export const TOOL_EXECUTION_BLOCK_LIMIT = 100;
export const TOOL_EXECUTION_BLOCK_TTL_MS = 1000 * 60 * 60 * 24 * 30;

/**
 * 字节预算比例。
 *
 * 2026-10-22 真机定位（页面崩溃）：这个 key 只按**条数**限 100，不按字节。
 * 而工具输出（目录列表、文件内容）可以任意大，100 条实测撑到 **2797 KB**。
 * 每次 `upsert` 都是「读全部 → 过滤 → 写全部」，也就是每次工具执行都要做
 * 一次 ~2.8 MB 的 JSON 反序列化 + 序列化。真机上连续 3 次工具调用
 * （04:24:32 / 04:24:33 / 04:24:38）之后渲染进程直接崩溃，
 * Chrome 提示「页面崩溃可能与浏览器插件对页面内容的修改有关」。
 *
 * 对照：`trace-store.ts` 早就有 20% 的字节预算，这里一直没有。
 * 给 blocks 留 25%（约 2.5 MB）：它是单项最大消费者，但也要给
 * traces(20%)、tool_history、usage、memories、settings 留出空间。
 */
const TOOL_EXECUTION_BLOCK_BUDGET_RATIO = 0.25;

function getToolExecutionBlockBudgetBytes(): number {
  // 与 trace-store 同样处理：非特权上下文（jsdom / SW 未就绪）回落到 10 MB 常量，
  // 且绝不能把 ReferenceError 抛进工具执行链路（持久化是尽力而为）。
  if (typeof chrome === 'undefined' || !chrome.storage?.local?.QUOTA_BYTES) {
    return Math.floor(10_485_760 * TOOL_EXECUTION_BLOCK_BUDGET_RATIO);
  }
  const quota = chrome.storage.local.QUOTA_BYTES as number;
  return Math.floor(quota * TOOL_EXECUTION_BLOCK_BUDGET_RATIO);
}

/**
 * 丢弃最旧的块直到序列化后落在预算内；**始终保留最新的那块**，
 * 否则刚执行的工具结果会立刻被裁掉（trace-store 历史上踩过这个坑：
 * 裁剪方向写反，丢的是最新那条）。
 */
function trimBlocksToFit(
  blocks: PersistedToolExecutionBlock[],
  budgetBytes: number,
): PersistedToolExecutionBlock[] {
  let candidate = blocks;
  while (candidate.length > 1) {
    const serialized = JSON.stringify(candidate);
    const size = typeof Blob === 'undefined'
      ? serialized.length
      : new Blob([serialized]).size;
    if (size <= budgetBytes) return candidate;
    candidate = candidate.slice(1);
  }
  return candidate;
}

export interface ToolExecutionBlockStore {
  read(): Promise<PersistedToolExecutionBlock[]>;
  upsert(block: PersistedToolExecutionBlock, now?: number): Promise<void>;
}

export function createToolExecutionBlockStore(
  storage: StorageSlotPort = createChromeStorageSlot(TOOL_EXECUTION_BLOCKS_STORAGE_KEY),
): ToolExecutionBlockStore {
  const repository = createVersionedRepository({
    label: 'toolExecutionBlocks',
    createDefault: () => [],
    codec: toolExecutionBlockCodec,
    storage,
  });

  return {
    read: () => repository.read(),
    async upsert(block, now = Date.now()) {
      await withSyncLocalStateLock(async () => {
        const decoded = toolExecutionBlockCodec.decode([block], 'toolExecutionBlocks.upsert')[0];
        const current = await repository.readAlreadyLocked();
        const retained = [
          ...current.filter((item) => item.id !== decoded.id),
          decoded,
        ]
          .filter((item) => now - item.createdAt < TOOL_EXECUTION_BLOCK_TTL_MS)
          .slice(-TOOL_EXECUTION_BLOCK_LIMIT);
        // 条数过滤之后再按字节预算裁剪，避免存储无限膨胀导致
        // 每次 upsert 都做数 MB 的 JSON 往返（真机渲染进程崩溃的直接原因）。
        const next = trimBlocksToFit(retained, getToolExecutionBlockBudgetBytes());
        await repository.writeAfterReadAlreadyLocked(next);
      });
    },
  };
}

const toolExecutionBlockStore = createToolExecutionBlockStore();

export function readPersistedToolExecutionBlocks(): Promise<PersistedToolExecutionBlock[]> {
  return toolExecutionBlockStore.read();
}

export function upsertPersistedToolExecutionBlock(
  block: PersistedToolExecutionBlock,
  now?: number,
): Promise<void> {
  return toolExecutionBlockStore.upsert(block, now);
}
