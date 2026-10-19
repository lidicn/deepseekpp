import { describe, expect, it, vi } from 'vitest';
import {
  clampText,
  createToolExecutionRecord,
  executeToolCallsSequentially,
  runToolContinuationLoop,
} from '../core/tool-loop/engine';
import type { ToolCall, ToolExecutionRecord, ToolResult } from '../core/types';

// T28: tool-loop 循环终止条件、最大步数、顺序执行中断、clamp 与记录回填。

interface StubTurn {
  text: string;
  parentId: number | null;
}

function stubCall(name = 'shell_exec'): ToolCall {
  return { name, payload: {}, raw: `<${name}/>` };
}

function stubRecord(name: string): ToolExecutionRecord {
  return { name, result: { ok: true, summary: `ran ${name}` } };
}

function baseLoop(overrides: Partial<Parameters<typeof runToolContinuationLoop<StubTurn>>[0]> = {}) {
  const executed: string[] = [];
  const submitContinuation = vi.fn(async () => ({ text: 'CALL', parentId: 1 } as StubTurn));
  return {
    executed,
    submitContinuation,
    run: runToolContinuationLoop<StubTurn>({
      initialTurn: { text: 'CALL', parentId: 1 },
      maxDepth: 3,
      getAssistantText: (t) => t.text,
      getParentMessageId: (t) => t.parentId,
      extractToolCalls: (text) => (text === 'CALL' ? [stubCall()] : []),
      executeToolCall: vi.fn(async (call) => {
        executed.push(call.name);
        return stubRecord(call.name);
      }),
      buildContinuationPrompt: () => '',
      submitContinuation,
      ...overrides,
    }),
  };
}

describe('runToolContinuationLoop · termination reasons', () => {
  it('returns completed when the turn carries no tool calls', async () => {
    const { run, executed } = baseLoop({
      initialTurn: { text: 'done', parentId: 1 },
    });
    const out = await run;
    expect(out.termination).toBe('completed');
    expect(executed).toEqual([]);
    expect(out.executions).toEqual([]);
  });

  it('returns stream_cut when the initial turn has no parent message id', async () => {
    const { run, executed } = baseLoop({
      initialTurn: { text: 'CALL', parentId: null },
    });
    const out = await run;
    expect(out.termination).toBe('stream_cut');
    expect(executed).toEqual([]);
  });

  it('returns max_depth and exhausts every slot when calls keep arriving', async () => {
    const { run, executed, submitContinuation } = baseLoop({ maxDepth: 2 });
    const out = await run;
    expect(out.termination).toBe('max_depth');
    expect(executed).toHaveLength(2);
    expect(submitContinuation).toHaveBeenCalledTimes(2);
  });
});

describe('executeToolCallsSequentially · abort breaks the chain', () => {
  it('runs every call when the signal is live and stops after an abort', async () => {
    const live = vi.fn(async (call) => stubRecord(call.name));
    const all = await executeToolCallsSequentially([stubCall('a'), stubCall('b')], live);
    expect(all).toHaveLength(2);

    const ctrl = new AbortController();
    const sequential = vi.fn(async (call) => {
      if (call.name === 'b') ctrl.abort();
      return stubRecord(call.name);
    });
    const partial = await executeToolCallsSequentially(
      [stubCall('a'), stubCall('b'), stubCall('c')],
      sequential,
      { signal: ctrl.signal },
    );
    expect(partial).toHaveLength(2);
  });
});

describe('clampText', () => {
  it('passes short text through and returns undefined for empty input', () => {
    expect(clampText(undefined, 100)).toBeUndefined();
    expect(clampText('short', 100)).toBe('short');
  });

  it('truncates long text to the byte budget and appends the marker', () => {
    const long = 'x'.repeat(500);
    const clamped = clampText(long, 80)!;
    expect(clamped.endsWith('\n...[truncated]')).toBe(true);
    expect(new TextEncoder().encode(clamped).byteLength).toBeLessThanOrEqual(80);
  });
});

describe('createToolExecutionRecord · field backfill and clamping', () => {
  it('fills missing name/provider/descriptorId from the call and clamps detail/output', () => {
    const call: ToolCall = {
      name: 'local_file_read',
      descriptorId: 'desc-1',
      payload: {},
      raw: '',
    };
    const result: ToolResult = {
      ok: true,
      summary: 'ok',
      detail: 'd'.repeat(500),
      output: { big: 'o'.repeat(500) },
    };
    const record = createToolExecutionRecord(call, result, { detailMaxLength: 40, outputMaxLength: 60 });
    expect(record.name).toBe('local_file_read');
    expect(record.descriptorId).toBe('desc-1');
    expect(record.result.detail!.endsWith('\n...[truncated]')).toBe(true);
    const serializedOutput = record.result.output;
    expect(typeof serializedOutput).toBe('string');
    expect((serializedOutput as string).endsWith('\n...[truncated]')).toBe(true);
  });
});
