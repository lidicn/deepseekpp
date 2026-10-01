// Tracks an in-flight sidepanel chat tool loop so a service-worker restart
// can be reconciled: if the SW dies mid-loop, the loop never emits a final
// `done:true` chunk and the sidepanel hangs. `reconcileInterruptedChatLoop`
// (called on every SW wake) detects a stale marker and lets the caller emit
// a terminating chunk.
//
// `chrome.storage.session` is used intentionally — it is cleared when the
// browser session ends, mirroring the lifetime of an in-flight chat turn.
//
// P0-1 SW Keepalive (引用计数式): SW 约 30s 空闲回收。任何需要 SW 长时存活
// 的操作（chat 循环、native tool 执行）都可以用 acquireKeepalive() /
// releaseKeepalive() 包裹。只有最后一个持有者 release 时才真正清理 alarm。

// P0-3: 扩展 marker 带工具执行历史 + 当前工具状态
// SW 重启后 reconcile 能知道"执行到哪了"，而非只知道"断了"
import type { ToolExecutionRecord } from '../types';

const SESSION_STORAGE_KEY = 'deepseek_pp_active_chat_loop';
// P0-3: stale 阈值从 15s → 60s（和 keepalive 周期对齐：keepalive 30s 心跳，
// SW 在 keepalive 存活期间不应被回收；若真回收了，60s 足够覆盖绝大多数场景）
const STALE_THRESHOLD_MS = 60_000;
const CHAT_LOOP_KEEPALIVE_ALARM = 'deepseek_pp_chat_loop_keepalive';
// chrome.alarms minimum period is ~30s; value below gets clamped. We use
// 0.5 which Chrome clamps to its internal floor, guaranteeing a period
// strictly less than the SW idle-reclaim (~30s) while the alarm exists.
const CHAT_LOOP_KEEPALIVE_PERIOD_MIN = 0.5;

// ---- 引用计数 keepalive ----
// chatRuntimeService 和 EXECUTE_TOOL_CALL 两条路径共享。
// Web 模式下 inline agent 连续调 N 个工具 → N 次 acquire / N 次 release，
// alarm 保持存活到最后一个工具完成。
let keepaliveRefCount = 0;
let keepaliveRegistered = false;

function registerKeepaliveAlarm(): boolean {
  const alarms = (chrome as typeof chrome & {
    alarms?: { create: typeof chrome.alarms.create };
  }).alarms;
  if (!alarms) return false;
  try {
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    alarms.create(CHAT_LOOP_KEEPALIVE_ALARM, {
      periodInMinutes: CHAT_LOOP_KEEPALIVE_PERIOD_MIN,
    });
    if (!keepaliveRegistered) {
      console.log('[DPP] SW keepalive alarm registered (30s period)');
      keepaliveRegistered = true;
    }
    return true;
  } catch (err) {
    console.warn('[DPP] Failed to register SW keepalive alarm:', err);
    return false;
  }
}

function clearKeepaliveAlarm(): void {
  const alarms = (chrome as typeof chrome & {
    alarms?: { clear: typeof chrome.alarms.clear };
  }).alarms;
  if (!alarms) return;
  try {
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    alarms.clear(CHAT_LOOP_KEEPALIVE_ALARM);
    console.log('[DPP] SW keepalive alarm cleared');
    keepaliveRegistered = false;
  } catch (err) {
    console.warn('[DPP] Failed to clear SW keepalive alarm:', err);
  }
}

/**
 * 注册 SW 保活 alarm。每次调用引用计数 +1。
 * 适用于任何需要 SW 在长时操作（>5s）中存活的场景：
 *   - chat runtime service 的官方 API 工具循环
 *   - web 模式下 inline agent 触发的 EXECUTE_TOOL_CALL
 */
export function acquireKeepalive(): void {
  keepaliveRefCount++;
  registerKeepaliveAlarm();
}

/** 释放保活引用。最后一个持有者 release 时才真正清理 alarm。 */
export function releaseKeepalive(): void {
  keepaliveRefCount = Math.max(0, keepaliveRefCount - 1);
  if (keepaliveRefCount === 0) {
    clearKeepaliveAlarm();
  }
}

/** 同步读取当前 keepalive 引用计数（调试用）。 */
export function getKeepaliveRefCount(): number {
  return keepaliveRefCount;
}

// ---- 原始 chat loop marker（reconcileInterruptedChatLoop 依赖） ----

export type ChatLoopProvider = 'web' | 'official-api';

export interface ActiveChatLoop {
  active: boolean;
  startedAt: number;
  provider: ChatLoopProvider;
  // P0-3: 工具执行历史（纯数据，可 JSON 序列化）
  executions: ToolExecutionRecord[];
  // P0-3: 正在执行的工具（若有）
  currentTool: { name: string; startedAt: number } | null;
}

export interface InterruptedChatLoop {
  provider: ChatLoopProvider;
  startedAt: number;
  interruptedAt: number;
  // P0-3: 把执行历史带给 reconcile 调用方
  executions: ToolExecutionRecord[];
  currentTool: { name: string; startedAt: number } | null;
}

