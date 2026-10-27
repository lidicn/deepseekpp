import { describe, expect, it } from 'vitest';
import {
  decodeRuntimeResponse,
  getRuntimeErrorMessage,
  isRuntimeFailure,
  unwrapRuntimeResponse,
} from '../core/messaging/runtime-response';

describe('unwrapRuntimeResponse (audit #56 guard)', () => {
  // #56: 成功响应必须显式 ok:true —— 这条修复是 "防止漏传 ok 的响应被当成有效数据"
  // 变异自证：把 source L5 的 `ok !== true` 改成 `ok != null` 或注释掉 ⇒ 下面两条守卫必须红

  it('throws when the response has no ok field at all (shape that would have silently passed pre-#56)', () => {
    const missingOk = { data: 'some-value' };
    expect(() => unwrapRuntimeResponse(missingOk, 'response missing')).toThrow(
      'response missing (missing ok:true in response)',
    );
  });

  it('throws when ok is explicitly false instead of just absent', () => {
    const notOk = { ok: false, data: 'x' };
    expect(() => unwrapRuntimeResponse(notOk, 'response missing')).toThrow(
      'response missing',
    );
  });

  it('throws when ok is present but not boolean true (string true / 1 / etc)', () => {
    expect(() => unwrapRuntimeResponse({ ok: 'true', data: 'x' }, 'msg')).toThrow('missing ok:true');
    expect(() => unwrapRuntimeResponse({ ok: 1, data: 'x' }, 'msg')).toThrow('missing ok:true');
  });

  it('passes through when ok:true', () => {
    const ok = { ok: true as const, payload: 'value' };
    expect(unwrapRuntimeResponse(ok, 'msg')).toBe(ok);
  });

  it('throws on null / undefined input', () => {
    expect(() => unwrapRuntimeResponse(null, 'null resp')).toThrow('null resp');
    expect(() => unwrapRuntimeResponse(undefined, 'undef resp')).toThrow('undef resp');
  });
});

describe('decodeRuntimeResponse helper', () => {
  it('rejects undefined response', () => {
    expect(() => decodeRuntimeResponse(undefined, JSON.parse as (value: unknown) => any, 'missing')).toThrow('missing');
  });

  it('propagates decode errors', () => {
    expect(() => decodeRuntimeResponse('not-json', JSON.parse as (value: unknown) => any, 'boom')).toThrow();
  });

  it('returns decoded value on success', () => {
    expect(decodeRuntimeResponse('{"a":1}', JSON.parse as (value: unknown) => any, 'missing')).toEqual({ a: 1 });
  });
});

describe('isRuntimeFailure shape recognizer', () => {
  it('returns true only for ok:false objects', () => {
    expect(isRuntimeFailure({ ok: false })).toBe(true);
    expect(isRuntimeFailure({ ok: true })).toBe(false);
    expect(isRuntimeFailure({ ok: 'false' })).toBe(false);
    expect(isRuntimeFailure(null)).toBe(false);
    expect(isRuntimeFailure({})).toBe(false);
  });
});

describe('getRuntimeErrorMessage stringifier', () => {
  it('uses Error.message when available', () => {
    expect(getRuntimeErrorMessage(new Error('bad'))).toBe('bad');
  });

  it('falls back to String() for primitives', () => {
    expect(getRuntimeErrorMessage(42)).toBe('42');
    expect(getRuntimeErrorMessage('oops')).toBe('oops');
  });
});
