/**
 * 审计 #54：单 provider 失败不拖垮全量工具列表。
 *
 * Promise.allSettled 让每个 provider.listTools 独立 settle；
 * 第 2 个 provider 抛错时，第 1、3 个的 descriptor 必须全部返回。
 *
 * 变异自证：把 provider-registry.ts 里的 Promise.allSettled 改回 Promise.all
 *          ⇒ 本用例必须红（整个 listTools 直接 reject，拿不到 1/3 的 descriptor）。
 *
 * 注意：ToolProviderRegistry 只允许注册 **一个** mcp provider（key 是 mcp:*）；
 *       这里 3 个都用 local，各自不同 id。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToolProviderRegistry } from '../core/tool/provider-registry';
import type { ToolProviderIdentity } from '../core/tool/types';

const CONTEXT = { locale: 'en' as const, includeDisabled: false };

describe('审计 #54：单 provider 失败不拖垮全量', () => {
  afterEach(() => vi.restoreAllMocks());

  it('3 个 local provider 中间那个 listTools 抛错 → 第 1/3 个 descriptor 仍全部返回', async () => {
    const err = new Error('provider-2 exploded');
    const d1 = makeDescriptor(localIdentity('alpha'), 'local:alpha:one', 'one_alpha');
    const d3a = makeDescriptor(localIdentity('gamma'), 'local:gamma:beta', 'beta_gamma');
    const d3b = makeDescriptor(localIdentity('gamma'), 'local:gamma:gamma', 'gamma_gamma');

    const registry = new ToolProviderRegistry([
      {
        registration: { kind: 'local', id: 'alpha' },
        listTools: vi.fn(async () => [d1]),
        execute: vi.fn(async () => ({ ok: true, summary: 'alpha' })),
      },
      {
        registration: { kind: 'local', id: 'beta' },
        listTools: vi.fn(async () => { throw err; }),
        execute: vi.fn(async () => ({ ok: true, summary: 'beta' })),
      },
      {
        registration: { kind: 'local', id: 'gamma' },
        listTools: vi.fn(async () => [d3a, d3b]),
        execute: vi.fn(async () => ({ ok: true, summary: 'gamma' })),
      },
    ]);

    const result = await registry.listTools(CONTEXT);

    // 全量返回 = 第 1 个 (1 条) + 第 2 个 (失败跳过) + 第 3 个 (2 条)
    expect(result).toHaveLength(3);
    expect(result).toEqual(expect.arrayContaining([d1, d3a, d3b]));
    // 变异：allSettled → all 时这里会直接 reject，根本走不到
  });
});

function localIdentity(id: string): ToolProviderIdentity {
  return { kind: 'local', id, displayName: id, transport: 'in_process' };
}

function makeDescriptor(
  provider: ToolProviderIdentity,
  id: string,
  invocationName: string,
) {
  return {
    id,
    provider,
    name: invocationName,
    invocationName,
    title: invocationName,
    description: invocationName,
    inputSchema: { type: 'object' },
    execution: { mode: 'auto', enabled: true, risk: 'low' as const },
  };
}
