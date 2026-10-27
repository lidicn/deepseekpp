import { describe, expect, it, vi } from 'vitest';
import {
  createScenarioRuntimeHandlers,
  type ScenarioRuntimeHandlerDependencies,
} from '../entrypoints/background/scenario-runtime-handlers';

function makeDeps(): ScenarioRuntimeHandlerDependencies {
  return {
    getAllScenarios: vi.fn(async () => []),
    saveScenario: vi.fn(async () => undefined),
    addCustomScenario: vi.fn(async () => ({ id: 's1' } as any)),
    deleteScenario: vi.fn(async () => undefined),
    refreshScenarioMenus: vi.fn(async () => undefined),
  };
}

// #85 audit guard — scenario handler default-deny instead of default-delete.
// The decoder layer already rejects unknown ops (scenario-coverage.test.ts),
// but the handler must also stand on its own in defense-in-depth.
// Here we mock the decoder to let unknown ops through, simulating a future
// decode-layer regression — the handler must NOT delete.
vi.doMock('../core/scenario/runtime-request-codec', async () => {
  const actual = await vi.importActual<typeof import('../core/scenario/runtime-request-codec')>(
    '../core/scenario/runtime-request-codec',
  );
  return {
    ...actual,
    decodeScenarioRuntimeRequest: vi.fn(() => ({ operation: 'unknown_xyz' } as any)),
  };
});

describe('audit #85 guard: handler default-deny when decode lets unknown op through', () => {
  it('unknown operation does NOT delete/save/add — returns ok:false, no side effects', async () => {
    const { createScenarioRuntimeHandlers } = await import('../entrypoints/background/scenario-runtime-handlers');
    const deps = makeDeps();
    const handlers = createScenarioRuntimeHandlers(deps);
    const rawHandler = handlers[0];

    const result = (await rawHandler.handle!(
      { type: 'SCENARIOS_UPDATED', payload: { operation: 'unknown_xyz', id: 'victim-scenario' } } as any,
      { tabId: 1 } as any,
    )) as { ok: boolean };

    expect(result.ok).toBe(false);
    expect(deps.deleteScenario).not.toHaveBeenCalled();
    expect(deps.saveScenario).not.toHaveBeenCalled();
    expect(deps.addCustomScenario).not.toHaveBeenCalled();
    expect(deps.refreshScenarioMenus).not.toHaveBeenCalled();
    expect(deps.getAllScenarios).not.toHaveBeenCalled();
  });
});
