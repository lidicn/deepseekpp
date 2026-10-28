/**
 * 审计 #99：Chat transcript 持久化 —— MV3 chrome.storage.session 存对话状态，
 * 切 tab / 关侧栏 / SW 回收后回来能续上。
 *
 * 设计要点：
 * - 单一真实来源：storage 里的 ActiveTranscript 是对话状态的 durable 影子
 * - 双 writer：background（ChatPage 不在时继续写）+ ChatPage（在时也写，抵消 background 写的延迟）
 * - 节流：250ms 或累计 64 字符触发一次 storage.set，避免每 chunk 重写整篇
 * - seq 递增：每个 chunk 带唯一 seq，ChatPage 按 seq 去重 + 排序
 * - fencing：markStopped() 后 appendChunk 静默丢弃（迟到 chunk 不入 transcript）
 * - quota 可见：写失败时标 truncatedAt，UI 可见提示
 *
 * 与 automation 骨架的边界：
 * - 不复用 AutomationRun 表/类型（语义不同）
 * - 不自动重试（chat 重试 = 两条回答 + 两次扣额度）
 * - 不用 AUTOMATION_RUN_TIMEOUT_MS（chat 时长由用户控制）
 * - 不用快照式 assistantText（要逐字流 + 工具卡片渐进）
 */
import type { ChatMessage } from '../types';

const STORAGE_KEY = 'deepseek_pp_active_transcript';
const THROTTLE_MS = 250;
const THROTTLE_MIN_CHARS = 64;
/** readTranscript() 读到的记录超过 STALE_AGE_MS 且非 streaming → 视为陈旧、清掉返回空 */
const STALE_AGE_MS = 30 * 60 * 1000;

export interface ActiveTranscriptChunk {
  seq: number;
  text: string;
  at: number;
  /** reasoningText 增量（非文本块，单独 track 以便渲染时拆 reasoning/answer phase） */
  reasoningText?: string;
  /** true 表示这是 done:true 的终止标记（无文本增量） */
  done?: boolean;
}

export interface ActiveTranscript {
  chatSessionId: string | null;
  status: 'idle' | 'streaming' | 'done' | 'failed' | 'stopped';
  messages: ChatMessage[];
  pendingChunks: ActiveTranscriptChunk[];
  lastSeq: number;
  truncatedAt: number | null;
  updatedAt: number;
}

// ---- 模块级节流缓冲 + 写链 ----

/** 节流缓冲：还没 flush 到 storage 的 chunk（按 seq 追加） */
let pendingChunks: ActiveTranscriptChunk[] = [];
/** 节流定时器：setTimeout 句柄，null 表示没在节流 */
let throttleTimer: ReturnType<typeof setTimeout> | null = null;
/** 累计待 flush 的字符数，超过 THROTTLE_MIN_CHARS 立即触发 */
let pendingChars = 0;
/** 全局 seq 计数器：每次 appendChunk 递增 */
let seqCounter = 0;
/** 写链：串行化所有 storage.set（防止并发写丢最新值） */
let writeChain: Promise<void> = Promise.resolve();
/** 当前 transcript 快照：每次从 storage 读 / flush 后内存里也保留一份，供 fast path 读取 */
let inMemory: ActiveTranscript | null = null;
/** truncatedAt：最近一次写失败的时间戳（UI 可见提示用） */
let lastWriteError: unknown = null;

function serializeWrite(task: () => Promise<void>): Promise<void> {
  const run = writeChain.then(task);
  writeChain = run.catch(() => undefined);
  return run;
}

/** 节流 flush — 250ms 到点或累计字符超阈值，立即整对象写 storage */
function scheduleFlush(): void {
  if (throttleTimer !== null) return;
  throttleTimer = setTimeout(() => {
    throttleTimer = null;
    // 如果此时累计字符又超阈值，再触发一次
    if (pendingChars >= THROTTLE_MIN_CHARS) {
      pendingChars = 0;
      scheduleFlush();
    }
    void flushNow();
  }, THROTTLE_MS);
}

/** 立即把 pendingChunks flush 到 storage（绕过节流） */
export async function flushNow(): Promise<void> {
  if (pendingChunks.length === 0) return;
  const chunks = pendingChunks;
  pendingChunks = [];
  pendingChars = 0;
  if (throttleTimer !== null) {
    clearTimeout(throttleTimer);
    throttleTimer = null;
  }
  await serializeWrite(async () => {
    try {
      const existing = await readTranscriptRaw();
      const merged = mergeChunks(existing, chunks);
      merged.updatedAt = Date.now();
      const session = safeSession();
      if (session) await session.set({ [STORAGE_KEY]: merged });
      inMemory = merged;
      lastWriteError = null;
    } catch (err) {
      // 配额或其他写失败：标 truncatedAt，保留已写入部分
      lastWriteError = err;
      if (inMemory) {
        inMemory.truncatedAt = Date.now();
        inMemory.updatedAt = Date.now();
      }
    }
  });
}

