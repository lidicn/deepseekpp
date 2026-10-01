import type { McpServerConfig } from '../types';
import { McpTransportError } from './transport-errors';

export function getMcpEndpointUrl(server: McpServerConfig): URL {
  const url = server.transport.url;
  if (!url) {
    throw new McpTransportError('mcp_endpoint_missing', 'MCP server URL is missing.', { retryable: false });
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('Unsupported protocol');
    }
    return parsed;
  } catch {
    throw new McpTransportError('mcp_endpoint_invalid', `Invalid MCP server URL: ${url}`, { retryable: false });
  }
}

export function getMcpOriginPattern(server: McpServerConfig): string {
  const url = getMcpEndpointUrl(server);
  return `${url.protocol}//${url.host}/*`;
}

export async function hasMcpServerOriginPermission(server: McpServerConfig): Promise<boolean> {
  const origin = getMcpOriginPattern(server);
  if (!chrome.permissions?.contains) {
    throw new McpTransportError(
      'mcp_origin_permission_check_unavailable',
      `Host permission cannot be verified for ${origin}.`,
      { retryable: false },
    );
  }
  try {
    return await chrome.permissions.contains({ origins: [origin] });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new McpTransportError(
      'mcp_origin_permission_check_failed',
      `Host permission could not be verified for ${origin}: ${message}`,
    );
  }
}

export async function ensureMcpServerOriginPermission(server: McpServerConfig): Promise<void> {
  const granted = await hasMcpServerOriginPermission(server);
  if (!granted) {
    throw new McpTransportError(
      'mcp_origin_permission_denied',
      `Host permission was not granted for ${getMcpOriginPattern(server)}.`,
      { retryable: false },
    );
  }
}
