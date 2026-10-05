import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  claimAutomationRun,
  createAutomation,
  deleteAutomation,
  finalizeAutomationRun,
  getAutomationById,
  getAutomationRunById,
  terminalizeAutomationRuns,
  updateAutomationRun,
} from '../core/automation/store';
import type {
  Automation,
  AutomationRunnerRequest,
  AutomationRunnerResult,
} from '../core/automation/types';

function createChromeStub() {
  const storage = new Map<string, unknown>();
  return {
    storage,
    chromeStub: {
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: storage.get(key) })),
          set: vi.fn(async (value: Record<string, unknown>) => {
            for (const [key, storedValue] of Object.entries(value)) storage.set(key, storedValue);
          }),
        },
      },
    },
  };
}

async function createTestAutomation(): Promise<Automation> {
  return createAutomation({
    name: 'Delete terminal state',
    prompt: 'Run once.',
    schedule: {
      kind: 'manual',
      expression: null,
      timezone: 'UTC',
      enabled: false,
      minimumIntervalMinutes: 15,
    },
    promptOptions: {
      modelType: null,
      searchEnabled: false,
      thinkingEnabled: false,
      refFileIds: [],
    },
  });
}

async function claimRunningRun(automation: Automation, runId: string) {
  const startedAt = Date.now();
  const claim = await claimAutomationRun({
    runId,
    automationId: automation.id,
    trigger: 'manual',
    scheduledFor: null,
    startedAt,
    createRequest: (current): AutomationRunnerRequest => ({
      runId,
      automationId: current.id,
      deadlineAt: startedAt + 180_000,
      prompt: current.prompt,
      trigger: 'manual',
      chatSessionId: null,
      parentMessageId: null,
      promptOptions: current.promptOptions,
      requestedAt: startedAt,
    }),
  });
  expect(claim.kind).toBe('claimed');
  if (claim.kind !== 'claimed') throw new Error('unreachable');
  return claim.run;
}

function successResult(request: AutomationRunnerRequest, completedAt: number): AutomationRunnerResult {
  return {
    ok: true,
    chatSessionId: 'late-session',
    sessionUrl: null,
    parentMessageId: 1,
    assistantMessageId: 2,
    assistantText: 'arrived after terminalization',
    history: null,
    completedAt,
  };
}

describe('automation delete terminalizes in-flight rows (DCD 20261005 §五 第 1 条)', () => {
  beforeEach(() => {
    vi.stubGlobal('chrome', createChromeStub().chromeStub);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('writes a running row as ambiguous so history never claims a settled outcome', async () => {
    const automation = await createTestAutomation();
    const run = await claimRunningRun(automation, 'run-running');

    const terminalized = await terminalizeAutomationRuns(automation.id);

    expect(terminalized.map((item) => item.id)).toEqual([run.id]);
    const persisted = await getAutomationRunById(run.id);
    expect(persisted?.status).toBe('ambiguous');
    expect(persisted?.completedAt).not.toBeNull();
  });

  it('writes a queued row as cancelled because nothing left the process yet', async () => {
    const automation = await createTestAutomation();
    const run = await claimRunningRun(automation, 'run-queued');
    await updateAutomationRun(run.id, { status: 'queued' }, { expectedStatus: 'running' });

    await terminalizeAutomationRuns(automation.id);

    expect((await getAutomationRunById(run.id))?.status).toBe('cancelled');
  });

  it('leaves already settled rows untouched', async () => {
    const automation = await createTestAutomation();
    const run = await claimRunningRun(automation, 'run-settled');
    await finalizeAutomationRun({
      runId: run.id,
      automationId: automation.id,
      status: 'succeeded',
      result: successResult(run.request!, Date.now()),
      runtimePatch: () => ({ nextRunAt: null }),
    });

    const terminalized = await terminalizeAutomationRuns(automation.id);

    expect(terminalized).toEqual([]);
    expect((await getAutomationRunById(run.id))?.status).toBe('succeeded');
  });

  it('refuses a late executor result once the row is terminal', async () => {
    const automation = await createTestAutomation();
    const run = await claimRunningRun(automation, 'run-fenced');
    await terminalizeAutomationRuns(automation.id);

    const finalized = await finalizeAutomationRun({
      runId: run.id,
      automationId: automation.id,
      status: 'succeeded',
      result: successResult(run.request!, Date.now()),
      runtimePatch: () => ({ lastError: null }),
    });

    expect(finalized).toBeNull();
    const persisted = await getAutomationRunById(run.id);
    expect(persisted?.status).toBe('ambiguous');
    expect(persisted?.result).toBeNull();
  });

  it('keeps deleted automation state unreconstructable after the terminal write', async () => {
    const automation = await createTestAutomation();
    const run = await claimRunningRun(automation, 'run-deleted');
    await terminalizeAutomationRuns(automation.id);
    await deleteAutomation(automation.id);

    expect(await getAutomationById(automation.id)).toBeNull();
    expect(await getAutomationRunById(run.id)).toBeNull();

    const finalized = await finalizeAutomationRun({
      runId: run.id,
      automationId: automation.id,
      status: 'succeeded',
      result: successResult(run.request!, Date.now()),
      runtimePatch: () => ({ nextRunAt: null }),
    });
    expect(finalized).toBeNull();
    expect(await getAutomationRunById(run.id)).toBeNull();
  });
});
