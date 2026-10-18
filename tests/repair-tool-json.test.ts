import { describe, expect, it } from 'vitest';
import { repairToolJsonBody } from '../core/interceptor/repair-tool-json';

describe('repairToolJsonBody', () => {
  // 验收 1：正常 JSON 不被修改
  it('returns valid JSON unchanged (same reference)', () => {
    const valid = '{"a": 1, "path": "D:\\\\project\\\\file.txt", "text": "line1\\nline2"}';
    expect(repairToolJsonBody(valid)).toBe(valid);
  });

  // 验收 2：Windows 路径修复
  it('repairs Windows path with unescaped backslashes', () => {
    const input = '{"path": "D:\\project\\file.txt"}';
    const result = repairToolJsonBody(input);
    expect(result).not.toBeNull();
    expect(JSON.parse(result as string).path).toBe('D:\\project\\file.txt');
  });

  // Windows 路径中 \f 是合法转义（换页符），也要一起修
  it('repairs Windows path where \\f is a valid escape', () => {
    const input = '{"path": "D:\\project\\file.txt"}';
    const result = repairToolJsonBody(input);
    expect(result).not.toBeNull();
    expect(JSON.parse(result as string).path).toBe('D:\\project\\file.txt');
  });

  // 验收 3：字符串内裸换行修复
  it('repairs bare newlines inside strings', () => {
    const input = '{"text": "line1\nline2"}';
    const result = repairToolJsonBody(input);
    expect(result).not.toBeNull();
    expect(JSON.parse(result as string).text).toBe('line1\nline2');
  });

  // 多段相对路径
  it('repairs relative Windows path with multiple backslashes', () => {
    const input = '{"path": "src\\project\\file.ts"}';
    const result = repairToolJsonBody(input);
    expect(result).not.toBeNull();
    expect(JSON.parse(result as string).path).toBe('src\\project\\file.ts');
  });

  // 验收 4：无法修复返回 null
  it('returns null for structurally broken JSON', () => {
    expect(repairToolJsonBody('{"a": ')).toBeNull();
    expect(repairToolJsonBody('{')).toBeNull();
    expect(repairToolJsonBody('{"a": "x')).toBeNull();
    expect(repairToolJsonBody('')).toBeNull();
  });

  // 验收 5：修复后一定可 parse
  it('repaired output always parses successfully', () => {
    const cases = [
      '{"path": "D:\\project\\file.txt"}',
      '{"text": "line1\nline2"}',
      '{"cmd": "echo hello", "dir": "C:\\Users\\test"}',
    ];
    for (const input of cases) {
      const result = repairToolJsonBody(input);
      if (result !== null) {
        expect(() => JSON.parse(result)).not.toThrow();
      }
    }
  });

  // 合法转义在需要修复的文档里也保持原样
  it('preserves legal escapes in mixed content', () => {
    const input = '{"msg": "he said \\"hi\\"", "path": "D:\\project\\file.txt"}';
    const result = repairToolJsonBody(input);
    expect(result).not.toBeNull();
    expect(JSON.parse(result as string).msg).toBe('he said "hi"');
    expect(JSON.parse(result as string).path).toBe('D:\\project\\file.txt');
  });

  // 策略 3：字符串内未转义的引号
  it('repairs unescaped quotes inside strings', () => {
    const input = '{"q": "he said "hi" to me"}';
    const result = repairToolJsonBody(input);
    expect(result).not.toBeNull();
    expect(JSON.parse(result as string).q).toBe('he said "hi" to me');
  });

  // #54：剥离 markdown 代码围栏（```json / ```）——真实错误 "Unexpected token 反引号"
  it('strips ```json fenced code block', () => {
    const input = '```json\n{"cmd": "echo hello", "dir": "C:\\\\Users\\\\test"}\n```';
    const result = repairToolJsonBody(input);
    expect(result).not.toBeNull();
    expect(JSON.parse(result as string).cmd).toBe('echo hello');
  });

  it('strips bare ``` fenced block without language', () => {
    const input = '```\n{"a": 1}\n```';
    const result = repairToolJsonBody(input);
    expect(result).not.toBeNull();
    expect(JSON.parse(result as string).a).toBe(1);
  });

  // #54：JSON 之后的尾随文字/残留标签 —— 真实错误 "non-whitespace character after JSON"
  it('extracts first balanced object when trailing text follows', () => {
    const input = '{"cmd": "echo hello"} 后面多了一句解释文字';
    const result = repairToolJsonBody(input);
    expect(result).not.toBeNull();
    expect(JSON.parse(result as string).cmd).toBe('echo hello');
  });

  it('drops trailing residual close tag after the JSON object', () => {
    const input = '{"code": "print(1)"}</python_exec>';
    const result = repairToolJsonBody(input);
    expect(result).not.toBeNull();
    expect(JSON.parse(result as string).code).toBe('print(1)');
  });

  // 空字符串
  it('returns null for empty input', () => {
    expect(repairToolJsonBody('')).toBeNull();
  });

  // 非字符串输入
  it('returns null for non-string input', () => {
    expect(repairToolJsonBody(null as unknown as string)).toBeNull();
    expect(repairToolJsonBody(undefined as unknown as string)).toBeNull();
  });
});
