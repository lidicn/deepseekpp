import { describe, expect, it } from 'vitest';
import {
  CLIENT_ONLY_RUNTIME_COMMAND_TYPES,
  getRuntimeCommandOwner,
  RUNTIME_COMMAND_CONTRACTS,
  TYPED_RUNTIME_COMMAND_TYPES,
  type RuntimeCommandContract,
} from '../core/messaging/runtime-command-contracts';

// T18: 契约层自洽——命令名唯一、每条命令结构完整且枚举合法、owner 分组互斥完备、
// getRuntimeCommandOwner 路由正确。独立文件，不碰 baseline 红的 runtime-command-contract.test.ts。

const OWNERS = new Set(['typed-handler', 'client-only']);
const SURFACES = new Set(['live-and-declared', 'live-only', 'declared-only']);
const ACCESS = new Set(['none', 'payload-cast', 'payload-delegated', 'payload-decoded']);
const RESPONSES = new Set([
  'value', 'nullable-value', 'ack', 'status', 'domain-error',
  'status-or-domain-error', 'status-or-domain-error-or-tool-result',
  'value-or-domain-error', 'tool-result', 'unrouted',
]);
const ERRORS = new Set(['background-error', 'tool-error', 'none']);
const PRESENCE = new Set(['none', 'required', 'optional']);

const ALL_KEYS = Object.keys(RUNTIME_COMMAND_CONTRACTS);

describe('RUNTIME_COMMAND_CONTRACTS · registry integrity', () => {
  it('registers every command name exactly once (no duplicate keys)', () => {
    expect(new Set(ALL_KEYS).size).toBe(ALL_KEYS.length);
  });

  it('every declared command has a complete, enum-valid contract', () => {
    for (const [type, contract] of Object.entries(RUNTIME_COMMAND_CONTRACTS) as [string, RuntimeCommandContract][]) {
      expect(OWNERS.has(contract.owner), `${type} owner`).toBe(true);
      expect(SURFACES.has(contract.surface), `${type} surface`).toBe(true);
      expect(ACCESS.has(contract.request.access), `${type} access`).toBe(true);
      expect(PRESENCE.has(contract.request.presence), `${type} presence`).toBe(true);
      expect(RESPONSES.has(contract.response), `${type} response`).toBe(true);
      expect(ERRORS.has(contract.error), `${type} error`).toBe(true);
    }
  });

  it('a none-access command declares a none payload presence', () => {
    for (const [type, contract] of Object.entries(RUNTIME_COMMAND_CONTRACTS)) {
      if (contract.request.access === 'none') {
        expect(contract.request.presence, `${type} presence`).toBe('none');
      }
    }
  });

  it('typed and client-only groups are disjoint and cover the whole registry', () => {
    const typed = new Set(TYPED_RUNTIME_COMMAND_TYPES);
    const clientOnly = new Set(CLIENT_ONLY_RUNTIME_COMMAND_TYPES);
    const overlap = [...typed].filter((type) => clientOnly.has(type));
    expect(overlap).toEqual([]);
    expect(new Set([...typed, ...clientOnly]).size).toBe(ALL_KEYS.length);
    for (const key of ALL_KEYS) {
      expect(typed.has(key) || clientOnly.has(key)).toBe(true);
    }
  });

  it('client-only commands are declared-only and unrouted', () => {
    for (const type of CLIENT_ONLY_RUNTIME_COMMAND_TYPES as readonly (keyof typeof RUNTIME_COMMAND_CONTRACTS)[]) {
      const contract = RUNTIME_COMMAND_CONTRACTS[type];
      expect(contract.owner).toBe('client-only');
      expect(contract.surface).toBe('declared-only');
      expect(contract.response).toBe('unrouted');
    }
  });
});

describe('getRuntimeCommandOwner · routing', () => {
  it('returns typed-handler for a registered typed command', () => {
    expect(getRuntimeCommandOwner('GET_MEMORIES')).toBe('typed-handler');
  });

  it('returns client-only for a registered client-only command', () => {
    expect(getRuntimeCommandOwner('TOOL_CALL_EXECUTED')).toBe('client-only');
  });

  it('returns undefined for an unknown command', () => {
    expect(getRuntimeCommandOwner('NOT_A_REAL_COMMAND')).toBeUndefined();
    expect(getRuntimeCommandOwner('')).toBeUndefined();
  });
});
