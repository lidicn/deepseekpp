import type { McpClientInfo, McpServerConfig } from './types';
import { SHELL_MCP_NATIVE_HOST } from '../shell';
import {
  MULTIMODAL_MCP_NATIVE_HOST,
  MULTIMODAL_MCP_PACKAGE_NAME,
  MULTIMODAL_MCP_PACKAGE_VERSION,
} from '../multimodal';

// release.yml pins the Shell Host to the extension version; the multimodal host keeps its own line.
const SHELL_MCP_PACKAGE_NAME = 'deepseek-pp-shell-host';

interface FirstPartyHostPolicy {
  packageName: string;
  expectedVersion: string;
}

function getFirstPartyHostPolicy(
  server: Pick<McpServerConfig, 'transport'>,
  extensionVersion: string,
): FirstPartyHostPolicy | null {
  if (server.transport.kind !== 'native_messaging') return null;
  if (server.transport.nativeHost === SHELL_MCP_NATIVE_HOST) {
    return { packageName: SHELL_MCP_PACKAGE_NAME, expectedVersion: extensionVersion };
  }
  if (server.transport.nativeHost === MULTIMODAL_MCP_NATIVE_HOST) {
    return {
      packageName: MULTIMODAL_MCP_PACKAGE_NAME,
      expectedVersion: MULTIMODAL_MCP_PACKAGE_VERSION,
    };
  }
  return null;
}

function readVersionSegments(value: unknown): number[] | null {
  if (typeof value !== 'string') return null;
  const match = /^\d+(?:\.\d+)*/.exec(value.trim());
  if (!match) return null;
  return match[0].split('.').map((segment) => Number.parseInt(segment, 10));
}

export function isOlderVersion(actual: unknown, expected: unknown): boolean {
  const left = readVersionSegments(actual);
  const right = readVersionSegments(expected);
  if (!left || !right) return false;
  const width = Math.max(left.length, right.length);
  for (let index = 0; index < width; index += 1) {
    const leftSegment = left[index] ?? 0;
    const rightSegment = right[index] ?? 0;
    if (leftSegment !== rightSegment) return leftSegment < rightSegment;
  }
  return false;
}

// Envelope v1 is shared by every host version, so an outdated host answers all
// frames while missing whole tool paths; this note is the only signal it lags.
// The stored form is a locale-independent code so the sidepanel can render it
// from locale resources instead of echoing protocol-layer text at the user.
export const NATIVE_HOST_OUTDATED_CODE = 'mcp_native_host_version_outdated';

export interface NativeHostOutdatedNote {
  packageName: string;
  hostVersion: string;
  expectedVersion: string;
}

export function nativeHostVersionHint(
  server: Pick<McpServerConfig, 'transport'>,
  serverInfo: McpClientInfo | undefined,
  extensionVersion: string,
): string | null {
  const policy = getFirstPartyHostPolicy(server, extensionVersion);
  if (!policy) return null;
  const hostVersion = serverInfo?.version;
  if (!isOlderVersion(hostVersion, policy.expectedVersion)) return null;
  return [
    NATIVE_HOST_OUTDATED_CODE,
    `package=${policy.packageName}`,
    `host=${hostVersion}`,
    `expected=${policy.expectedVersion}`,
  ].join(' ');
}

export function parseNativeHostOutdatedNote(
  value: string | null | undefined,
): NativeHostOutdatedNote | null {
  if (!value?.startsWith(`${NATIVE_HOST_OUTDATED_CODE} `)) return null;
  const fields = new Map<string, string>();
  for (const part of value.slice(NATIVE_HOST_OUTDATED_CODE.length + 1).split(' ')) {
    const separator = part.indexOf('=');
    if (separator <= 0 || separator === part.length - 1) return null;
    fields.set(part.slice(0, separator), part.slice(separator + 1));
  }
  const packageName = fields.get('package');
  const hostVersion = fields.get('host');
  const expectedVersion = fields.get('expected');
  if (!packageName || !hostVersion || !expectedVersion) return null;
  return { packageName, hostVersion, expectedVersion };
}
