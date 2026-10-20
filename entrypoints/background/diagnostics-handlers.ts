import {
  definePayloadlessRuntimeCommandHandler,
  type RuntimeCommandHandler,
} from '../../core/messaging/runtime-command-registry';
import { diagnosticLogBuffer } from '../../core/diagnostics/log-buffer';
import { readPersistedInlineAgentTraces } from '../../core/inline-agent/trace-store';
import { renderTraceReport } from '../../core/trace/report';

export interface DiagnosticsRuntimeHandlerDependencies {
  getVersion(): string;
  /** P1: 获取最近的用户消息（用于导出日志时带上上下文） */
  getRecentUserMessages?(): Promise<readonly string[]>;
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
      const trace = await buildTraceReport();
      return {
        timestamp: Date.now(),
        logs: diagnosticLogBuffer.snapshot().map((entry) => ({ ...entry })),
        version: dependencies.getVersion(),
        ...trace,
      };
    }),
  ]);
}
