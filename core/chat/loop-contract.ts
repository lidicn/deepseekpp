// M1-2c D1: 共享常量 + 工具结果序列化，防止两套循环漂移
// chat-runtime-service.ts（原循环）与 resume-tool-loop.ts（续跑循环）共用本模块

import type { ToolExecutionRecord } from '../types';

export const MAX_CHAT_TOOL_STEPS = 20;

/**
 * R07：无工具截断续轮（auto-continue）的单次上限。区别于 MAX_CHAT_TOOL_STEPS
 * （含工具轮的外层步数），本上限只约束「流截断且无工具」的空转续轮，避免无限烧配额。
 */
export const MAX_AUTO_CONTINUE = 3;

export const SIDEBAR_TOOL_RESULT_DETAIL_MAX = 4000;
export const SIDEBAR_TOOL_RESULT_OUTPUT_MAX = 8000;
export const SIDEBAR_TOOL_RESULT_ERROR_MAX = 400;

export function clampSidebarText(value: string | undefined, maxLength: number): string | undefined {
  if (!value) return value;
  return value.length > maxLength ? `${value.slice(0, maxLength)}\n...[truncated]` : value;
}

export function serializeToolExecutions(executions: readonly ToolExecutionRecord[]): string {
  return executions.map((execution) => {
    const result = execution.result;
    const serialized = {
      ok: result.ok,
      summary: result.summary,
      detail: clampSidebarText(result.detail, SIDEBAR_TOOL_RESULT_DETAIL_MAX),
      error: result.error
        ? {
            code: result.error.code,
            message: clampSidebarText(result.error.message, SIDEBAR_TOOL_RESULT_ERROR_MAX) ?? '',
            retryable: result.error.retryable,
          }
        : undefined,
      output: result.output === undefined
        ? undefined
        : clampSidebarText(JSON.stringify(result.output), SIDEBAR_TOOL_RESULT_OUTPUT_MAX),
      truncated: result.truncated === true,
    };
    return `<${execution.name}_result>\n${JSON.stringify(serialized)}\n</${execution.name}_result>`;
  }).join('\n');
}
