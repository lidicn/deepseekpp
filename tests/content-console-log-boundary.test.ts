import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(join(process.cwd(), 'entrypoints/content.ts'), 'utf8');

function consoleLogRegion(): string {
  const start = source.indexOf('const CONSOLE_LOG_BUFFER_KEY');
  const end = source.indexOf('/**', start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('content console-log persistence boundary', () => {
  it('keeps the hijacked log buffer out of page-shared localStorage', () => {
    const region = consoleLogRegion();
    expect(region).toMatch(
      /chrome\.storage\.local\s*\.set\(\s*\{\s*\[CONSOLE_LOG_BUFFER_KEY\]:\s*consoleLogBuffer/,
    );
    expect(region).not.toMatch(/localStorage\.setItem\(/);
    expect(region).not.toMatch(/localStorage\.getItem\(/);
  });

  it('clears the key a previous build leaked into the page origin', () => {
    const region = consoleLogRegion();
    expect(region).toContain("localStorage.removeItem(LEGACY_CONSOLE_LOG_STORAGE_KEY)");
    expect(region).toContain("const LEGACY_CONSOLE_LOG_STORAGE_KEY = 'dpp_console_log_buffer'");
  });

  it('settles the handoff buffer before the reload decision returns', () => {
    expect(source).toContain('await persistConsoleLogBufferBeforeReload();');
    const reloadStart = source.indexOf('function reloadInlineAgentNativeHistory(');
    const reloadEnd = source.indexOf('\n}', reloadStart);
    expect(source.slice(reloadStart, reloadEnd)).toContain('window.location.reload();');
    expect(source.slice(reloadStart, reloadEnd)).not.toMatch(/localStorage|storage\.local\.set/);
  });

  it('reports a persistence degradation instead of swallowing it', () => {
    const region = consoleLogRegion();
    expect(region).not.toMatch(/catch \{\}/);
    expect(region).toContain('warnOnceConsoleLogPersistenceFailed(');
  });

  it('keeps the reload call site the terminal-flow contract test pins', () => {
    expect(source).toContain('if (shouldReloadNativeHistory) reloadInlineAgentNativeHistory();');
  });
});
