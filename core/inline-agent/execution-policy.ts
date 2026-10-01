import type { ToolExecutionRecord } from '../types';
import { MCP_CAPABILITY_TOOL_PROVIDER_ID } from '../mcp/capability-contract';

export { INCOMPLETE_TOOL_CALL_ERROR_CODE } from '../tool/execution-error';

/**
 * An incomplete streamed call is a recovery-only execution record. It must be
 * included so the inline agent can see the failure and re-emit a closed call;
 * executeToolCall exits on call.parseError before any provider is reached.
 */
export function selectContinuableToolExecutions(
  executions: readonly ToolExecutionRecord[],
): ToolExecutionRecord[] {
  return executions.filter((execution) =>
    !execution.pending &&
    (
      // All MCP tools (streamable_http, native_messaging, etc.)
      execution.provider?.kind === 'mcp' ||
      // Legacy / special provider IDs
      execution.provider?.id === MCP_CAPABILITY_TOOL_PROVIDER_ID ||
      execution.provider?.id === 'web' ||
      execution.provider?.id === 'browser_control' ||
      // Built-in web/browser tools
      execution.name === 'web_search' ||
      execution.name === 'web_fetch' ||
      execution.name.startsWith('browser_') ||
      // Native messaging tools (shell, python, local_file_*, etc.)
      execution.name.startsWith('shell_') ||
      execution.name.startsWith('python_') ||
      execution.name.startsWith('local_')
    ));
}
