import type { McpServerConfig, McpServerCreateInput, McpToolAllowlist } from '../mcp/types';
import { SHELL_MCP_NATIVE_HOST, SHELL_MCP_SERVER_NAME } from './contracts';

export interface ShellMcpPresetOptions {
  nativeHost?: string;
  enabled?: boolean;
  executionEnabled?: boolean;
}

export const DEFAULT_SHELL_MCP_ALLOWLIST_TOOL_NAMES = [
  'shell_status',
  'python_status',
  'local_skill_preview',
  'local_folder_pick',
] as const;

export const LOCAL_SKILL_SHELL_TOOL_NAMES = [
  'local_skill_preview',
  'local_folder_pick',
] as const;

export const LOCAL_FILE_SHELL_TOOL_NAMES = [
  'local_file_stat',
  'local_file_read',
  'local_file_write',
] as const;

/**
 * Subset of LOCAL_FILE_SHELL_TOOL_NAMES safe to auto-grant when importing
 * a local Skill. Import only needs read access; write access must be
 * explicitly authorized by the user (DPP-043).
 */
export const LOCAL_FILE_READONLY_SHELL_TOOL_NAMES = [
  'local_file_stat',
  'local_file_read',
] as const;

export function createShellMcpPresetInput(
  options: ShellMcpPresetOptions = {},
): McpServerCreateInput {
  return {
    displayName: SHELL_MCP_SERVER_NAME,
    enabled: options.enabled ?? false,
    transport: {
      kind: 'native_messaging',
      nativeHost: options.nativeHost ?? SHELL_MCP_NATIVE_HOST,
    },
    headers: [],
    secrets: [],
    timeouts: {
      connectMs: 5_000,
      requestMs: 120_000,
      discoveryMs: 10_000,
    },
    limits: {
      maxResultBytes: 128_000,
      maxToolCount: 8,
    },
    allowlist: {
      mode: 'allow',
      toolNames: [...DEFAULT_SHELL_MCP_ALLOWLIST_TOOL_NAMES],
    },
    execution: {
      enabled: options.executionEnabled ?? false,
      mode: 'auto',
    },
  };
}

export function isShellMcpServer(
  server: Pick<McpServerConfig, 'displayName' | 'transport'>,
): boolean {
  return server.displayName === SHELL_MCP_SERVER_NAME ||
    server.transport.nativeHost === SHELL_MCP_NATIVE_HOST;
}

export function buildShellAllowlistUpgrade(allowlist: McpToolAllowlist): McpToolAllowlist | null {
  if (allowlist.mode !== 'allow') return null;

  const names = new Set(allowlist.toolNames);
  const missingLocalSkillTools = LOCAL_SKILL_SHELL_TOOL_NAMES.filter((name) => !names.has(name));
  // DPP-043: only auto-grant read-only file tools on Skill import.
  // local_file_write must be explicitly authorized by the user.
  const missingLocalFileTools = LOCAL_FILE_READONLY_SHELL_TOOL_NAMES.filter((name) => !names.has(name));
  const missing = [...missingLocalSkillTools, ...missingLocalFileTools];
  if (missing.length === 0) return null;

  return {
    mode: 'allow',
    toolNames: [...allowlist.toolNames, ...missing],
  };
}
