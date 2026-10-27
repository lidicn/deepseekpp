/**
 * 审计 #54：单 provider 失败不拖垮全量工具列表。
 *
 * Promise.allSettled 让每个 provider.listTools 独立 settle；
 * 第 2 个 provider 抛错时，第 1、3 个的 descriptor 必须全部返回。
 *
 * 变异自证：把 provider-registry.ts 里的 Promise.allSettled 改回 Promise.all
 *          ⇒ 本用例必须红（整个 listTools 直接 reject，拿不到 1/3 的 descriptor）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToolProviderRegistry, type RuntimeToolProvider } from '../core/tool/provider-registry';
import type { ToolDescriptor, ToolProviderIdentity } from '../core/tool/types';

const CONTEXT = { locale: 'en' as const, includeDisabled: false };

describe('审计 #54：单 provider 失败不拖垮全量', () => {
  afterEach(() => vi.restoreAllMocks());

  it('3 个 local provider 中间那个 listTools 抛错 → 第 1/3 个 descriptor 仍全部返回', async () => {
    const err = new Error('provider-2 exploded');
    const d1 = makeDescriptor(localIdentity('alpha'), 'local:alpha:one', 'one_alpha');
    const d3a = makeDescriptor(localIdentity('gamma'), 'local:gamma:beta', 'beta_gamma');
    const d3b = makeDescriptor(localIdentity('gamma'), 'local:gamma:gamma', 'gamma_gamma');

    const registry = new ToolProviderRegistry([
      makeProvider({ kind: 'local', id: 'alpha' }, [d1]),
      makeProvider({ kind: 'local', id: 'beta' }, [], vi.fn(async () => { throw err; })),
      makeProvider({ kind: 'local', id: 'gamma' }, [d3a, d3b]),
    ]);

    const result = await registry.listTools(CONTEXT);

    expect(result).toHaveLength(3);
    expect(result).toEqual(expect.arrayContaining([d1, d3a, d3b]));
  });
});

function localIdentity(id: string): ToolProviderIdentity {
  return { kind: 'local', id, displayName: id, transport: 'in_process' };
}

function makeDescriptor(
  provider: ToolProviderIdentity,
  id: string,
  invocationName: string,
): ToolDescriptor {
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

function makeProvider(
  registration: { kind: 'local'; id: string },
  descriptors: ToolDescriptor[],
  listToolsOverride?: () => Promise<ToolDescriptor[]>,
): RuntimeToolProvider {
  return {
    registration,
    async listTools() {
      return listToolsOverride ? listToolsOverride() : descriptors;
    },
    execute: vi.fn(async () => ({ ok: true, summary: 'ok' })),
  };
}
