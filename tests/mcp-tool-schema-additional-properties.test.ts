/**
 * 审计 #68：`sanitizeToolSchema` 不得丢掉 `additionalProperties: false`。
 *
 * 原实现对 boolean 形式一律 `return undefined`（注释理由是"false 由执行层字段白名单强制"）。
 * 但**全仓没有按 schema 校验/过滤参数的实现**：模型给出的 arguments 是原样转发的
 * （`core/mcp/client.ts:165` `arguments: options.call.payload`）。
 * 所以丢掉 `false` 等于把"不许加额外字段"这条生成指导抹掉 —— 实打实地放宽了 schema。
 *
 * 保留范围：只保留 `false`；`true` 是 JSON Schema 默认值，保留只是噪音，仍丢弃。
 *
 * 变异方式：删掉 `if (value === false) return false;` ⇒ 本文件 ★ 用例必须红。
 */
import { describe, expect, it } from 'vitest';
import { sanitizeToolSchema } from '../core/mcp/schema-sanitizer';
import { normalizeToolSchema } from '../core/mcp/client-descriptor';

describe('审计 #68：additionalProperties 保真', () => {
  it('★ 顶层 additionalProperties:false 必须保留', () => {
    const sanitized = sanitizeToolSchema({
      type: 'object',
      properties: { a: { type: 'string' } },
      additionalProperties: false,
    });

    expect(sanitized.additionalProperties).toBe(false);
  });

  it('★ 嵌套子 schema 里的 additionalProperties:false 也必须保留（递归）', () => {
    const sanitized = sanitizeToolSchema({
      type: 'object',
      properties: {
        nested: {
          type: 'object',
          properties: { b: { type: 'number' } },
          additionalProperties: false,
        },
      },
    });

    const properties = sanitized.properties as Record<string, Record<string, unknown>>;
    expect(properties.nested?.additionalProperties).toBe(false);
  });

  it('★ 对象形式仍保留，且其内部未知关键字被清洗', () => {
    const sanitized = sanitizeToolSchema({
      type: 'object',
      additionalProperties: { type: 'string', title: '应被丢弃' },
    });

    const additional = sanitized.additionalProperties as Record<string, unknown>;
    expect(additional.type).toBe('string');
    expect(additional.title).toBeUndefined();
  });

  it('负控：additionalProperties:true 仍被丢弃（默认值，保留只是噪音）', () => {
    const sanitized = sanitizeToolSchema({ type: 'object', additionalProperties: true });
    expect('additionalProperties' in sanitized).toBe(false);
  });

  it('负控：其它被弃关键字仍然被弃（不能顺手放宽）', () => {
    const sanitized = sanitizeToolSchema({
      type: 'object',
      title: 'x',
      default: {},
      deprecated: true,
      additionalProperties: false,
    });

    expect(sanitized.title).toBeUndefined();
    expect(sanitized.default).toBeUndefined();
    expect(sanitized.deprecated).toBeUndefined();
    expect(sanitized.additionalProperties).toBe(false);
  });

  it('负控：normalizeToolSchema 仍强制 type:object 与 properties 缺省', () => {
    const normalized = normalizeToolSchema({ additionalProperties: false });
    expect(normalized.type).toBe('object');
    expect(normalized.properties).toEqual({});
    expect(normalized.additionalProperties).toBe(false);
  });
});
