import { describe, expect, it } from 'vitest';
import { createDiagnosticLogBuffer } from '../core/diagnostics/log-buffer';

describe('diagnostic log buffer', () => {
  it('keeps entries in insertion order and clears on demand', () => {
    const buffer = createDiagnosticLogBuffer(100, 1024 * 1024);
    buffer.record({ level: 'info', source: 'tool-runtime', message: 'tool start: shell_exec' });
    buffer.record({ level: 'warn', source: 'tool-runtime', message: 'authorization denied', details: 'tool_authorization_missing: ...' });

    const snapshot = buffer.snapshot();
    expect(snapshot).toHaveLength(2);
    expect(snapshot[0]?.message).toBe('tool start: shell_exec');
    expect(snapshot[1]?.level).toBe('warn');
    expect(snapshot[1]?.ts).toEqual(expect.any(Number));

    buffer.clear();
    expect(buffer.snapshot()).toHaveLength(0);
  });

  it('bounded by entry count, evicting the oldest entries', () => {
    const buffer = createDiagnosticLogBuffer(3, 1024 * 1024);
    buffer.record({ level: 'info', source: 's', message: 'a' });
    buffer.record({ level: 'info', source: 's', message: 'b' });
    buffer.record({ level: 'info', source: 's', message: 'c' });
    buffer.record({ level: 'error', source: 's', message: 'd' });

    expect(buffer.snapshot().map((entry) => entry.message)).toEqual(['b', 'c', 'd']);
  });

  it('bounded by total byte budget', () => {
    const buffer = createDiagnosticLogBuffer(100, 60);
    buffer.record({ level: 'info', source: 's', message: 'x'.repeat(30) });
    buffer.record({ level: 'info', source: 's', message: 'y'.repeat(30) });
    buffer.record({ level: 'info', source: 's', message: 'z'.repeat(30) });

    const snapshot = buffer.snapshot();
    expect(snapshot.length).toBeLessThanOrEqual(2);
  });

  it('never exposes raw payloads through the message field contract', () => {
    const buffer = createDiagnosticLogBuffer();
    buffer.record({ level: 'info', source: 'tool-runtime', message: 'tool start: shell_exec', details: 'ok:true | wrote 123 bytes' });
    for (const entry of buffer.snapshot()) {
      expect(entry).toEqual(expect.objectContaining({
        ts: expect.any(Number),
        level: expect.stringMatching(/^(info|warn|error)$/),
        source: expect.any(String),
        message: expect.any(String),
      }));
      expect(JSON.stringify(entry)).not.toContain('secret');
    }
  });

  it('restores persisted history before writing, so a service-worker restart does not wipe the trail', async () => {
    const saved = [
      { ts: 1, level: 'info', source: 'tool-runtime', message: 'old-1' },
      { ts: 2, level: 'info', source: 'tool-runtime', message: 'old-2' },
    ];
    const setCalls: Array<Record<string, unknown>> = [];
    let releaseGet: (value: unknown) => void = () => {};
    const pendingGet = new Promise((resolve) => { releaseGet = resolve; });

    const originalChrome = (globalThis as { chrome?: unknown }).chrome;
    (globalThis as { chrome?: unknown }).chrome = {
      storage: {
        local: {
          get: () => pendingGet,
          set: (value: Record<string, unknown>) => { setCalls.push(value); return Promise.resolve(); },
          remove: () => Promise.resolve(),
        },
      },
    };

    try {
      const buffer = createDiagnosticLogBuffer(100, 1024 * 1024);
      // 恢复尚未完成时立刻记录（真实场景：SW 启动即写 boot_ms）
      buffer.record({ level: 'info', source: 'boot', message: 'boot_ms' });

      // 恢复完成前不得落盘，否则会用「仅一条」覆盖历史
      expect(setCalls).toHaveLength(0);

      releaseGet({ dpp_diagnostic_logs: saved });
      await new Promise((resolve) => { setTimeout(resolve, 0); });

      // 内存中应为「历史 + 启动期间新记的」
      expect(buffer.snapshot().map((entry) => entry.message)).toEqual(['old-1', 'old-2', 'boot_ms']);

      await new Promise((resolve) => { setTimeout(resolve, 0); });
      expect(setCalls.length).toBeGreaterThan(0);
      const written = setCalls[setCalls.length - 1];
      const persisted = (written?.dpp_diagnostic_logs ?? []) as Array<{ message: string }>;
      expect(persisted.map((entry) => entry.message)).toEqual(['old-1', 'old-2', 'boot_ms']);
    } finally {
      (globalThis as { chrome?: unknown }).chrome = originalChrome;
    }
  });
});
