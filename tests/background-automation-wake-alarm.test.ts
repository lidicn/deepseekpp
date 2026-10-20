import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTOMATION_WAKE_ALARM_NAME } from '../core/automation/scheduler';

// The wake-alarm helper lives in the WXT background entrypoint. `defineBackground`
// is a build-time auto-import that is not present under Vitest, so it is stubbed
// to a no-op that returns the entrypoint descriptor without running startup.
vi.stubGlobal('defineBackground', (main: unknown) => ({ defineBackground: true, main }));

const alarms = {
  create: vi.fn(async () => {}),
  get: vi.fn(async (_name: string): Promise<{ name: string } | undefined> => undefined),
  onAlarm: { addListener: vi.fn() },
};

// Declared as a named constant (not only inline in stubGlobal) so beforeEach
// can re-stub it: unstubGlobals:true (vitest.config) revokes the module-level
// stub before each test, which otherwise leaves `chrome` undefined inside the
// async function under test. The module-level stub below also satisfies the
// background entrypoint's top-level chrome access during the dynamic import.
const chromeStub = {
  alarms,
  storage: {
    local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}), remove: vi.fn(async () => {}) },
    onChanged: { addListener: vi.fn() },
    session: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) },
  },
  runtime: {
    onMessage: { addListener: vi.fn() },
    sendMessage: vi.fn(async () => {}),
    getURL: (path: string) => `chrome-extension://test/${path}`,
    openOptionsPage: vi.fn(async () => {}),
    id: 'test',
  },
  tabs: {
    query: vi.fn(async () => []),
    sendMessage: vi.fn(async () => {}),
    create: vi.fn(async () => {}),
  },
  menus: { create: vi.fn(), removeAll: vi.fn(async () => {}), onClicked: { addListener: vi.fn() } },
};

vi.stubGlobal('chrome', chromeStub);

// Loading the full background entrypoint module graph (all core services) takes
// several seconds at collection time, which is why these assertions live in one
// file rather than per-test imports.
const { ensureAutomationWakeAlarm } = await import('../entrypoints/background');

describe('ensureAutomationWakeAlarm', () => {
  beforeEach(() => {
    // Re-stub every case: unstubGlobals revoked the module-level stub above.
    vi.stubGlobal('chrome', chromeStub);
    alarms.create.mockClear();
    alarms.get.mockReset();
    alarms.get.mockResolvedValue(undefined);
  });

  it('creates the wake alarm when none exists', async () => {
    await ensureAutomationWakeAlarm();

    expect(alarms.get).toHaveBeenCalledWith(AUTOMATION_WAKE_ALARM_NAME);
    expect(alarms.create).toHaveBeenCalledTimes(1);
    expect(alarms.create).toHaveBeenCalledWith(AUTOMATION_WAKE_ALARM_NAME, expect.objectContaining({
      periodInMinutes: expect.any(Number),
    }));
  });

  it('skips creation when the wake alarm already exists', async () => {
    alarms.get.mockResolvedValue({ name: AUTOMATION_WAKE_ALARM_NAME });

    await ensureAutomationWakeAlarm();

    expect(alarms.get).toHaveBeenCalledWith(AUTOMATION_WAKE_ALARM_NAME);
    expect(alarms.create).not.toHaveBeenCalled();
  });
});
