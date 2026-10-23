// 2026-10-23 审计 X-60 回归：MCP 连接复用缓存的哈希必须含凭据，且更新/删除要清缓存。
//
// 缺陷：`hashServerConfig` 只取 `id`/`transport`/`timeouts`/`limits`，
// 而 `headers` 与 `secrets`（凭据）是 `McpServerConfig` 的顶层字段、
// **不在 `transport` 里** ⇒ 改密钥后哈希不变 ⇒ 命中旧缓存 ⇒ 继续用旧凭据发请求。
//
// 更坏的是现象：`store.ts` 用的是**发现指纹**（含 headers/secrets/url），
// 所以改密钥时工具列表会刷新 —— 用户看到「生效了」，实际连接还是旧的。
//
// 本测试锁定：
//   A. 改 secret 值 / headers / enabled ⇒ 缓存失效（不返回旧 transport）
//   B. 改 displayName / allowlist ⇒ 缓存**不**失效（否则改个备注就被重连）
//   C. `isMcpConnectionConfigEqual` 的判定与上面的行为一致
//   D. `invalidateMcpTransportCache` 能无条件清掉
import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearMcpTransportCache,
  getCachedMcpTransport,
  invalidateMcpTransportCache,
  isMcpConnectionConfigEqual,
  setCachedMcpTransport,
} from '../core/mcp/client-cache';
import type { McpProtocolTransport, McpServerConfig } from '../core/mcp/types';

// 缓存只关心对象引用，不需要真实 transport 行为
const STUB_TRANSPORT = { kind: 'stub' } as unknown as McpProtocolTransport;

function makeServer(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    version: 1,
    id: 'server-1',
    displayName: 'Local tools',
    enabled: true,
    transport: { kind: 'http', url: 'http://127.0.0.1:8080' },
    headers: [],
    secrets: [],
    timeouts: { connectMs: 5_000, requestMs: 30_000, discoveryMs: 10_000 },
    limits: { maxResultBytes: 1_000_000, maxToolCount: 200 },
    allowlist: { mode: 'all', toolNames: [] },
    execution: { mode: 'auto', enabled: true },
    status: 'unknown',
    ...overrides,
  } as McpServerConfig;
}

beforeEach(() => {
  clearMcpTransportCache();
});

describe('X-60: 连接缓存哈希包含凭据', () => {
  it('改 secret 值 ⇒ 旧连接不再命中（修复前会命中旧凭据）', () => {
    const before = makeServer({
      secrets: [{ kind: 'bearer', value: 'old-key' }],
    });
    setCachedMcpTransport(before, STUB_TRANSPORT);
    expect(getCachedMcpTransport(before)).toBe(STUB_TRANSPORT);

    // 用户换了密钥
    const after = makeServer({
      secrets: [{ kind: 'bearer', value: 'new-key' }],
    });
    expect(getCachedMcpTransport(after)).toBeUndefined();
  });

  it('改请求头 ⇒ 旧连接不再命中', () => {
    const before = makeServer({ headers: [{ name: 'X-Tenant', value: 'a' }] });
    setCachedMcpTransport(before, STUB_TRANSPORT);

    const after = makeServer({ headers: [{ name: 'X-Tenant', value: 'b' }] });
    expect(getCachedMcpTransport(after)).toBeUndefined();
  });

  it('停用服务器（enabled:false）⇒ 旧连接不再命中', () => {
    const before = makeServer();
    setCachedMcpTransport(before, STUB_TRANSPORT);

    const after = makeServer({ enabled: false });
    expect(getCachedMcpTransport(after)).toBeUndefined();
  });

  it('改地址 ⇒ 旧连接不再命中（这一条修复前就成立，防回归）', () => {
    const before = makeServer();
    setCachedMcpTransport(before, STUB_TRANSPORT);

    const after = makeServer({
      transport: { kind: 'http', url: 'http://192.168.1.50:8080' },
    });
    expect(getCachedMcpTransport(after)).toBeUndefined();
  });

  it('改 displayName ⇒ 缓存**不**失效（改备注不该触发重连）', () => {
    const before = makeServer();
    setCachedMcpTransport(before, STUB_TRANSPORT);

    const after = makeServer({ displayName: 'Renamed server' });
    expect(getCachedMcpTransport(after)).toBe(STUB_TRANSPORT);
  });

  it('改 allowlist ⇒ 缓存**不**失效', () => {
    const before = makeServer();
    setCachedMcpTransport(before, STUB_TRANSPORT);

    const after = makeServer({ allowlist: { mode: 'allow', toolNames: ['read_file'] } });
    expect(getCachedMcpTransport(after)).toBe(STUB_TRANSPORT);
  });

  it('相同配置 ⇒ 命中（负控：哈希没有变成恒不等）', () => {
    const server = makeServer({ secrets: [{ kind: 'bearer', value: 'k' }] });
    setCachedMcpTransport(server, STUB_TRANSPORT);
    // 用一份内容相同但对象不同的配置再取
    expect(getCachedMcpTransport(makeServer({ secrets: [{ kind: 'bearer', value: 'k' }] })))
      .toBe(STUB_TRANSPORT);
  });
});

describe('X-60: isMcpConnectionConfigEqual', () => {
  it('凭据不同 ⇒ 不等价', () => {
    expect(isMcpConnectionConfigEqual(
      makeServer({ secrets: [{ kind: 'bearer', value: 'a' }] }),
      makeServer({ secrets: [{ kind: 'bearer', value: 'b' }] }),
    )).toBe(false);
  });

  it('请求头不同 ⇒ 不等价', () => {
    expect(isMcpConnectionConfigEqual(
      makeServer({ headers: [{ name: 'X', value: 'a' }] }),
      makeServer({ headers: [{ name: 'X', value: 'b' }] }),
    )).toBe(false);
  });

  it('只有 displayName 不同 ⇒ 等价（存储层据此决定不重连）', () => {
    expect(isMcpConnectionConfigEqual(
      makeServer({ displayName: 'A' }),
      makeServer({ displayName: 'B' }),
    )).toBe(true);
  });

  it('只有 allowlist 不同 ⇒ 等价', () => {
    expect(isMcpConnectionConfigEqual(
      makeServer({ allowlist: { mode: 'all', toolNames: [] } }),
      makeServer({ allowlist: { mode: 'deny', toolNames: ['x'] } }),
    )).toBe(true);
  });

  it('timeouts 不同 ⇒ 不等价（它影响连接参数）', () => {
    expect(isMcpConnectionConfigEqual(
      makeServer(),
      makeServer({ timeouts: { connectMs: 1, requestMs: 2, discoveryMs: 3 } }),
    )).toBe(false);
  });
});

describe('X-60: invalidateMcpTransportCache', () => {
  it('无条件清掉指定服务器的缓存（delete 路径依赖它）', () => {
    const server = makeServer();
    setCachedMcpTransport(server, STUB_TRANSPORT);
    invalidateMcpTransportCache(server.id);
    expect(getCachedMcpTransport(server)).toBeUndefined();
  });

  it('只清指定服务器，不影响别的', () => {
    const a = makeServer({ id: 'server-a' });
    const b = makeServer({ id: 'server-b' });
    setCachedMcpTransport(a, STUB_TRANSPORT);
    setCachedMcpTransport(b, STUB_TRANSPORT);
    invalidateMcpTransportCache('server-a');
    expect(getCachedMcpTransport(a)).toBeUndefined();
    expect(getCachedMcpTransport(b)).toBe(STUB_TRANSPORT);
  });
});
