/**
 * 审计 #69：`normalizeJsonRpcResponse` 不得把 `id: null` 当成有效响应。
 *
 * JSON-RPC 2.0 里 `id: null` 只出现在「服务端无法解析请求 id」的错误响应中，
 * 它**无法与任何在飞请求关联**。放行它等于允许一条无主响应被当成本次调用结果 ——
 * 尤其在不传 `expectedRequest` 的调用路径上，后面那句
 * `raw.id !== expectedRequest.id` 的匹配检查会被整段跳过。
 *
 * 变异方式：把 `|| raw.id === null` 去掉 ⇒ 第一条用例必须红。
 */
import { describe, expect, it } from 'vitest';
import { normalizeJsonRpcResponse } from '../core/mcp/transports/transport-jsonrpc';

describe('审计 #69：MCP 响应 id 不能是 null', () => {
  it('★ id:null 的响应必须被拒绝', () => {
    expect(() =>
      normalizeJsonRpcResponse({ jsonrpc: '2.0', id: null, result: { ok: true } }),
    ).toThrowError(/id must be a string or a finite number/);
  });

  it('负控：字符串与数字 id 照常接受', () => {
    expect(normalizeJsonRpcResponse({ jsonrpc: '2.0', id: 1, result: { ok: true } }))
      .toMatchObject({ jsonrpc: '2.0', id: 1 });
    expect(normalizeJsonRpcResponse({ jsonrpc: '2.0', id: 'abc', result: { ok: true } }))
      .toMatchObject({ jsonrpc: '2.0', id: 'abc' });
  });

  it('负控：完全缺 id 同样被拒绝', () => {
    expect(() => normalizeJsonRpcResponse({ jsonrpc: '2.0', result: {} })).toThrowError(/id must be/);
  });

  it('负控：id 与 expectedRequest 不匹配仍被拒绝', () => {
    expect(() =>
      normalizeJsonRpcResponse(
        { jsonrpc: '2.0', id: 2, result: {} },
        { jsonrpc: '2.0', id: 1, method: 'tools/list' } as never,
      ),
    ).toThrowError(/id did not match/);
  });
});
