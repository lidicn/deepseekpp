import { describe, expect, it } from 'vitest';
import {
  TOOL_RUNTIME_PAYLOAD_DECODERS,
  decodeToolRuntimePayload,
} from '../core/messaging/tool-runtime-request-codec';

describe('audit #55 guard: DIAGNOSE_WEB_SEARCH decoder validates payload keys', () => {
  // #55 修复前：DIAGNOSE_WEB_SEARCH decoder 只检查 isPlainRuntimeRecord，
  // 不拒绝额外字段，query 非 string 也静默回退 'test'。
  // 修复后：额外字段 / 非对象 ⇒ invalidDecodedPayload；query 缺失或非 string 才回退 'test'。

  it('returns ok:false invalidDecodedPayload when payload is a non-object (string, number, null, array)', () => {
    const decoder = TOOL_RUNTIME_PAYLOAD_DECODERS.DIAGNOSE_WEB_SEARCH;

    expect(decoder('plain-string')).toEqual({ ok: false, error: 'invalid_diagnose_web_search' });
    expect(decoder(123)).toEqual({ ok: false, error: 'invalid_diagnose_web_search' });
    expect(decoder(null)).toEqual({ ok: false, error: 'invalid_diagnose_web_search' });
    expect(decoder([{ query: 'x' }])).toEqual({ ok: false, error: 'invalid_diagnose_web_search' });
  });

  it('returns ok:false invalidDecodedPayload when payload has extra keys beyond query', () => {
    const decoder = TOOL_RUNTIME_PAYLOAD_DECODERS.DIAGNOSE_WEB_SEARCH;

    expect(decoder({ query: 'hi', evilExtra: true })).toEqual({
      ok: false,
      error: 'invalid_diagnose_web_search_extra_field',
    });
    expect(decoder({ foo: 'bar' })).toEqual({
      ok: false,
      error: 'invalid_diagnose_web_search_extra_field',
    });
    expect(decoder({ query: 'hi', somethingElse: 1, another: null })).toEqual({
      ok: false,
      error: 'invalid_diagnose_web_search_extra_field',
    });
  });

  it('returns ok:true validDecodedPayload when payload is just query (or empty)', () => {
    const decoder = TOOL_RUNTIME_PAYLOAD_DECODERS.DIAGNOSE_WEB_SEARCH;

    expect(decoder({ query: 'weather in tokyo' })).toEqual({
      ok: true,
      payload: { query: 'weather in tokyo' },
    });
    // 空 payload 也合法（query 可选），回退默认 'test'
    expect(decoder({})).toEqual({ ok: true, payload: { query: 'test' } });
  });

  it('rejects via decodeToolRuntimePayload entrypoint for extra keys', () => {
    // 消费方统一入口 —— 必须也返回 ok:false
    const result = decodeToolRuntimePayload('DIAGNOSE_WEB_SEARCH', { extra: true });
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.error).toBe('invalid_diagnose_web_search_extra_field');
    }
  });
});
