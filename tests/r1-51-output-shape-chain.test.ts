/**
 * R1 验收补充（PM，2026-10-27）：#51 的**端到端形状链路**用例。
 *
 * 为什么要再加一条：DB 交付的 `tests/render-code-runner-output.test.ts` 直接手工喂
 * `{ stdout, stderr }` 对象给 `formatAgentCodeRunOutput`，**绕过了真正的修复点**
 * （`engine.ts:114` 的 `clampJsonValueToBytes`）。我做变异复验时证实：
 * 把 `output: clampedOutput.value` 改回 `JSON.stringify(result.output)`，
 * 那个文件 **红 0**（只有 `tool-loop-coverage.test.ts` 红 2）—— 也就是说
 * 「上游产出形状 → 下游能读出 stdout」这条链在验收用例里没有被串起来验证过。
 *
 * 本文件把两端连起来：真实调用 `createToolExecutionRecord` 产出 record，
 * 再把 record.result 交给 `formatAgentCodeRunOutput`，断言 stdout/stderr 真的可见。
 * 上游一旦改回 stringify，这条必然红。
 */
import { describe, expect, it } from 'vitest';
import { createToolExecutionRecord } from '../core/tool-loop/engine';
import { formatAgentCodeRunOutput } from '../core/inline-agent/render-code-runner';
import type { ToolCall, ToolResult } from '../core/tool/types';

const CALL: ToolCall = {
  name: 'python_exec',
  callId: 'call-1' as never,
  descriptorId: 'desc-1' as never,
  payload: { code: 'print(1)' },
} as never;

const LIMITS = { detailMaxBytes: 4000, outputMaxBytes: 8000 };

function makeResult(output: unknown): ToolResult {
  return {
    ok: true,
    name: 'python_exec',
    summary: '执行完成',
    detail: 'ok',
    output,
  } as never;
}

describe('#51 端到端：产出形状 → 渲染可见（串起真实链路）', () => {
  it('createToolExecutionRecord 产出的 output 仍是对象，且 stdout/stderr 能被渲染出来', () => {
    const record = createToolExecutionRecord(CALL, makeResult({ stdout: 'hello', stderr: 'warn', exitCode: 0 }), LIMITS);

    // 上游：形状保留（这是 #51 修的点）
    expect(typeof record.result.output).toBe('object');
    expect(record.result.output).not.toBeNull();
    const output = record.result.output as Record<string, unknown>;
    expect(output.stdout).toBe('hello');
    expect(output.stderr).toBe('warn');

    // 下游：把 record 直接喂给真实渲染函数，用户能看见 stdout/stderr
    const text = formatAgentCodeRunOutput(record.result as never);
    expect(text).toContain('stdout:');
    expect(text).toContain('hello');
    expect(text).toContain('stderr:');
    expect(text).toContain('warn');
    // 不是裸 OK —— 那正是原缺陷的用户可见表现
    expect(text).not.toBe('OK');
  });

  it('负控：output 被 stringify 成字符串时渲染确实看不见（证明上面那条不是恒真）', () => {
    const text = formatAgentCodeRunOutput({
      ok: true,
      name: 'python_exec',
      summary: '执行完成',
      detail: 'ok',
      output: '{"stdout":"hello","stderr":"warn"}',
    } as never);
    expect(text).not.toContain('stdout:');
  });

  it('未超预算时深拷贝保留原对象不被改写（防调用方对象被就地裁剪）', () => {
    const output = { stdout: 'x', nested: { keep: [1, 2, 3] } };
    const record = createToolExecutionRecord(CALL, makeResult(output), LIMITS);
    expect(record.result.output).toEqual(output);
    // 原对象不应被挂上任何裁剪痕迹
    expect((output as Record<string, unknown>).truncated).toBeUndefined();
  });
});
