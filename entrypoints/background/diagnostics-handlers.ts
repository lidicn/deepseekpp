import {
  definePayloadlessRuntimeCommandHandler,
  type RuntimeCommandHandler,
} from '../../core/messaging/runtime-command-registry';
import { diagnosticLogBuffer } from '../../core/diagnostics/log-buffer';

export interface DiagnosticsRuntimeHandlerDependencies {
  getVersion(): string;
  /** P1: 获取最近的用户消息（用于导出日志时带上上下文） */
  getRecentUserMessages?(): Promise<readonly string[]>;
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
  ]);
}