/** 合并新 chunks 到已有 transcript：
 * - pendingChunks 追加（按 seq 排序；可能有重复，去重）
 * - status 若 chunk.done=true → 自动推进到 done
 * - pendingChunks 最多保留 500 条（节流期间的缓冲），防止存储膨胀
 */
function mergeChunks(
  existing: ActiveTranscript | null,
  chunks: ActiveTranscriptChunk[],
): ActiveTranscript {
  const base = existing ?? freshTranscript();
  // 去重：seq 已存在（storage 里）或本批次已见过的 → 跳过
  const seen = new Set<number>(base.pendingChunks.map((c) => c.seq));
  const deduped: ActiveTranscriptChunk[] = [];
  for (const c of chunks) {
    if (seen.has(c.seq)) continue;
    seen.add(c.seq);
    deduped.push(c);
  }
  // 合并后按 seq 排序
  const merged = [...base.pendingChunks, ...deduped].sort((a, b) => a.seq - b.seq);
  // 截断：pendingChunks 超过上限时丢最老的
  const MAX_PENDING = 500;
  const trimmed = merged.length > MAX_PENDING
    ? merged.slice(merged.length - MAX_PENDING)
    : merged;
  // 更新 lastSeq
  const lastSeq = trimmed.length > 0
    ? trimmed[trimmed.length - 1]!.seq
    : base.lastSeq;
  // status 推进：收到 done 标记 → 自动 status=done
  const hasDone = trimmed.some((c) => c.done === true);
  const status = hasDone && base.status === 'streaming' ? 'done' : base.status;
  return {
    ...base,
    pendingChunks: trimmed,
    lastSeq,
    status,
  };
}

function freshTranscript(): ActiveTranscript {
  return {
    chatSessionId: null,
    status: 'idle',
    messages: [],
    pendingChunks: [],
    lastSeq: 0,
    truncatedAt: null,
    updatedAt: Date.now(),
  };
}

/**
 * 所有 storage 操作的安全入口 —— 测试环境（无 chrome stub）或扩展上下文失效
 * 时返回 null，让上层返回 fresh transcript / 静默降级；任何"storage 不可用"
 * 不许冒泡成未处理 rejection。
 */
function safeSession(): typeof chrome.storage.session | null {
  const c = (globalThis as unknown as { chrome?: { storage?: { session?: typeof chrome.storage.session } } }).chrome;
  return c?.storage?.session ?? null;
}

async function readTranscriptRaw(): Promise<ActiveTranscript | null> {
  const session = safeSession();
  if (!session) return null;
  const data = await session.get(STORAGE_KEY) as Record<string, unknown>;
  const raw = data[STORAGE_KEY];
  if (!raw || typeof raw !== 'object') return null;
  const t = raw as Partial<ActiveTranscript>;
  // schema 宽松读取 — 缺失字段回落默认
  return {
    chatSessionId: typeof t.chatSessionId === 'string' ? t.chatSessionId : null,
    status: ['idle', 'streaming', 'done', 'failed', 'stopped'].includes(t.status as string)
      ? (t.status as ActiveTranscript['status'])
      : 'idle',
    messages: Array.isArray(t.messages) ? t.messages as ChatMessage[] : [],
    pendingChunks: Array.isArray(t.pendingChunks) ? t.pendingChunks as ActiveTranscriptChunk[] : [],
    lastSeq: typeof t.lastSeq === 'number' ? t.lastSeq : 0,
    truncatedAt: typeof t.truncatedAt === 'number' ? t.truncatedAt : null,
    updatedAt: typeof t.updatedAt === 'number' ? t.updatedAt : Date.now(),
  };
}

// ---- 公开 API ----

/**
 * ChatPage mount 时调用 — 读 storage 拿到完整 transcript。
 * 如果 storage 为空或不存在，返回 fresh transcript。
 *
 * 陈旧兜底（P2）：storage 记录 updatedAt 超 30 分钟且 status !== 'streaming'
 * —— 视为陈旧残留（浏览器关闭前用户离开 + 后台 SW 没机会清理），顺手清掉、返回空。
 * streaming 状态的记录永不清（意味着后台还有请求在跑）。
 */
export async function readTranscript(): Promise<ActiveTranscript> {
  await serializeWrite(async () => {
    inMemory = await readTranscriptRaw();
    if (inMemory !== null
        && inMemory.status !== 'streaming'
        && Date.now() - inMemory.updatedAt > STALE_AGE_MS) {
      // 陈旧记录 → 清掉
      const session = safeSession();
      if (session) await session.remove(STORAGE_KEY);
      inMemory = freshTranscript();
    }
  });
  return inMemory ?? freshTranscript();
}

