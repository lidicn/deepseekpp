// 2026-10-22：字节口径截断的回归测试。
//
// 起因：兄弟项目 Studio 的对齐建议书 §3.2 指出「dpp 切点可能落在多字节字符中间」。
// 核实后发现 dpp 有两套同名 clampText：
//   · core/tool-loop/engine.ts —— 字节口径 + UTF-8 边界回退（正确）
//   · core/tool/execution-restore.ts —— 字符口径（value.length / slice）
// 而 AUTOMATION_TOOL_DETAIL_MAX_BYTES（注释写 4 KB）恰好流进字符口径那套，
// CJK 下 4000 字符 ≈ 12000 字节，预算被放宽 3 倍。
//
// 现收敛到 core/text/truncate-bytes.ts。本测试锁定四条契约：
//   1. 未超预算原样返回
//   2. 超预算时结果的总字节数（含标记）不超预算 —— 字符口径会在这里失败
//   3. 截断后不出现 U+FFFD（说明没把多字节字符切坏）
//   4. 代理对（emoji / 生僻字）不被劈开
import { describe, expect, it } from 'vitest';
import {
  TRUNCATION_MARKER,
  clampTextToBytes,
  utf8ByteLength,
} from '../core/text/truncate-bytes';

describe('clampTextToBytes', () => {
  it('未超预算时原样返回', () => {
    expect(clampTextToBytes('hello', 100)).toBe('hello');
    expect(clampTextToBytes('中文内容', 100)).toBe('中文内容');
  });

  it('undefined / 空串原样返回', () => {
    expect(clampTextToBytes(undefined, 100)).toBeUndefined();
    expect(clampTextToBytes('', 100)).toBe('');
  });

  it('CJK 内容超预算时，总字节数不超过预算（字符口径会失败）', () => {
    // 1000 个中文字 = 3000 字节；预算 300 字节
    const value = '中'.repeat(1000);
    const clamped = clampTextToBytes(value, 300)!;

    expect(utf8ByteLength(clamped)).toBeLessThanOrEqual(300);
    // 对照：同样的字符串按字符截 300 会是 900 字节 —— 正是原 bug
    expect(value.slice(0, 300).length).toBe(300);
    expect(utf8ByteLength(value.slice(0, 300))).toBe(900);
  });

  it('截断后不含替换符 U+FFFD（说明没切坏多字节字符）', () => {
    // 用不同宽度字符混合，制造各种可能的错位切点
    const samples = ['中文测试内容', '😀😀😀😀😀', 'áéíóú', '𠮷野家'];
    for (const sample of samples) {
      for (let limit = 1; limit <= 40; limit += 1) {
        const clamped = clampTextToBytes(sample.repeat(10), limit)!;
        expect(clamped).not.toContain('\uFFFD');
      }
    }
  });

  it('代理对（emoji）不被劈开', () => {
    const emoji = '😀'; // U+1F600，UTF-16 下是两个 code unit
    const value = emoji.repeat(20);
    for (let limit = 1; limit <= 30; limit += 1) {
      const clamped = clampTextToBytes(value, limit);
      if (clamped === undefined || clamped === '') continue;
      // 去掉标记后，剩下的必须是完整的 emoji 序列
      const body = clamped.endsWith(TRUNCATION_MARKER)
        ? clamped.slice(0, -TRUNCATION_MARKER.length)
        : clamped;
      expect(body).not.toContain('\uFFFD');
      // 不能出现孤立的代理项
      for (let i = 0; i < body.length; i += 1) {
        const code = body.charCodeAt(i);
        if (code >= 0xd800 && code <= 0xdbff) {
          const next = body.charCodeAt(i + 1);
          expect(next >= 0xdc00 && next <= 0xdfff).toBe(true);
        }
      }
    }
  });

  it('maxBytes <= 0 返回空串', () => {
    expect(clampTextToBytes('内容', 0)).toBe('');
    expect(clampTextToBytes('内容', -1)).toBe('');
  });

  it('预算极小时保证不超预算，且不丢内容（丢标记而非丢数据）', () => {
    const value = '中'.repeat(100);
    for (let limit = 1; limit <= 30; limit += 1) {
      const clamped = clampTextToBytes(value, limit)!;
      // 契约一：永远不超预算
      expect(utf8ByteLength(clamped)).toBeLessThanOrEqual(limit);
      // 契约二：预算 >= 3 字节（一个中文字）时必须保留内容，不能返回空串。
      // 与 result-governance 的既有约定一致：装不下标记就丢标记，不丢数据。
      if (limit >= 3) expect(clamped.length).toBeGreaterThan(0);
    }
  });
});
