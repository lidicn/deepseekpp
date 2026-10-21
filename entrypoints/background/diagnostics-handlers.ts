import {
  definePayloadlessRuntimeCommandHandler,
  type RuntimeCommandHandler,
} from '../../core/messaging/runtime-command-registry';
import { diagnosticLogBuffer, type DiagnosticLogEntry } from '../../core/diagnostics/log-buffer';
import { readPersistedInlineAgentTraces } from '../../core/inline-agent/trace-store';
import { renderTraceReport } from '../../core/trace/report';

export interface DiagnosticsRuntimeHandlerDependencies {
  getVersion(): string;
  /** P1: 获取最近的用户消息（用于导出日志时带上上下文） */
  getRecentUserMessages?(): Promise<readonly string[]>;
}

/**
 * content script 侧的诊断（独立存储键，见 entrypoints/content.ts 的 CONTENT_DIAGNOSTIC_STORAGE_KEY）。
 * 合并后再按时间排序，让「agent 为什么没启动」与「工具何时执行」落在同一条时间线上。
 */
const CONTENT_DIAGNOSTIC_STORAGE_KEY = 'dpp_content_diagnostics';

function isDiagnosticLogEntry(value: unknown): value is DiagnosticLogEntry {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.ts === 'number'
    && typeof v.level === 'string'
    && typeof v.source === 'string'
    && typeof v.message === 'string'
    && (v.details === undefined || typeof v.details === 'string')
  );
}

async function readContentDiagnostics(): Promise<DiagnosticLogEntry[]> {
  try {
    const data = await chrome.storage.local.get(CONTENT_DIAGNOSTIC_STORAGE_KEY);
    const raw = data?.[CONTENT_DIAGNOSTIC_STORAGE_KEY];
    // 形状不合法的一律丢弃：诊断出口不能因为一条脏数据就报错。
    return Array.isArray(raw) ? raw.filter(isDiagnosticLogEntry) : [];
  } catch {
    return [];
  }
}

function mergeByTimestamp(
  background: readonly DiagnosticLogEntry[],
  content: readonly DiagnosticLogEntry[],
): DiagnosticLogEntry[] {
  return [...background, ...content].sort((a, b) => a.ts - b.ts);
}

/**
 * W29 观测出口（2026-10-21）。
 *
 * 把最近一条 inline agent 轨迹渲染成可读文本。这是「断流」类问题的第一手现场：
 * 能直接看出哪一轮 OPEN（从未结束）、continuation.decision 是 true 还是 false、
 * turn.end 的 stopReason 是什么。
 *
 * 读取失败一律降级为空报告——诊断出口绝不能因为存储异常而让整条命令报错。
 */
async function buildTraceReport(): Promise<{ traceReport: string; traceEvents: number }> {
  try {
    const traces = await readPersistedInlineAgentTraces();
    const latest = traces.length > 0 ? traces[traces.length - 1] : null;
    const events = latest?.events ?? [];
    return {
      traceReport: events.length > 0 ? renderTraceReport(events) : '',
      traceEvents: events.length,
    };
  } catch {
    return { traceReport: '', traceEvents: 0 };
  }
}

export function createDiagnosticsRuntimeHandlers(
  dependencies: DiagnosticsRuntimeHandlerDependencies,
): readonly RuntimeCommandHandler[] {
  return Object.freeze([
    definePayloadlessRuntimeCommandHandler('EXPORT_DIAGNOSTIC_LOGS', async () => {
      const recentMessages = dependencies.getRecentUserMessages
        ? await dependencies.getRecentUserMessages()
        : [];
      return {
        exportedAt: new Date().toISOString(),
        extensionVersion: dependencies.getVersion(),
        recentUserMessages: recentMessages.slice(-3),
        entries: diagnosticLogBuffer.snapshot(),
      };
    }),
    definePayloadlessRuntimeCommandHandler('GET_DIAGNOSTIC_SNAPSHOT', async () => {
      const [trace, contentEntries] = await Promise.all([
        buildTraceReport(),
        readContentDiagnostics(),
      ]);
      return {
        timestamp: Date.now(),
        logs: mergeByTimestamp(
          diagnosticLogBuffer.snapshot().map((entry) => ({ ...entry })),
          contentEntries,
        ),
        version: dependencies.getVersion(),
        ...trace,
      };
    }),
  ]);
}
