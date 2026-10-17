import { describe, expect, it } from 'vitest';
import {
  INCOMPLETE_TOOL_CALL_ERROR_CODE,
  selectContinuableToolExecutions,
} from '../core/inline-agent/execution-policy';
import type { ToolExecutionRecord } from '../core/types';
import { MEMORY_TOOL_NAMES, MEMORY_TOOL_PROVIDER } from '../core/tool/memory';

describe('inline agent execution policy', () => {
  it('keeps incomplete calls as recovery failures but excludes pending starts', () => {
    const completed = makeExecution();
    const pending = makeExecution({ pending: true });
    const interrupted = makeExecution({
      result: {
        ok: false,
        summary: 'failed',
        error: {
          code: INCOMPLETE_TOOL_CALL_ERROR_CODE,
          message: 'incomplete',
          retryable: false,
        },
      },
    });

    expect(selectContinuableToolExecutions([pending, interrupted, completed])).toEqual([
      interrupted,
      completed,
    ]);
  });

  it('keeps ordinary local tools continuable by default (continuation blacklist is empty)', () => {
    const failed = makeExecution({
      result: {
        ok: false,
        summary: 'provider failed',
        error: { code: 'provider_failed', message: 'failed', retryable: false },
      },
    });
    const unsupported = makeExecution({
      name: 'clock_now',
      provider: { kind: 'local', id: 'clock', displayName: 'Clock', transport: 'in_process' },
    });

    // R1: NO_CONTINUATION_TOOL_NAMES is intentionally empty. Every non-pending
    // tool is continuable by default so a newly added local tool can always be
    // re-emitted (this avoids the artifact_create/sandbox_run断流 regression).
    // The old test asserted clock_now was excluded; clock_now is fictional and
    // the blacklist no longer excludes anything, so the correct assertion is
    // that ordinary local tools are kept.
    expect(selectContinuableToolExecutions([failed, unsupported])).toEqual([failed, unsupported]);
  });

  it('keeps every memory tool call in the continuation set', () => {
    // The provider object is the production identity, so renaming its id turns this red.
    const memoryExecutions = MEMORY_TOOL_NAMES.map((name) =>
      makeExecution({ name, provider: MEMORY_TOOL_PROVIDER }),
    );

    expect(selectContinuableToolExecutions(memoryExecutions)).toEqual(memoryExecutions);
  });
});

function makeExecution(overrides: Partial<ToolExecutionRecord> = {}): ToolExecutionRecord {
  return {
    callId: 'call-1',
    name: 'web_fetch',
    provider: { kind: 'local', id: 'web', displayName: 'Web', transport: 'in_process' },
    result: { ok: true, summary: 'done' },
    ...overrides,
  };
}
