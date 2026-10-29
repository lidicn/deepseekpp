/**
 * W18 + W19 的**接线守卫**（PM 验收时发现缺口并补，2026-10-27）。
 *
 * 为什么要单独有这一份：`tests/execution-gates.test.ts` 只测 `checkExecutionGate` 这个
 * 纯函数本身。我按铁律 1 做变异复验时把 `core/tool/runtime.ts` 两处
 * `if (!gate.allowed) {` 改成 `if (false) {`（即"接了但永不生效"），
 * 结果 **execution-gates / tool-runtime-history / mcp-capability-runtime /
 * background-tool-authorization-integration / tool-interactive-abandon 五个文件全部红 0**。
 * 也就是说：闸门从 runtime 上被摘掉时，**没有任何测试会失败**。
 *
 * 本文件驱动**真实 runtime**（`createRuntimeToolRuntime` + `ToolProviderRegistry`），
 * 断言的是「provider 的 execute 有没有被真的调用」——摘掉接线必然红。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ToolProviderRegistry,
  type RuntimeToolProvider,
} from '../core/tool/provider-registry';
import { createRuntimeToolRuntime } from '../core/tool/runtime';
import { TOOL_RATE_POLICY, resetExecutionGatesForTests } from '../core/tool/execution-gates';
import type {
  ToolCall,
  ToolDescriptor,
  ToolProviderIdentity,
  ToolResult,
} from '../core/tool/types';

/**
 * 每个用例用**独立 provider id**：gates 是按 `kind:id` 存 Map 的，
 * 不同 provider 之间不串状态（这本身也是 #52/负控要求的行为）。
 */
function makeRuntime(providerId: string, behaviour: 'ok' | 'fail') {
  const provider: ToolProviderIdentity = {
    kind: 'local',
    id: providerId,
    displayName: `Gate Wiring ${providerId}`,
    transport: 'in_process',
  };
  const descriptor: ToolDescriptor = {
    id: `local:${providerId}:probe`,
    provider,
    name: `gate_wiring_${providerId}`,
    invocationName: `gate_wiring_${providerId}`,
    title: 'Gate wiring probe',
    description: 'Exercises the W18/W19 wiring in the runtime, not the gate itself.',
    inputSchema: { type: 'object' },
    execution: { mode: 'auto', enabled: true, risk: 'low' },
  };
  const execute = vi.fn(async (): Promise<ToolResult> =>
    behaviour === 'ok'
      ? { ok: true, summary: 'provider ok' }
      : {
        ok: false,
        summary: 'provider failed',
        error: { code: 'PROVIDER_BOOM', message: 'boom', retryable: true },
      },
  );
  const runtimeProvider: RuntimeToolProvider = {
    registration: { kind: 'local', id: provider.id },
    listTools: async () => [descriptor],
    execute,
  };
  const runtime = createRuntimeToolRuntime(new ToolProviderRegistry([runtimeProvider]));
  const call: ToolCall = {
    id: `${providerId}-call`,
    descriptorId: descriptor.id,
    provider,
    name: descriptor.name,
    invocationName: descriptor.invocationName,
    payload: {},
    raw: `<${descriptor.invocationName}>{}</${descriptor.invocationName}>`,
    // 必须有 source：runtime 会把它写进工具历史，history codec 校验
    // `TOOL_EXECUTION_TRIGGER_SET.has(String(record.source))`，缺了会抛
    // ToolPostEffectPersistenceError（夹具问题，不是产品缺陷）。
    source: { trigger: 'test', requestId: `${providerId}-request` },
  } as never;
  return { execute, runtime, call };
}

beforeEach(() => {
  vi.stubGlobal('chrome', {
    storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) } },
  });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  resetExecutionGatesForTests();
});

afterEach(() => {
  resetExecutionGatesForTests();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('W19 熔断器已接在 runtime 上（不是只有纯函数）', () => {
  it('★ 连续 3 次失败后，第 4 次**不再调用 provider**，并返回可重试的熔断错误', async () => {
    const { execute, runtime, call } = makeRuntime('w19_open', 'fail');

    for (let i = 0; i < 3; i += 1) {
      const r = await runtime.executeToolCall(call, 'test', 'en');
      expect(r.ok).toBe(false);
    }
    expect(execute).toHaveBeenCalledTimes(3);

    const blocked = await runtime.executeToolCall(call, 'test', 'en');
    // 接线生效的唯一硬证据：provider 没有被调用
    expect(execute).toHaveBeenCalledTimes(3);
    expect(blocked.ok).toBe(false);
    expect(blocked.error?.code).toBe('TOOL_CIRCUIT_OPEN');
    expect(blocked.error?.retryable).toBe(true);
  });

  it('负控：serverA 熔断不影响 serverB（provider 维度隔离，接线层也成立）', async () => {
    const a = makeRuntime('w19_iso_a', 'fail');
    for (let i = 0; i < 4; i += 1) await a.runtime.executeToolCall(a.call, 'test', 'en');
    expect(a.execute).toHaveBeenCalledTimes(3); // 第 4 次被熔断

    const b = makeRuntime('w19_iso_b', 'ok');
    const result = await b.runtime.executeToolCall(b.call, 'test', 'en');
    expect(b.execute).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
  });

  it('负控：未触发熔断时正常调用 provider（证明上面的 0 次不是恒真）', async () => {
    const { execute, runtime, call } = makeRuntime('w19_happy', 'ok');
    const result = await runtime.executeToolCall(call, 'test', 'en');
    expect(result.ok).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

describe('W18 速率限制已接在 runtime 上', () => {
  it('★ 超过 RATE_POLICY.maxCalls 后不再调用 provider，返回 TOOL_RATE_LIMITED', async () => {
    const { execute, runtime, call } = makeRuntime('w18_limit', 'ok');

    // 全部成功 ⇒ 熔断器不会介入，只能由限流器拦
    const first = [];
    for (let i = 0; i < TOOL_RATE_POLICY.maxCalls; i += 1) first.push(await runtime.executeToolCall(call, 'test', 'en'));
    expect(first.every((r) => r.ok)).toBe(true);
    expect(execute).toHaveBeenCalledTimes(TOOL_RATE_POLICY.maxCalls);

    const limited = await runtime.executeToolCall(call, 'test', 'en');
    expect(execute).toHaveBeenCalledTimes(TOOL_RATE_POLICY.maxCalls); // ← 第 61 次没有落到 provider
    expect(limited.ok).toBe(false);
    expect(limited.error?.code).toBe('TOOL_RATE_LIMITED');
    expect(limited.error?.retryable).toBe(true);
    expect(typeof (limited.error?.details as { retryAfterMs?: unknown } | undefined)?.retryAfterMs)
      .toBe('number');
  });
});
