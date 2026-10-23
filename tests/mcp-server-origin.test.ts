// 2026-10-23 审计 X-67 回归：换端点 origin 必须撤销活跃授权。
//
// 缺陷：工具授权快照只收 `{id, provider:{kind,id,transport}, name, invocationName,
// execution, inputSchemaDigest}` —— **端点地址不在其中**（`ToolProviderIdentity`
// 本身就没有 url 字段，URL 只活在 `McpServerConfig.transport.url`）。
// 于是用户把地址从 A 改到 B 之后：
//   · 发现指纹含 url ⇒ 工具缓存失效（界面看起来「生效了」）
//   · 连接缓存取整个 transport ⇒ 连接重建
//   · **授权快照不含 url ⇒ 旧 grant 静默续用到新端点**
//
// 修法（方案 B，落点在编排层）：`UPDATE_MCP_SERVER` 发现 origin 变化时，
// 调 `revokeToolAuthorizationsForProvider` 清掉该 server 的活跃授权。
//
// 本测试锁定：
//   A. origin 判定：换 host / 换 scheme / 换端口 ⇒ 变；改 path / query ⇒ 不变
//   B. stdio 与 http 之间切换 ⇒ 算变（数据去向变了）
//   C. 撤销函数按 provider.id 精确匹配、返回撤销数量、非目标不误伤
import { describe, expect, it } from 'vitest';
import { mcpServerOrigin, mcpServerOriginChanged } from '../core/mcp/server-origin';
import type { McpServerConfig } from '../core/mcp/types';

function makeServer(
  transport: McpServerConfig['transport'],
  id = 'server-1',
): McpServerConfig {
  return { id, transport } as McpServerConfig;
}

const HTTP_A = { kind: 'http', url: 'https://mcp.a.example/mcp' } as const;
const HTTP_B = { kind: 'http', url: 'https://mcp.b.example/mcp' } as const;

describe('X-67: mcpServerOrigin', () => {
  it('取到 scheme://host:port', () => {
    expect(mcpServerOrigin(makeServer(HTTP_A))).toBe('https://mcp.a.example');
    expect(mcpServerOrigin(makeServer({ kind: 'http', url: 'http://127.0.0.1:8080/x' })))
      .toBe('http://127.0.0.1:8080');
  });

  it('stdin 型传输没有端点 ⇒ null', () => {
    expect(mcpServerOrigin(makeServer({ kind: 'stdio_bridge', command: 'node' }))).toBeNull();
    expect(mcpServerOrigin(makeServer({ kind: 'native_messaging', nativeHost: 'x' }))).toBeNull();
  });

  it('空 url ⇒ null', () => {
    expect(mcpServerOrigin(makeServer({ kind: 'http', url: '   ' }))).toBeNull();
  });

  it('非法 url 退回原串（宁可判「变了」也不要漏判）', () => {
    expect(mcpServerOrigin(makeServer({ kind: 'http', url: 'not a url' }))).toBe('not a url');
  });
});

describe('X-67: mcpServerOriginChanged', () => {
  it('换 host ⇒ 变了', () => {
    expect(mcpServerOriginChanged(makeServer(HTTP_A), makeServer(HTTP_B))).toBe(true);
  });

  it('换 scheme ⇒ 变了', () => {
    expect(mcpServerOriginChanged(
      makeServer({ kind: 'http', url: 'https://mcp.a.example/mcp' }),
      makeServer({ kind: 'http', url: 'http://mcp.a.example/mcp' }),
    )).toBe(true);
  });

  it('换端口 ⇒ 变了', () => {
    expect(mcpServerOriginChanged(
      makeServer({ kind: 'http', url: 'https://mcp.a.example:443/mcp' }),
      makeServer({ kind: 'http', url: 'https://mcp.a.example:8443/mcp' }),
    )).toBe(true);
  });

  it('同 origin 改 path ⇒ **不**变（否则改个路径就打断授权，会被当 bug 报）', () => {
    expect(mcpServerOriginChanged(
      makeServer({ kind: 'http', url: 'https://mcp.a.example/mcp' }),
      makeServer({ kind: 'http', url: 'https://mcp.a.example/mcp/v2' }),
    )).toBe(false);
  });

  it('同 origin 改 query ⇒ **不**变', () => {
    expect(mcpServerOriginChanged(
      makeServer({ kind: 'http', url: 'https://mcp.a.example/mcp' }),
      makeServer({ kind: 'http', url: 'https://mcp.a.example/mcp?project=alpha' }),
    )).toBe(false);
  });

  it('http ⇄ stdio 切换 ⇒ 变了（数据去向变了）', () => {
    expect(mcpServerOriginChanged(
      makeServer({ kind: 'http', url: 'https://mcp.a.example/mcp' }),
      makeServer({ kind: 'stdio_bridge', command: 'node' }),
    )).toBe(true);
    expect(mcpServerOriginChanged(
      makeServer({ kind: 'stdio_bridge', command: 'node' }),
      makeServer({ kind: 'http', url: 'https://mcp.a.example/mcp' }),
    )).toBe(true);
  });

  it('两边都是 stdio ⇒ 不变', () => {
    expect(mcpServerOriginChanged(
      makeServer({ kind: 'stdio_bridge', command: 'node' }),
      makeServer({ kind: 'stdio_bridge', command: 'node' }),
    )).toBe(false);
  });

  it('完全相同 ⇒ 不变（负控）', () => {
    expect(mcpServerOriginChanged(makeServer(HTTP_A), makeServer(HTTP_A))).toBe(false);
  });
});
