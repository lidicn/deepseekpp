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
}

const cache = new Map<string, CacheEntry>();
const MAX_CACHE_ENTRIES = 32;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 分钟

function hashServerConfig(server: McpServerConfig): string {
  // 简化哈希：JSON.stringify 配置中影响连接的字段
  const relevant = {
    id: server.id,
    transport: server.transport,
    timeouts: server.timeouts,
    limits: server.limits,
  };
  return JSON.stringify(relevant);
}

function cacheKey(serverId: string): string {
  return serverId;
}

/** 获取缓存的 transport（如果配置未变更且未过期） */
export function getCachedMcpTransport(server: McpServerConfig): McpProtocolTransport | undefined {
  const entry = cache.get(cacheKey(server.id));
  if (!entry) return undefined;
  // 配置变更失效
  if (entry.configHash !== hashServerConfig(server)) {
    cache.delete(cacheKey(server.id));
    return undefined;
  }
  // TTL 过期失效
  if (Date.now() - entry.lastUsed > CACHE_TTL_MS) {
    cache.delete(cacheKey(server.id));
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
    if (oldestKey) cache.delete(oldestKey);
  }
  cache.set(cacheKey(server.id), {
    transport,
    configHash: hashServerConfig(server),
    initialized: true,
    lastUsed: Date.now(),
  });
}

/** 使指定服务器的缓存失效（配置更新/健康状态变为 error 时调用） */
export function invalidateMcpTransportCache(serverId: string): void {
  cache.delete(cacheKey(serverId));
}

/** 清空全部缓存（测试/调试用） */
export function clearMcpTransportCache(): void {
  cache.clear();
}
