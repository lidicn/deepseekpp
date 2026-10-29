/**
 * 流结束原因诊断（P0-1，**纯观测，不改任何行为**）。
 *
 * 背景：`断流根因与修复方案-20261029.md` §2.第二层 ——
 * `DeepSeekStreamSummary` 只有 finished/responseMessageId/assistantText，
 * 截断时**没有任何"为什么结束"的记录**，所以每次只能猜，
 * 于是反复在 shouldNudge 里加文本启发式（两处「Root cause of 高概率断流」注释就是指纹）。
 *
 * 本模块只回答：这次流是
 *   - 看到 FINISHED 帧正常结束
 *   - 服务端直接关流（done，但没 FINISHED）
 *   - 读到一半抛错（连接重置/超时 abort）
 *   - 最后见过哪些帧类型、状态值是什么（PREEMPTED / FAILED / …）
 *   - 有没有声明过 TOOL fragment（工具轮的特征）
 *
 * 注意：这里**不判断"算不算截断"**（那是 P0-2 的事），只如实记录事实。
 */

export type StreamEndedBy = 'done' | 'error' | 'partial-abort' | 'unknown';

export interface StreamDiagnosticsSnapshot {
  frameCount: number;
  eventTypeCounts: Record<string, number>;
  lastEventType: string | null;
  /** parsed.p（如 response/status、response/fragments/-1/content） */
  lastFramePath: string | null;
  /** 状态类帧的值（response/status 的 v、BATCH 里 quasi_status 的 v） */
  lastFrameStatus: string | null;
  /** parsed.o（如 BATCH / APPEND） */
  lastFrameOperation: string | null;
  /** 见过的 output fragment 类型（来自 codec 的 fragment state） */
  fragmentTypes: string[];
  /** 是否声明过 TOOL fragment（工具轮的强特征） */
  sawToolFragment: boolean;
  /** 见过 TOOL fragment 但没拿到 FINISHED（P0-2 要用的关键组合） */
  toolFragmentUnfinished: boolean;
  responseMessageId: number | null;
  endedBy: StreamEndedBy;
}

export interface StreamDiagnostics {
  noteParsed(parsed: unknown, eventType?: string): void;
  noteFragmentTypes(types: readonly string[]): void;
  noteMessageIds(responseMessageId: number | null): void;
  noteEnd(endedBy: Exclude<StreamEndedBy, 'unknown'>): void;
  snapshot(): StreamDiagnosticsSnapshot;
}

const STATUS_PATHS = new Set(['response/status', 'quasi_status']);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function createStreamDiagnostics(): StreamDiagnostics {
  let frameCount = 0;
  const eventTypeCounts: Record<string, number> = {};
  let lastEventType: string | null = null;
  let lastFramePath: string | null = null;
  let lastFrameStatus: string | null = null;
  let lastFrameOperation: string | null = null;
  let fragmentTypes: string[] = [];
  let responseMessageId: number | null = null;
  let endedBy: StreamEndedBy = 'unknown';

  return {
    noteParsed(parsed, eventType) {
      frameCount += 1;
      if (eventType) {
        lastEventType = eventType;
        eventTypeCounts[eventType] = (eventTypeCounts[eventType] ?? 0) + 1;
      }

      const record = asRecord(parsed);
      if (!record) return;

      const path = typeof record.p === 'string' ? record.p : null;
      const operation = typeof record.o === 'string' ? record.o : null;
      if (path) lastFramePath = path;
      if (operation) lastFrameOperation = operation;

      // ① 直接的状态帧：{p:'response/status', v:'FINISHED'|'PREEMPTED'|...}
      if (path && STATUS_PATHS.has(path) && typeof record.v === 'string') {
        lastFrameStatus = record.v;
      }

      // ② BATCH 帧里夹带的 quasi_status
      if (operation === 'BATCH' && Array.isArray(record.v)) {
        for (const item of record.v) {
          const entry = asRecord(item);
          if (!entry) continue;
          if (entry.p === 'quasi_status' && typeof entry.v === 'string') {
            lastFrameStatus = entry.v;
          }
        }
      }

      // ③ 顺带记一下 id（BATCH 里也可能带）
      const maybeId = record.v;
      if (typeof maybeId === 'number' && Number.isSafeInteger(maybeId) && maybeId > 0) {
        responseMessageId = maybeId;
      }
    },

    noteFragmentTypes(types) {
      fragmentTypes = [...types];
    },

    noteMessageIds(id) {
      if (typeof id === 'number' && Number.isSafeInteger(id) && id > 0) responseMessageId = id;
    },

    noteEnd(how) {
      endedBy = how;
    },

    snapshot() {
      const sawToolFragment = fragmentTypes.includes('TOOL');
      return {
        frameCount,
        eventTypeCounts: { ...eventTypeCounts },
        lastEventType,
        lastFramePath,
        lastFrameStatus,
        lastFrameOperation,
        fragmentTypes: [...fragmentTypes],
        sawToolFragment,
        toolFragmentUnfinished: sawToolFragment && lastFrameStatus !== 'FINISHED',
        responseMessageId,
        endedBy,
      };
    },
  };
}

/** 拼成一行日志（diagnosticLogBuffer.details 用）。 */
export function formatStreamDiagnostics(snapshot: StreamDiagnosticsSnapshot): string {
  const parts = [
    `endedBy=${snapshot.endedBy}`,
    `frames=${snapshot.frameCount}`,
    `lastEvent=${snapshot.lastEventType ?? 'n/a'}`,
    `lastPath=${snapshot.lastFramePath ?? 'n/a'}`,
    `lastStatus=${snapshot.lastFrameStatus ?? 'n/a'}`,
    `fragments=${snapshot.fragmentTypes.join('|') || 'none'}`,
    `toolUnfinished=${snapshot.toolFragmentUnfinished}`,
    `msgId=${snapshot.responseMessageId ?? 'n/a'}`,
  ];
  return parts.join(' ');
}

/**
 * 流结束分类（P0-2）。用 P0-1 已采的事实判定"这次结束是不是正常"，
 * 而不是继续往 shouldNudge 里加文本启发式。
 *
 * - `clean`：见到 FINISHED 帧
 * - `tool-turn-close`：见过 TOOL fragment、拿到了正的 responseMessageId、没见 FINISHED
 *   ⇒ 极可能是"工具轮正常收尾但服务端没发结束帧"。**不该当成截断去 nudge**。
 * - `truncated`：有 TOOL fragment 未闭合，或既无 id 也无正文 ⇒ 真截断
 * - `connection-error`：读流抛错（连接层）
 */
export type StreamEndClass = 'clean' | 'tool-turn-close' | 'truncated' | 'connection-error';

export function classifyStreamEnd(snapshot: StreamDiagnosticsSnapshot): StreamEndClass {
  if (snapshot.lastFrameStatus === 'FINISHED') return 'clean';
  if (snapshot.endedBy === 'error') return 'connection-error';
  // 工具轮收尾：声明过 TOOL fragment，且服务端确实落了一条消息（正 id）
  if (snapshot.sawToolFragment && snapshot.responseMessageId !== null) return 'tool-turn-close';
  return 'truncated';
}

