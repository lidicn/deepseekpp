import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { McpServerConfig } from '../core/mcp/types';
import { isOlderVersion, nativeHostVersionHint } from '../core/mcp/native-host-version';
import { SHELL_MCP_NATIVE_HOST } from '../core/shell';
import {
  MULTIMODAL_MCP_NATIVE_HOST,
  MULTIMODAL_MCP_PACKAGE_NAME,
  MULTIMODAL_MCP_PACKAGE_VERSION,
} from '../core/multimodal';

// McpPage.tsx classifies health.error by substring before it reaches the ready
// branch, so a hint containing any of these would render as a fatal setup error.
const FATAL_HINT_SUBSTRINGS = [
  'forbidden',
  'not found',
  'specified native messaging host',
  'native_host_unavailable',
  'native_messaging_unavailable',
  'failed to fetch',
  'mcp_network_error',
  'cannot reach',
  'connection refused',
];

function nativeServer(nativeHost: string): Pick<McpServerConfig, 'transport'> {
  return { transport: { kind: 'native_messaging', nativeHost } };
}

describe('First-party native host version gate', () => {
  it('hints when the Shell Host lags the extension', () => {
    const hint = nativeHostVersionHint(
      nativeServer(SHELL_MCP_NATIVE_HOST),
      { name: 'deepseek-pp-shell', version: '1.14.0' },
      '1.16.0',
    );

    expect(hint).toContain('deepseek-pp-shell-host 1.14.0');
    expect(hint).toContain('1.16.0');
    expect(hint).toContain('npx --yes deepseek-pp-shell-host@1.16.0 install');
  });

  it('stays silent when the Shell Host matches or leads the extension', () => {
    const server = nativeServer(SHELL_MCP_NATIVE_HOST);
    expect(nativeHostVersionHint(server, { name: 'deepseek-pp-shell', version: '1.16.0' }, '1.16.0'))
      .toBeNull();
    expect(nativeHostVersionHint(server, { name: 'deepseek-pp-shell', version: '1.17.1' }, '1.16.0'))
      .toBeNull();
  });

  it('judges the multimodal host by its own release line, not the extension version', () => {
    const server = nativeServer(MULTIMODAL_MCP_NATIVE_HOST);
    expect(nativeHostVersionHint(server, { name: 'multimodal', version: '0.1.0' }, '1.16.0'))
      .toBeNull();

    const hint = nativeHostVersionHint(server, { name: 'multimodal', version: '0.0.9' }, '1.16.0');
    expect(hint).toContain(`${MULTIMODAL_MCP_PACKAGE_NAME} 0.0.9`);
    expect(hint).toContain(`${MULTIMODAL_MCP_PACKAGE_NAME}@${MULTIMODAL_MCP_PACKAGE_VERSION} install`);
  });

  it('ignores third-party servers and non-native transports', () => {
    expect(nativeHostVersionHint(nativeServer('com.example.host'), { name: 'x', version: '0.0.1' }, '1.16.0'))
      .toBeNull();
    expect(nativeHostVersionHint(
      { transport: { kind: 'http', url: 'http://127.0.0.1:1/mcp' } },
      { name: 'deepseek-pp-shell', version: '0.0.1' },
      '1.16.0',
    )).toBeNull();
  });

  it('ignores hosts that report no usable version', () => {
    const server = nativeServer(SHELL_MCP_NATIVE_HOST);
    expect(nativeHostVersionHint(server, undefined, '1.16.0')).toBeNull();
    expect(nativeHostVersionHint(server, { name: 'deepseek-pp-shell' } as never, '1.16.0')).toBeNull();
    expect(nativeHostVersionHint(server, { name: 'deepseek-pp-shell', version: 'dev' }, '1.16.0'))
      .toBeNull();
  });

  it('compares version segments numerically', () => {
    expect(isOlderVersion('0.9.0', '0.10.0')).toBe(true);
    expect(isOlderVersion('1.2.10', '1.2.9')).toBe(false);
    expect(isOlderVersion('1.2', '1.2.0')).toBe(false);
    expect(isOlderVersion('1.14.0', '1.16.0')).toBe(true);
    expect(isOlderVersion(undefined, '1.16.0')).toBe(false);
    expect(isOlderVersion('1.16.0', undefined)).toBe(false);
  });

  it('keeps the hint wording clear of the sidepanel fatal classifier', () => {
    const hint = nativeHostVersionHint(
      nativeServer(SHELL_MCP_NATIVE_HOST),
      { name: 'deepseek-pp-shell', version: '1.14.0' },
      '1.16.0',
    );
    expect(hint).not.toBeNull();
    const lowered = hint!.toLowerCase();
    for (const needle of FATAL_HINT_SUBSTRINGS) {
      expect(lowered.includes(needle), `hint must not contain "${needle}"`).toBe(false);
    }
  });

  it('pins the multimodal install script to the version this gate expects', () => {
    const scripts = JSON.parse(readFileSync('package.json', 'utf8')).scripts as Record<string, string>;
    expect(scripts['multimodal:install'])
      .toBe(`npx --yes ${MULTIMODAL_MCP_PACKAGE_NAME}@${MULTIMODAL_MCP_PACKAGE_VERSION}`);
  });

  it('keeps the Shell Host package version equal to the extension version', () => {
    const root = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };
    const shell = JSON.parse(
      readFileSync('packages/shell-host/package.json', 'utf8'),
    ) as { version: string };
    const lock = JSON.parse(readFileSync('package-lock.json', 'utf8')) as {
      version: string;
      packages: Record<string, { version?: string }>;
    };

    expect(shell.version).toBe(root.version);
    expect(lock.version).toBe(root.version);
    expect(lock.packages[''].version).toBe(root.version);
    expect(lock.packages['packages/shell-host'].version).toBe(root.version);
  });
});
