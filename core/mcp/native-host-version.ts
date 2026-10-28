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

interface ParsedVersion {
  segments: number[];
  /** semver pre-release 标识符；正式版为空数组 */
  prerelease: string[];
}

/**
 * 审计 #70：解析时**保留 pre-release 后缀**。
 *
 * 原实现只取 `^\d+(\.\d+)*`，把 `1.2.3-beta` 截成 `[1,2,3]` ⇒ 与 `1.2.3` 判等，
 * 于是"测试版宿主要不要提示过期"这一判断永远为 false（semver 里 `1.2.3-beta < 1.2.3`）。
 */
function readVersion(value: unknown): ParsedVersion | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?/.exec(value.trim());
  if (!match) return null;
  return {
    segments: match[1].split('.').map((segment) => Number.parseInt(segment, 10)),
    prerelease: match[2] ? match[2].split('.') : [],
  };
}

/** semver 11.4：正式版 > 预发布；同前缀逐段比较，数字段按数值、字母段按字典序，数字 < 字母 */
function comparePrerelease(left: readonly string[], right: readonly string[]): number {
  if (left.length === 0 && right.length === 0) return 0;
  if (left.length === 0) return 1;
  if (right.length === 0) return -1;
  const width = Math.max(left.length, right.length);
  for (let index = 0; index < width; index += 1) {
    const leftPart = left[index];
    const rightPart = right[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) {
      const delta = Number(leftPart) - Number(rightPart);
      if (delta !== 0) return delta < 0 ? -1 : 1;
      continue;
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    if (leftPart !== rightPart) return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

export function isOlderVersion(actual: unknown, expected: unknown): boolean {
  const left = readVersion(actual);
  const right = readVersion(expected);
  if (!left || !right) return false;
  const width = Math.max(left.segments.length, right.segments.length);
  for (let index = 0; index < width; index += 1) {
    const leftSegment = left.segments[index] ?? 0;
    const rightSegment = right.segments[index] ?? 0;
    if (leftSegment !== rightSegment) return leftSegment < rightSegment;
  }
  return comparePrerelease(left.prerelease, right.prerelease) < 0;
}

// Envelope v1 is shared by every host version, so an outdated host answers all
// frames while missing whole tool paths; this note is the only signal it lags.
// The stored form is a locale-independent code so the sidepanel can render it
// from locale resources instead of echoing protocol-layer text at the user.
export const NATIVE_HOST_OUTDATED_CODE = 'mcp_native_host_version_outdated';
// Audit fix N-2: bidirectional version check. A host that is NEWER than the
// extension is equally risky (new/changed frame semantics the extension doesn't
// understand), but isOlderVersion only caught the "too old" direction.
export const NATIVE_HOST_NEWER_CODE = 'mcp_native_host_version_newer';

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
  // Audit fix N-2: bidirectional check — both older AND newer than expected
  // produce a hint. Previously only "older" was caught, so a newer host with
  // incompatible frame semantics would pass silently.
  if (isOlderVersion(hostVersion, policy.expectedVersion)) {
    return [
      NATIVE_HOST_OUTDATED_CODE,
      `package=${policy.packageName}`,
      `host=${hostVersion}`,
      `expected=${policy.expectedVersion}`,
    ].join(' ');
  }
  if (isNewerVersion(hostVersion, policy.expectedVersion)) {
    return [
      NATIVE_HOST_NEWER_CODE,
      `package=${policy.packageName}`,
      `host=${hostVersion}`,
      `expected=${policy.expectedVersion}`,
    ].join(' ');
  }
  return null;
}

/**
 * Returns true when `actual` is strictly newer than `expected` (numeric
 * segment comparison). Audit fix N-2: complements isOlderVersion for
 * bidirectional version mismatch detection.
 */
export function isNewerVersion(actual: unknown, expected: unknown): boolean {
  const left = readVersion(actual);
  const right = readVersion(expected);
  if (!left || !right) return false;
  const width = Math.max(left.segments.length, right.segments.length);
  for (let index = 0; index < width; index += 1) {
    const leftSegment = left.segments[index] ?? 0;
    const rightSegment = right.segments[index] ?? 0;
    if (leftSegment !== rightSegment) return leftSegment > rightSegment;
  }
  // 审计 #70：数字段相同再比 pre-release（与 isOlderVersion 同一口径，保证双向判断自洽）
  return comparePrerelease(left.prerelease, right.prerelease) > 0;
}

export function parseNativeHostOutdatedNote(
  value: string | null | undefined,
): NativeHostOutdatedNote | null {
  if (!value) return null;
  // Audit fix N-2: accept both outdated and newer codes.
  const isOutdated = value.startsWith(`${NATIVE_HOST_OUTDATED_CODE} `);
  const isNewer = value.startsWith(`${NATIVE_HOST_NEWER_CODE} `);
  if (!isOutdated && !isNewer) return null;
  const codeLength = isOutdated
    ? NATIVE_HOST_OUTDATED_CODE.length
    : NATIVE_HOST_NEWER_CODE.length;
  const fields = new Map<string, string>();
  for (const part of value.slice(codeLength + 1).split(' ')) {
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
