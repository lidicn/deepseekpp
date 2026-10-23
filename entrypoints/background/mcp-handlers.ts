import {
  definePayloadlessRuntimeCommandHandler,
  type RuntimeCommandHandler,
} from '../../core/messaging/runtime-command-registry';
import type {
  McpServerPermissionResponse,
} from '../../core/messaging/tool-runtime-contracts';
import type {
  McpServerConfig,
  McpServerCreateInput,
  McpServerUpdateInput,
  McpToolCacheEntry,
} from '../../core/mcp/types';
import type {
  McpCapabilityExposureMode,
  McpCapabilitySettings,
  McpCapabilitySettingsPatch,
} from '../../core/mcp/capability-types';
import { defineToolPayloadRuntimeCommandHandler } from './runtime-handler';
import { mcpServerOriginChanged } from '../../core/mcp/server-origin';

export interface McpRuntimeHandlerDependencies {
  getAllMcpServers(): Promise<McpServerConfig[]>;
  getMcpCapabilitySettings(): Promise<McpCapabilitySettings>;
  updateMcpCapabilitySettings(patch: McpCapabilitySettingsPatch): Promise<McpCapabilitySettings>;
  setMcpCapabilityServerExposure(input: {
    serverId: string;
    mode: McpCapabilityExposureMode;
    pinnedDescriptorIds?: readonly string[];
  }): Promise<McpCapabilitySettings>;
  getMcpServerById(id: string): Promise<McpServerConfig | null>;
  createMcpServer(input: McpServerCreateInput): Promise<McpServerConfig>;
  updateMcpServer(id: string, patch: McpServerUpdateInput): Promise<McpServerConfig | null>;
  deleteMcpServer(id: string): Promise<void>;
  /**
   * 撤销某个 MCP server 名下的全部活跃工具授权（审计 X-67）。
   *
   * 授权快照不含端点地址（`ToolProviderIdentity` 就没有 url 字段），所以换地址
   * 后旧 grant 会被静默续用到新端点。`UPDATE_MCP_SERVER` 发现 origin 变化时调它，
   * 让下一次调用重新征求同意。
   *
   * 返回被撤销的 grant 数量。
   */
  revokeToolAuthorizationsForProvider(providerId: string): Promise<number>;
  getMcpToolCache(serverId: string): Promise<McpToolCacheEntry | null>;
  refreshMcpServerDiscovery(serverId: string): Promise<McpToolCacheEntry>;
  getMcpOriginPattern(server: McpServerConfig): string;
  hasMcpServerOriginPermission(server: McpServerConfig): Promise<boolean>;
  broadcastMcpServersUpdate(excludeTabId?: number): Promise<void>;
  broadcastToolDescriptorsUpdate(excludeTabId?: number): Promise<void>;
}

export function createMcpRuntimeHandlers(
  dependencies: McpRuntimeHandlerDependencies,
): readonly RuntimeCommandHandler[] {
  const notifyMcpAndTools = async (excludeTabId?: number): Promise<void> => {
    await dependencies.broadcastMcpServersUpdate(excludeTabId);
    await dependencies.broadcastToolDescriptorsUpdate(excludeTabId);
  };

  return Object.freeze([
    definePayloadlessRuntimeCommandHandler('GET_MCP_SERVERS', () => (
      dependencies.getAllMcpServers()
    )),
    definePayloadlessRuntimeCommandHandler('GET_MCP_CAPABILITY_SETTINGS', () => (
      dependencies.getMcpCapabilitySettings()
    )),
    defineToolPayloadRuntimeCommandHandler('UPDATE_MCP_CAPABILITY_SETTINGS', async (payload, context) => {
      const settings = await dependencies.updateMcpCapabilitySettings(payload);
      await notifyMcpAndTools(context.tabId);
      return settings;
    }),
    defineToolPayloadRuntimeCommandHandler('SET_MCP_CAPABILITY_SERVER_EXPOSURE', async (payload, context) => {
      const settings = await dependencies.setMcpCapabilityServerExposure(payload);
      await notifyMcpAndTools(context.tabId);
      return settings;
    }),
    defineToolPayloadRuntimeCommandHandler('GET_MCP_SERVER', (payload) => (
      dependencies.getMcpServerById(payload.id)
    )),
    defineToolPayloadRuntimeCommandHandler('CREATE_MCP_SERVER', async (payload, context) => {
      const server = await dependencies.createMcpServer(payload);
      await notifyMcpAndTools(context.tabId);
      return server;
    }),
    defineToolPayloadRuntimeCommandHandler('UPDATE_MCP_SERVER', async (payload, context) => {
      // 审计 X-67：先取旧配置，更新后比较端点 origin。
      // 授权快照不含端点（`ToolProviderIdentity` 没有 url 字段），所以换地址后
      // 旧 grant 会被静默续用到新端点 —— 必须在这里主动撤销。
      // 落点选编排层而不是 `core/mcp/store.ts`：授权态在 `core/tool/`，
      // 让存储层反向依赖授权层会把 `core/mcp` ↔ `core/tool` 变成双向依赖。
      const previous = await dependencies.getMcpServerById(payload.id);
      const server = await dependencies.updateMcpServer(payload.id, payload.patch);
      // 比较时**不加**「旧端点必须非 null」：stdio ↔ http 的传输切换也改变了
      // 数据的实际去向（origin 从 null 变成某个 host），同样必须撤销。
      if (previous && server && mcpServerOriginChanged(previous, server)) {
        await dependencies.revokeToolAuthorizationsForProvider(payload.id);
      }
      await notifyMcpAndTools(context.tabId);
      return server;
    }),
    defineToolPayloadRuntimeCommandHandler('DELETE_MCP_SERVER', async (payload, context) => {
      await dependencies.deleteMcpServer(payload.id);
      await notifyMcpAndTools(context.tabId);
      return { ok: true as const };
    }),
    defineToolPayloadRuntimeCommandHandler('GET_MCP_TOOL_CACHE', (payload) => (
      dependencies.getMcpToolCache(payload.serverId)
    )),
    defineToolPayloadRuntimeCommandHandler('REFRESH_MCP_SERVER_TOOLS', async (payload, context) => {
      const cache = await dependencies.refreshMcpServerDiscovery(payload.serverId);
      await notifyMcpAndTools(context.tabId);
      return cache;
    }),
    // Keep the released command for compatibility, but never request a new
    // host permission from a runtime message: the Side Panel owns that user
    // gesture. Background callers may only observe the current grant.
    defineToolPayloadRuntimeCommandHandler('REQUEST_MCP_SERVER_PERMISSION', async (payload) => {
      const server = await dependencies.getMcpServerById(payload.serverId);
      if (!server) return { ok: false as const, error: 'mcp_server_not_found' };
      if (server.transport.kind === 'native_messaging') {
        return { ok: true, origin: null };
      }
      try {
        const origin = dependencies.getMcpOriginPattern(server);
        const ok = await dependencies.hasMcpServerOriginPermission(server);
        return { ok, origin };
      } catch (error) {
        return permissionFailure(error);
      }
    }),
    defineToolPayloadRuntimeCommandHandler('TEST_MCP_SERVER_CONNECTION', async (payload, context) => {
      const cache = await dependencies.refreshMcpServerDiscovery(payload.serverId);
      await notifyMcpAndTools(context.tabId);
      return {
        ok: cache.health.status === 'ready',
        cache,
        health: cache.health,
      };
    }),
  ]);
}

function permissionFailure(error: unknown): McpServerPermissionResponse {
  return {
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  };
}