/**
 * submitPrompt 时由 ChatPage 或 background 调 — 加一条 user 消息。
 * 同时把 status 推进到 streaming。
 */
export async function addUserMessage(
  msg: ChatMessage,
  sessionId?: string | null,
): Promise<void> {
  seqCounter = 0; // 每轮对话新 user msg → seq 从 0 重新开始
  await flushNow();
  await serializeWrite(async () => {
    const existing = await readTranscriptRaw() ?? freshTranscript();
    const messages = [...existing.messages.filter((m) => !(m.role === 'assistant' && !m.text && !(m.reasoningText))), msg];
    const next: ActiveTranscript = {
      ...existing,
      chatSessionId: sessionId ?? existing.chatSessionId,
      status: 'streaming',
      messages,
      pendingChunks: [],
      lastSeq: 0,
      truncatedAt: null,
      updatedAt: Date.now(),
    };
    const session = safeSession();
    if (session) await session.set({ [STORAGE_KEY]: next });
    inMemory = next;
  });
}

/**
 * background broadcastChatChunk 和 ChatPage handler 都调 — 追加 chunk。
 * - 自动 fencing：status=='stopped' 时静默丢弃（迟到 chunk 不入 transcript）
 * - 自动节流：250ms 或累计 >64 字符触发 storage.set
 * - 自动 done 推进：chunk.done=true 时 flush 后 status → 'done'
 */
export function appendChunk(chunk: {
  text?: string;
  reasoningText?: string;
  done?: boolean;
  phase?: string;
}): void {
  // fencing：stopped 后所有 chunk 丢弃
  if (inMemory?.status === 'stopped') return;

  const hasText = (chunk.text?.length ?? 0) > 0 || (chunk.reasoningText?.length ?? 0) > 0;
  const at = Date.now();
  if (chunk.done === true && !hasText) {
    // 纯终止标记 —— 单独一个 done chunk
    pendingChunks.push({ seq: ++seqCounter, text: '', at, done: true });
  } else if (hasText) {
    const seq = ++seqCounter;
    const len = (chunk.text?.length ?? 0) + (chunk.reasoningText?.length ?? 0);
    pendingChunks.push({
      seq,
      text: chunk.text ?? '',
      reasoningText: chunk.reasoningText,
      at,
      done: chunk.done,
    });
    pendingChars += len;
  } else {
    return;
  }

  if (chunk.done === true) {
    // 终止标记 → 立即 flush（不等节流）
    void flushNow();
    return;
  }
  if (pendingChars >= THROTTLE_MIN_CHARS) {
    pendingChars = 0;
    void flushNow();
    return;
  }
  scheduleFlush();
}

/**  fencing 闸门：用户点"停止"时调。此后所有 appendChunk 静默丢弃。 */
export async function markStopped(): Promise<void> {
  await flushNow();
  await serializeWrite(async () => {
    const existing = await readTranscriptRaw() ?? freshTranscript();
    const next: ActiveTranscript = {
      ...existing,
      status: 'stopped',
      truncatedAt: null,
      updatedAt: Date.now(),
    };
    const session = safeSession();
    if (session) await session.set({ [STORAGE_KEY]: next });
    inMemory = next;
  });
}

/** background 侧推进终态（done/failed） */
export async function setTerminalStatus(status: 'done' | 'failed'): Promise<void> {
  await flushNow();
  await serializeWrite(async () => {
    const existing = await readTranscriptRaw() ?? freshTranscript();
    if (existing.status === 'stopped') return; // 用户已停 → 不覆盖
    const next: ActiveTranscript = {
      ...existing,
      status,
      updatedAt: Date.now(),
    };
    const session = safeSession();
    if (session) await session.set({ [STORAGE_KEY]: next });
    inMemory = next;
  });
}

/** newSession 时调 — 清空 transcript，seq 归零 */
export async function clearTranscript(): Promise<void> {
  pendingChunks = [];
  pendingChars = 0;
  seqCounter = 0;
  if (throttleTimer !== null) {
    clearTimeout(throttleTimer);
    throttleTimer = null;
  }
  await serializeWrite(async () => {
    const session = safeSession();
    if (session) await session.remove(STORAGE_KEY);
    inMemory = freshTranscript();
  });
}

/** 读当前 in-memory 快照（同步快路径，跳过 storage.get） */
export function peekTranscript(): ActiveTranscript | null {
  return inMemory;
}

/** 检查上次写是否因配额等失败过（UI 可提示 "早期部分已省略"） */
export function getLastWriteError(): unknown {
  return lastWriteError;
}
