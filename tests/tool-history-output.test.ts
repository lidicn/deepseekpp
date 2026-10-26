/**
 * 审计 #15：历史记录里 output 必须保留对象形状。
 * 旧实现 sanitizeResult 把 result.output 整体 JSON.stringify 压成字符串，
 * 历史回放时读取方按 output.url 取不到结构化字段。
 */
import { describe, expect, it } from 'vitest';
import { sanitizeResult } from '../core/tool/history';
import type { ToolResult } from '../core/tool/types';

describe('sanitizeResult · output 形状', () => {
  it('未超预算时 output 仍是对象，output.url 可取到', () => {
    const result: ToolResult = {
      ok: true,
      summary: 'ok',
      output: { url: 'https://example.com/a', content: 'hello' },
    };
    const out = sanitizeResult(result);
    expect(typeof out.output).toBe('object');
    expect((out.output as Record<string, unknown>).url).toBe('https://example.com/a');
    expect((out.output as Record<string, unknown>).content).toBe('hello');
  });

  it('超大 output 仍被字节预算限制（不无限增长），但保持对象形状', () => {
    const result: ToolResult = {
      ok: true,
      summary: 'ok',
      output: { url: 'https://example.com/b', content: 'x'.repeat(200_000) },
    };
    const out = sanitizeResult(result);
    expect(typeof out.output).toBe('object');
    expect((out.output as Record<string, unknown>).url).toBe('https://example.com/b');
    // content 被裁短
    expect(((out.output as Record<string, unknown>).content as string).length).toBeLessThan(200_000);
    // 序列化后不超 32_000 字节预算
    expect(new TextEncoder().encode(JSON.stringify(out.output)).byteLength).toBeLessThanOrEqual(32_000);
  });

  it('undefined output 保持 undefined', () => {
    const result: ToolResult = { ok: true, summary: 'ok' };
    expect(sanitizeResult(result).output).toBeUndefined();
  });
});
