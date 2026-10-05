import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  refreshAutomationNextRunAt,
  scanDueAutomations,
} from '../core/automation/scheduler';
import {
  createAutomation,
  getAutomationById,
  setAutomationStatus,
  updateAutomation,
} from '../core/automation/store';
import type { Automation } from '../core/automation/types';

function createChromeStub() {
  const storage = new Map<string, unknown>();
  return {
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({ [key]: storage.get(key) })),
        set: vi.fn(async (value: Record<string, unknown>) => {
          for (const [key, storedValue] of Object.entries(value)) storage.set(key, storedValue);
        }),
      },
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// A deterministic schedule failure must be terminal. Before the pause existed,
// the 1-minute wake alarm rescan-then-null'd forever and each rescan was a
// 25-second busy loop that froze the background service worker.
describe('automation schedule-failure terminal state', () => {
  it('pauses an automation whose next run cannot be computed and records the schedule error', async () => {
    vi.stubGlobal('chrome', createChromeStub());
    const automation = await createUnschedulableAutomation();

    const updated = await refreshAutomationNextRunAt(automation.id, Date.UTC(2026, 9, 5));

    expect(updated).toMatchObject({
      status: 'paused',
      nextRunAt: null,
    });
    expect(updated?.lastError).toMatchObject({
      code: 'cron_no_next_run',
      phase: 'schedule',
      retryable: false,
    });
  });

  it('stops re-running the failing schedule calculation on the next wake', async () => {
    vi.stubGlobal('chrome', createChromeStub());
    const automation = await createUnschedulableAutomation();
    const now = Date.UTC(2026, 9, 5);

    const first = await scanDueAutomations(vi.fn(), now);
    expect(first.initialized).toBe(1);

    const afterFirst = await getAutomationById(automation.id);
    expect(afterFirst?.status).toBe('paused');

    const executor = vi.fn();
    const second = await scanDueAutomations(executor, now + 60_000);
    expect(second.initialized).toBe(0);
    expect(second.scanned).toBe(1);
    expect(executor).not.toHaveBeenCalled();
  });

  it('scans again once the user repairs the schedule and re-activates', async () => {
    vi.stubGlobal('chrome', createChromeStub());
    const automation = await createUnschedulableAutomation();
    await refreshAutomationNextRunAt(automation.id, Date.UTC(2026, 9, 5));

    const repaired = await updateAutomation(automation.id, {
      schedule: {
        kind: 'cron',
        expression: '0 9 1 * *',
        timezone: 'UTC',
        enabled: true,
        minimumIntervalMinutes: 15,
      },
    });
    const reactivated = await setAutomationStatus(automation.id, 'active');
    expect(reactivated?.status).toBe('active');

    const next = await refreshAutomationNextRunAt(repaired!.id, Date.UTC(2026, 9, 5));
    expect(next?.nextRunAt).toBe(Date.UTC(2026, 10, 1, 9));
    expect(next?.lastError).toBeNull();

    const scan = await scanDueAutomations(vi.fn(), Date.UTC(2026, 9, 6));
    expect(scan.initialized).toBe(0);
    expect(scan.due).toBe(0);
  });
});

async function createUnschedulableAutomation(): Promise<Automation> {
  return createAutomation({
    name: 'Impossible date',
    prompt: 'Never runs.',
    schedule: {
      kind: 'cron',
      expression: '0 0 30 2 *',
      timezone: 'UTC',
      enabled: true,
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
