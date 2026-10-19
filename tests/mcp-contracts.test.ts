import { describe, expect, it } from 'vitest';
import {
  MCP_CAPABILITY_OPERATION_ANNOTATION,
  MCP_CAPABILITY_OPERATIONS,
  MCP_CAPABILITY_TOOL_PROVIDER_ID,
  getMcpCapabilityOperation,
  isMcpCapabilityDescriptor,
} from '../core/mcp/capability-contract';
import {
  MCP_NATIVE_ENVELOPE_PROTOCOL,
  MCP_NATIVE_ENVELOPE_VERSION,
} from '../core/mcp/native-contract';
import { SHELL_MCP_NATIVE_HOST } from '../core/shell/contracts';
import type { ToolDescriptor } from '../core/tool/types';

// T46: MCP 契约层纯常量/类型守卫 + 第一方宿主名权威。

function makeDescriptor(overrides: Partial<ToolDescriptor> & { operation?: string }): ToolDescriptor {
  const { operation, ...rest } = overrides;
  return {
    id: `local:${MCP_CAPABILITY_TOOL_PROVIDER_ID}:mcp_${operation ?? 'discover'}`,
    provider: { kind: 'local', id: MCP_CAPABILITY_TOOL_PROVIDER_ID, displayName: 'MCP capability', transport: 'in_process' },
    name: `mcp_${operation ?? 'discover'}`,
    invocationName: `mcp_${operation ?? 'discover'}`,
    title: 'Capability',
    description: 'capability contract',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    execution: { mode: 'auto', enabled: true, risk: 'low' },
    annotations: operation === undefined ? undefined : { [MCP_CAPABILITY_OPERATION_ANNOTATION]: operation },
    ...rest,
  };
}

describe('capability-contract · 契约常量', () => {
  it('pins the operation set to discover/describe/invoke and the annotation key', () => {
    expect([...MCP_CAPABILITY_OPERATIONS]).toEqual(['discover', 'describe', 'invoke']);
    expect(MCP_CAPABILITY_TOOL_PROVIDER_ID).toBe('mcp_capability');
    expect(MCP_CAPABILITY_OPERATION_ANNOTATION).toBe('dpp.mcpCapabilityOperation');
  });
});

describe('getMcpCapabilityOperation · 类型守卫', () => {
  it('returns the declared operation for a valid annotation and null otherwise', () => {
    expect(getMcpCapabilityOperation(makeDescriptor({ operation: 'describe' }))).toBe('describe');
    expect(getMcpCapabilityOperation(makeDescriptor({ operation: 'bogus' }))).toBeNull();
    expect(getMcpCapabilityOperation(makeDescriptor({ operation: undefined }))).toBeNull();
  });
});

describe('isMcpCapabilityDescriptor · 真/假识别', () => {
  it('accepts a genuine local mcp_capability descriptor', () => {
    expect(isMcpCapabilityDescriptor(makeDescriptor({ operation: 'invoke' }))).toBe(true);
  });

  it('rejects an MCP target that merely carries the annotation (impersonation)', () => {
    const spoofed = makeDescriptor({
      operation: 'invoke',
      id: 'mcp:server-1:mcp_invoke',
      provider: { kind: 'mcp', id: 'server-1', displayName: 'MCP', transport: 'streamable_http' },
    });
    expect(isMcpCapabilityDescriptor(spoofed)).toBe(false);
  });

  it('rejects a local descriptor with a mismatched tool id or missing operation', () => {
    const badId = makeDescriptor({ operation: 'discover', id: 'local:mcp_capability:other' });
    expect(isMcpCapabilityDescriptor(badId)).toBe(false);
    expect(isMcpCapabilityDescriptor(makeDescriptor({ operation: undefined }))).toBe(false);
  });
});

describe('native-contract · 信封常量', () => {
  it('pins the native envelope protocol tag and version', () => {
    expect(MCP_NATIVE_ENVELOPE_PROTOCOL).toBe('deepseek-pp-mcp-native');
    expect(MCP_NATIVE_ENVELOPE_VERSION).toBe(1);
  });
});

describe('shell native host · 唯一权威名', () => {
  it('authoritative host id uses underscore, not a hyphenated variant', () => {
    expect(SHELL_MCP_NATIVE_HOST).toBe('com.deepseek_pp.shell');
    expect(SHELL_MCP_NATIVE_HOST).not.toContain('-');
  });
});
