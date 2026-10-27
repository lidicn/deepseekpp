import type { McpProtocolTransport, McpServerConfig } from './types';

/**
 * MCP 连接复用缓存：在 service worker 生命周期内复用已 initialize 的 transport。
 * 缓存 key = serverId + 配置哈希；配置变更时自动失效。
 * MV3 service worker 被杀后缓存自然丢失，重启后重新 initialize。
 */

interface CacheEntry {
  transport: McpProtocolTransport;
  configHash: string;
  initialized: boolean;
  lastUsed: number;
  /** 审计 #73：绝对存活起点。TTL 每次命中都会续期（滑动过期），没有它热连接永不过期。 */
  createdAt: number;
}

const cache = new Map<string, CacheEntry>();
const MAX_CACHE_ENTRIES = 32;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 分钟（滑动：每次命中续期）
/**
 * 审计 #73：绝对存活上限。`lastUsed` 每次命中都续期 ⇒ 单靠滑动 TTL，
 * 一个每 4 分钟被用一次的热连接**永不淘汰**；而底层连接（native Port / SSE 流）
 * 可能早已半死（对端重启、会话失效），表现为"偶发超时"而不是立刻报错。
 * 取 30 分钟 = 6 × TTL：足够覆盖正常会话，又能保证每半小时强制重连一次。
 */
const MAX_CONNECTION_LIFETIME_MS = 30 * 60 * 1000;

/**
 * 连接相关配置的哈希。
 *
 * 2026-10-23 修复审计 X-60：原实现只取 `id`/`transport`/`timeouts`/`limits`，
 * 而 `headers` 与 `secrets`（凭据）是 `McpServerConfig` 的**顶层字段**
 * （`core/mcp/types.ts:64-81`），不在 `transport` 里 ⇒ 改密钥／改请求头之后
 * 哈希不变 ⇒ `getCachedMcpTransport` 命中旧缓存 ⇒ **继续用旧凭据发请求**。
 *
 * 更坏的是它的现象：`store.ts` 用的是**发现指纹**（含 headers/secrets/url），
 * 所以改密钥时工具列表会刷新 —— 用户看到「生效了」，实际连接还是旧的。
 *
 * 现纳入 `headers` / `secrets` / `enabled`。取整个值而不是摘要：这个字符串
 * 只活在本模块的内存 Map 里（`CacheEntry.configHash`），**从不持久化、从不打印**，
 * 因此不会造成额外的凭据落盘。⚠ 后续若要给它加日志，必须先改成摘要。
 */
export function hashMcpConnectionConfig(server: McpServerConfig): string {
  const relevant = {
    id: server.id,
    enabled: server.enabled,
    transport: server.transport,
    headers: server.headers,
    secrets: server.secrets,
    timeouts: server.timeouts,
    limits: server.limits,
  };
  return JSON.stringify(relevant);
}

/**
 * 两份配置在**连接层面**是否等价。
 *
 * 用于让存储层在更新后决定要不要显式失效连接缓存 —— 只看连接相关字段，
 * 改 `displayName`／`allowlist` 不算。
 */
export function isMcpConnectionConfigEqual(left: McpServerConfig, right: McpServerConfig): boolean {
  return hashMcpConnectionConfig(left) === hashMcpConnectionConfig(right);
}

function hashServerConfig(server: McpServerConfig): string {
  return hashMcpConnectionConfig(server);
}

function cacheKey(serverId: string): string {
  return serverId;
}

/**
 * 审计 #65：淘汰缓存条目时必须**关闭底层连接**。
 *
 * 之前所有失效路径都只做 `cache.delete()`：native messaging 的 Port 会一直挂在
 * 模块级 `nativePortStates` 里（直到宿主断开或 GC），SSE/HTTP 的长连接同理。
 * 高频切换 server 或配置反复变更时会稳定泄漏连接。
 */
function evict(key: string): void {
  const entry = cache.get(key);
  if (!entry) return;
  try {
    entry.transport.close?.();
  } catch {
    // best-effort：close 失败不能影响缓存淘汰本身
  }
  cache.delete(key);
}

/** 获取缓存的 transport（如果配置未变更且未过期） */
export function getCachedMcpTransport(server: McpServerConfig): McpProtocolTransport | undefined {
  const entry = cache.get(cacheKey(server.id));
  if (!entry) return undefined;
  // 配置变更失效
  if (entry.configHash !== hashServerConfig(server)) {
    evict(cacheKey(server.id));
    return undefined;
  }
  // 审计 #73：绝对寿命到点即淘汰（不受滑动续期影响）
  if (Date.now() - entry.createdAt > MAX_CONNECTION_LIFETIME_MS) {
    evict(cacheKey(server.id));
    return undefined;
  }
  // TTL 过期失效
  if (Date.now() - entry.lastUsed > CACHE_TTL_MS) {
    evict(cacheKey(server.id));
    return undefined;
  }
  entry.lastUsed = Date.now();
  return entry.transport;
}

/** 缓存已 initialize 的 transport */
export function setCachedMcpTransport(server: McpServerConfig, transport: McpProtocolTransport): void {
  // LRU 淘汰：超过上限时删除最久未使用的
  if (cache.size >= MAX_CACHE_ENTRIES && !cache.has(cacheKey(server.id))) {
    let oldestKey: string | undefined;
    let oldestTime = Infinity;
    for (const [key, entry] of cache) {
      if (entry.lastUsed < oldestTime) {
        oldestTime = entry.lastUsed;
        oldestKey = key;
      }
    }
    if (oldestKey) evict(oldestKey);
  }
  cache.set(cacheKey(server.id), {
    transport,
    configHash: hashServerConfig(server),
    initialized: true,
    lastUsed: Date.now(),
    createdAt: Date.now(),
  });
}

/** 使指定服务器的缓存失效（配置更新/健康状态变为 error 时调用） */
export function invalidateMcpTransportCache(serverId: string): void {
  evict(cacheKey(serverId));
}

/** 清空全部缓存（测试/调试用） */
export function clearMcpTransportCache(): void {
  for (const key of [...cache.keys()]) evict(key);
}
