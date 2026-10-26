/**
 * 审计 #38：serializeToolExecutions 两个问题
 *   1. output 被整体 stringify 成字符串（同 #51 根因）→ 应保持对象形状
 *   2. execution.name 原样插进 XML 标签名，含 <> & 空格会破坏 XML → 应转义/替换
 */
import { describe, expect, it } from 'vitest';
import { serializeToolExecutions } from '../core/chat/loop-contract';
import type { ToolExecutionRecord } from '../core/types';

function rec(name: string, output: unknown): ToolExecutionRecord {
  return {
    name,
    result: {
      ok: true,
      summary: 'ok',
      output: output as never,
    },
  };
}

describe('serializeToolExecutions', () => {
  it('output 保持对象形状（不再是被 stringify 的字符串）', () => {
    const out = serializeToolExecutions([rec('web_search', { url: 'https://x', stdout: 'ran' })]);
    // 标签内的 JSON 里 output 应是嵌套对象，不是转义字符串
    expect(out).toContain('"output":{"url":"https://x","stdout":"ran"}');
  });

  it('工具名含 <> & 空格时，生成合法 XML 标签（非法字符替换为 _）', () => {
    const out = serializeToolExecutions([rec('we<ird & name', { a: 1 })]);
    // 不应出现原始的 `<` 进标签名
    expect(out).not.toContain('<we<ird & name_result>');
    expect(out).toContain('<we_ird___name_result>');
    expect(out).toContain('</we_ird___name_result>');
  });

  it('正常工具名标签不变', () => {
    const out = serializeToolExecutions([rec('code_run', { ok: true })]);
    expect(out).toContain('<code_run_result>');
    expect(out).toContain('</code_run_result>');
  });
});
