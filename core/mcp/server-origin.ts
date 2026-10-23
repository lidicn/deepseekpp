/**
 * MCP 服务器端点身份（2026-10-23，审计 X-67）。
 *
 * ## 为什么需要这个模块
 *
 * 工具授权快照（`core/tool/descriptor-security.ts`）只收
 * `{ id, provider:{kind,id,transport}, name, invocationName, execution, inputSchemaDigest }` ——
 * **端点地址不在其中**。而 `ToolProviderIdentity`（`core/tool/types.ts:50-55`）
 * 本身就没有 url 字段，URL 只活在 `McpServerConfig.transport.url`。
 *
 * 于是同一个配置编辑，三套机制读数相反：
 *
 *   · 发现指纹（`core/mcp/store.ts` 的 `mcpDiscoveryFingerprint`）—— 含 url ⇒ 工具缓存失效
 *   · 连接缓存哈希（`core/mcp/client-cache.ts`）—— 取整个 transport ⇒ 连接重建
 *   · **授权快照 —— 不含 url ⇒ 旧 grant 静默续用**
 *
 * 本模块提供「端点是否换了」的判定，供 `UPDATE_MCP_SERVER` 处理器在换端点时
 * 撤销该服务器的活跃授权（审计建议的方案 B：不动跨模块契约，落点在编排层）。
 *
 * ## 为什么只比 origin
 *
 * 若比完整 URL，用户改个 query（比如换个 `?project=`）或补个 path 也会被要求
 * 重新授权 —— 体验过差，会被当 bug 报。而**换 origin 意味着数据实际发往了
 * 另一台主机**，这才是同意边界真正变化的地方。
 */

import type { McpServerConfig } from './types';

/**
 * 取服务器的端点 origin（`scheme://host:port`）。
 *
 * - 非 URL 型传输（`stdio_bridge` / `native_messaging`）或没有 url → `null`
 * - URL 非法 → 返回原始字符串的 trim（宁可判「变了」也不要漏判）
 */
export function mcpServerOrigin(server: McpServerConfig): string | null {
  const raw = server.transport?.url;
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const trimmed = raw.trim();
  try {
    return new URL(trimmed).origin;
  } catch {
    return trimmed;
  }
}

/**
 * 两份配置的端点 origin 是否发生了变化。
 *
 * 两边都没有端点（如 stdio 服务器）视为**未变化**；
 * 一边有、一边没有视为变化（传输方式被换掉）。
 */
export function mcpServerOriginChanged(previous: McpServerConfig, next: McpServerConfig): boolean {
  return mcpServerOrigin(previous) !== mcpServerOrigin(next);
}
