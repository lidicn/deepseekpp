import { describe, expect, it, vi } from 'vitest';
import {
  createScenarioRuntimeHandlers,
  type ScenarioRuntimeHandlerDependencies,
} from '../entrypoints/background/scenario-runtime-handlers';

function makeDeps(): ScenarioRuntimeHandlerDependencies {
  return {
    getAllScenarios: vi.fn(async () => []),
    saveScenario: vi.fn(async () => undefined),
    addCustomScenario: vi.fn(async (label: string, template: string) => ({
      id: 's1', label, template, timestamp: Date.now(),
    } as any)),
    deleteScenario: vi.fn(async () => undefined),
    refreshScenarioMenus: vi.fn(async () => undefined),
  };
}

// Split into two files — vi.doMock in describe.each leaks across tests.
// This file tests the legitimate op routing (real decoder).
// scenario-runtime-handlers-default-deny.test.ts tests handler defense-in-depth
// with a mocked decoder that lets unknown ops through.

describe('SCENARIOS_UPDATED handler legitimate ops still reach correct deps', () => {
  it('delete path calls deleteScenario', async () => {
    const deps = makeDeps();
    const handlers = createScenarioRuntimeHandlers(deps);
    const rawHandler = handlers[0];
    await rawHandler.handle!({ type: 'SCENARIOS_UPDATED', payload: { operation: 'delete', id: 'x' } } as any, { tabId: 1 } as any);
    expect(deps.deleteScenario).toHaveBeenCalledWith('x');
    expect(deps.refreshScenarioMenus).toHaveBeenCalled();
  });

  it('save path calls saveScenario', async () => {
    const deps = makeDeps();
    const handlers = createScenarioRuntimeHandlers(deps);
    const rawHandler = handlers[0];
    await rawHandler.handle!({ type: 'SCENARIOS_UPDATED', payload: { operation: 'save', scenario: { id: 'y', label: 'L', template: 'T', builtIn: false, enabled: true } } } as any, { tabId: 1 } as any);
    expect(deps.saveScenario).toHaveBeenCalled();
    expect(deps.deleteScenario).not.toHaveBeenCalled();
  });

  it('add path calls addCustomScenario', async () => {
    const deps = makeDeps();
    const handlers = createScenarioRuntimeHandlers(deps);
    const rawHandler = handlers[0];
    await rawHandler.handle!({ type: 'SCENARIOS_UPDATED', payload: { operation: 'add', label: 'L', template: 'T' } } as any, { tabId: 1 } as any);
    expect(deps.addCustomScenario).toHaveBeenCalledWith('L', 'T');
  });

  it('get and refresh remain short-circuit ok:true paths', async () => {
    const deps = makeDeps();
    const handlers = createScenarioRuntimeHandlers(deps);
    const rawHandler = handlers[0];

    const get = (await rawHandler.handle!({ type: 'SCENARIOS_UPDATED', payload: { operation: 'get' } } as any, { tabId: 1 } as any)) as { ok: boolean };
    expect(get.ok).toBe(true);
    expect(deps.getAllScenarios).toHaveBeenCalled();

    const refresh = (await rawHandler.handle!({ type: 'SCENARIOS_UPDATED', payload: { operation: 'refresh' } } as any, { tabId: 1 } as any)) as { ok: boolean };
    expect(refresh.ok).toBe(true);
    expect(deps.refreshScenarioMenus).toHaveBeenCalled();
  });
});