async function readMarker(): Promise<ActiveChatLoop | null> {
  const data = await chrome.storage.session
    .get(SESSION_STORAGE_KEY) as Record<string, unknown>;
  const value = data[SESSION_STORAGE_KEY];
  if (!value || typeof value !== 'object') return null;
  const marker = value as Partial<ActiveChatLoop>;
  if (marker.active !== true || typeof marker.startedAt !== 'number') return null;
  return {
    active: true,
    startedAt: marker.startedAt,
    provider: marker.provider === 'official-api' ? 'official-api' : 'web',
    executions: Array.isArray(marker.executions) ? marker.executions : [],
    currentTool: marker.currentTool ?? null,
  };
}

export async function markChatLoopStarted(provider: ChatLoopProvider): Promise<void> {
  const marker: ActiveChatLoop = {
    active: true,
    startedAt: Date.now(),
    provider,
    executions: [],
    currentTool: null,
  };
  await chrome.storage.session.set({ [SESSION_STORAGE_KEY]: marker });

  // P0-1: SW 保活 — 引用计数 +1。
  acquireKeepalive();
}

export async function markChatLoopFinished(): Promise<void> {
  await chrome.storage.session.remove(SESSION_STORAGE_KEY);

  // P0-1: SW 保活 — 引用计数 -1，归零才真正清理。
  releaseKeepalive();
}

/** P0-3: 追加一条工具执行记录到 storage marker */
export async function appendToolExecution(record: ToolExecutionRecord): Promise<void> {
  const marker = await readMarker();
  if (!marker) return;
  marker.executions.push(record);
  await chrome.storage.session.set({ [SESSION_STORAGE_KEY]: marker });
}

/** P0-3: 设置当前正在执行的工具（工具执行前调，完成后调 clearCurrentTool） */
export async function setCurrentTool(name: string): Promise<void> {
  const marker = await readMarker();
  if (!marker) return;
  marker.currentTool = { name, startedAt: Date.now() };
  await chrome.storage.session.set({ [SESSION_STORAGE_KEY]: marker });
}

/** P0-3: 清除当前工具标记（工具完成或失败后调） */
export async function clearCurrentTool(): Promise<void> {
  const marker = await readMarker();
  if (!marker) return;
  marker.currentTool = null;
  await chrome.storage.session.set({ [SESSION_STORAGE_KEY]: marker });
}

export async function getActiveChatLoop(): Promise<ActiveChatLoop | null> {
  return readMarker();
}

/**
 * Detects a chat loop that was interrupted by a service-worker termination.
 * Returns the interrupted loop descriptor when the marker is stale (i.e. the
 * SW was likely killed while the loop was still running), and clears the
 * marker. Returns `null` when there is no marker or it is still fresh, in
 * which case the loop may simply be running in the current SW instance.
 *
 * Callers should emit a final `done:true` chunk and reset in-memory state
 * when this returns a non-null value.
 */
/**
 * P0-6 fix: SW 冷启动时 reconcile — marker 存在即中断（去掉 stale 阈值）。
 *
 * 为什么可以去掉 STALE_THRESHOLD_MS：
 * - reconcileInterruptedOnWake 只在 chrome.runtime.onStartup/onInstalled 里调
 * - 冷启动意味着 SW 刚从磁盘加载 → 所有内存态（activeTurn、chat loop）全丢
 * - marker 是唯一的 SW 持久态，如果 marker 存在 → 一定是上一个 SW 实例断了
 * - stale 阈值在这个场景下有害：它让"开始 20s 但 SW 被回收了"的 loop 不触发终止 chunk → 侧面板永久挂起
 *
 * 保留 STALE_THRESHOLD_MS 常量作为未来"同实例 reconcile"的防御（如果以后加了手动 reconcile 入口）。
 */
/**
 * P0-6 fix: SW 冷启动时 reconcile — marker 存在即中断（去掉 stale 阈值）。
 *
 * 为什么可以去掉 STALE_THRESHOLD_MS：
 * - reconcileInterruptedOnWake 只在 chrome.runtime.onStartup/onInstalled 里调
 * - 冷启动意味着 SW 刚从磁盘加载 → 所有内存态（activeTurn、chat loop）全丢
 * - marker 是唯一的 SW 持久态，如果 marker 存在 → 一定是上一个 SW 实例断了
 * - stale 阈值在这个场景下有害：它让"开始 20s 但 SW 被回收了"的 loop 不触发终止 chunk → 侧面板永久挂起
 *
 * 保留 STALE_THRESHOLD_MS 常量作为未来"同实例 reconcile"的防御（如果以后加了手动 reconcile 入口）。
 */
export async function reconcileInterruptedChatLoop(): Promise<InterruptedChatLoop | null> {
  const marker = await readMarker();
  if (!marker) return null;

  await markChatLoopFinished();
  // P0-3: 把 executions + currentTool 带给调用方
  return {
    provider: marker.provider,
    startedAt: marker.startedAt,
    interruptedAt: Date.now(),
    executions: marker.executions,
    currentTool: marker.currentTool,
  };
}
