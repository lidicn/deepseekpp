/**
 * 审计 #89：continuation prompt 里 output 故意 stringify（prompt 文本），
 * 但 JSON.stringify 对循环引用会抛 —— 单个工具结果不能让整个续跑崩掉。
 */
import { describe, expect, it } from 'vitest';
import { buildAutomationToolContinuationPrompt } from '../core/automation/runner';
import type { ToolExecutionRecord } from '../core/types';

function rec(output: unknown): ToolExecutionRecord {
  return {
    name: 'code_run',
    result: { ok: true, summary: 'ok', output: output as never },
  };
}

describe('buildAutomationToolContinuationPrompt', () => {
  it('循环引用的 output 不抛错，prompt 仍生成', () => {
    const circular: Record<string, unknown> = { foo: 'bar' };
    circular.self = circular;
    expect(() => buildAutomationToolContinuationPrompt([rec(circular)])).not.toThrow();
    const prompt = buildAutomationToolContinuationPrompt([rec(circular)]);
    expect(prompt).toContain('<tool_results>');
  });

  it('普通对象 output 仍被 stringify 进 prompt', () => {
    const prompt = buildAutomationToolContinuationPrompt([rec({ stdout: 'hello' })]);
    // output 被 stringify 后再嵌进外层 JSON（转义），只要 stdout/hello 还在 prompt 里即可
    expect(prompt).toContain('stdout');
    expect(prompt).toContain('hello');
  });

  it('undefined output 不抛错', () => {
    expect(() => buildAutomationToolContinuationPrompt([rec(undefined)])).not.toThrow();
  });
});
