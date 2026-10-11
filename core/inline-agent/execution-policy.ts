import type { ToolDescriptor, ToolExecutionRecord } from '../types';

export { INCOMPLETE_TOOL_CALL_ERROR_CODE } from '../tool/execution-error';

/**
 * Tools that do NOT need a continuation turn after execution.
 *
 * These are pure local side-effects whose result is already rendered in the
 * UI and does not need to be fed back to the model. Everything else defaults
 * to continuable — this avoids the "add a new local tool and forget to update
 * the whitelist" class of bug (artifact_create / sandbox_run were dropped
 * this way, causing the tool-result断流 root cause).
 */
const NO_CONTINUATION_TOOL_NAMES = new Set<string>([
  // Add tool names here when a tool genuinely should not trigger a continuation
  // loop. Keep this list small and well-documented.
]);

/**
 * An incomplete streamed call is a recovery-only execution record. It must be
 * included so the inline agent can see the failure and re-emit a closed call;
 * executeToolCall exits on call.parseError before any provider is reached.
 */
export function selectContinuableToolExecutions(
  executions: readonly ToolExecutionRecord[],
): ToolExecutionRecord[] {
  return executions.filter(
    (execution) =>
      !execution.pending &&
      !NO_CONTINUATION_TOOL_NAMES.has(execution.name),
  );
}

/**
 * Single authority for the tool descriptor catalog passed into the inline
 * agent continuation loop. Must produce the same membership as
 * selectContinuableToolExecutions so the model can re-emit every tool whose
 * execution record is reported back.
 *
 * Previously content.ts maintained a duplicate whitelist here with a different
 * (stricter) membership — memory_* / shell_* / python_* / local_* triggered
 * continuation but were absent from the loop's Available Tools, so the model
 * could see a tool had run but could not re-invoke it.
 */
export function filterContinuableToolDescriptors(
  descriptors: readonly ToolDescriptor[],
): ToolDescriptor[] {
  return descriptors.filter(
    (d) => !NO_CONTINUATION_TOOL_NAMES.has(d.name),
  );
}
