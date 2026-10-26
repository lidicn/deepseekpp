// M1-2c D1: 共享常量 + 工具结果序列化，防止两套循环漂移
// chat-runtime-service.ts（原循环）与 resume-tool-loop.ts（续跑循环）共用本模块

import type { ToolExecutionRecord } from '../types';
import { clampJsonValueToBytes } from '../text/truncate-bytes';

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

/**
 * 审计 #38：把工具名转成合法的 XML 标签名。若含 <、>、&、空格等字符，原样插入
 * `<name_result>` 会破坏 XML 结构，模型解析出错。非法字符一律替换成 `_`。
 */
function toSafeXmlTagName(name: string): string {
  return name.replace(/[^A-Za-z0-9_.-]/g, '_');
}

export function serializeToolExecutions(executions: readonly ToolExecutionRecord[]): string {
  return executions.map((execution) => {
    const result = execution.result;
    // 审计 #38：output 保持对象形状（不整体 stringify），按字节预算裁字段。
    const clampedOutput = clampJsonValueToBytes(result.output, SIDEBAR_TOOL_RESULT_OUTPUT_MAX);
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
      output: clampedOutput.value,
      truncated: result.truncated === true || clampedOutput.truncated,
    };
    const tag = toSafeXmlTagName(execution.name);
    return `<${tag}_result>\n${JSON.stringify(serialized)}\n</${tag}_result>`;
  }).join('\n');
}
